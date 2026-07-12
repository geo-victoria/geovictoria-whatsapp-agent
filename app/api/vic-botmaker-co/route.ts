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
import { getSystemPromptCO } from "@/lib/paises/co/prompt"
import { TOOL_SCHEMAS_CO, buildDispatchCO } from "@/lib/paises/co/tools"
import {
  fetchHistoryV3,
  appendTurnV3,
  markUserActivity,
  armFollowup,
  closeFollowup,
  scheduleConsensualFollowup,
} from "@/lib/supabase-persistence-v3"
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
import { transcribirAudio } from "@/lib/transcribe-audio"

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
// Despedida limpia si el modelo registró un opt-out y el turno quedó sin texto
// (herencia del guardrail 2.6d chileno — caso real de Rodrigo en CL).
const OPTOUT_GOODBYE_CO =
  "Entendido, no lo contactaremos más. Si en el futuro lo necesita, aquí estaré. ¡Que le vaya muy bien! 🙌"
// Fallback que emite lib/agent-loop.ts cuando el turno termina SIN texto final.
// Está TUTEADO (herencia chilena): en CO hay que detectarlo y reemplazarlo por
// el genérico en usted (visto en simulación: un opt-out sin texto final lo
// habría enviado tal cual). Copia literal — mantener en sync con agent-loop.
const AGENT_LOOP_EMPTY_FALLBACK =
  "Disculpa, tuve un problema procesando tu mensaje. ¿Puedes repetirlo o decirme con qué te puedo ayudar?"

// ── Re-engagement CO (mismo modelo de estados que Chile) ────────────────────
// La cadencia se arma SOLO en conversaciones COMERCIALES; soporte/FAQ no
// reciben nudges; despedidas naturales tampoco.
const FOLLOWUP_SUPPORT_TOOLS_CO = new Set(["consultar_agente_soporte"])
// Cierran el ciclo: la conversación quedó en manos humanas (derivación o
// reunión agendada con un ejecutivo).
const FOLLOWUP_CLOSING_TOOLS_CO = new Set(["derivar_a_ejecutivo", "agendar_reunion"])
const FOLLOWUP_COMMERCIAL_TOOLS_CO = new Set([
  "cotizar_referencial",
  "generar_link_cotizadora",
])
const FAREWELL_RE_CO =
  /\b(gracias|chao|chau|nos vemos|hasta luego|adi[oó]s|que est[eé] bien|feliz d[ií]a)\b/iu

type ToolCallRecordCO = { name: string; ok: boolean; output?: unknown }

// ── Ruteo de modelo por turno (paridad con Chile, decisión de costos 11-jul) ──
// Sonnet SOLO en el flujo de cotización (precios/configuración/cotización
// formal), donde la calidad es crítica; Haiku para el resto (saludos, FAQ,
// soporte) — 3× más barato en el mismo pipeline que Chile ya validó.
const MODELO_COTIZACION_CO = (
  process.env.ANTHROPIC_SALES_AGENT_MODEL_V3 || "claude-sonnet-4-5-20250929"
).trim()
const MODELO_SIMPLE_CO = (
  process.env.ANTHROPIC_SALES_AGENT_MODEL_SIMPLE || "claude-haiku-4-5-20251001"
).trim()

// El mensaje entrante pinta cotización/precio (marcadores CO: COP, NIT,
// mensualidad; sin UF ni chilenismos).
const COTIZ_MSG_RE_CO =
  /cotiz|precio|cu[aá]nto|cuesta|\bvale\b|\bvalor\b|\bcaro\b|barat|descuento|rebaj|presupuesto|plan|oferta|pago inicial|mensualidad|reloj|\bNIT\b|\d+\s*(trabajador|persona|emplead|colaborador|usuario)|somos\s+\d+/i
// La ÚLTIMA respuesta de Vicky ya estaba cotizando (sigue el flujo aunque el
// cliente solo conteste "sí"/"listo"/un dato suelto como el correo o el NIT).
const COTIZ_HIST_RE_CO =
  /cotiz|\/mes|pago inicial|mensualidad|activaci[oó]n|instalaci[oó]n|\bplan\b|\bpunto|marca|reloj|\bNIT\b|correo|cu[aá]nt[ao]s?\s+person|trabajador|usuario/i

function esFlujoCotizacionCO(
  message: string,
  history: Array<{ role: string; content: string }>,
): boolean {
  if (COTIZ_MSG_RE_CO.test(message)) return true
  const lastAssistant =
    [...history].reverse().find((m) => m.role === "assistant")?.content || ""
  return COTIZ_HIST_RE_CO.test(lastAssistant)
}

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
  const modelo = esFlujoCotizacionCO(message, history)
    ? MODELO_COTIZACION_CO
    : MODELO_SIMPLE_CO
  console.log(
    `[vic-co-modelo] contact=${contact} modelo=${modelo} flujoCotizacion=${modelo === MODELO_COTIZACION_CO}`,
  )
  const result = await runAgentLoop({
    systemPrompt: getSystemPromptCO(),
    history,
    userMessage: message,
    apiKey,
    contact,
    model: modelo,
    tools: {
      schemas: TOOL_SCHEMAS_CO as unknown as unknown[],
      dispatch: buildDispatchCO(contact),
    },
  })
  // El fallback del agent-loop viene tuteado (Chile): en CO se trata como
  // "turno sin texto". OJO: comparar ANTES de sanear — quitarSignosApertura
  // le quita el '¿' y la igualdad ya no calzaría.
  const rawReply = (result.reply || "").trim() === AGENT_LOOP_EMPTY_FALLBACK ? "" : result.reply || ""
  let reply = quitarSignosApertura(normalizarFormatoWhatsApp(sanitizarVoseo(rawReply)))

  const toolCalls = (result.toolCalls || []) as ToolCallRecordCO[]
  // Opt-out con turno sin texto → despedida limpia, no un mensaje de error.
  const callNoContactar = toolCalls.find((c) => c.name === "marcar_no_contactar" && c.ok)
  if (callNoContactar && (!reply.trim() || reply === ERROR_GENERICO_CO)) {
    reply = OPTOUT_GOODBYE_CO
  }
  if (!reply.trim()) reply = ERROR_GENERICO_CO

  await appendTurnV3(contact, message, reply, "co").catch((e) =>
    console.error(`[vic-co] error persistiendo turno contact=${contact}:`, e),
  )

  // Estado del ciclo de re-engagement según cómo terminó el turno (espejo del
  // bloque 5 chileno, con el set de tools CO). Best-effort.
  try {
    const tipoNoContactar =
      (callNoContactar?.output as { tipo?: string } | undefined)?.tipo === "perdido"
        ? "perdido"
        : "opt_out"
    const segConsensuado = toolCalls.find((c) => c.name === "programar_seguimiento" && c.ok)
    const usoCierre = toolCalls.some((c) => FOLLOWUP_CLOSING_TOOLS_CO.has(c.name) && c.ok)
    const esSoporte = toolCalls.some((c) => FOLLOWUP_SUPPORT_TOOLS_CO.has(c.name) && c.ok)
    const esDespedida = message.trim().length <= 30 && FAREWELL_RE_CO.test(message)
    const comercialEsteTurno = toolCalls.some(
      (c) => FOLLOWUP_COMMERCIAL_TOOLS_CO.has(c.name) && c.ok,
    )
    // Conversación ya comercial: hubo un estimado/cotización antes (marcadores
    // del mensaje canónico CO: "/mes", "pago inicial", "cotización").
    const yaHuboEstimacion = history.some(
      (m) => m.role === "assistant" && /\/mes|pago inicial|cotizaci[oó]n/i.test(m.content || ""),
    )
    const esComercial = comercialEsteTurno || yaHuboEstimacion
    if (callNoContactar) {
      await closeFollowup(contact, tipoNoContactar, "co")
      console.log(`[vic-co][followup] ${tipoNoContactar} (tool) → ciclo cerrado contact=${contact}`)
    } else if (segConsensuado) {
      const cuandoIso = (segConsensuado.output as { cuandoIso?: string } | undefined)?.cuandoIso
      if (cuandoIso) {
        await scheduleConsensualFollowup(contact, cuandoIso, "co")
        console.log(`[vic-co][followup] consensuado contact=${contact} cuando=${cuandoIso}`)
      } else {
        await armFollowup(contact, "co")
      }
    } else if (usoCierre) {
      await closeFollowup(contact, "derivado", "co")
    } else if (esSoporte) {
      // Pidió soporte → cero seguimiento/proactividad aunque la conversación
      // sea comercial (decisión de costos 11-jul, igual que Chile).
      await closeFollowup(contact, "soporte", "co")
    } else if (reply && !esDespedida && esComercial) {
      await armFollowup(contact, "co")
    }
    // else: conversación no comercial → sin nudges.
  } catch (err) {
    console.error(`[vic-co][followup] error actualizando seguimiento contact=${contact}:`, err)
  }
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
    let message = (body.message || "").trim()
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

    // Nota de voz: misma herencia chilena — transcribir y seguir como texto.
    // Si la transcripción falla (o no hay ELEVENLABS_API_KEY), pedir texto en
    // usted; NUNCA procesar el placeholder "__audio__" como mensaje real.
    if (audioUrl && (!message || message === "__audio__")) {
      sendTypingIndicator(contact, true, CANAL_CO()).catch(() => {})
      const transcript = await transcribirAudio(audioUrl)
      if (transcript) {
        message = transcript
        console.log(`[vic-co] audio transcrito contact=${contact} len=${transcript.length}`)
      } else {
        return NextResponse.json({ reply: PIDE_TEXTO_CO, pais: "co" })
      }
    }
    if (!message || message === "__audio__") {
      return NextResponse.json({ ok: false, error: "message requerido" }, { status: 400 })
    }

    // Modo simulación (pruebas E2E): síncrono, sin lock, sin persistir.
    if (simulacion) {
      // Mismo ruteo de modelo que el camino real (sin historia persistida).
      const modeloSim = esFlujoCotizacionCO(message, [])
        ? MODELO_COTIZACION_CO
        : MODELO_SIMPLE_CO
      const result = await runAgentLoop({
        systemPrompt: getSystemPromptCO(),
        history: [],
        userMessage: message,
        apiKey,
        contact,
        model: modeloSim,
        tools: { schemas: TOOL_SCHEMAS_CO as unknown as unknown[], dispatch: buildDispatchCO(contact) },
      })
      // Mismos guardrails de texto final del camino real (fallback tuteado del
      // loop → usted; opt-out sin texto → despedida) para que la simulación
      // refleje lo que vería el cliente. La comparación va ANTES de sanear.
      const simRaw =
        (result.reply || "").trim() === AGENT_LOOP_EMPTY_FALLBACK ? "" : result.reply || ""
      let reply = quitarSignosApertura(normalizarFormatoWhatsApp(sanitizarVoseo(simRaw)))
      const simToolCalls = (result.toolCalls || []) as ToolCallRecordCO[]
      if (
        simToolCalls.some((c) => c.name === "marcar_no_contactar" && c.ok) &&
        (!reply.trim() || reply === ERROR_GENERICO_CO)
      ) {
        reply = OPTOUT_GOODBYE_CO
      }
      if (!reply.trim()) reply = ERROR_GENERICO_CO
      return NextResponse.json({
        reply,
        handoff: result.handoff,
        pais: "co",
        simulacion: true,
        modelo: modeloSim,
      })
    }

    // ── Pipeline endurecido (herencia chilena) ──
    // Re-engagement: el cliente habló → pausar la cadencia en curso (si la había).
    await markUserActivity(contact, "co").catch(() => {})

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
