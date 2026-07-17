/**
 * Endpoint POST /api/vic-botmaker-v3
 *
 * Adapter entre Botmaker y el agent-loop de V3.
 *
 * ─── Arquitectura: async + push (refactor 2026-05-29) ──────────────────
 *
 * Antes: el endpoint procesaba el mensaje sincrónamente y devolvía
 * { reply } a Botmaker. Cuando una cotización formal tardaba más que el
 * timeout del webhook (~17s), Botmaker reintentaba la request, y la segunda
 * llamada (descartada como concurrente con reply="") era la que Botmaker
 * tomaba como respuesta válida — el cliente no recibía nada aunque la
 * cotización sí se hubiera creado en Zoho.
 *
 * Ahora:
 *   1. El webhook responde INMEDIATO con reply vacío (always).
 *   2. Antes del response se dispara el typing indicator de WhatsApp.
 *   3. El procesamiento real corre en background con after() de next/server.
 *   4. El reply final se entrega vía push de Botmaker
 *      (/v2.0/chats-actions/send-messages).
 *   5. Lock distribuido en Supabase (vic_v3_processing_locks) reemplaza
 *      el Set<string> en memoria, que no servía en serverless.
 *
 * El filtro de teléfonos autorizados sigue viviendo en el Master Bot de
 * Botmaker — solo derivan a este endpoint los contactos en whitelist.
 */

import { NextResponse, after } from "next/server"
import { runAgentLoop, type ConversationMessage } from "@/lib/agent-loop"
import {
  getSystemPromptV3,
  formatCotizacionExistenteParaPrompt,
  formatCotizacionesMultiplesParaPrompt,
} from "@/app/api/vic-sales-agent-v3/prompt"
import {
  fetchHistoryV3,
  appendTurnV3,
  getPrefEscalon,
  getQuotePointer,
  getQuotePointers,
  getFormalQuote,
  isReengaged,
} from "@/lib/supabase-persistence-v3"
import {
  acquireLock,
  releaseLock,
  hashMessage,
  bufferInboundMessage,
  drainInbox,
  inboxHasPending,
} from "@/lib/processing-lock-v3"
import { sendBotmakerMessage, sendTypingIndicator } from "@/lib/botmaker-push-v3"
import { sanitizarVoseo, normalizarFormatoWhatsApp, quitarSignosApertura, blindarContactoComercial } from "@/lib/voseo-v3"
import { transcribirAudio } from "@/lib/transcribe-audio"
import { describirImagen } from "@/lib/describe-image"
import { marcarCotizacionRechazada } from "@/lib/zoho-quote-status"
import { updateZohoLeadStatus } from "@/lib/zoho-leads"
import {
  markUserActivity,
  armFollowup,
  closeFollowup,
  scheduleConsensualFollowup,
  confirmMeetingAttendance,
} from "@/lib/supabase-persistence-v3"

export const dynamic = "force-dynamic"
export const maxDuration = 60

// ── Guardrails de seguridad ───────────────────────────────────────────
const MAX_INPUT_CHARS = 2000
const INJECT_RE =
  /###|IGNORE|DUMP|INSTRUC|SYSTEM PROMPT|\bPROMPT\b|\\u202|<script|DROP\s+TABLE|DELETE\s+FROM|UNION\s+SELECT/i

// ── Ráfaga de mensajes (buffer + debounce + drenaje) ──────────────────────
// Cada mensaje entrante se encola en vic_v3_inbox. El que toma el lock espera
// una ventana corta de "silencio" para que la ráfaga aterrice, drena TODOS los
// pendientes y los procesa como un solo turno combinado. Así no se descartan
// los mensajes 2/3 de una ráfaga (caso Rodrigo) ni se fragmentan las respuestas.
const BURST_DEBOUNCE_MS = Number(process.env.BURST_DEBOUNCE_MS || 1500)
// Tope de turnos por sesión de ráfaga (anti-loop ante un flujo continuo).
const MAX_BURST_TURNS = 10

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── Cadencia humana ──────────────────────────────────────────────────────
// Vicky no responde al instante: antes de enviar el reply mostramos
// "escribiendo…" y esperamos una demora proporcional al largo del mensaje (con
// jitter), para que se sienta como una persona y no como un bot. Corre en el
// procesamiento de fondo (no bloquea la respuesta HTTP). Apagable por env.
const HUMAN_DELAY_ON =
  (process.env.VICKY_HUMAN_DELAY || "on").trim().toLowerCase() !== "off"
const HUMAN_DELAY_MIN_MS = Number(process.env.VICKY_HUMAN_DELAY_MIN_MS || 1200)
const HUMAN_DELAY_MAX_MS = Number(process.env.VICKY_HUMAN_DELAY_MAX_MS || 6000)
function humanDelayMs(text: string): number {
  const raw = 800 + (text?.length || 0) * 25 // ~base + velocidad de tipeo
  const jitter = 0.85 + Math.random() * 0.3 // ±15% para que no sea idéntico
  return Math.round(
    Math.min(HUMAN_DELAY_MAX_MS, Math.max(HUMAN_DELAY_MIN_MS, raw)) * jitter,
  )
}

// ── Tipos ─────────────────────────────────────────────────────────────
type BotmakerRequest = {
  contact?: string
  message?: string
  // Nota de voz: Botmaker entrega la URL del audio (variable `audioURL`). La
  // acción de código la reenvía aquí; nosotros la descargamos y transcribimos.
  audioUrl?: string
  audioURL?: string
  // Imagen/foto: URL del archivo que entrega Botmaker (la acción de código
  // debe reenviarla, igual que audioURL). La describimos con visión y el
  // texto sigue el flujo normal.
  imageUrl?: string
  imageURL?: string
  mediaUrl?: string
  mediaURL?: string
}

type ToolCallRecord = {
  name: string
  ok: boolean
  output?: unknown
}

type PdfUrlOutput = { pdfUrl?: string }

// ── Constantes de UX ──────────────────────────────────────────────────
const ERROR_FALLBACK_MSG =
  "Disculpa, tuve un problema procesando tu mensaje. ¿Puedes intentar de nuevo en un momento?"

const GENERIC_ERROR_MSG =
  "Tuve un problema técnico momentáneo. ¿Podrías repetir tu mensaje?"

// Fallback que devuelve el agent-loop cuando el turno terminó SIN texto final
// (ver lib/agent-loop.ts). Lo necesitamos acá para detectar ese caso y, en un
// opt-out, reemplazarlo por una despedida limpia (guardrail 2.6d).
const AGENT_LOOP_EMPTY_FALLBACK =
  "Disculpa, tuve un problema procesando tu mensaje. ¿Puedes repetirlo o decirme con qué te puedo ayudar?"

// Despedida cordial cuando el cliente se da de baja (opt-out). El opt-out ya se
// registró (cierra el seguimiento); esto solo evita que reciba un mensaje que
// parece error en vez de una despedida.
const OPTOUT_GOODBYE_MSG =
  "Entendido, no te contactaremos más. Si en el futuro lo necesitas, aquí estaré. ¡Que te vaya muy bien! 🙌"

// Circuit-breaker (C): tras varios errores seguidos en una misma conversación,
// escalamos a humano UNA vez en lugar de repetir el fallback en loop (en
// producción este loop llegó a 60 mensajes idénticos).
const ESCALADA_ERROR_MSG =
  "Disculpa, sigo teniendo un problema técnico. Ya le avisé a un ejecutivo para que se contacte contigo a la brevedad. 🙏"

// Saneador anti-voseo (D): vive en lib/voseo-v3.ts (compartido con el cron de
// re-engagement, que también sanea sus nudges antes de enviar).

// ── Re-engagement (item 5) ────────────────────────────────────────────────
// La cadencia se arma SOLO en conversaciones COMERCIALES (hubo un estimado,
// cotización, negociación o agenda): ahí Vicky responde, la pelota queda en el
// cliente y vale la pena perseguir. Las conversaciones NO comerciales (soporte,
// FAQ, login) NO reciben nudges. Tampoco se persigue tras una despedida natural.
// SOPORTE (decisión de costos 11-jul): un turno que usó el agente de soporte
// CIERRA el ciclo SIEMPRE — cero seguimiento ni comunicación proactiva a quien
// pide soporte, aunque la conversación tenga historial comercial.
const FOLLOWUP_SUPPORT_TOOLS = new Set(["consultar_agente_soporte"])
// Tools que CIERRAN el ciclo: la conversación quedó en manos de un humano
// (reunión agendada, callback registrado, derivación) — no perseguimos más.
const FOLLOWUP_CLOSING_TOOLS = new Set([
  "agendar_reunion",
  "registrar_solicitud_callback",
  "derivar_a_soporte",
])
// Tools que evidencian intención COMERCIAL (prospecto en el embudo de venta). El
// seguimiento (re-engagement) se arma SOLO en conversaciones comerciales: las no
// comerciales (soporte, FAQ, login) NO reciben nudges. agendar_reunion y
// registrar_solicitud_callback NO van aquí porque ya CIERRAN el ciclo (quedó en
// manos de un humano).
const FOLLOWUP_COMMERCIAL_TOOLS = new Set([
  "cotizar_referencial",
  "consultar_descuento_referencial",
  "consultar_siguiente_descuento",
  "generar_link_cotizadora",
  "aplicar_siguiente_descuento",
  "consultar_disponibilidad_horario",
  "enviar_certificacion",
])
// Despedida corta y natural ("gracias!", "chao", "nos vemos") → la conversación
// terminó bien; un "te perdí" después de un adiós sería torpe. Solo aplica a
// mensajes cortos: "gracias, ¿y cuánto vale el reloj?" NO es despedida.
const FAREWELL_RE =
  /\b(gracias|chao|chau|nos vemos|hasta luego|adi[oó]s|que est[eé]s bien)\b/iu
// Opt-out: lo decide el MODELO vía la tool marcar_no_contactar (ver route abajo),
// no un regex sobre el texto del usuario. (Antes había un OPTOUT_RE; se eliminó
// porque siempre se le escapaba alguna redacción — p. ej. "no me hables más".)

// ── Ruteo de modelo por turno (híbrido costo/calidad) ─────────────────────
// Sonnet SOLO en el flujo de cotización (precios/descuentos/cotización formal),
// donde la calidad es crítica y Haiku falló (repetía tramos, alucinaba el link/
// PDF). Haiku para todo lo demás (saludo, FAQ, soporte, agenda, opt-out), que es
// alto volumen y simple. Sesgado a Sonnet ante la duda: el ahorro viene de los
// turnos claramente NO comerciales.
const MODELO_COTIZACION =
  (process.env.ANTHROPIC_SALES_AGENT_MODEL_V3 || "claude-sonnet-4-5-20250929").trim()
const MODELO_SIMPLE =
  (process.env.ANTHROPIC_SALES_AGENT_MODEL_SIMPLE || "claude-haiku-4-5-20251001").trim()

// El mensaje del cliente pinta cotización/precio/descuento o da cantidad.
const COTIZ_MSG_RE =
  /cotiz|precio|cu[aá]nto|cuesta|\bvale\b|\bvalor\b|\bcaro\b|barat|descuento|rebaj|presupuesto|\bUF\b|plan mensual|oferta|pago inicial|\d+\s*(trabajador|persona|emplead|colaborador|usuario)|somos\s+\d+/i
// La ÚLTIMA respuesta de Vicky ya estaba en modo cotización (sigue el flujo
// aunque el cliente solo conteste "ok"/"sí").
const COTIZ_HIST_RE =
  /cotiz|\bUF\b|\/mes|pago inicial|plan mensual|descuento|instalaci[oó]n|\bpunto|marca|reloj|cu[aá]nt[ao]s?\s+person|trabajador/i

/** Decide si el turno pertenece al flujo de cotización (→ Sonnet). */
function esFlujoCotizacion(
  message: string,
  history: ConversationMessage[],
  prefEscalon: number,
  tieneCotizacion: boolean,
): boolean {
  // Estado: cotización formal vigente o negociación de descuento en curso.
  if (tieneCotizacion || prefEscalon > 0) return true
  // El mensaje entrante pinta cotización/precio.
  if (COTIZ_MSG_RE.test(message)) return true
  // Mid-flujo: la última respuesta de Vicky ya estaba cotizando.
  const lastAssistant =
    [...history].reverse().find((m) => m.role === "assistant")?.content || ""
  if (COTIZ_HIST_RE.test(lastAssistant)) return true
  return false
}

// ── Utilidades ────────────────────────────────────────────────────────
function getEnv(name: string) {
  return (process.env[name] || "").trim()
}

function normalizeContact(raw: string): string {
  return raw.replace(/\D/g, "")
}

/**
 * Busca en los toolCalls una llamada exitosa a generar_link_cotizadora
 * y extrae el pdfUrl del output. Se usa solo para logging/observabilidad.
 */
function extractPdfUrl(
  toolCalls: ToolCallRecord[] | undefined,
): string | undefined {
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

// ── Procesamiento en background ───────────────────────────────────────
/**
 * Corre el agent-loop completo y entrega el reply vía push de Botmaker.
 *
 * Se invoca con after() de next/server para que Vercel mantenga el
 * container vivo después de que el webhook ya respondió a Botmaker.
 *
 * Pasos:
 *   1. runAgentLoop completo (puede tardar 20+ seg en cotización formal)
 *   2. Persistir turno en Supabase
 *   3. Enviar reply final vía push
 *   4. Liberar lock (siempre, incluso si hay error)
 */
// Contexto que se antepone al prompt cuando el cliente responde por PRIMERA vez a
// un toque de reactivación. Refuerza la excepción "REENGANCHE POR OFERTA" para que
// Vicky retome con continuidad: ofrecer el máximo si no lo tenía / recordar el
// plazo si ya estaba en el tope, siempre con sentido de caducidad.
const CONTEXTO_REENGANCHE =
  "[CONTEXTO — REENGANCHE ACTIVO] Tú (Vicky) reabriste esta conversación con un toque de " +
  "reactivación: le ofreciste al cliente un precio especial por tiempo limitado, y este mensaje " +
  "es su respuesta a ese toque. Aplica la regla 'REENGANCHE POR OFERTA': si el cliente todavía " +
  "NO está en el descuento máximo del plan, ofrécele el máximo de forma proactiva con la tool de " +
  "descuento que corresponda; si YA estaba en el máximo, recuérdale que ese precio caduca pronto. " +
  "ADEMÁS, si el precio que vio llevaba RELOJ control (arriendo), acompaña la oferta con la " +
  "alternativa más económica sin reloj usando los marcajes gratis (app, o la app de cuadrilla " +
  "donde todo el equipo marca en una sola tablet o celular de la empresa): cotízala con " +
  "cotizar_referencial sin hardware y muestra ambos caminos para que elija. " +
  "En todos los casos transmite urgencia (la oferta tiene caducidad). No inventes cifras: usa solo " +
  "los textos que devuelven las tools.\n\n"

async function processOneTurn(
  contact: string,
  message: string,
  apiKey: string,
): Promise<void> {
  try {
    // 1. Cargar historial
    const history: ConversationMessage[] = await fetchHistoryV3(contact, 40)

    // 1.2. Diccionario Vicky (acuerdo con Marketing jul-2026): la PRIMERA
    // respuesta de un lead outbound (conversación abierta por el toque 0, aún
    // sin mensajes del cliente) pasa el lead a "3. Contactado". Best-effort.
    if (!history.some((m) => m.role === "user")) {
      const bloque = history.find(
        (m) => m.role === "assistant" && m.content?.includes("[Datos del formulario web:"),
      )
      const zohoLeadId = bloque?.content?.match(/zohoLeadId (\d+)/)?.[1]
      if (zohoLeadId) {
        // AWAIT obligatorio: sin await la lambda puede congelar la promesa y el
        // hito se pierde en silencio (pasó en la prueba E2E del 08-jul).
        const st = await updateZohoLeadStatus(zohoLeadId, "3. Contactado").catch((e) => ({
          success: false,
          error: e instanceof Error ? e.message : "excepción",
        }))
        console.log(
          `[v3-bg] lead ${zohoLeadId} → "3. Contactado": ${st.success ? "ok" : `FALLÓ ${st.error || ""}`}`,
        )
      }
    }

    // 1.5. Item B (anti-amnesia): si el contacto YA tiene una cotización formal
    // (puntero durable), inyectamos ese estado al prompt para que Vicky la
    // retome en vez de re-cotizar de cero — incluso si perdió el historial.
    const quotePointers = await getQuotePointers(contact).catch(() => [])
    const quotePointer = quotePointers[0] || null
    // Multi-RUT (caso Génesis): con varias formales vivas, el contexto lista
    // TODAS (empresa, RUT, total y link de cada una) para que Vicky no las
    // mezcle ni pierda ninguna.
    const contextoCotizacionExistente =
      quotePointers.length > 1
        ? formatCotizacionesMultiplesParaPrompt(quotePointers)
        : formatCotizacionExistenteParaPrompt(
            quotePointer
              ? {
                  quoteId: quotePointer.quoteId,
                  acceptanceUrl: quotePointer.acceptanceUrl,
                  totalUf: quotePointer.totalUf,
                  totalClp: quotePointer.totalClp,
                }
              : undefined,
          )
    // Reenganche: si esta es la PRIMERA respuesta del cliente a un toque de
    // reactivación, inyectamos contexto para que Vicky retome con la oferta flash
    // (activa la excepción de descuento proactivo del prompt). Se auto-limpia al
    // persistir la respuesta (last_user_at pasa a ser > reactivation_at).
    const reengaged = await isReengaged(contact).catch(() => false)
    const contextoCotizacion =
      (reengaged ? CONTEXTO_REENGANCHE : "") + contextoCotizacionExistente

    // 2. Ruteo de modelo: Sonnet SOLO para el flujo de cotización; Haiku el resto.
    const prefEscalonPre = await getPrefEscalon(contact).catch(() => 0)
    const modelo = esFlujoCotizacion(message, history, prefEscalonPre, !!quotePointer)
      ? MODELO_COTIZACION
      : MODELO_SIMPLE
    console.log(
      `[v3-modelo] contact=${contact} modelo=${modelo} flujoCotizacion=${modelo === MODELO_COTIZACION}`,
    )

    // Correr el agent
    const result = await runAgentLoop({
      systemPrompt: contextoCotizacion + getSystemPromptV3(contact),
      history,
      userMessage: message,
      apiKey,
      contact,
      model: modelo,
    })

    let reply = (result.reply || "").trim()

    // 2.5. Guardrail anti-alucinación de URL del cotizador.
    // Si el reply contiene CUALQUIER URL del cotizador (con path) pero NO hubo
    // una invocación exitosa de generar_link_cotizadora/aplicar_siguiente_descuento
    // en este turno (ni es el reenvío del link ya conocido), el modelo construyó
    // la URL desde su propio output (alucinación). Caso real visto: Haiku inventó
    // `cotizacion.geovictoria.com/accept/<uuid>` (ruta inexistente) diciendo que
    // la cotización estaba lista sin haberla generado. Antes solo se vigilaba
    // /pdf/ y /quote-acceptance.html, así que rutas inventadas se colaban.
    const hasCotizacionUrl =
      /cotizacion\.geovictoria\.com\/[^\s)]+/i.test(reply)
    const toolCalls = (result.toolCalls || []) as ToolCallRecord[]
    // Tanto generar_link_cotizadora como aplicar_siguiente_descuento (commit
    // del descuento) regeneran un PDF legítimo del cotizador.
    const realCotizacion = toolCalls.some(
      (c) =>
        (c.name === "generar_link_cotizadora" ||
          c.name === "aplicar_siguiente_descuento" ||
          c.name === "actualizar_cotizacion") &&
        c.ok,
    )
    // Item B: reenviar el link de aceptación de la cotización YA existente (el
    // del puntero durable, inyectado en el contexto) es legítimo, no una
    // alucinación: lo dejamos pasar aunque no haya tool de cotización este turno.
    const reenviaLinkConocido = quotePointers.some(
      (qp) => !!qp.acceptanceUrl && reply.includes(qp.acceptanceUrl),
    )
    if (hasCotizacionUrl && !realCotizacion && !reenviaLinkConocido) {
      console.error(
        `[v3-bg] ALUCINACIÓN_URL contact=${contact} replyOriginal=${JSON.stringify(reply.slice(0, 400))}`,
      )
      // Auto-recuperación (17-jul, caso Multirut): con historial lleno de links
      // viejos el modelo imita el patrón "confirmación → link" sin llamar la
      // tool, y la muletilla "¿me confirmas otra vez?" lo dejaba en loop
      // infinito de disculpas (la cotización nunca salía). Mismo patrón de
      // reintento forzado que descuento/agenda/callback: re-correr el loop UNA
      // vez exigiendo la tool; la muletilla queda solo como último recurso.
      const FORZAR_TOOL_COTIZACION =
        "\n\n# Instrucción de sistema (este turno)\n" +
        "Tu borrador anterior incluía un link del cotizador INVENTADO (no llamaste ninguna tool). " +
        "PROHIBIDO escribir URLs del cotizador de memoria o copiarlas del historial: la ÚNICA fuente " +
        "válida es el output de una tool de ESTE turno. Llama AHORA a la tool correcta " +
        "(generar_link_cotizadora para una cotización formal nueva; actualizar_cotizacion para modificar " +
        "la vigente; aplicar_siguiente_descuento para el descuento acordado) con los datos ya confirmados " +
        "por el cliente, y entrega EXACTAMENTE su mensajeParaProspecto."
      const retry = await runAgentLoop({
        systemPrompt:
          contextoCotizacion + getSystemPromptV3(contact) + FORZAR_TOOL_COTIZACION,
        history,
        userMessage: message,
        apiKey,
        contact,
        model: MODELO_COTIZACION,
      }).catch((e) => {
        console.error(`[v3-bg] Reintento forzado de cotización falló:`, e)
        return null
      })
      let recuperadoUrl = false
      if (retry) {
        const retryReply = (retry.reply || "").trim()
        const retryTools = (retry.toolCalls || []) as ToolCallRecord[]
        const retryReal = retryTools.some(
          (c) =>
            (c.name === "generar_link_cotizadora" ||
              c.name === "aplicar_siguiente_descuento" ||
              c.name === "actualizar_cotizacion") &&
            c.ok,
        )
        const retryLinkConocido = quotePointers.some(
          (qp) => !!qp.acceptanceUrl && retryReply.includes(qp.acceptanceUrl),
        )
        const retryTieneUrl = /cotizacion\.geovictoria\.com\/[^\s)]+/i.test(retryReply)
        // Aceptar el reintento solo si el link viene de una tool real (o de un
        // puntero conocido), o si optó por responder sin link.
        if (retryReply && (retryReal || retryLinkConocido || !retryTieneUrl)) {
          console.warn(
            `[v3-bg] URL_RECUPERADA contact=${contact}: reintento con tool real=${retryReal}.`,
          )
          reply = retryReply
          result.toolCalls = retry.toolCalls
          recuperadoUrl = true
        }
      }
      if (!recuperadoUrl) {
        reply =
          "Disculpa, tuve un problema generando tu cotización formal. ¿Me confirmas otra vez para procesarla?"
      }
    }

    // 2.6. Guardrail anti-alucinación de descuento.
    // Si el reply menciona un % de descuento pero NO hubo una tool de descuento
    // exitosa en este turno, lo normal es que el modelo lo inventó. Pero hay dos
    // casos legítimos que NO debemos bloquear, y un loop que debemos cortar:
    //   (B1) el cliente acepta/reconfirma un % que YA está negociado/comiteado
    //        (incluido el tope) → dejar pasar; bloquear solo si el % es MAYOR al
    //        ya comiteado (eso sí sería avanzar sin pasar por el servidor).
    //   (B2) si el turno anterior ya fue la muletilla, NO repetirla: cerrar
    //        hacia una decisión / derivación en vez de quedar pegados en loop.
    const MULETILLA_DESCUENTO =
      "Permíteme procesar el descuento en el sistema para confirmarte el porcentaje exacto que puedo aplicarte. ¿Te parece?"
    // (A) Forma clásica: "X% de descuento".
    const ofrecePctDescuento =
      /\d+\s*%\s*de\s+descuento|descuento\s+del?\s+\d+\s*%/i.test(reply)
    // (A2) Rebaja SIN porcentaje: el modelo a veces ofrece una concesión hecha a
    // mano ("te dejo la instalación sin costo", "te ahorro las 3 UF", "te la dejo
    // gratis / en 0") calculando el monto él mismo, sin pasar por la tool. Eso es
    // tan alucinación como un % inventado. Se detecta la INTENCIÓN de regalar/
    // rebajar ("te ahorro/regalo/rebajo…", "te lo dejo gratis/sin costo/en 0"),
    // que no aparece en menciones legítimas y descriptivas ("capacitación sin
    // costo", "si lo instalas tú, sin costo").
    const ofreceRebajaSinPct =
      /\bte\s+(ahorro|regalo|bonifico|rebajo|descuento)\b|\bte\s+(?:la|lo|los|las)\s+(?:dejo|doy)\s+(?:gratis|sin\s+costo|sin\s+cargo|en\s+(?:0|cero))/i.test(
        reply,
      )
    const ofreceDescuento = ofrecePctDescuento || ofreceRebajaSinPct
    // El modelo a veces manda SOLO el anuncio de proceso ("permíteme procesar el
    // descuento…", "déjame confirmarte el porcentaje…", "voy a revisar en el
    // sistema") SIN un %: ahí ofreceDescuento es false y el guard no entraba, así
    // que la muletilla pasaba derecho (casos reales 18-jun y 25-jun). La
    // detectamos en sí para que el guard igual fuerce la tool o cierre directo.
    // OJO: NO confundir con "déjame confirmar los DATOS antes de generar la
    // cotización" (confirmación de datos legítima) — por eso exige
    // descuento/porcentaje/sistema, nunca "datos".
    const pareceMuletillaDescuento =
      /perm[ií]teme\s+procesar\s+el\s+descuento/i.test(reply) ||
      /d[eé]jame\s+(confirmar(te)?|revisar|procesar|chequear)\b[^.]{0,40}\b(descuento|porcentaje|el\s+sistema)\b/i.test(
        reply,
      ) ||
      /voy\s+a\s+revisar\b[^.]{0,30}\b(el\s+sistema|descuento)\b/i.test(reply)
    // generar_link_cotizadora también es un commit legítimo: emite la cotización
    // formal CON el descuento ya aplicado (escalonDescuento), así que si fue
    // exitosa, el % que aparece en el reply NO es una alucinación aunque
    // pref_escalon no se haya seteado por separado. Sin esto, el turno de cierre
    // (PDF + correo OK) se tapaba con la muletilla cuando pref_escalon era NULL.
    const realDescuento = toolCalls.some(
      (c) =>
        (c.name === "consultar_descuento_referencial" ||
          c.name === "consultar_siguiente_descuento" ||
          c.name === "aplicar_siguiente_descuento" ||
          c.name === "generar_link_cotizadora") &&
        c.ok,
    )
    // (B1) ¿El % mencionado ya está negociado/comiteado para este contacto?
    // pref_escalon es el "siguiente índice" (idx+1); el % recurrente comiteado
    // queda determinado por él. Reconfirmar ese % (o uno menor, o el de
    // instalación) es legítimo; reclamar uno MAYOR sin tool no lo es.
    const pctMatch = reply.match(/(\d+)\s*%/)
    const pctEnReply = pctMatch ? Number(pctMatch[1]) : null
    const prefEscalon = await getPrefEscalon(contact).catch(() => 0)
    // Escalera del plan mensual (espejo de DISCOUNT_LADDER del cotizador):
    // 10 → 20 (tope 20%). pref_escalon usa la forma "siguiente índice" (i+1);
    // los dos primeros índices son instalación, así que el recurrente arranca en
    // pref_escalon=3 (=10%). recStep indexa la escalera del plan.
    const REC_PCTS = [10, 20]
    const recStep = prefEscalon - 3
    const committedRecPct =
      recStep < 0 ? 0 : REC_PCTS[Math.min(recStep, REC_PCTS.length - 1)]
    // Si ya existe cotización formal, el descuento quedó comiteado en ella (y
    // pref_escalon se limpió al generarla). Reconfirmar/recapitular un % legítimo
    // (≤20% plan, o 25/50 instalación) NO es alucinación.
    // Reconocemos la formal por DOS vías: el puntero durable (quotePointer) y el
    // formal_quote_id de la conversación. Antes solo se miraba el puntero; cuando
    // ese write quedaba rezagado/fallaba, una recapitulación benigna del % ya
    // acordado (cliente que solo dice "gracias, lo pienso") gatillaba la muletilla
    // "permíteme procesar el descuento" — fuera de lugar (caso real Rodrigo).
    const formalQuoteId = await getFormalQuote(contact).catch(() => "")
    const tieneFormal = !!quotePointer || !!formalQuoteId
    // ¿El CLIENTE está pidiendo rebaja en ESTE turno? Regex estricto a
    // peticiones inequívocas — si fuera amplio, el reintento forzado ofrecería
    // el siguiente tramo sin que nadie lo pidiera (regalar descuento).
    const pideRebaja =
      /\b(descuento|rebaj\w+|m[aá]s\s+barat\w+|muy\s+caro|me\s+lo\s+dejar?[ií]?a?s\b|d[eé]jamelo\s+(a|en)\b|baj[ae]\w*\s+(el\s+)?precio)/i.test(
        message,
      )
    const pctYaNegociado =
      pctEnReply !== null &&
      ((prefEscalon > 0 &&
        (pctEnReply <= committedRecPct || pctEnReply === 50 || pctEnReply === 25)) ||
        // Post-formal, la exención de "recapitulación benigna" aplica SOLO si el
        // cliente NO está pidiendo rebaja. Si la está pidiendo, un % sin tool es
        // una OFERTA NUEVA inventada (caso Rodrigo 17-jul: 10% y 20% alucinados
        // pasaron por esta puerta porque su RUT tenía formal previa).
        (tieneFormal &&
          !pideRebaja &&
          (pctEnReply <= 20 || pctEnReply === 25 || pctEnReply === 50)))

    if ((ofreceDescuento || pareceMuletillaDescuento) && !realDescuento && !pctYaNegociado) {
      const ultimoAsistente = [...history]
        .reverse()
        .find((m) => m.role === "assistant")
        ?.content?.trim()

      // Recuperación: el modelo enunció un % sin invocar la tool de descuento
      // (típico en la 2ª/3ª objeción: dice el siguiente tramo "de memoria"). Si
      // todavía hay margen, en vez de stallear con la muletilla re-corremos el
      // loop UNA vez forzando la llamada a la tool. Así se produce el % REAL ya
      // comiteado (la tool recalcula precio y el agent-loop persiste el escalón).
      let recuperado = false
      // El reintento forzado corre en dos escenarios: (a) pre-formal con margen
      // (comportamiento original); (b) post-formal cuando el cliente PIDE
      // rebaja (caso Rodrigo 17-jul: antes este camino quedaba excluido y el %
      // alucinado salía tal cual).
      const elegibleRetry =
        (!tieneFormal && committedRecPct < 20) || (tieneFormal && pideRebaja)
      if (elegibleRetry && ultimoAsistente !== MULETILLA_DESCUENTO) {
        const FORZAR_TOOL_DESCUENTO =
          "\n\n# Instrucción de sistema (este turno)\n" +
          "El cliente está pidiendo (más) descuento y aún estás negociando. DEBES llamar la tool de " +
          "descuento que corresponda (consultar_descuento_referencial si AÚN NO existe cotización formal; " +
          "consultar_siguiente_descuento si YA existe) ANTES de mencionar cualquier porcentaje o precio, y " +
          "ofrecer EXACTAMENTE su mensajeParaProspecto. NUNCA digas el % de memoria. NO generes la " +
          "cotización formal en este turno: solo ofrece el siguiente tramo de descuento." +
          (tieneFormal
            ? ` YA existe una cotización formal en esta conversación (quote_id ${formalQuoteId || quotePointer?.quoteId || "vigente"}): usa consultar_siguiente_descuento sobre ELLA.`
            : "")
        const retry = await runAgentLoop({
          systemPrompt:
            contextoCotizacion + getSystemPromptV3(contact) + FORZAR_TOOL_DESCUENTO,
          history,
          userMessage: message,
          apiKey,
          contact,
          model: MODELO_COTIZACION,
        }).catch((e) => {
          console.error(`[v3-bg] Reintento forzado de descuento falló:`, e)
          return null
        })
        if (retry) {
          const retryReply = (retry.reply || "").trim()
          const retryTools = (retry.toolCalls || []) as ToolCallRecord[]
          const retryReal = retryTools.some(
            (c) =>
              (c.name === "consultar_descuento_referencial" ||
                c.name === "consultar_siguiente_descuento" ||
                c.name === "aplicar_siguiente_descuento" ||
                c.name === "generar_link_cotizadora") &&
              c.ok,
          )
          if (retryReal && retryReply) {
            console.warn(
              `[v3-bg] DESCUENTO_RECUPERADO contact=${contact}: el reintento forzó la tool.`,
            )
            reply = retryReply
            result.toolCalls = retry.toolCalls
            recuperado = true
          }
        }
      }

      if (recuperado) {
        // ya tenemos un % real desde la tool; no aplicar muletilla.
      } else if (ultimoAsistente === MULETILLA_DESCUENTO) {
        // (B2) Ya pedimos "procesar el descuento" el turno anterior: romper el
        // loop cerrando hacia una decisión o derivación.
        console.error(
          `[v3-bg] LOOP_MULETILLA_ROTO contact=${contact} replyOriginal=${JSON.stringify(reply.slice(0, 300))}`,
        )
        reply =
          "Para no darte más vueltas con los números: te dejo el mejor precio que te ofrecí y te paso la cotización formal, o si prefieres te contacto con un ejecutivo para revisar el precio. Cómo prefieres?"
      } else if (committedRecPct >= 20) {
        // En el tope ya no hay margen y el prompt prohíbe volver a llamar la
        // tool: en vez de la muletilla "permíteme procesar el descuento" (paso
        // intermedio que sobra acá), declina firme en UNA sola frase.
        console.error(
          `[v3-bg] TOPE_DECLINE_LIMPIO contact=${contact} replyOriginal=${JSON.stringify(reply.slice(0, 300))}`,
        )
        reply =
          "Ese es el mejor precio que te puedo ofrecer: 20% de descuento en el plan mensual. Lo tomas así, o prefieres que te contacte un ejecutivo para revisarlo?"
      } else if (tieneFormal) {
        // Post-formal: el descuento ya está cerrado en la cotización. NO metas la
        // muletilla "permíteme procesar el descuento" (paso intermedio que aquí
        // sobra y confunde —p. ej. cuando el cliente solo se está despidiendo—):
        // cierra suave hacia la decisión o la derivación.
        console.error(
          `[v3-bg] POST_FORMAL_NO_MULETILLA contact=${contact} replyOriginal=${JSON.stringify(reply.slice(0, 300))}`,
        )
        reply =
          "Tu cotización ya quedó con el mejor precio que te ofrecí. Si quieres revisarla o ajustar algo, te puedo contactar con un ejecutivo. ¿Cómo prefieres seguir?"
      } else {
        // Antes aquí se ENVIABA la muletilla ("permíteme procesar el descuento…
        // ¿te parece?") como holding para el próximo turno. El usuario la marcó
        // como robótica (suena a bot atascado y agrega una vuelta extra). Como el
        // reintento forzado de la tool ya falló, NO podemos inventar el %, pero
        // tampoco mandamos la muletilla: cerramos directo y cálido, sin "procesar
        // en el sistema" ni "¿te parece?", invitando a seguir.
        console.error(
          `[v3-bg] DESCUENTO_SIN_TOOL contact=${contact} replyOriginal=${JSON.stringify(reply.slice(0, 400))}`,
        )
        reply =
          "Déjame dejarte el mejor precio posible y te lo confirmo enseguida. Me confirmas que seguimos con esta opción?"
      }
    }

    // 2.6b. Guardrail anti-alucinación de reunión agendada.
    // Caso real (Eduardo): Vicky dijo "Tu reunión quedó agendada" SIN invocar
    // agendar_reunion → no hubo booking en Cal.com, ni correo, ni fila en
    // vic_v3_meetings. Misma clase de bug que la alucinación del link de
    // cotización. Si el reply AFIRMA que la reunión quedó agendada/reagendada
    // pero NO hubo un agendar_reunion/reagendar_reunion exitoso este turno,
    // re-corremos forzando la tool; si aun así no se concreta, NO confirmamos.
    const afirmaReunionLista =
      /\breuni[oó]n\b[^.]{0,40}\b(qued[oó]|est[aá]|fue)\b[^.]{0,18}\b(agendad|reagendad|confirmad|coordinad)/i.test(
        reply,
      ) ||
      /\b(agend[eé]|reagend[eé])\b[^.]{0,25}\breuni[oó]n\b/i.test(reply) ||
      /\bte\s+(la|lo)\s+(agend[eé]|reagend[eé])\b/i.test(reply)
    const realAgenda = toolCalls.some(
      (c) => (c.name === "agendar_reunion" || c.name === "reagendar_reunion") && c.ok,
    )
    if (afirmaReunionLista && !realAgenda) {
      let agendaRecuperada = false
      const FORZAR_TOOL_AGENDA =
        "\n\n# Instrucción de sistema (este turno)\n" +
        "Estás por confirmar una reunión, pero NO puedes decir que quedó agendada sin antes EJECUTAR la tool. " +
        "Si el cliente YA tiene una reunión y quiere cambiarla de día/hora, llama reagendar_reunion(newSlotIso). " +
        "Si es una reunión NUEVA, llama agendar_reunion(slotIso, prospectName, prospectEmail, ...) con los datos que el cliente ya entregó en la conversación. " +
        "Si tienes cualquier duda de disponibilidad del horario, llama primero consultar_disponibilidad_horario. " +
        "SOLO después de que la tool devuelva ok, confirma usando EXACTAMENTE su mensajeParaProspecto. " +
        "Si la tool falla o no hay disponibilidad, díselo con honestidad y ofrece otro horario — JAMÁS afirmes que la reunión quedó agendada si la tool no tuvo éxito."
      const retry = await runAgentLoop({
        systemPrompt: contextoCotizacion + getSystemPromptV3(contact) + FORZAR_TOOL_AGENDA,
        history,
        userMessage: message,
        apiKey,
        contact,
        model: MODELO_COTIZACION,
      }).catch((e) => {
        console.error(`[v3-bg] Reintento forzado de agenda falló:`, e)
        return null
      })
      if (retry) {
        const retryReply = (retry.reply || "").trim()
        const retryReal = ((retry.toolCalls || []) as ToolCallRecord[]).some(
          (c) => (c.name === "agendar_reunion" || c.name === "reagendar_reunion") && c.ok,
        )
        if (retryReal && retryReply) {
          console.warn(`[v3-bg] AGENDA_RECUPERADA contact=${contact}: el reintento forzó la tool.`)
          reply = retryReply
          result.toolCalls = retry.toolCalls
          agendaRecuperada = true
        }
      }
      if (!agendaRecuperada) {
        console.error(
          `[v3-bg] ALUCINACIÓN_AGENDA contact=${contact} replyOriginal=${JSON.stringify(reply.slice(0, 400))}`,
        )
        reply =
          "Disculpa, no alcancé a dejar la reunión agendada. ¿Me confirmas el día y la hora que prefieres y lo dejo listo enseguida?"
      }
    }

    // 2.6c. Guardrail anti-alucinación de callback / lead registrado.
    // Caso real (Rodrigo/Dixi): Vicky dijo "dejé registrados tus datos, un
    // ejecutivo te contactará" SIN invocar registrar_solicitud_callback → no se
    // creó el Lead en Zoho, no entró a la tómbola, nadie lo contactó. Misma clase
    // de bug que la alucinación de reunión (2.6b): el modelo AFIRMA el cierre sin
    // ejecutar la tool. Si el reply asegura que tomó/registró los datos o que un
    // ejecutivo va a contactar, pero NO hubo un registrar_solicitud_callback (ni
    // un agendar_reunion, que también crea el Lead) exitoso este turno,
    // re-corremos forzando la tool; si aun así no se concreta, NO confirmamos.
    const afirmaCallbackListo =
      // "tomé/dejé/registré/guardé tus datos | tu solicitud | el callback"
      /\b(tom[eé]|dej[eé]|guard[eé]|registr[eé]|anot[eé])\b[^.]{0,30}\b(tus\s+datos|tu\s+solicitud|tus\s+antecedentes|el\s+callback|tu\s+contacto)\b/i.test(
        reply,
      ) ||
      // "quedaste/quedó registrado" / "te dejé registrado"
      /\bqued(aste|[oó])\b[^.]{0,20}\bregistrad/i.test(reply) ||
      /\bte\s+(dej[eé]|registr[eé])\b[^.]{0,15}\bregistrad/i.test(reply) ||
      // Afirmación de contacto futuro por parte de un ejecutivo/equipo/Anderson.
      // Solo formas ASERTIVAS (contactará / te va a contactar / llamará / se
      // pondrá en contacto), NO la oferta en subjuntivo ("¿quieres que un
      // ejecutivo te contacte?"), que es legítima sin tool.
      /\b(un\s+ejecutivo|el\s+equipo|nuestro\s+ejecutivo|un\s+asesor|Anderson)\b[^.]{0,45}\b(te\s+(contactar[aá]|llamar[aá]|va\s+a\s+(contactar|llamar))|se\s+(pondr[aá]|contactar[aá])\s+en\s+contacto)/i.test(
        reply,
      )
    const realCallback = toolCalls.some(
      (c) =>
        (c.name === "registrar_solicitud_callback" || c.name === "agendar_reunion") && c.ok,
    )
    if (afirmaCallbackListo && !realCallback) {
      let callbackRecuperado = false
      const FORZAR_TOOL_CALLBACK =
        "\n\n# Instrucción de sistema (este turno)\n" +
        "Estás por confirmarle al cliente que registraste su solicitud o que un ejecutivo lo va a contactar, " +
        "pero NO puedes afirmarlo sin antes EJECUTAR la tool. " +
        "Si el cliente pidió que lo llamen/contacten, llama registrar_solicitud_callback(nombre, empresa, telefono, ...) " +
        "con los datos que ya entregó en la conversación. " +
        "Si fue un fallback de cotización (tenía intención de cotizar pero faltaron datos para emitirla), pásale seguimientoCotizacion=true. " +
        "SOLO después de que la tool devuelva ok, confirma usando EXACTAMENTE su mensajeParaProspecto. " +
        "Si faltan datos obligatorios (nombre, empresa o teléfono), PÍDESELOS en vez de afirmar que ya quedó registrado. " +
        "JAMÁS digas que tomaste sus datos o que un ejecutivo lo contactará si la tool no tuvo éxito."
      const retry = await runAgentLoop({
        systemPrompt: contextoCotizacion + getSystemPromptV3(contact) + FORZAR_TOOL_CALLBACK,
        history,
        userMessage: message,
        apiKey,
        contact,
        model: MODELO_COTIZACION,
      }).catch((e) => {
        console.error(`[v3-bg] Reintento forzado de callback falló:`, e)
        return null
      })
      if (retry) {
        const retryReply = (retry.reply || "").trim()
        const retryReal = ((retry.toolCalls || []) as ToolCallRecord[]).some(
          (c) =>
            (c.name === "registrar_solicitud_callback" || c.name === "agendar_reunion") && c.ok,
        )
        if (retryReal && retryReply) {
          console.warn(`[v3-bg] CALLBACK_RECUPERADO contact=${contact}: el reintento forzó la tool.`)
          reply = retryReply
          result.toolCalls = retry.toolCalls
          callbackRecuperado = true
        }
      }
      if (!callbackRecuperado) {
        console.error(
          `[v3-bg] ALUCINACIÓN_CALLBACK contact=${contact} replyOriginal=${JSON.stringify(reply.slice(0, 400))}`,
        )
        reply =
          "Disculpa, no alcancé a dejar registrada tu solicitud. ¿Me confirmas tu nombre, empresa y teléfono y la dejo lista enseguida para que un ejecutivo te contacte?"
      }
    }

    // 2.6d. Opt-out → despedida limpia (no el fallback de "problema procesando").
    // Caso real (Rodrigo): escribió "no me insistan" y, aunque el opt-out SÍ se
    // registró (el ciclo de seguimiento quedó cerrado), el turno terminó sin texto
    // final y se envió el fallback genérico de error — el cliente recibió un
    // "tuve un problema procesando tu mensaje" en vez de una despedida. Si el
    // modelo ejecutó marcar_no_contactar y el reply quedó vacío o cayó en un
    // mensaje de error, lo reemplazamos por una despedida cordial.
    const usoOptOut = toolCalls.some(
      (c) => c.name === "marcar_no_contactar" && c.ok,
    )
    if (usoOptOut) {
      const replyVacioOError =
        !reply.trim() ||
        reply === AGENT_LOOP_EMPTY_FALLBACK ||
        reply === ERROR_FALLBACK_MSG ||
        reply === GENERIC_ERROR_MSG
      if (replyVacioOError) {
        console.warn(
          `[v3-bg] OPTOUT_DESPEDIDA contact=${contact}: opt-out con reply vacío/error; se usa despedida limpia.`,
        )
        reply = OPTOUT_GOODBYE_MSG
      }
    }

    // 2.6e. Derivación EXITOSA + reply vacío/error → confirmación limpia.
    // Caso real (Pedro, +56968503645): registrar_solicitud_callback SÍ creó el
    // Lead en Zoho, pero el turno final terminó sin texto y se envió el fallback
    // genérico de error en vez de confirmar; el cliente quedó pensando que falló
    // (aunque su lead estaba guardado). Distinto de 2.6c/2.6b (esos cubren la
    // ALUCINACIÓN: tool NO ejecutada). Aquí la tool SÍ corrió con ok: si el reply
    // quedó vacío/error, lo reemplazamos por una confirmación clara.
    const usoCallbackOk = toolCalls.some(
      (c) => c.name === "registrar_solicitud_callback" && c.ok,
    )
    const usoAgendarOk = toolCalls.some((c) => c.name === "agendar_reunion" && c.ok)
    if (usoCallbackOk || usoAgendarOk) {
      const replyVacioOError =
        !reply.trim() ||
        reply === AGENT_LOOP_EMPTY_FALLBACK ||
        reply === ERROR_FALLBACK_MSG ||
        reply === GENERIC_ERROR_MSG
      if (replyVacioOError) {
        console.warn(
          `[v3-bg] DERIVACION_CONFIRMA contact=${contact}: tool de derivación ok con reply vacío/error; confirmación limpia.`,
        )
        reply = usoAgendarOk
          ? "Listo, tu reunión quedó agendada. Te llega la confirmación con el link por correo. Cualquier duda, aquí estoy."
          : "Listo, dejé registrada tu solicitud. Un ejecutivo te contactará a la brevedad. Algo más en lo que te pueda ayudar mientras tanto?"
      }
    }

    // 2.7. Saneadores deterministas de tono (por si el modelo se escapó pese a
    // las reglas del prompt): anti-voseo (incl. voseo chileno -ái/-ís), quitar
    // negritas y quitar signos de apertura ¡/¿.
    reply = quitarSignosApertura(normalizarFormatoWhatsApp(sanitizarVoseo(reply)))

    // 2.8. Blindaje del contacto comercial: SIN EJECUTIVO ANTES DEL PAGO
    // (decisión 17-jul). El número de Anderson NUNCA sale por el chat — ni
    // siquiera tras la formal: el traspaso post-pago lo envía vic-quote-notify
    // (evento 'pagada'), no el modelo. Si Vicky lo filtra, se reemplaza por el
    // WhatsApp real de soporte.
    reply = blindarContactoComercial(reply, false)

    // 3. Persistir turno en Supabase
    await appendTurnV3(contact, message, reply).catch((err) => {
      console.error("[v3-bg] Error persistiendo turno:", err)
    })

    // 4. Enviar reply final vía push (solo si hay reply real)
    if (reply) {
      // Cadencia humana: "escribiendo…" + demora proporcional al largo, para que
      // no llegue al instante. Best-effort: si falla el typing, igual se envía.
      if (HUMAN_DELAY_ON) {
        await sendTypingIndicator(contact, true).catch(() => {})
        await sleep(humanDelayMs(reply))
      }
      const sent = await sendBotmakerMessage(contact, reply)
      if (!sent) {
        console.error(
          `[v3-bg] No se pudo enviar reply final a Botmaker para ${contact}`,
        )
      }
    } else {
      console.warn(`[v3-bg] Reply vacío para ${contact}, no se envía push`)
    }

    // 5. Re-engagement: decidir el estado del ciclo según cómo terminó el turno.
    //    El seguimiento se hace SOLO en conversaciones COMERCIALES; las no
    //    comerciales (soporte, FAQ, login) NO reciben nudges.
    //    - Opt-out explícito → cerrar (no contactar más).
    //    - Tool de cierre (reunión/callback/derivación) → cerrar (quedó en humanos).
    //    - Turno de SOPORTE → cerrar SIEMPRE (aunque sea comercial): cero
    //      proactividad a quien pide soporte (decisión de costos 11-jul).
    //    - Turno comercial con respuesta real → (re)armar.
    //    - Cualquier otro (no comercial) → no armar (queda dormido).
    try {
      const finalToolCalls = (result.toolCalls || []) as ToolCallRecord[]
      // Opt-out: lo DECIDE el modelo (tool marcar_no_contactar), no un regex.
      const callNoContactar = finalToolCalls.find(
        (c) => c.name === "marcar_no_contactar" && c.ok,
      )
      const usoOptOut = !!callNoContactar
      const tipoNoContactar =
        (callNoContactar?.output as { tipo?: string } | undefined)?.tipo === "perdido"
          ? "perdido"
          : "opt_out"
      const usoCierre = finalToolCalls.some(
        (c) => FOLLOWUP_CLOSING_TOOLS.has(c.name) && c.ok,
      )
      // Seguimiento CONSENSUADO: el cliente dio una señal explícita de decisión
      // diferida y acordó cuándo retomar (tool programar_seguimiento). Se apaga
      // la cadencia automática y se deja UN toque a la fecha acordada.
      const segConsensuado = finalToolCalls.find(
        (c) => c.name === "programar_seguimiento" && c.ok,
      )
      const esSoporte = finalToolCalls.some(
        (c) => FOLLOWUP_SUPPORT_TOOLS.has(c.name) && c.ok,
      )
      const esDespedida =
        message.trim().length <= 30 && FAREWELL_RE.test(message)
      // RECHAZO explícito ("no gracias", "ya no lo quiero"): NUNCA re-armar la
      // cadencia, ni siquiera con cotización formal vigente (caso Rodrigo
      // 17-jul: tras dos 'no', el cron siguió nudgeando "una última cosa"
      // porque el override formal-sobre-despedida re-armaba en cada turno).
      // Capa determinista; el cierre formal (perdido) sigue siendo del modelo
      // vía marcar_no_contactar según la regla de retención del prompt.
      const esRechazo =
        message.trim().length <= 60 &&
        /\b(no\s+gracias|no\s+me\s+interesa|ya\s+no\s+(lo\s+)?quiero|no\s+lo\s+quiero|no\s+quiero\s+(nada|seguir|avanzar)|no\s+insist\w+|dej\w+\s+de\s+(escribir\w*|hablar\w*|insistir\w*)|no\s+me\s+escrib\w+)\b/i.test(
          message,
        )
      // Señal COMERCIAL: actividad comercial en este turno, o estado comercial
      // persistente (cotización formal / negociación en curso), o un estimado/
      // cotización ya mostrado antes en la conversación (para seguir armando en los
      // turnos inline de una conversación que ya es comercial).
      const comercialEsteTurno = finalToolCalls.some(
        (c) => FOLLOWUP_COMMERCIAL_TOOLS.has(c.name) && c.ok,
      )
      const tieneEstadoComercial = !!quotePointer || prefEscalonPre > 0
      const yaHuboEstimacion = history.some(
        (m) =>
          m.role === "assistant" &&
          /\bUF\b|cotizaci[oó]n|\/mes|pago inicial/i.test(m.content || ""),
      )
      const esComercial = comercialEsteTurno || tieneEstadoComercial || yaHuboEstimacion
      if (usoOptOut) {
        await closeFollowup(contact, tipoNoContactar)
        console.log(`[v3-followup] ${tipoNoContactar} (tool) → ciclo cerrado contact=${contact}`)
        // Pérdida declarada: la cotización pendiente se marca Rechazada en Zoho
        // (limpia el pipeline y el guard de reactivación la excluye para siempre).
        if (tipoNoContactar === "perdido" && quotePointer?.quoteId) {
          await marcarCotizacionRechazada(quotePointer.quoteId).catch(() => {})
        }
      } else if (segConsensuado) {
        const cuandoIso = (
          segConsensuado.output as { cuandoIso?: string } | undefined
        )?.cuandoIso
        if (cuandoIso) {
          await scheduleConsensualFollowup(contact, cuandoIso)
          console.log(
            `[v3-followup] consensuado → toque único programado contact=${contact} cuando=${cuandoIso}`,
          )
        } else {
          // Sin fecha válida: no apagamos la cadencia (mejor cae al flujo normal).
          await armFollowup(contact)
        }
      } else if (usoCierre) {
        await closeFollowup(contact, "derivado")
      } else if (esSoporte) {
        // Pidió soporte → CERO seguimiento/proactividad, aunque la conversación
        // tenga historial comercial (decisión de costos 11-jul: antes esta rama
        // solo aplicaba si NO era comercial, y bastaba un estimado viejo en el
        // historial para que el turno de soporte re-armara la cadencia — de ahí
        // los nudges "¿cómo le fue con su problema de…?"). El cierre con razón
        // 'soporte' también lo excluye de la reactivación HSM.
        await closeFollowup(contact, "soporte")
        console.log(`[v3-followup] soporte → ciclo cerrado (sin proactividad) contact=${contact}`)
      } else if (reply && (!esDespedida || tieneEstadoComercial) && !esRechazo && esComercial) {
        // La COTIZACIÓN FORMAL manda sobre la despedida (caso Constanza,
        // 17-jul): un "muchas gracias" tras recibir la formal es recibo
        // cortés, no fin de conversación — sin este override el ciclo quedaba
        // sin armar justo en el momento de mayor valor del funnel. La
        // despedida sigue frenando nudges en conversaciones sin formal.
        await armFollowup(contact)
      }
      // else: conversación no comercial → no se arma (sin nudges).
    } catch (err) {
      console.error(`[v3-followup] Error actualizando seguimiento:`, err)
    }

    const pdfUrl = extractPdfUrl(result.toolCalls as ToolCallRecord[])
    console.log(
      `[v3-bg] DONE contact=${contact} iters=${result.iterations} tools=${result.toolCalls?.length || 0} pdf=${!!pdfUrl}`,
    )
  } catch (err) {
    console.error(`[v3-bg] Error procesando ${contact}:`, err)
    // Circuit-breaker (C): si los turnos anteriores ya fueron mensajes de error,
    // no repitas el mismo fallback en loop (en producción llegó a 60×). Tras 2
    // errores seguidos, escala a un humano UNA vez y luego silencia.
    try {
      const recientes = await fetchHistoryV3(contact, 6).catch(() => [])
      const esError = (t?: string) =>
        t === ERROR_FALLBACK_MSG || t === GENERIC_ERROR_MSG || t === ESCALADA_ERROR_MSG
      const ultimosAsistente = recientes
        .filter((m) => m.role === "assistant")
        .slice(-2)
        .map((m) => m.content?.trim())
      const dosErroresSeguidos =
        ultimosAsistente.length >= 2 && ultimosAsistente.every(esError)
      let errReply: string
      if (dosErroresSeguidos) {
        if (ultimosAsistente[ultimosAsistente.length - 1] === ESCALADA_ERROR_MSG) {
          console.error(
            `[v3-bg] CIRCUIT_BREAKER contact=${contact}: errores en loop, silenciando (ya se escaló).`,
          )
          return
        }
        errReply = ESCALADA_ERROR_MSG
      } else {
        errReply = ERROR_FALLBACK_MSG
      }
      // Persistimos el mensaje de error para que el próximo turno pueda detectar
      // el loop (antes no se persistía y el contador nunca avanzaba).
      await appendTurnV3(contact, message, errReply).catch(() => {})
      await sendBotmakerMessage(contact, errReply).catch(() => {})
    } catch {
      // No-op
    }
  }
}

// ── Orquestador de la ráfaga ───────────────────────────────────────────
/**
 * Lo invoca (vía after()) la request que TOMÓ el lock. Espera un debounce para
 * que la ráfaga aterrice, drena todos los mensajes pendientes del contacto y
 * los procesa como un solo turno combinado; repite mientras lleguen más durante
 * el procesamiento. Gestiona el lock y el indicador de "escribiendo".
 *
 * Carrera de cierre: si un mensaje entra entre el último drenaje vacío y la
 * liberación del lock, se detecta con inboxHasPending y se re-toma el lock (o,
 * si otra invocación ya lo tomó, esa se encarga). Así ningún mensaje queda
 * varado en el buffer.
 */
async function processBurst(
  contact: string,
  apiKey: string,
  seedMessage?: string,
): Promise<void> {
  let holdsLock = true
  let turns = 0
  let seed = seedMessage
  try {
    for (;;) {
      await sleep(BURST_DEBOUNCE_MS)
      let pending = await drainInbox(contact)

      // Resiliencia: si el primer drenaje vino vacío pero teníamos el mensaje
      // original (p. ej. Supabase falló al encolar), procesarlo para no perderlo.
      if (pending.length === 0 && seed) {
        pending = [{ message: seed, created_at: new Date().toISOString() }]
      }
      seed = undefined // el respaldo solo aplica al primer ciclo

      if (pending.length === 0) {
        // Tentativamente terminado: soltar el lock y cerrar la ventana de carrera.
        await releaseLock(contact).catch(() => {})
        holdsLock = false
        if (!(await inboxHasPending(contact))) return
        // Entró un mensaje justo en la ventana: intentar re-tomar el lock.
        const re = await acquireLock(contact, "burst-recheck")
        if (!re.acquired) return // otra invocación tomó el lock; ella procesa
        holdsLock = true
        continue
      }

      const combinado = pending
        .map((p) => p.message)
        .join("\n")
        .slice(0, MAX_INPUT_CHARS)
      await processOneTurn(contact, combinado, apiKey)

      if (++turns >= MAX_BURST_TURNS) {
        // Salvaguarda: liberar y dejar que el próximo mensaje continúe el drenaje.
        console.warn(`[v3-burst] tope de turnos alcanzado contact=${contact}`)
        return
      }
    }
  } finally {
    sendTypingIndicator(contact, false).catch(() => {})
    if (holdsLock) await releaseLock(contact).catch(() => {})
  }
}

// ── Webhook entrypoint ────────────────────────────────────────────────
export async function POST(request: Request): Promise<NextResponse> {
  try {
    // 1. Validar secret
    const secret = request.headers.get("x-secret") || ""
    const expected = getEnv("BOTMAKER_SECRET")
    if (expected && secret !== expected) {
      return NextResponse.json(
        { reply: "Unauthorized" },
        { status: 401 },
      )
    }

    // 2. Validar body
    const body = (await request.json()) as BotmakerRequest
    const contact = normalizeContact(body.contact || "")
    let message = (body.message || "").trim()

    // 2.5. Nota de voz: si vino la URL del audio y no hay texto útil, la
    // transcribimos y seguimos como si el usuario lo hubiera escrito. Si la
    // transcripción falla, o llegó un audio sin URL (la acción de código aún no
    // la reenvía), pedimos el mensaje por texto y salimos — nunca procesamos el
    // placeholder "__audio__" como si fuera el texto del usuario.
    const audioUrl = (body.audioUrl || body.audioURL || "").trim()
    if (audioUrl && (!message || message === "__audio__")) {
      sendTypingIndicator(contact).catch(() => {})
      const transcript = await transcribirAudio(audioUrl)
      if (transcript) {
        message = transcript
        console.log(
          `[v3-botmaker] audio transcrito contact=${contact} len=${transcript.length}`,
        )
      } else {
        await sendBotmakerMessage(
          contact,
          "Uy, no pude escuchar bien tu nota de voz 🙈 ¿Me lo puedes escribir, por favor?",
        ).catch(() => {})
        return NextResponse.json({ reply: "" })
      }
    } else if (message === "__audio__") {
      await sendBotmakerMessage(
        contact,
        "Por ahora no puedo escuchar notas de voz 🙈 ¿Me lo escribes, por favor?",
      ).catch(() => {})
      return NextResponse.json({ reply: "" })
    }

    // 2.6. Foto/imagen: si vino la URL, la "leemos" con visión y el texto sigue
    // el flujo normal (mismo patrón que el audio). Si además venía un caption,
    // se conserva. Placeholders sin URL → pedimos el mensaje por texto.
    const imageUrl = (body.imageUrl || body.imageURL || body.mediaUrl || body.mediaURL || "").trim()
    const IMG_PLACEHOLDERS = ["__image__", "__media__", "__photo__"]
    if (imageUrl) {
      sendTypingIndicator(contact).catch(() => {})
      const descripcion = await describirImagen(imageUrl)
      const caption = IMG_PLACEHOLDERS.includes(message) ? "" : message
      if (descripcion) {
        const bloque = `[El cliente envió una imagen por WhatsApp. Contenido de la imagen]: ${descripcion}`
        message = caption ? `${caption}\n\n${bloque}` : bloque
        console.log(`[v3-botmaker] imagen descrita contact=${contact} len=${descripcion.length}`)
      } else if (!caption) {
        await sendBotmakerMessage(
          contact,
          "Uy, no pude ver bien la imagen 🙈 ¿Me lo puedes contar por texto, por favor?",
        ).catch(() => {})
        return NextResponse.json({ reply: "" })
      } else {
        message = caption
      }
    } else if (IMG_PLACEHOLDERS.includes(message)) {
      await sendBotmakerMessage(
        contact,
        "Uy, no pude ver bien la imagen 🙈 ¿Me lo puedes contar por texto, por favor?",
      ).catch(() => {})
      return NextResponse.json({ reply: "" })
    }

    if (!contact || !message) {
      return NextResponse.json(
        { reply: "Error: contact y message son requeridos." },
        { status: 400 },
      )
    }

    // 2.6. Botón "Confirmo asistencia" del recordatorio de reunión (plantilla
    //      HSM). Se maneja de forma determinista: marca la asistencia en la BD
    //      y responde, SIN gastar una llamada al modelo. "Quiero reagendar" NO
    //      se intercepta: cae al flujo normal para que Vicky conduzca el
    //      reagendamiento con sus tools de agenda.
    const msgNorm = message
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
    if (msgNorm === "confirmo asistencia" || msgNorm === "confirmo mi asistencia") {
      await markUserActivity(contact).catch(() => {})
      const meeting = await confirmMeetingAttendance(contact).catch(() => null)
      let reply: string
      if (meeting) {
        const tz = meeting.timezone || "America/Santiago"
        const cuando = new Intl.DateTimeFormat("es-CL", {
          timeZone: tz,
          weekday: "long",
          day: "numeric",
          month: "long",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).format(new Date(meeting.start_at))
        const nombre = (meeting.prospect_name || "").trim().split(/\s+/)[0]
        reply =
          (nombre ? `¡Perfecto, ${nombre}! ` : "¡Perfecto! ") +
          `Te esperamos el ${cuando} hrs 😊\n\n` +
          "Recuerda conectarte desde tu computador; la invitación está en tu correo."
      } else {
        reply = "¡Gracias por confirmar! 😊 Te esperamos."
      }
      await sendBotmakerMessage(contact, reply).catch(() => {})
      await appendTurnV3(contact, message, reply).catch(() => {})
      console.log(
        `[v3-botmaker] confirmacion asistencia contact=${contact} meeting=${meeting ? "si" : "no"}`,
      )
      return NextResponse.json({ reply: "" })
    }

    // 3. Guardrails de input (largo + prompt injection)
    if (message.length > MAX_INPUT_CHARS || INJECT_RE.test(message)) {
      return NextResponse.json({
        reply: "El formato del mensaje no es válido.",
      })
    }

    // 4. Validar API key de Anthropic
    const apiKey = getEnv("ANTHROPIC_API_KEY")
    if (!apiKey) {
      console.error("[v3-botmaker] ANTHROPIC_API_KEY no configurada")
      return NextResponse.json({
        reply:
          "Servicio no disponible temporalmente. Intenta de nuevo en unos minutos.",
      })
    }

    // 5. Re-engagement: el cliente habló → pausar la cadencia en curso (si la
    //    había). Se hace por cada mensaje entrante, antes de bufferear.
    await markUserActivity(contact).catch(() => {})

    // 6. Encolar el mensaje en el buffer de ráfaga (dedup de retries por hash).
    const messageHash = hashMessage(contact, message)
    await bufferInboundMessage(contact, message, messageHash)

    // 7. Tomar el lock. Solo UNA request por contacto procesa la ráfaga; las
    //    demás dejan su mensaje en el buffer y el procesador activo lo drena.
    const lockResult = await acquireLock(contact, messageHash)
    if (!lockResult.acquired) {
      console.log(
        `[v3-botmaker] ${contact}: mensaje encolado, ya hay un procesador activo`,
      )
      return NextResponse.json({ reply: "" })
    }

    // 8. Typing indicator + procesamiento de la ráfaga en background.
    sendTypingIndicator(contact).catch(() => {})
    console.log(
      `[v3-botmaker] IN contact=${contact} msg=${JSON.stringify(message.slice(0, 60))}`,
    )
    after(processBurst(contact, apiKey, message))

    // 9. Responder INMEDIATO a Botmaker. El reply real se entrega vía push.
    return NextResponse.json({ reply: "" })
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err)
    console.error("[v3-botmaker] Error procesando request:", errMsg)
    return NextResponse.json({
      reply: GENERIC_ERROR_MSG,
    })
  }
}

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 204,
    headers: { Allow: "OPTIONS, POST" },
  })
}
