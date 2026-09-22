/**
 * Cliente para el agente Foundry "first-response-zoho" v14 hospedado en
 * Azure AI Foundry, vía la Responses API.
 *
 * Endpoint y schema conformes a la guía oficial de integración:
 *   POST {ENDPOINT}/openai/v1/responses
 *   Body: { input, agent_reference: { name, version, type }, previous_response_id? }
 *   Auth header: api-key: <FOUNDRY_API_KEY>
 *
 * El agente puede devolver markers de control al final del texto:
 *   - [ESCALAR]: requiere derivación humana
 *   - [END]: conversación cerrada por el usuario
 *
 * Threading: Foundry guarda el historial server-side. Solo se reenvía el
 * response_id del turno anterior como previous_response_id. NO se reenvía
 * el historial completo.
 */

const FOUNDRY_ENDPOINT =
  "https://claude-product-design.services.ai.azure.com/api/projects/claude-product-design/openai/v1/responses"

const AGENT_REFERENCE = {
  name: "first-response-zoho",
  version: "14",
  type: "agent_reference",
} as const

function getApiKey(): string {
  const key = (process.env.FOUNDRY_API_KEY || "").trim()
  if (!key) {
    throw new Error("FOUNDRY_API_KEY no configurada en el entorno.")
  }
  return key
}

export type FoundryMarker = "ESCALAR" | "END" | null

export type FoundryAgentResponse = {
  reply: string
  responseId: string
  marker: FoundryMarker
}

/**
 * Tipos parciales del shape de respuesta de la Responses API.
 * No exhaustivo; solo lo que parseamos.
 */
type FoundryOutputContent = {
  type?: string
  text?: string
}

type FoundryOutputMessage = {
  type?: string
  content?: FoundryOutputContent[]
}

type FoundryResponsesAPIResponse = {
  id?: string
  output?: FoundryOutputMessage[]
  error?: { code?: string; message?: string }
}

function extractReplyFromOutput(output: FoundryOutputMessage[] | undefined): string {
  if (!output || !Array.isArray(output)) return ""
  for (const item of output) {
    if (item?.type !== "message") continue
    const contents = item?.content
    if (!Array.isArray(contents)) continue
    for (const c of contents) {
      if (c?.type === "output_text" && typeof c.text === "string") {
        return c.text
      }
    }
  }
  return ""
}

/**
 * Invoca el agente Foundry. Mantiene contexto vía previousResponseId.
 */
export async function callFirstResponseAgent(
  message: string,
  previousResponseId?: string,
): Promise<FoundryAgentResponse> {
  const apiKey = getApiKey()

  const body: Record<string, unknown> = {
    input: message,
    agent_reference: AGENT_REFERENCE,
  }
  if (previousResponseId) {
    body.previous_response_id = previousResponseId
  }

  const res = await fetch(FOUNDRY_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": apiKey,
    },
    body: JSON.stringify(body),
    cache: "no-store",
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => "")
    console.error(`[foundry] HTTP ${res.status}:`, errText.slice(0, 500))
    throw new Error(`Foundry agent HTTP ${res.status}`)
  }

  const data = (await res.json()) as FoundryResponsesAPIResponse

  if (data.error) {
    console.error("[foundry] API error:", data.error)
    throw new Error(`Foundry agent error: ${data.error.message || data.error.code || "unknown"}`)
  }

  const rawReply = extractReplyFromOutput(data.output).trim()
  if (!rawReply) {
    console.error("[foundry] respuesta sin output_text:", JSON.stringify(data).slice(0, 500))
    throw new Error("Foundry agent devolvió respuesta vacía o con formato inesperado")
  }

  const responseId = data.id || ""

  // Detectar y limpiar markers (mutuamente excluyentes: ESCALAR o END, no ambos)
  let marker: FoundryMarker = null
  let reply = rawReply
  if (/\[ESCALAR\]/i.test(rawReply)) {
    marker = "ESCALAR"
    reply = rawReply.replace(/\[ESCALAR\]/gi, "").trim()
  } else if (/\[END\]/i.test(rawReply)) {
    marker = "END"
    reply = rawReply.replace(/\[END\]/gi, "").trim()
  }

  return { reply, responseId, marker }
}
