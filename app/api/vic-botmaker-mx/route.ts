/**
 * Webhook de la línea de WhatsApp de MÉXICO (+52 1 56 5977 8486).
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
 *   - VICKY_MX_ENABLED != "on": OBSERVACIÓN — registra y no responde.
 *   - body.simular === true: SÍNCRONO sin persistir ni lock — pruebas E2E.
 *
 * Auth: header x-secret == BOTMAKER_SECRET_MX.
 */

import { NextResponse, after } from "next/server"
import { runAgentLoop } from "@/lib/agent-loop"
import { detectarProcesoHumano, directivaProcesoHumano } from "@/lib/proceso-humano"
import { PERFIL_MX } from "@/lib/paises/mx"
import { getSystemPromptMX, formatCotizacionExistenteMX } from "@/lib/paises/mx/prompt"
import { TOOL_SCHEMAS_MX, buildDispatchMX } from "@/lib/paises/mx/tools"
import {
  fetchHistoryV3,
  appendTurnV3,
  markUserActivity,
  armFollowup,
  closeFollowup,
  scheduleConsensualFollowup,
  getQuotePointer,
  setKvValue,
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
import { avisarEquipoInterno } from "@/lib/alerta-interna"
import { sanitizarVoseo, normalizarFormatoWhatsApp, quitarSignosApertura } from "@/lib/voseo-v3"
import { transcribirAudio } from "@/lib/transcribe-audio"
import { describirImagen } from "@/lib/describe-image"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const SECRET_CO = (process.env.BOTMAKER_SECRET_MX || "").trim()
const ENABLED = (process.env.VICKY_MX_ENABLED || "off").trim().toLowerCase() === "on"
const CANAL_CO = () => PERFIL_MX.canal.channelId

const BURST_DEBOUNCE_MS = Number(process.env.BURST_DEBOUNCE_MS || 1500)
const MAX_BURST_TURNS = 10
const MAX_INPUT_CHARS = 4000

// Guardrail anti prompt-injection (espejo del chileno): mensajes que intentan
// extraer el prompt o inyectar instrucciones no se procesan con el agente.
const INJECT_RE =
  /###|IGNORE|DUMP|INSTRUC|SYSTEM PROMPT|\bPROMPT\b|\\u202|<script|DROP\s+TABLE|DELETE\s+FROM|UNION\s+SELECT/i

const PIDE_TEXTO_CO =
  "Uy, disculpa — por ahora no puedo escuchar notas de voz 🙏 Me lo escribes por texto porfa?"
const PIDE_TEXTO_IMAGEN_CO =
  "Uy, no pude ver bien la imagen 🙈 Me lo cuentas por texto porfa?"
const ERROR_GENERICO_CO =
  "Disculpa, tuve un inconveniente para procesar tu mensaje. Me lo repites porfa? 🙏"
// Despedida limpia si el modelo registró un opt-out y el turno quedó sin texto
// (herencia del guardrail 2.6d chileno — caso real de Rodrigo en CL).
const OPTOUT_GOODBYE_CO =
  "Entendido, no te contactaremos más. Si en el futuro lo necesitas, aquí estaré. Que te vaya muy bien!! 🙌"
// Circuit-breaker (espejo del chileno): tras 2 errores seguidos en la misma
// conversación, se escala a humano UNA vez y luego se silencia (en CL este
// loop llegó a 60 mensajes idénticos en producción).
const ESCALADA_ERROR_CO =
  "Disculpa, sigo teniendo un problema técnico. Ya le avisé a un ejecutivo para que se comunique contigo a la brevedad 🙏"
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
  // Imagen/foto: URL del archivo que entrega Botmaker (la acción de código
  // debe reenviarla, igual que audioURL).
  imageUrl?: string
  imageURL?: string
  mediaUrl?: string
  mediaURL?: string
  simular?: boolean
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Guarda el último payload no procesable en vic_kv para diagnóstico (qué
 * variables manda realmente la acción de Botmaker en audios/fotos/adjuntos). */
async function capturarPayloadDebug(body: unknown): Promise<void> {
  try {
    await setKvValue(
      "debug_last_co_payload",
      JSON.stringify({ at: new Date().toISOString(), body }).slice(0, 4000),
    )
  } catch {
    // best-effort
  }
}

async function processOneTurnCO(contact: string, message: string, apiKey: string): Promise<void> {
  const history = await fetchHistoryV3(contact)
  // PROCESO ÚNICO (espejo CL, 20-jul): conversación nueva con ejecutivo ya
  // trabajando al contacto → candado comercial + directiva.
  if (history.length === 0) {
    const proceso = await detectarProcesoHumano(contact, "mx").catch(() => null)
    if (proceso) history.push({ role: "assistant", content: directivaProcesoHumano(proceso) })
  }
  // Anti-amnesia (espejo CL): si ya existe una cotización formal, se inyecta
  // su estado al prompt (no re-pedir datos, no regenerar, reenviar el link).
  const quotePointer = await getQuotePointer(contact).catch(() => null)
  const contextoCotizacion = formatCotizacionExistenteMX(quotePointer || undefined)
  // Con formal vigente el turno ES de cotización aunque el mensaje no lo diga.
  const modelo =
    quotePointer || esFlujoCotizacionCO(message, history)
      ? MODELO_COTIZACION_CO
      : MODELO_SIMPLE_CO
  console.log(
    `[vic-co-modelo] contact=${contact} modelo=${modelo} flujoCotizacion=${modelo === MODELO_COTIZACION_CO} formal=${!!quotePointer}`,
  )
  const systemPromptCO = contextoCotizacion + getSystemPromptMX(contact)
  const dispatchCO = buildDispatchMX(contact)
  const result = await runAgentLoop({
    systemPrompt: systemPromptCO,
    history,
    userMessage: message,
    apiKey,
    contact,
    model: modelo,
    tools: {
      schemas: TOOL_SCHEMAS_MX as unknown as unknown[],
      dispatch: dispatchCO,
    },
  })
  // El fallback del agent-loop viene tuteado (Chile): en CO se trata como
  // "turno sin texto". OJO: comparar ANTES de sanear — quitarSignosApertura
  // le quita el '¿' y la igualdad ya no calzaría.
  const rawReply = (result.reply || "").trim() === AGENT_LOOP_EMPTY_FALLBACK ? "" : result.reply || ""
  let reply = quitarSignosApertura(normalizarFormatoWhatsApp(sanitizarVoseo(rawReply)))

  // Guardrail anti-link ALUCINADO de documentos (espejo del 2.4b chileno,
  // caso Cynthia 21-jul): Vicky no tiene documentos en Drive/Dropbox — todo
  // link a esos dominios es fabricado. En CO no existe la certificación DT,
  // así que siempre se elimina el link.
  const LINK_FABRICADO_MX =
    /https?:\/\/(?:drive|docs)\.google\.com\/\S+|https?:\/\/(?:www\.)?(?:dropbox|wetransfer|mega)\.[a-z]+\/\S+/gi
  if (LINK_FABRICADO_MX.test(reply)) {
    console.error(`[vic-mx] LINK_FABRICADO contact=${contact} reply=${JSON.stringify(reply.slice(0, 300))}`)
    reply = reply.replace(LINK_FABRICADO_MX, "(te lo hago llegar enseguida)").trim()
  }

  let toolCalls = (result.toolCalls || []) as ToolCallRecordCO[]

  // ── Guardrails anti-alucinación (espejo de 2.6b/2.6c chilenos) ──
  // Si el reply AFIRMA que una reunión quedó agendada o que el equipo lo va a
  // contactar, pero NINGUNA tool lo respalda este turno, se re-corre el loop
  // forzando la tool; si tampoco se concreta, NO se confirma en falso.
  const afirmaReunionLista =
    /\breuni[oó]n\b[^.]{0,40}\b(qued[oó]|est[aá]|fue)\b[^.]{0,18}\b(agendad|reagendad|confirmad|coordinad)/i.test(reply) ||
    /\b(agend[eé]|reagend[eé])\b[^.]{0,25}\breuni[oó]n\b/i.test(reply) ||
    /\bse\s+l[ao]\s+(agend[eé]|reagend[eé])\b/i.test(reply)
  const afirmaContactoListo =
    /\b(un\s+ejecutiv[oa]|el\s+equipo|nuestro\s+equipo|un\s+asesor|Yahel)\b[^.]{0,50}\b(l[oe]\s+(contactar[aá]|llamar[aá]|va\s+a\s+(contactar|llamar))|se\s+(pondr[aá]|comunicar[aá]|contactar[aá]))/i.test(reply)
  const realAgenda = toolCalls.some(
    (c) => (c.name === "agendar_reunion" || c.name === "reagendar_reunion") && c.ok,
  )
  const realContacto = toolCalls.some(
    (c) => (c.name === "derivar_a_ejecutivo" || c.name === "agendar_reunion") && c.ok,
  )
  const alucinacion =
    (afirmaReunionLista && !realAgenda) || (!afirmaReunionLista && afirmaContactoListo && !realContacto)
  if (alucinacion) {
    const FORZAR_TOOL =
      "\n\n# Instrucción de sistema (este turno)\n" +
      "Estás por confirmarle al cliente una reunión agendada o que el equipo lo contactará, pero NO puedes afirmarlo sin EJECUTAR la tool correspondiente. " +
      "Si confirmó un horario de reunión, llama agendar_reunion (o reagendar_reunion si ya tenía una). " +
      "Si pidió que lo contacten, llama derivar_a_ejecutivo con los datos que ya entregó. " +
      "SOLO después de que la tool devuelva ok confirma, usando su mensajeParaProspecto. " +
      "Si faltan datos obligatorios, PÍDELOS en vez de afirmar que ya quedó listo."
    const retry = await runAgentLoop({
      systemPrompt: systemPromptCO + FORZAR_TOOL,
      history,
      userMessage: message,
      apiKey,
      contact,
      model: MODELO_COTIZACION_CO,
      tools: { schemas: TOOL_SCHEMAS_MX as unknown as unknown[], dispatch: dispatchCO },
    }).catch(() => null)
    const retryCalls = ((retry?.toolCalls || []) as ToolCallRecordCO[])
    const retryOk = retryCalls.some(
      (c) =>
        (c.name === "agendar_reunion" || c.name === "reagendar_reunion" || c.name === "derivar_a_ejecutivo") &&
        c.ok,
    )
    const retryReply = (retry?.reply || "").trim()
    if (retryOk && retryReply && retryReply !== AGENT_LOOP_EMPTY_FALLBACK) {
      console.warn(`[vic-mx] ALUCINACION_RECUPERADA contact=${contact}: el reintento forzó la tool.`)
      reply = quitarSignosApertura(normalizarFormatoWhatsApp(sanitizarVoseo(retryReply)))
      toolCalls = retryCalls
    } else {
      console.error(
        `[vic-mx] ALUCINACION_SIN_TOOL contact=${contact} replyOriginal=${JSON.stringify(reply.slice(0, 300))}`,
      )
      // Auditoría 20-jul: el fallo técnico NO se le cobra al cliente
      // re-pidiéndole datos que ya están en el historial — se avisa al
      // equipo para completar el registro a mano.
      reply = afirmaReunionLista
        ? "Disculpa, tuve un problema técnico y tu reunión quedó pendiente de registro — ya avisé al equipo para dejarla agendada con lo que me indicaste. Te confirmo apenas esté lista, no necesitas reenviarme nada 🙌"
        : "Disculpa, tuve un problema técnico registrando tu solicitud — ya avisé al equipo para que igual te contacten con los datos que me diste. No necesitas reenviarme nada 🙌"
      await avisarEquipoInterno(
        `⚠️ Registro de ${afirmaReunionLista ? "REUNIÓN" : "CALLBACK"} falló (tras reintento, línea CO) — contacto +${contact}. El cliente quedó con la promesa de contacto: revisar la conversación en Botmaker y completar a mano.`,
      )
    }
  }
  // Telemetría de diagnóstico: si el turno tocó tools de agenda, dejar el
  // detalle exacto (input/output de cada tool) legible desde Supabase
  // (vic_kv.debug_last_mx_tools) — los runtime logs de Vercel no siempre son
  // accesibles y estos flujos han tenido éxitos falsos difíciles de rastrear.
  if (toolCalls.some((c) => /reunion|disponibilidad/.test(c.name))) {
    setKvValue(
      "debug_last_mx_tools",
      JSON.stringify({
        at: new Date().toISOString(),
        contact,
        reply: reply.slice(0, 200),
        tools: toolCalls.map((c) => ({
          name: c.name,
          ok: c.ok,
          input: (c as unknown as { input?: unknown }).input,
          output: c.output,
        })),
      }).slice(0, 8000),
    ).catch(() => {})
  }

  // Opt-out con turno sin texto → despedida limpia, no un mensaje de error.
  const callNoContactar = toolCalls.find((c) => c.name === "marcar_no_contactar" && c.ok)
  if (callNoContactar && (!reply.trim() || reply === ERROR_GENERICO_CO)) {
    reply = OPTOUT_GOODBYE_CO
  }
  if (!reply.trim()) reply = ERROR_GENERICO_CO

  await appendTurnV3(contact, message, reply, "mx").catch((e) =>
    console.error(`[vic-mx] error persistiendo turno contact=${contact}:`, e),
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
    // Espejo del chileno (caso Rodrigo 17-jul): rechazo explícito → no re-armar.
    const esRechazo =
      message.trim().length <= 60 &&
      /\b(no\s+gracias|no\s+(me|nos)\s+interesa|no\s+estoy\s+interesad\w+|ya\s+no\s+(lo\s+)?quiero|no\s+lo\s+quiero|no\s+quiero\s+(nada|seguir|avanzar)|no\s+necesito\s+(nada|informaci[oó]\w*|cotiz\w+|el\s+servicio)|no\s+insist\w+|dej\w+\s+de\s+(escribir\w*|hablar\w*|insistir\w*)|no\s+me\s+escrib\w+)\b/i.test(
        message,
      )
    const comercialEsteTurno = toolCalls.some(
      (c) => FOLLOWUP_COMMERCIAL_TOOLS_CO.has(c.name) && c.ok,
    )
    // Conversación ya comercial: hubo un estimado/cotización antes (marcadores
    // del mensaje canónico CO: "/mes", "pago inicial", "cotización").
    const yaHuboEstimacion = history.some(
      (m) => m.role === "assistant" && /\/mes|pago inicial|cotizaci[oó]n/i.test(m.content || ""),
    )
    // Captura de lead EN CURSO (feedback CO 15-jul, caso María Fernanda):
    // Vicky está pidiendo datos para derivar a ejecutivo (ej. >50 personas) y
    // el cliente se queda en visto. Eso ES comercial — un lead enterprise sin
    // seguimiento es la peor fuga. Marcador: Vicky pidió nombre/empresa/correo
    // o mencionó al equipo comercial/ejecutivo en sus últimos mensajes.
    const capturaLeadEnCurso = history.slice(-6).some(
      (m) =>
        m.role === "assistant" &&
        /(correo|nombre de tu empresa|me confirmas tu nombre|equipo comercial|ejecutivo te contactar|consultor)/i.test(
          m.content || "",
        ),
    )
    const esComercial =
      comercialEsteTurno || yaHuboEstimacion || !!quotePointer || capturaLeadEnCurso
    if (callNoContactar) {
      await closeFollowup(contact, tipoNoContactar, "mx")
      console.log(`[vic-mx][followup] ${tipoNoContactar} (tool) → ciclo cerrado contact=${contact}`)
    } else if (segConsensuado) {
      const cuandoIso = (segConsensuado.output as { cuandoIso?: string } | undefined)?.cuandoIso
      if (cuandoIso) {
        await scheduleConsensualFollowup(contact, cuandoIso, "mx")
        console.log(`[vic-mx][followup] consensuado contact=${contact} cuando=${cuandoIso}`)
      } else {
        await armFollowup(contact, "mx")
      }
    } else if (usoCierre) {
      await closeFollowup(contact, "derivado", "mx")
    } else if (esSoporte) {
      // Pidió soporte → cero seguimiento/proactividad aunque la conversación
      // sea comercial (decisión de costos 11-jul, igual que Chile).
      await closeFollowup(contact, "soporte", "mx")
    } else if (reply && (!esDespedida || !!quotePointer) && esComercial) {
      // Espejo del chileno (caso Constanza 17-jul): con cotización FORMAL
      // vigente, la despedida corta ("muchas gracias") no frena la cadencia —
      // es recibo cortés, no cierre.
      await armFollowup(contact, "mx")
    }
    // else: conversación no comercial → sin nudges.
  } catch (err) {
    console.error(`[vic-mx][followup] error actualizando seguimiento contact=${contact}:`, err)
  }
  const sent = await sendBotmakerMessage(contact, reply, CANAL_CO())
  console.log(
    `[vic-mx] turno contact=${contact} iter=${result.iterations} tools=${result.toolCalls.map((t) => t.name).join(",") || "-"} sent=${sent}`,
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
        console.error(`[vic-mx] error en turno contact=${contact}:`, err)
        // Circuit-breaker (espejo CL): si los últimos turnos ya fueron errores,
        // no repetir el fallback en loop — escalar UNA vez y luego silenciar.
        // El mensaje de error SE PERSISTE para que el contador avance.
        try {
          const recientes = await fetchHistoryV3(contact, 6).catch(() => [])
          const esError = (t?: string) => t === ERROR_GENERICO_CO || t === ESCALADA_ERROR_CO
          const ultimos = recientes
            .filter((m) => m.role === "assistant")
            .slice(-2)
            .map((m) => m.content?.trim())
          const dosErroresSeguidos = ultimos.length >= 2 && ultimos.every(esError)
          if (dosErroresSeguidos && ultimos[ultimos.length - 1] === ESCALADA_ERROR_CO) {
            console.error(`[vic-mx] CIRCUIT_BREAKER contact=${contact}: errores en loop, silenciando (ya se escaló).`)
          } else {
            const errReply = dosErroresSeguidos ? ESCALADA_ERROR_CO : ERROR_GENERICO_CO
            await appendTurnV3(contact, combinado, errReply, "mx").catch(() => {})
            await sendBotmakerMessage(contact, errReply, CANAL_CO()).catch(() => {})
          }
        } catch {
          await sendBotmakerMessage(contact, ERROR_GENERICO_CO, CANAL_CO()).catch(() => {})
        }
      }

      if (++turns >= MAX_BURST_TURNS) {
        console.warn(`[vic-mx] tope de turnos de ráfaga alcanzado contact=${contact}`)
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
      return NextResponse.json({ ok: false, error: "BOTMAKER_SECRET_MX no configurado" }, { status: 503 })
    }
    if (secret !== SECRET_CO) {
      return NextResponse.json({ reply: "Unauthorized" }, { status: 401 })
    }

    const body = (await request.json().catch(() => ({}))) as BotmakerBody
    const contact = (body.contact || "").replace(/\D/g, "")
    let message = (body.message || "").trim()
    const audioUrl = (body.audioUrl || body.audioURL || "").trim()
    const simulacion = body.simular === true

    // Canal de ORIGEN (espejo del webhook CL): si la acción de código CO manda
    // channelId, se persiste — los pushes salen por la línea donde el cliente
    // escribió, aunque el prefijo del número sea de otro país.
    const canalBody = ((body as { channelId?: string }).channelId || "").trim()
    if (contact && canalBody) {
      setKvValue(`canal_origen_${contact}`, canalBody).catch(() => {})
    }

    if (!ENABLED && !simulacion) {
      console.log(
        `[vic-mx][observacion] contact=${contact} msgLen=${message.length} audio=${audioUrl ? "sí" : "no"} texto="${message.slice(0, 120)}"`,
      )
      return NextResponse.json({ ok: true, modo: "observacion", pais: "mx" })
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
        console.log(`[vic-mx] audio transcrito contact=${contact} len=${transcript.length}`)
      } else {
        // Push + reply VACÍO: si además devolviéramos el texto en el JSON, la
        // acción de Botmaker podría entregarlo de nuevo (mensaje duplicado).
        if (!simulacion) await sendBotmakerMessage(contact, PIDE_TEXTO_CO, CANAL_CO()).catch(() => {})
        return NextResponse.json({ reply: simulacion ? PIDE_TEXTO_CO : "", pais: "mx" })
      }
    }

    // Foto/imagen (paridad CL): se "lee" con visión y el texto sigue el flujo
    // normal. Con caption, se conservan ambos. Placeholder sin URL → pedir texto.
    const imageUrl = (body.imageUrl || body.imageURL || body.mediaUrl || body.mediaURL || "").trim()
    const IMG_PLACEHOLDERS = ["__image__", "__media__", "__photo__"]
    if (imageUrl) {
      sendTypingIndicator(contact, true, CANAL_CO()).catch(() => {})
      const descripcion = await describirImagen(imageUrl)
      const caption = IMG_PLACEHOLDERS.includes(message) ? "" : message
      if (descripcion) {
        const bloque = `[El cliente envió una imagen por WhatsApp. Contenido de la imagen]: ${descripcion}`
        message = caption ? `${caption}\n\n${bloque}` : bloque
        console.log(`[vic-mx] imagen descrita contact=${contact} len=${descripcion.length}`)
      } else if (!caption) {
        await capturarPayloadDebug(body)
        if (!simulacion) await sendBotmakerMessage(contact, PIDE_TEXTO_IMAGEN_CO, CANAL_CO()).catch(() => {})
        return NextResponse.json({ reply: simulacion ? PIDE_TEXTO_IMAGEN_CO : "", pais: "mx" })
      } else {
        message = caption
      }
    } else if (IMG_PLACEHOLDERS.includes(message)) {
      await capturarPayloadDebug(body)
      if (!simulacion) await sendBotmakerMessage(contact, PIDE_TEXTO_IMAGEN_CO, CANAL_CO()).catch(() => {})
      return NextResponse.json({ reply: simulacion ? PIDE_TEXTO_IMAGEN_CO : "", pais: "mx" })
    }

    if (!message || message === "__audio__") {
      // Payload sin texto utilizable (ej. adjunto que la acción de Botmaker no
      // reenvía): capturarlo para diagnóstico en vez de perderlo en silencio.
      await capturarPayloadDebug(body)
      return NextResponse.json({ ok: false, error: "message requerido" }, { status: 400 })
    }

    // Anti prompt-injection (espejo CL): no se procesa con el agente; se
    // responde neutro en usted y se registra para revisión.
    if (INJECT_RE.test(message)) {
      console.warn(`[vic-mx] INJECT bloqueado contact=${contact} msg=${JSON.stringify(message.slice(0, 150))}`)
      const neutro = "Te puedo ayudar con información sobre nuestro servicio de control de asistencia? 😊"
      if (simulacion) return NextResponse.json({ reply: neutro, pais: "mx", simulacion: true })
      await sendBotmakerMessage(contact, neutro, CANAL_CO()).catch(() => {})
      return NextResponse.json({ reply: "" })
    }

    // Modo simulación (pruebas E2E): síncrono, sin lock, sin persistir.
    if (simulacion) {
      // Mismo ruteo de modelo que el camino real (sin historia persistida).
      const modeloSim = esFlujoCotizacionCO(message, [])
        ? MODELO_COTIZACION_CO
        : MODELO_SIMPLE_CO
      const result = await runAgentLoop({
        systemPrompt: getSystemPromptMX(contact),
        history: [],
        userMessage: message,
        apiKey,
        contact,
        model: modeloSim,
        tools: { schemas: TOOL_SCHEMAS_MX as unknown as unknown[], dispatch: buildDispatchMX(contact) },
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
        pais: "mx",
        simulacion: true,
        modelo: modeloSim,
      })
    }

    // ── Pipeline endurecido (herencia chilena) ──
    // Re-engagement: el cliente habló → pausar la cadencia en curso (si la había).
    await markUserActivity(contact, "mx").catch(() => {})

    const msgHash = hashMessage(contact, message)
    await bufferInboundMessage(contact, message, msgHash)

    const lockResult = await acquireLock(contact, msgHash)
    if (!lockResult.acquired) {
      console.log(`[vic-mx] ${contact}: mensaje encolado, ya hay un procesador activo`)
      return NextResponse.json({ reply: "" })
    }

    sendTypingIndicator(contact, true, CANAL_CO()).catch(() => {})
    console.log(`[vic-mx] IN contact=${contact} msg=${JSON.stringify(message.slice(0, 60))}`)
    after(processBurstCO(contact, apiKey, message))

    return NextResponse.json({ reply: "" })
  } catch (err) {
    console.error("[vic-mx] error en webhook:", err)
    return NextResponse.json({ reply: ERROR_GENERICO_CO, pais: "mx" }, { status: 200 })
  }
}
