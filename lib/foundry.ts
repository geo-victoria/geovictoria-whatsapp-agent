/**
 * Cliente para el agente Foundry "first-response-zoho" v14 hospedado en
 * Azure AI Foundry. Reemplaza la lógica de respuesta automática a clientes
 * existentes que antes vivía en /api/support (V1/V2).
 *
 * El agente devuelve la respuesta al usuario y opcionalmente un marker:
 *   - [ESCALAR]: la consulta necesita un humano. Vicky comunica los
 *     canales de soporte (WhatsApp, email, teléfono).
 *   - [END]: la conversación quedó cerrada. Vicky despide amablemente.
 *   - (sin marker): conversación continúa, mantener responseId para el
 *     próximo turno.
 *
 * Si Azure devuelve error o timeout, la función propaga el error y la
 * tool wrapper (consultar_agente_soporte) decide cómo actuar.
 */

const FOUNDRY_ENDPOINT = "https://claude-product-design.services.ai.azure.com"
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
 * Invoca el agente Foundry. Mantiene contexto vía previousResponseId.
 */
export async function callFirstResponseAgent(
  message: string,
  previousResponseId?: string,
): Promise<FoundryAgentResponse> {
  const apiKey = getApiKey()

  const url = `${FOUNDRY_ENDPOINT}/api/projects/claude-product-design/agents/${AGENT_REFERENCE.name}/versions/${AGENT_REFERENCE.version}/run`

  const body: Record<string, unknown> = {
    input: message,
    agent_reference: AGENT_REFERENCE,
  }
  if (previousResponseId) {
    body.previous_response_id = previousResponseId
  }

  const res = await fetch(url, {
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
    console.error(`[foundry] HTTP ${res.status}:`, errText.slice(0, 300))
    throw new Error(`Foundry agent HTTP ${res.status}`)
  }

  const data = (await res.json()) as {
    output?: string
    response_id?: string
    id?: string
  }

  const rawReply = (data.output || "").trim()
  if (!rawReply) {
    throw new Error("Foundry agent devolvió respuesta vacía")
  }

  const responseId = data.response_id || data.id || ""

  // Detectar y limpiar markers
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
