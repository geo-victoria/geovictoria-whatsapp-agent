/**
 * Webhook de la línea de WhatsApp de COLOMBIA (+57 318 107 0737).
 *
 * Ruta delgada por país: la acción de código de la línea CO apunta ACÁ; la
 * chilena sigue en /api/vic-botmaker-v3. Imposible cruzar países por config.
 *
 * HEREDA EL ESQUELETO ENDURECIDO DE CHILE (mismas piezas, misma razón):
 *   - ASÍNCRONO: responde {reply:""} de inmediato y procesa con after();
 *     el reply llega por push por el CANAL CO. (Chile aprendió que los turnos
 *     largos superaban el timeout del webhook → chat sin respuesta + retries
 *     duplicando procesamiento.)
 *   - BUFFER + DEDUP: cada mensaje se encola en vic_v3_inbox con hash único —
 *     un reintento de Botmaker no se procesa dos veces.
 *   - LOCK por contacto (vic_v3_processing_locks): solo UN procesador por
 *     contacto; una ráfaga de mensajes cortos se drena y procesa como UN
 *     turno combinado (nada de N respuestas paralelas pisándose).
 *   - Typing indicator del canal CO mientras procesa; saneadores compartidos.
 *
 * Modos:
 *   - VICKY_CO_ENABLED != "on": OBSERVACIÓN — registra y no responde.
 *   - body.simular === true: SÍNCRONO sin persistir ni lock — pruebas E2E.
 *
 * Auth: header x-secret == BOTMAKER_SECRET_CO.
 */

import { NextResponse, after } from "next/server"
import { runAgentLoop } from "@/lib/agent-loop"
import { PERFIL_CO } from "@/lib/paises/co"
import { SYSTEM_PROMPT_CO } from "@/lib/paises/co/prompt"
import { TOOL_SCHEMAS_CO, buildDispatchCO } from "@/lib/paises/co/tools"
import { fetchHistoryV3, appendTurnV3 } from "@/lib/supabase-persistence-v3"
import {
  hashMessage,
  acquireLock,
  releaseLock,
  bufferInboundMessage,
  drainInbox,
  inboxHasPending,
} from "@/lib/processing-lock-v3"
import { sendBotmakerMessage, sendTypingIndicator } from "@/lib/botmaker-push-v3"
import { sanitizarVoseo, normalizarFormatoWhatsApp, quitarSignosApertura } from "@/lib/voseo-v3"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const SECRET_CO = (process.env.BOTMAKER_SECRET_CO || "").trim()
const ENABLED = (process.env.VICKY_CO_ENABLED || "off").trim().toLowerCase() === "on"
const CANAL_CO = () => PERFIL_CO.canal.channelId

const BURST_DEBOUNCE_MS = Number(process.env.BURST_DEBOUNCE_MS || 1500)
const MAX_BURST_TURNS = 10
const MAX_INPUT_CHARS = 4000

const PIDE_TEXTO_CO =
  "Le pido disculpas: por ahora no puedo escuchar notas de voz. ¿Me lo puede escribir por texto, por favor?"
const ERROR_GENERICO_CO =
  "Disculpe, tuve un inconveniente para procesar su mensaje. ¿Me lo puede repetir, por favor?"

type BotmakerBody = {
  contact?: string
  message?: string
  audioUrl?: string
  audioURL?: string
  simular?: boolean
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function processOneTurnCO(contact: string, message: string, apiKey: string): Promise<void> {
  const history = await fetchHistoryV3(contact)
  const result = await runAgentLoop({
    systemPrompt: SYSTEM_PROMPT_CO,
    history,
    userMessage: message,
    apiKey,
    contact,
    tools: {
      schemas: TOOL_SCHEMAS_CO as unknown as unknown[],
      dispatch: buildDispatchCO(contact),
    },
  })
  let reply = quitarSignosApertura(normalizarFormatoWhatsApp(sanitizarVoseo(result.reply || "")))
  if (!reply.trim()) reply = ERROR_GENERICO_CO

  await appendTurnV3(contact, message, reply, "co").catch((e) =>
    console.error(`[vic-co] error persistiendo turno contact=${contact}:`, e),
  )
  const sent = await sendBotmakerMessage(contact, reply, CANAL_CO())
  console.log(
    `[vic-co] turno contact=${contact} iter=${result.iterations} tools=${result.toolCalls.map((t) => t.name).join(",") || "-"} sent=${sent}`,
  )
}

// Espejo de processBurst chileno (misma semántica de lock/carrera/tope).
async function processBurstCO(contact: string, apiKey: string, seedMessage?: string): Promise<void> {
  let holdsLock = true
  let turns = 0
  let seed = seedMessage
  try {
    for (;;) {
      await sleep(BURST_DEBOUNCE_MS)
      let pending = await drainInbox(contact)
      if (pending.length === 0 && seed) {
        pending = [{ message: seed, created_at: new Date().toISOString() }]
      }
      seed = undefined

      if (pending.length === 0) {
        await releaseLock(contact).catch(() => {})
        holdsLock = false
        if (!(await inboxHasPending(contact))) return
        const re = await acquireLock(contact, "burst-recheck")
        if (!re.acquired) return
        holdsLock = true
        continue
      }

      const combinado = pending.map((p) => p.message).join("\n").slice(0, MAX_INPUT_CHARS)
      try {
        await processOneTurnCO(contact, combinado, apiKey)
      } catch (err) {
        console.error(`[vic-co] error en turno contact=${contact}:`, err)
        await sendBotmakerMessage(contact, ERROR_GENERICO_CO, CANAL_CO()).catch(() => {})
      }

      if (++turns >= MAX_BURST_TURNS) {
        console.warn(`[vic-co] tope de turnos de ráfaga alcanzado contact=${contact}`)
        return
      }
    }
  } finally {
    sendTypingIndicator(contact, false, CANAL_CO()).catch(() => {})
    if (holdsLock) await releaseLock(contact).catch(() => {})
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const secret = request.headers.get("x-secret") || ""
    if (!SECRET_CO) {
      return NextResponse.json({ ok: false, error: "BOTMAKER_SECRET_CO no configurado" }, { status: 503 })
    }
    if (secret !== SECRET_CO) {
      return NextResponse.json({ reply: "Unauthorized" }, { status: 401 })
    }

    const body = (await request.json().catch(() => ({}))) as BotmakerBody
    const contact = (body.contact || "").replace(/\D/g, "")
    const message = (body.message || "").trim()
    const audioUrl = (body.audioUrl || body.audioURL || "").trim()
    const simulacion = body.simular === true

    if (!ENABLED && !simulacion) {
      console.log(
        `[vic-co][observacion] contact=${contact} msgLen=${message.length} audio=${audioUrl ? "sí" : "no"} texto="${message.slice(0, 120)}"`,
      )
      return NextResponse.json({ ok: true, modo: "observacion", pais: "co" })
    }

    if (!contact) return NextResponse.json({ ok: false, error: "contact requerido" }, { status: 400 })

    const apiKey = (process.env.ANTHROPIC_API_KEY || "").trim()
    if (!apiKey) {
      return NextResponse.json({ ok: false, error: "ANTHROPIC_API_KEY no configurada" }, { status: 503 })
    }

    // v1 sin transcripción: notas de voz piden texto (respuesta directa vía acción).
    if (!message || message === "__audio__") {
      if (audioUrl) return NextResponse.json({ reply: PIDE_TEXTO_CO, pais: "co" })
      return NextResponse.json({ ok: false, error: "message requerido" }, { status: 400 })
    }

    // Modo simulación (pruebas E2E): síncrono, sin lock, sin persistir.
    if (simulacion) {
      const result = await runAgentLoop({
        systemPrompt: SYSTEM_PROMPT_CO,
        history: [],
        userMessage: message,
        apiKey,
        contact,
        tools: { schemas: TOOL_SCHEMAS_CO as unknown as unknown[], dispatch: buildDispatchCO(contact) },
      })
      const reply = quitarSignosApertura(normalizarFormatoWhatsApp(sanitizarVoseo(result.reply || "")))
      return NextResponse.json({ reply, handoff: result.handoff, pais: "co", simulacion: true })
    }

    // ── Pipeline endurecido (herencia chilena) ──
    const msgHash = hashMessage(contact, message)
    await bufferInboundMessage(contact, message, msgHash)

    const lockResult = await acquireLock(contact, msgHash)
    if (!lockResult.acquired) {
      console.log(`[vic-co] ${contact}: mensaje encolado, ya hay un procesador activo`)
      return NextResponse.json({ reply: "" })
    }

    sendTypingIndicator(contact, true, CANAL_CO()).catch(() => {})
    console.log(`[vic-co] IN contact=${contact} msg=${JSON.stringify(message.slice(0, 60))}`)
    after(processBurstCO(contact, apiKey, message))

    return NextResponse.json({ reply: "" })
  } catch (err) {
    console.error("[vic-co] error en webhook:", err)
    return NextResponse.json({ reply: ERROR_GENERICO_CO, pais: "co" }, { status: 200 })
  }
}
