/**
 * Endpoint POST /api/vic-botmaker-v3
 *
 * Adapter delgado entre Botmaker y el agent-loop de V3.
 *
 * Botmaker funciona como relay: recibe el mensaje del usuario por WhatsApp,
 * lo manda acá vía HTTP POST, espera la respuesta, y la devuelve por
 * WhatsApp. Este endpoint:
 *
 *   1. Valida el x-secret (autenticación de Botmaker).
 *   2. Rehidrata el historial conversacional desde Supabase (vic_v3_*).
 *   3. Invoca el mismo runAgentLoop que usa /api/vic-sales-agent-v3.
 *   4. Persiste el turno (user + assistant) en Supabase.
 *   5. Extrae pdfUrl si la conversación generó cotización.
 *   6. Devuelve { reply, handoff?, pdfUrl? } a Botmaker.
 *
 * El filtro de teléfonos autorizados vive en el Master Bot de Botmaker —
 * solo derivan a este endpoint los contactos en la lista de pruebas.
 */

import { NextResponse } from "next/server"
import { runAgentLoop, type ConversationMessage } from "@/lib/agent-loop"
import { getSystemPromptV3 } from "@/app/api/vic-sales-agent-v3/prompt"
import { fetchHistoryV3, appendTurnV3 } from "@/lib/supabase-persistence-v3"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const MAX_INPUT_CHARS = 2000
const INJECT_RE =
  /###|IGNORE|DUMP|INSTRUC|SYSTEM PROMPT|\bPROMPT\b|\\u202|<script|DROP\s+TABLE|DELETE\s+FROM|UNION\s+SELECT/i

const globalStore = globalThis as unknown as { __vicV3Processing?: Set<string> }
if (!globalStore.__vicV3Processing) globalStore.__vicV3Processing = new Set()
const processing = globalStore.__vicV3Processing

function getEnv(name: string): string {
  return (process.env[name] || "").trim()
}

function normalizeContact(raw: string): string {
  return raw.replace(/\D/g, "")
}

type ToolCallRecord = {
  name: string
  ok: boolean
  output?: unknown
}

type PdfUrlOutput = {
  pdfUrl?: string
}

/**
 * Extrae el pdfUrl de los toolCalls si la conversación incluyó una llamada
 * exitosa a generar_link_cotizadora.
 */
function extractPdfUrl(toolCalls: ToolCallRecord[] | undefined): string | undefined {
  if (!toolCalls) return undefined
  for (const call of toolCalls) {
    if (call.name !== "generar_link_cotizadora" || !call.ok) continue
    const output = call.output as PdfUrlOutput | undefined
    if (output?.pdfUrl && typeof output.pdfUrl === "string") {
      return output.pdfUrl
    }
  }
  return undefined
}

type BotmakerRequest = { contact?: string; message?: string }
type BotmakerResponse = { reply: string; handoff?: boolean; pdfUrl?: string }

export async function POST(request: Request): Promise<NextResponse<BotmakerResponse>> {
  let lockedContact = ""
  try {
    // ── 1. Validar secret ────────────────────────────────────────────────
    const secret = request.headers.get("x-secret") || ""
    const expected = getEnv("BOTMAKER_SECRET")
    if (expected && secret !== expected) {
      return NextResponse.json(
        { reply: "Unauthorized" },
        { status: 401 },
      )
    }

    // ── 2. Validar body ──────────────────────────────────────────────────
    const body = (await request.json()) as BotmakerRequest
    const contact = normalizeContact(body.contact || "")
    const message = (body.message || "").trim()

    if (!contact || !message) {
      return NextResponse.json(
        { reply: "Error: contact y message son requeridos." },
        { status: 400 },
      )
    }

    if (message.length > MAX_INPUT_CHARS || INJECT_RE.test(message)) {
      return NextResponse.json({
        reply: "El formato del mensaje no es válido.",
      })
    }

    // ── 3. Race condition guard ──────────────────────────────────────────
    if (processing.has(contact)) {
      console.log(`[v3-botmaker] Request concurrente descartado para ${contact}`)
      return NextResponse.json({ reply: "" })
    }
    processing.add(contact)
    lockedContact = contact

    // ── 4. Validar API key de Anthropic ──────────────────────────────────
    const apiKey = getEnv("ANTHROPIC_API_KEY")
    if (!apiKey) {
      console.error("[v3-botmaker] ANTHROPIC_API_KEY no configurada")
      return NextResponse.json({
        reply: "Servicio no disponible temporalmente. Intenta de nuevo en unos minutos.",
      })
    }

    // ── 5. Rehidratar historial ──────────────────────────────────────────
    const history: ConversationMessage[] = await fetchHistoryV3(contact, 40)

    // ── 6. Ejecutar agent-loop de V3 ─────────────────────────────────────
    const result = await runAgentLoop({
      systemPrompt: getSystemPromptV3(),
      history,
      userMessage: message,
      apiKey,
    })

    const reply = result.reply || "Gracias por escribir."
    const pdfUrl = extractPdfUrl(result.toolCalls as ToolCallRecord[] | undefined)
    const handoff = result.handoff || false

    // ── 7. Persistir el turno ────────────────────────────────────────────
    await appendTurnV3(contact, message, reply).catch((err) => {
      console.error("[v3-botmaker] Error persistiendo turno:", err)
    })

    // ── 8. Responder a Botmaker ──────────────────────────────────────────
    const response: BotmakerResponse = { reply }
    if (handoff) response.handoff = true
    if (pdfUrl) response.pdfUrl = pdfUrl

    console.log(
      `[v3-botmaker] OUT contact=${contact} iters=${result.iterations} tools=${result.toolCalls?.length || 0} pdf=${!!pdfUrl}`,
    )

    return NextResponse.json(response)
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err)
    console.error("[v3-botmaker] Error procesando request:", errMsg)
    return NextResponse.json({
      reply: "Tuve un problema técnico momentáneo. ¿Podrías repetir tu mensaje?",
    })
  } finally {
    if (lockedContact) processing.delete(lockedContact)
  }
}

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 204,
    headers: { Allow: "OPTIONS, POST" },
  })
}
