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

import {
  cierrePorBoton,
  esTextoDeBotonDeCierre,
  normalizarMensajeEntrante,
} from "@/lib/respuesta-boton"
import { NextResponse, after } from "next/server"
import { runAgentLoop, type ConversationMessage } from "@/lib/agent-loop"
import { urlsDeToolsDelTurno, vieneDeUnaTool, curarPlaceholdersDeLink } from "@/lib/links-de-tools"
import { partirEnBurbujas } from "@/lib/burbujas"
import { faseDelContacto, armarOnboarding } from "@/lib/onboarding-canal"
import { honestarMencionesDeCorreo } from "@/lib/honestidad-entrega"
import { corregirPedidoDeTelefono } from "@/lib/no-pedir-telefono"
import { detectarProcesoHumano, directivaProcesoHumano } from "@/lib/proceso-humano"
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
  setKvValue,
  getKvValue,
} from "@/lib/supabase-persistence-v3"
import {
  acquireLock,
  releaseLock,
  hashMessage,
  bufferInboundMessage,
  drainInbox,
  inboxHasPending,
} from "@/lib/processing-lock-v3"
import { sendBotmakerMessage, sendTypingIndicator, detectarCanalOrigen, canalCoherenteConContacto } from "@/lib/botmaker-push-v3"
import { avisarEquipoInterno } from "@/lib/alerta-interna"
import { consumirCotizacionPendiente } from "@/lib/enviar-cotizacion-wa"
import { sanitizarVoseo, normalizarFormatoWhatsApp, quitarSignosApertura, blindarContactoComercial } from "@/lib/voseo-v3"
import { transcribirAudio } from "@/lib/transcribe-audio"
import { describirImagen } from "@/lib/describe-image"
import { marcarCotizacionRechazada } from "@/lib/zoho-quote-status"
import { updateZohoLeadStatus } from "@/lib/zoho-leads"
import {
  markUserActivity,
  closeFollowup,
  scheduleConsensualFollowup,
  confirmMeetingAttendance,
} from "@/lib/supabase-persistence-v3"
import { resetLoop, clasificarSenalEspera, enrolarEnLoop } from "@/lib/loop-v2"
import { umbralPrecios, formatUmbralParaPrompt, dotacionSobreUmbral, formatDirectivaSobreUmbral, cinturonPrecioSobreUmbral } from "@/lib/umbral-autonomia"

export const dynamic = "force-dynamic"
// 300s, igual que los webhooks CO y MX. Estaba en 60 desde el 22-jun, cuando
// el turno era mucho más corto: hoy un turno de cotización encadena varias
// iteraciones del modelo más generar_link_cotizadora (que crea la cuenta en
// Zoho, arma el PDF y manda el correo) y pasa de 60 segundos sin problema.
//
// CASO QUE ORIGINA EL CAMBIO (27-jul, Jackelin de Kláza SpA): escribió a las
// 13:30 y la función murió con "Vercel Runtime Timeout Error: Task timed out
// after 60 seconds". El turno alcanzó a escribir last_user_at y murió antes de
// persistir el mensaje y de responder — la clienta quedó esperando en silencio
// con la cotización ya emitida. Dos veces en 40 minutos, en dos contactos
// distintos. La línea chilena atiende el 92% del tráfico y era la única con el
// presupuesto recortado.
export const maxDuration = 300

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
  // Canal (línea) por el que ENTRÓ el mensaje. Lo manda la acción de código de
  // Botmaker (agregar `channelId` a su payload); con él respondemos por el
  // MISMO número al que el cliente escribió, aunque su prefijo sea de otro
  // país (caso +573117482905 escribiendo a la línea chilena, 21-jul).
  channelId?: string
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
  // Documento adjunto (PDF, ej. comprobantes): URL si la acción de código la
  // reenvía. Se lee con visión igual que las imágenes (25-jul).
  fileUrl?: string
  fileURL?: string
  documentUrl?: string
  documentURL?: string
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
  const sinMas = (raw || "").trim().replace(/^\+/, "")
  // Contactos SIN teléfono (números ocultos de Meta): llegan como
  // "CO.1025995573684934". Ese ID COMPLETO es la identidad del chat en
  // Botmaker — si lo reducimos a dígitos, la respuesta se va a un chat
  // fantasma y el cliente queda sin contestar (caso CIMA, 30-jul). Se
  // conserva crudo como clave de conversación y de respuesta.
  if (/[^\d]/.test(sinMas)) return sinMas
  return sinMas
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
  "alternativa más económica sin reloj usando los marcajes sin costo adicional (la app: cada persona marca " +
  "desde su propio celular o todo el equipo desde el celular del supervisor): cotízala con " +
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

    // 1.1. PROCESO ÚNICO (política Lalo 20-jul, caso Ingesub): conversación
    // NUEVA → ¿el contacto ya está siendo trabajado por un ejecutivo? Si sí,
    // se activa el candado comercial (el agent-loop retira las tools de
    // venta) y la directiva entra al historial — también en memoria para que
    // aplique desde ESTE primer turno.
    if (history.length === 0) {
      const proceso = await detectarProcesoHumano(contact, "cl").catch(() => null)
      if (proceso) history.push({ role: "assistant", content: directivaProcesoHumano(proceso) })
    }

    // 1.1-bis. CANDADO DE MONOTONÍA DEL DESCUENTO (caso Pablo/Ayres 25-jul):
    // Vicky ofreció 20% cuatro veces sin que la tool lo comiteara (pref_escalon
    // quedó null y la cotización en Zoho con 0%); cuando el cliente por fin
    // pidió rebaja, el guardrail forzó la tool, la tool partió del escalón 0 y
    // devolvió 10% — le SUBIÓ el precio a un cliente que ya tenía 20% en la
    // mano. Un vendedor jamás retrocede una oferta. Se escanea el máximo % de
    // descuento que Vicky YA mencionó en el historial y se inyecta como piso
    // duro del turno; el modelo lo usa para no ofrecer menos y para pasar el
    // escalonActual correcto a la tool.
    const pctsOfrecidos = history
      .filter((m) => m.role === "assistant")
      .flatMap((m) => [...String(m.content || "").matchAll(/(\d{1,2})\s*%\s*(?:de\s+)?desc/gi)])
      .map((mm) => Number(mm[1]))
      .filter((n) => n >= 5 && n <= 50)
    const pisoDescuento = pctsOfrecidos.length ? Math.max(...pctsOfrecidos) : 0
    if (pisoDescuento > 0) {
      history.push({
        role: "assistant",
        content:
          `[ESTADO INTERNO DE LA NEGOCIACIÓN — no lo cites al cliente]\n` +
          `Ya le ofreciste a este cliente un ${pisoDescuento}% de descuento en el plan mensual. ` +
          `REGLA DURA: ese ${pisoDescuento}% es un PISO, nunca un techo — JAMÁS le ofrezcas un porcentaje menor ` +
          `ni un precio mayor al que ya tiene en la mano (subirle el precio a un cliente que está negociando ` +
          `es la peor falla posible de un vendedor). Si pide más rebaja: llama la tool de descuento pasando ` +
          `escalonActual = el escalón que corresponde a ese ${pisoDescuento}% (10%→1, 20%→2), NUNCA 0. ` +
          `Si la tool indica que ya estás en el tope, mantén el ${pisoDescuento}% y dilo con seguridad: ` +
          `"ese es el máximo que puedo hacer". Si el resultado fuera menor al ${pisoDescuento}%, IGNÓRALO y ` +
          `mantén el ${pisoDescuento}%.`,
      })
    }

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
    // Umbral de venta autónoma (Lalo 08-ago): el prompt CL recibe el umbral
    // de PRECIOS de esta conversación (inbound 20 / outbound 10). En modo
    // clásico (VICKY_UMBRAL_CLASICO=1) el bloque es vacío y nada cambia.
    const umbralInfo = contact.replace(/\D/g, "").startsWith("56")
      ? await umbralPrecios(contact).catch(() => null)
      : null
    const contextoUmbral = umbralInfo
      ? formatUmbralParaPrompt(umbralInfo.umbral, umbralInfo.origen)
      : ""
    const contextoCotizacion =
      contextoUmbral + (reengaged ? CONTEXTO_REENGANCHE : "") + contextoCotizacionExistente
    // Directiva determinista (umbral 08-ago): si la CONVERSACIÓN declaró una
    // dotación sobre el umbral ("30 trabajadores" — en este mensaje o en
    // cualquiera anterior del cliente), la directiva va al FINAL del prompt
    // (recencia) y persiste todos los turnos: derivar si falta, y acompañar
    // sin precios siempre — la E2E mostró que el guion de venta le gana a
    // las reglas del preámbulo.
    const textoCliente = [message, ...history.filter((m) => m.role === "user").map((m) => String(m.content || ""))].join("\n")
    const dotacionDetectada = umbralInfo
      ? dotacionSobreUmbral(textoCliente, umbralInfo.umbral)
      : null
    const directivaUmbral = dotacionDetectada && umbralInfo
      ? formatDirectivaSobreUmbral(dotacionDetectada, umbralInfo.umbral)
      : ""
    // Directiva determinista del marcaje (biblia 12-ago; caso "Mixto" 13-ago,
    // dos veces el mismo día): la regla del prompt sola no alcanza — cuando el
    // cliente ELIGE reloj o marcaje mixto en una respuesta corta, sin declarar
    // cantidades ni sedes, la orden imperativa entra al FINAL del prompt
    // (recencia, igual que la del umbral): 1 punto y 1 reloj asumidos, la
    // única pregunta permitida es la comuna.
    const msgCorto = (message || "").trim()
    const eligeReloj =
      msgCorto.length <= 40 &&
      /\b(mixt[oa]s?|combinad[oa]s?|combinaci[oó]n|reloj(?:es)?|ambos|ambas|los dos|las dos)\b/i.test(msgCorto)
    const declaraCantidadOSedes = /\d|sucursal|sede|punto|local/i.test(msgCorto)
    const directivaMarcaje =
      eligeReloj && !declaraCantidadOSedes
        ? "\n\n[DIRECTIVA DEL TURNO — obligatoria] El cliente acaba de elegir un marcaje que INCLUYE reloj (o dijo 'mixto'). PROHIBIDO preguntarle cuántos relojes o cuántos puntos necesita: ASUME 1 punto y 1 reloj y decláralo en tu mensaje. Si aún no sabes la comuna de ese punto, tu ÚNICA pregunta de este turno es la comuna; si ya la sabes, cotiza AHORA con cotizar_referencial (1 punto, autoInstalada: true) presentando el doble valor (con y sin reloj)."
        : ""

    // Directiva determinista POST-PAGO (Lalo 18-ago, caso +56978903360): el
    // pagador mandó el comprobante de COT339 y 11 minutos después Vicky le
    // habló como prospecto nuevo y le EMITIÓ una segunda cotización duplicada.
    // Con la marca kv del comprobante fresca (48 h), el contacto está en MODO
    // POST-VENTA: nada de cotizar ni armar valores salvo pedido explícito
    // para OTRA empresa. (La marca la deja registrar_comprobante_transferencia
    // junto con cerrar el loop del remitente.)
    let directivaPostPago = ""
    try {
      const marcaComprobante = await getKvValue(`comprobante_ok_${contact}`)
      if (marcaComprobante) {
        const parsed = JSON.parse(marcaComprobante) as { at?: string; numero?: string }
        const edadMs = parsed.at ? Date.now() - new Date(parsed.at).getTime() : Number.POSITIVE_INFINITY
        if (edadMs < 48 * 60 * 60 * 1000) {
          directivaPostPago =
            `\n\n[DIRECTIVA POST-VENTA — obligatoria] Este contacto ACABA de enviar el comprobante de pago de su cotización (${parsed.numero || "registrada"}). Estás en MODO POST-VENTA: NO cotices, NO armes valores, NO preguntes dotación ni marcaje y NO emitas ninguna cotización nueva — su compra YA está cerrada. Acompáñalo con el onboarding y responde sus dudas. SOLO si pide EXPLÍCITAMENTE cotizar para OTRA empresa distinta (con sus palabras, no por iniciativa tuya) puedes volver al flujo de venta.`
        }
      }
    } catch { /* sin marca, sin directiva */ }

    // Directiva determinista de la ETAPA CONSULTIVA (Eduardo 14-ago, caso
    // Rodrigo): Vicky preguntó por la operación, el cliente respondió, y ella
    // volvió a preguntar lo mismo con otras palabras. Si en el historial YA
    // hay una pregunta consultiva suya y este mensaje es la respuesta del
    // cliente, se prohíbe repreguntar: toca parafrasear y mostrar el menú.
    const RE_PREGUNTA_OPERACION =
      /(sobre tu operaci[oó]n|c[oó]mo trabaja tu equipo|a qu[eé] se dedican|una sola oficina o varias|cu[eé]ntame un poco (m[aá]s )?de tu operaci[oó]n)/i
    const yaPregunto = (history || []).some(
      (h) => h.role === "assistant" && RE_PREGUNTA_OPERACION.test(String(h.content || "")),
    )
    const yaMostroMenu = (history || []).some(
      (h) =>
        h.role === "assistant" &&
        /formas m[aá]s usadas para marcar|te acomoda m[aá]s para tu operaci[oó]n/i.test(String(h.content || "")),
    )
    const directivaConsultiva =
      yaPregunto && !yaMostroMenu
        ? "\n\n[DIRECTIVA DEL TURNO — obligatoria] YA hiciste la pregunta consultiva sobre la operación y el cliente acaba de responderla. PROHIBIDO volver a preguntar por su operación, su rubro o cómo trabaja su equipo (aunque su respuesta te parezca corta o incompleta): con lo que dijo, PARAFRASEA en una frase y presenta AHORA el menú de modalidades de marcaje que calzan con su caso, cerrando con la pregunta de cuál le acomoda. Si te falta algún dato para cotizar, pídelo DENTRO de ese mismo mensaje, nunca en un turno aparte."
        : ""

    // 2. Ruteo de modelo: Sonnet SOLO para el flujo de cotización; Haiku el resto.
    const prefEscalonPre = await getPrefEscalon(contact).catch(() => 0)
    const modelo = esFlujoCotizacion(message, history, prefEscalonPre, !!quotePointer)
      ? MODELO_COTIZACION
      : MODELO_SIMPLE
    console.log(
      `[v3-modelo] contact=${contact} modelo=${modelo} flujoCotizacion=${modelo === MODELO_COTIZACION}`,
    )

    // Fase onboarding (CL, VICKY_ONBOARDING_ENABLED apagado por defecto): tras
    // el pago el contacto pasa al agente de onboarding — prompt y toolset
    // propios, MISMO pipeline de salida (sanitizadores, allowlist, persistencia).
    // Con el flag off, faseDelContacto devuelve "venta" sin tocar el kv y todo
    // este bloque es inerte.
    const enOnboarding = (await faseDelContacto(contact)) === "onboarding"
    const onboarding = enOnboarding ? await armarOnboarding(contact) : null

    // Correr el agent
    const result = await runAgentLoop({
      systemPrompt: onboarding
        ? onboarding.systemPrompt
        : contextoCotizacion + getSystemPromptV3(contact, umbralInfo?.umbral) + contextoUmbral + directivaUmbral + directivaMarcaje + directivaConsultiva + directivaPostPago,
      history,
      userMessage: message,
      apiKey,
      contact,
      // Onboarding siempre con el modelo grande: recopila datos de un alta
      // irreversible, no es un turno "simple".
      model: onboarding ? MODELO_COTIZACION : modelo,
      ...(onboarding ? { tools: onboarding.tools } : {}),
    })

    let reply = (result.reply || "").trim()

    // Guardrail de largo del ONBOARDING (Lalo 24-ago): mismo espíritu de la
    // vendedora ("mensajes cortos de WhatsApp") pero determinista — si el
    // modelo se explaya confirmando fichas o reportando nóminas, el canal
    // corta limpio en un borde de oración antes de enviar.
    if (enOnboarding && reply) {
      const { acortarParaWhatsApp } = await import("@/lib/onboarding/estilo")
      const acortado = acortarParaWhatsApp(reply)
      if (acortado !== reply) {
        console.warn(`[v3-bg] onboarding: mensaje de ${reply.length} chars acortado a ${acortado.length} (tope estilo)`)
        reply = acortado
      }
    }

    // 2.4b. Guardrail anti-link ALUCINADO de documentos (caso Cynthia, 21-jul):
    // el modelo "compartió" la certificación DT con un link de Google Drive
    // INVENTADO (drive.google.com/file/d/1Cbga… → "no se pudo abrir el
    // archivo") en vez de llamar enviar_certificacion. Vicky no tiene NINGÚN
    // documento en Drive/Dropbox: cualquier link a esos dominios es fabricado.
    // Determinista: si el contexto es la certificación DT, se sustituye por el
    // documento oficial (mismo que entrega la tool); si no, se elimina el link
    // y se deja la frase honesta de que el documento va enseguida.
    const LINK_FABRICADO =
      /https?:\/\/(?:drive|docs)\.google\.com\/\S+|https?:\/\/(?:www\.)?(?:dropbox|wetransfer|mega)\.[a-z]+\/\S+/gi
    if (LINK_FABRICADO.test(reply)) {
      console.error(
        `[v3-bg] LINK_FABRICADO contact=${contact} replyOriginal=${JSON.stringify(reply.slice(0, 300))}`,
      )
      const esContextoCert = /certificaci|direcci[oó]n del trabajo|\bDT\b|resoluci[oó]n/i.test(reply)
      if (esContextoCert) {
        reply = reply.replace(
          LINK_FABRICADO,
          "https://www.dt.gob.cl/legislacion/1624/articles-127208_recurso_1.pdf",
        )
      } else {
        reply = reply.replace(LINK_FABRICADO, "(te lo hago llegar enseguida)").trim()
      }
    }

    // 2.4c. ALLOWLIST de dominios (caso Transportes Viig, 22-jul): el modelo
    // inventó una "ficha técnica" en storage.googleapis.com — bucket
    // inexistente. Enumerar dominios malos no escala: TODO link cuyo dominio
    // no esté en la lista blanca de Vicky (sitios GeoVictoria, PDFs en
    // Supabase, certificación DT, wa.me, agenda, MercadoPago, videos demo)
    // se considera fabricado y se retira con la frase honesta.
    // PROCEDENCIA ANTES QUE DOMINIO (26-jul): si la URL salió textual de una
    // tool que corrió OK en este turno, la produjo nuestro backend y se respeta
    // aunque su dominio no esté enumerado. Solo rescata links legítimos: una URL
    // alucinada nunca está en un tool_result. Evita repetir el bug del link de
    // la demo cada vez que el backend estrena un dominio (p. ej. el acceso al
    // onboarding, que vive en NEXT_PUBLIC_BASE_URL de la app de onboarding).
    const urlsDeTools = urlsDeToolsDelTurno(result.toolCalls)
    const DOMINIOS_VICKY =
      /^https?:\/\/(?:(?:[a-z0-9-]+\.)*(?:geovictoria\.com|supabase\.co|dt\.gob\.cl|wa\.me|cal\.com|mercadopago\.[a-z.]+|mpago\.[a-z]+|youtube\.com|youtu\.be)(?:[/?#]|$)|geovictoria-demo-agent\.vercel\.app\/?$)/i
    for (const u of reply.match(/https?:\/\/[^\s)]+/gi) || []) {
      if (DOMINIOS_VICKY.test(u)) continue
      if (vieneDeUnaTool(u, urlsDeTools)) {
        console.log(`[v3-bg] LINK_DE_TOOL_RESCATADO contact=${contact} url=${u.slice(0, 140)}`)
        continue
      }
      console.error(`[v3-bg] LINK_FUERA_DE_ALLOWLIST contact=${contact} url=${u.slice(0, 140)}`)
      reply = reply.split(u).join("(te lo hago llegar enseguida)").trim()
    }

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
    // También el LINK CORTO /q/<quoteId>-<firma> (formato de entrega desde el
    // 17-ago): el guardrail solo conocía la URL larga con token, así que
    // re-mencionar el corto de una cotización vigente disparaba un falso
    // "tuve un problema generando tu cotización" DESPUÉS de una entrega
    // exitosa (caso Javiera/Bersa 24-ago, dos cotizaciones recién emitidas).
    const reenviaLinkConocido = quotePointers.some(
      (qp) =>
        (!!qp.acceptanceUrl && reply.includes(qp.acceptanceUrl)) ||
        (!!qp.quoteId && reply.includes(`/q/${qp.quoteId}`)),
    )
    // Item C (29-jul, caso +56958112916): una URL del cotizador que salió de
    // una TOOL de este turno no es alucinación — la produjo nuestro backend.
    // La ficha técnica del reloj (enviar_ficha_reloj) vive en
    // cotizacion.geovictoria.com y este guardrail la fusilaba: el cliente
    // pidió las características del huellero, la tool corrió OK, y la
    // respuesta correcta se reemplazó DOS veces por la muletilla de
    // cotización. Misma regla de procedencia que el allowlist de dominios.
    const urlsCotizadorReply = reply.match(/https?:\/\/cotizacion\.geovictoria\.com\/[^\s)]+/gi) || []
    const urlsToolsTurno = urlsDeToolsDelTurno(toolCalls)
    const urlsVienenDeTools =
      urlsCotizadorReply.length > 0 &&
      urlsCotizadorReply.every((u) => vieneDeUnaTool(u, urlsToolsTurno))
    // (los reintentos forzados son del flujo de VENTA: re-corren el loop con el
    // prompt y las tools de venta, así que en fase onboarding no deben disparar)
    if (
      !enOnboarding &&
      hasCotizacionUrl &&
      !realCotizacion &&
      !reenviaLinkConocido &&
      !urlsVienenDeTools
    ) {
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
          contextoCotizacion + getSystemPromptV3(contact, umbralInfo?.umbral) + contextoUmbral + directivaUmbral + FORZAR_TOOL_COTIZACION,
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
        // Procedencia también en el reintento: si sus URLs salieron de una
        // tool del retry (p. ej. enviar_ficha_reloj de nuevo), son legítimas.
        const retryUrls = retryReply.match(/https?:\/\/cotizacion\.geovictoria\.com\/[^\s)]+/gi) || []
        const retryUrlsDeTools = urlsDeToolsDelTurno(retryTools)
        const retryVieneDeTools =
          retryUrls.length > 0 && retryUrls.every((u) => vieneDeUnaTool(u, retryUrlsDeTools))
        // Aceptar el reintento solo si el link viene de una tool real (o de un
        // puntero conocido, o de cualquier tool del retry), o si optó por
        // responder sin link.
        if (retryReply && (retryReal || retryLinkConocido || retryVieneDeTools || !retryTieneUrl)) {
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
    // El rompe-loop debe reconocer TODOS los textos de contención que este
    // guardrail puede haber enviado en el turno anterior — comparar solo
    // contra la muletilla antigua dejó un loop de 4 repeticiones con un
    // cliente real (caso Jorge, 18-jul: "Déjame dejarte el mejor precio…"
    // cuatro veces seguidas ante cuatro "sí").
    const MULETILLAS_DESCUENTO = new Set([
      MULETILLA_DESCUENTO,
      "Déjame dejarte el mejor precio posible y te lo confirmo enseguida. Me confirmas que seguimos con esta opción?",
    ])
    // BENEFICIOS FIJOS DEL CATÁLOGO — no son descuento negociado (auditoría
    // 25-jul). El pitch estándar dice "la capacitación online, valorizada en
    // 1 UF, va incluida de regalo (100% de descuento)" y el prompt manda
    // repetirlo cuando preguntan "¿viene capacitación?". Sin esta exclusión
    // ese texto activaba el guardrail y pasaba una de dos cosas, ambas malas:
    // la respuesta buena se reemplazaba por la muletilla ("Déjame dejarte el
    // mejor precio posible…"), o se forzaba un reintento que ofrecía un tramo
    // de descuento que el cliente NUNCA pidió — regalando margen y quemando
    // la escalera. De los 18 disparos históricos de muletilla, varios siguen a
    // preguntas inocentes: "esto viene incluido con alguna capacitacion?",
    // "Qué valor?", "como es esa configuracion".
    // Se evalúa CADA mención de "% de descuento" con su contexto inmediato: la
    // que viene precedida de capacitación/regalo/incluida se ignora; cualquier
    // otra sigue contando como oferta (un mensaje con AMBAS se detecta igual).
    const PCT_DESCUENTO_RE = /(\d{1,3})\s*%\s*de\s+descuento|descuento\s+del?\s+(\d{1,3})\s*%/gi
    let ofrecePctDescuento = false
    let pctNegociado: number | null = null
    let finMencionPrevia = 0
    for (const m of reply.matchAll(PCT_DESCUENTO_RE)) {
      const idx = m.index ?? 0
      // El contexto arranca DESPUÉS de la mención anterior (no una ventana
      // fija): así "capacitación de regalo (100% dcto) y además te dejo un 20%
      // de descuento" detecta el 20% real en vez de heredar la exención.
      const contexto = reply.slice(Math.max(finMencionPrevia, idx - 60), idx)
      finMencionPrevia = idx + m[0].length
      if (/capacitaci|de\s+regalo|incluida\s+de/i.test(contexto)) continue
      ofrecePctDescuento = true
      if (pctNegociado === null) pctNegociado = Number(m[1] ?? m[2])
    }
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
    const pctEnReply = pctNegociado
    const prefEscalon = await getPrefEscalon(contact).catch(() => 0)
    // Escalera del plan mensual (espejo de DISCOUNT_LADDER del cotizador):
    // 10 → 20 (tope 20%). pref_escalon usa la forma "siguiente índice" (i+1);
    // los dos primeros índices son instalación, así que el recurrente arranca en
    // pref_escalon=3 (=10%). recStep indexa la escalera del plan.
    const REC_PCTS = [10, 20]
    // Dos convenciones de escalón conviven en pref_escalon: la escalera del
    // flujo FORMAL (los 2 primeros índices son instalación → recurrente parte
    // en 3) y la del PREFORM (consultar_descuento_referencial: 1=10%, 2=20%).
    // Interpretar solo la formal hacía que un recap LEGÍTIMO del % ya ofrecido
    // en preform pareciera alucinación (caso Jorge 18-jul: escalón 2 → fórmula
    // decía 0% comiteado → muletilla en loop). Se toma el MÁXIMO de ambas
    // lecturas: exposición mínima (peor caso: dejar pasar el recap de un % que
    // el cliente ya vio) contra el loop real que mataba ventas.
    const recStepFormal = prefEscalon - 3
    const pctFormal =
      recStepFormal < 0 ? 0 : REC_PCTS[Math.min(recStepFormal, REC_PCTS.length - 1)]
    const pctPreform =
      prefEscalon >= 1 ? REC_PCTS[Math.min(prefEscalon, REC_PCTS.length) - 1] : 0
    const committedRecPct = Math.max(pctFormal, pctPreform)
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

    if (!enOnboarding && (ofreceDescuento || pareceMuletillaDescuento) && !realDescuento && !pctYaNegociado) {
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
      if (elegibleRetry && !MULETILLAS_DESCUENTO.has(ultimoAsistente || "")) {
        // El escalón que YA está en la mano del cliente (por texto del
        // historial o por lo comiteado): el reintento debe partir de ahí, no
        // de 0 — si no, la tool devuelve su primer tramo y le SUBE el precio
        // (caso Pablo/Ayres 25-jul: 20% ofrecido → tool devolvió 10%).
        const pisoPct = Math.max(pisoDescuento, committedRecPct)
        const escalonPiso = pisoPct >= 20 ? 2 : pisoPct >= 10 ? 1 : 0
        const FORZAR_TOOL_DESCUENTO =
          "\n\n# Instrucción de sistema (este turno)\n" +
          "El cliente está pidiendo (más) descuento y aún estás negociando. DEBES llamar la tool de " +
          "descuento que corresponda (consultar_descuento_referencial si AÚN NO existe cotización formal; " +
          "consultar_siguiente_descuento si YA existe) ANTES de mencionar cualquier porcentaje o precio, y " +
          "ofrecer EXACTAMENTE su mensajeParaProspecto. NUNCA digas el % de memoria. NO generes la " +
          "cotización formal en este turno: solo ofrece el siguiente tramo de descuento." +
          (pisoPct > 0
            ? ` PISO OBLIGATORIO: a este cliente YA le ofreciste ${pisoPct}% — pasa escalonActual=${escalonPiso} ` +
              `(NUNCA 0) y jamás le ofrezcas menos de ${pisoPct}%. Si la tool devuelve un tramo menor o ya estás ` +
              `en el tope, mantén el ${pisoPct}% y dilo con seguridad ("ese es el máximo que puedo hacer").`
            : "") +
          (tieneFormal
            ? ` YA existe una cotización formal en esta conversación (quote_id ${formalQuoteId || quotePointer?.quoteId || "vigente"}): usa consultar_siguiente_descuento sobre ELLA.`
            : "")
        const retry = await runAgentLoop({
          systemPrompt:
            contextoCotizacion + getSystemPromptV3(contact, umbralInfo?.umbral) + contextoUmbral + directivaUmbral + FORZAR_TOOL_DESCUENTO,
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
      } else if (MULETILLAS_DESCUENTO.has(ultimoAsistente || "")) {
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
      /\breuni[oó]n\b[^.]{0,40}(qued[oó]|est[aá]|fue)[^.]{0,18}\b(agendad|reagendad|confirmad|coordinad)/i.test(
        reply,
      ) ||
      /\b(agend[eé]|reagend[eé])(?![a-záéíóúñ])[^.]{0,25}\breuni[oó]n\b/i.test(reply) ||
      /\bte\s+(la|lo)\s+(agend[eé]|reagend[eé])/i.test(reply)
    const realAgenda = toolCalls.some(
      (c) => (c.name === "agendar_reunion" || c.name === "reagendar_reunion") && c.ok,
    )
    if (!enOnboarding && afirmaReunionLista && !realAgenda) {
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
        systemPrompt: contextoCotizacion + getSystemPromptV3(contact, umbralInfo?.umbral) + contextoUmbral + directivaUmbral + FORZAR_TOOL_AGENDA,
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
        // Auditoría 20-jul: el fallo técnico NO se le cobra al cliente
        // re-pidiéndole datos que ya están en el historial — se avisa al
        // equipo para completar el registro a mano.
        reply =
          "Disculpa, tuve un problema técnico y tu reunión quedó pendiente de registro — ya le avisé al equipo para dejarla agendada con lo que me indicaste. Te confirmo apenas esté lista, no necesitas reenviarme nada 🙌"
        await avisarEquipoInterno(
          `⚠️ Registro de REUNIÓN falló (tras reintento) — contacto +${contact}. El cliente quedó con la promesa de agenda: revisar la conversación en Botmaker y agendar a mano.`,
        )
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
    const afirmaCallbackListoEn = (t: string) =>
      // "tomé/dejé/registré/guardé tus datos | tu solicitud | el callback"
      /\b(tom[eé]|dej[eé]|guard[eé]|registr[eé]|anot[eé])[^.]{0,30}\b(tus\s+datos|tu\s+solicitud|tus\s+antecedentes|el\s+callback|tu\s+contacto)\b/i.test(
        t,
      ) ||
      // "quedaste/quedó registrado" / "te dejé registrado"
      /\bqued(aste|[oó])\b[^.]{0,20}\bregistrad/i.test(t) ||
      /\bte\s+(dej[eé]|registr[eé])[^.]{0,15}\bregistrad/i.test(t) ||
      // Afirmación de contacto futuro por parte de un ejecutivo/equipo/Anderson.
      // Solo formas ASERTIVAS (contactará / te va a contactar / llamará / se
      // pondrá en contacto), NO la oferta en subjuntivo ("¿quieres que un
      // ejecutivo te contacte?"), que es legítima sin tool.
      /\b(un\s+ejecutivo|el\s+equipo|nuestro\s+ejecutivo|un\s+asesor|Anderson)\b[^.]{0,45}\b(te\s+(contactar[aá]|llamar[aá]|va\s+a\s+(contactar|llamar))|se\s+(pondr[aá]|contactar[aá])\s+en\s+contacto)/i.test(
        t,
      )
    const afirmaCallbackListo = afirmaCallbackListoEn(reply)
    // derivar_a_soporte cuenta como registro REAL (Eduardo 14-ago, su prueba
    // de callback con 70 empleados "falló"): con el flujo 21+ la rama "que me
    // llamen" se registra con derivar_a_soporte, no con
    // registrar_solicitud_callback. El cinturón no la conocía, así que leía
    // una derivación correcta como alucinación: le pedía disculpas al cliente
    // por un fallo inexistente y alertaba al equipo por nada.
    const TOOLS_QUE_REGISTRAN = [
      "registrar_solicitud_callback",
      "agendar_reunion",
      "derivar_a_soporte",
      "derivar_a_ejecutivo",
    ]
    const realCallback = toolCalls.some((c) => TOOLS_QUE_REGISTRAN.includes(c.name) && c.ok)
    if (!enOnboarding && afirmaCallbackListo && !realCallback) {
      let callbackRecuperado = false
      const FORZAR_TOOL_CALLBACK =
        "\n\n# Instrucción de sistema (este turno)\n" +
        "Estás por confirmarle al cliente que registraste su solicitud o que un ejecutivo lo va a contactar, " +
        "pero NO puedes afirmarlo sin antes EJECUTAR la tool. " +
        "Si el cliente pidió que lo llamen/contacten, llama registrar_solicitud_callback(nombre, empresa, telefono, ...) " +
        "con los datos que ya entregó en la conversación. " +
        "EXCEPCIÓN sobre el umbral (21+ trabajadores): ahí el registro correcto es derivar_a_soporte con motivo \"fuera_de_rango_trabajadores\" pasando nombre, rutEmpresa y trabajadores — llama ESA, no la de callback. " +
        "Si fue un fallback de cotización (tenía intención de cotizar pero faltaron datos para emitirla), pásale seguimientoCotizacion=true. " +
        "SOLO después de que la tool devuelva ok, confirma usando EXACTAMENTE su mensajeParaProspecto. " +
        "Si faltan datos obligatorios (nombre, empresa o teléfono), PÍDESELOS en vez de afirmar que ya quedó registrado. " +
        "JAMÁS digas que tomaste sus datos o que un ejecutivo lo contactará si la tool no tuvo éxito."
      const retry = await runAgentLoop({
        systemPrompt: contextoCotizacion + getSystemPromptV3(contact, umbralInfo?.umbral) + contextoUmbral + directivaUmbral + FORZAR_TOOL_CALLBACK,
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
          (c) => TOOLS_QUE_REGISTRAN.includes(c.name) && c.ok,
        )
        if (retryReal && retryReply) {
          console.warn(`[v3-bg] CALLBACK_RECUPERADO contact=${contact}: el reintento forzó la tool.`)
          reply = retryReply
          result.toolCalls = retry.toolCalls
          callbackRecuperado = true
        } else if (retryReply && !afirmaCallbackListoEn(retryReply)) {
          // La afirmación original era espuria: el reintento respondió sin
          // prometer ningún contacto y sin necesitar la tool. Esa respuesta
          // es la buena — el enlatado de abajo le inventaría al cliente una
          // solicitud que nunca hizo (espejo del caso Juan Angel en CO).
          console.warn(
            `[v3-bg] CALLBACK_CORREGIDO_SIN_TOOL contact=${contact}: la afirmación era espuria; va la respuesta del reintento.`,
          )
          reply = retryReply
          result.toolCalls = retry.toolCalls
          callbackRecuperado = true
        }
      }
      if (!callbackRecuperado) {
        console.error(
          `[v3-bg] ALUCINACIÓN_CALLBACK contact=${contact} replyOriginal=${JSON.stringify(reply.slice(0, 400))}`,
        )
        // Auditoría 20-jul (≥7 casos, un cliente urgido tipeó sus datos 3
        // veces): el fallo técnico NO se le cobra al cliente re-pidiéndole
        // nombre/empresa (ya están en el historial) ni el teléfono (escribe
        // por WhatsApp) — se avisa al equipo para completar a mano.
        reply =
          "Disculpa, tuve un problema técnico registrando tu solicitud — ya le avisé directamente al equipo para que igual te contacten con los datos que me diste. No necesitas reenviarme nada 🙌"
        await avisarEquipoInterno(
          `⚠️ Registro de CALLBACK falló (tras reintento) — contacto +${contact}. El cliente quedó con la promesa de contacto: revisar la conversación en Botmaker y registrar el lead a mano.`,
        )
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

    // 2.7b. HONESTIDAD DE ENTREGA DE CORREO (26-jul). Casos +56983757162 y
    // +56922041679: Vicky afirmó que la cotización "ya te llegó al correo"
    // mientras el cliente decía lo contrario. No podía saberlo: el registro de
    // Zoho solo guarda status "sent" — verificado con 5 envíos de prueba, no
    // existe "delivered" ni "bounced". Se degrada la afirmación de RECEPCIÓN a
    // una de ENVÍO (verdadera y comprobable) y se completa el consejo de
    // búsqueda: el correo pasa SPF/DMARC, así que no cae en spam sino en
    // Promociones (Gmail) u Otros (Outlook), que es donde el cliente no mira.
    reply = honestarMencionesDeCorreo(reply)
    // El cliente escribe DESDE su teléfono: pedírselo es pedirle un dato
    // que ya tenemos. La regla está en el prompt dos veces y falló igual
    // (caso Victor Bravo, 27-jul). Ver lib/no-pedir-telefono.ts.
    reply = corregirPedidoDeTelefono(reply)

    // 2.7c. PLACEHOLDER de link (08-ago, caso +56994457210): el molde
    // "[acceptanceUrl]" del prompt salió LITERAL en el mensaje de entrega — a
    // una clienta lista para pagar le llegó el texto entre corchetes en vez del
    // link. Cura determinista en el punto único de salida: se sustituye por el
    // link real (tool de este turno o puntero durable); sin link real, la línea
    // se elimina entera. Corre al final a propósito: cubre también los replies
    // de los reintentos forzados de los guardrails anteriores.
    {
      const cura = curarPlaceholdersDeLink(
        reply,
        result.toolCalls,
        quotePointers.find((qp) => !!qp.acceptanceUrl)?.acceptanceUrl,
      )
      if (cura.curado) {
        console.error(
          `[v3-bg] PLACEHOLDER_LINK contact=${contact} sinReemplazo=${cura.sinReemplazo} replyOriginal=${JSON.stringify(reply.slice(0, 300))}`,
        )
        reply = cura.texto
      }
    }

    // 2.8. Blindaje del contacto comercial: SIN EJECUTIVO ANTES DEL PAGO
    // (decisión 17-jul). El número de Anderson NUNCA sale por el chat — ni
    // siquiera tras la formal: el traspaso post-pago lo envía vic-quote-notify
    // (evento 'pagada'), no el modelo. Si Vicky lo filtra, se reemplaza por el
    // WhatsApp real de soporte.
    reply = blindarContactoComercial(reply, false)

    // 2.9. ANTI-ECO (caso Atcomo 09-ago): el cliente confirmó un supuesto ya
    // cotizado ("la instalan ustedes") y el modelo re-cotizó con los mismos
    // parámetros pegando el resumen IDÉNTICO — al cliente le llegó el mismo
    // texto dos veces ("error", dijo Rodrigo). Si el reply es una copia del
    // último mensaje del asistente, se fuerza UN reintento exigiendo responder
    // a lo que el cliente dijo; si el reintento también repite, se envía igual
    // (mejor repetir que callar).
    {
      const normEco = (s: string) =>
        String(s || "")
          .replace(/\n\s*\[?-{3,}\]?\s*(?:\n|$)/g, "\n")
          .replace(/\s+/g, " ")
          .trim()
      const ultimoAsistente = [...history].reverse().find((m) => m.role === "assistant")
      if (
        reply &&
        ultimoAsistente &&
        normEco(String(ultimoAsistente.content || "")) === normEco(reply) &&
        normEco(reply).length > 40
      ) {
        console.error(`[v3-bg] ECO_DETECTADO contact=${contact}: reply idéntico al turno anterior, reintentando.`)
        const FORZAR_NO_ECO =
          "\n\n# Instrucción de sistema (este turno)\n" +
          "Tu borrador REPITE EXACTAMENTE tu mensaje anterior. El cliente acaba de decirte algo nuevo: respóndele a ESO, corto y natural. " +
          "Si confirmó un supuesto que tu cotización vigente ya incluía, dilo en una frase (los números no cambian, NO vuelvas a pegar el resumen) y avanza al paso siguiente."
        const retryEco = await runAgentLoop({
          systemPrompt:
            contextoCotizacion + getSystemPromptV3(contact, umbralInfo?.umbral) + contextoUmbral + directivaUmbral + FORZAR_NO_ECO,
          history,
          userMessage: message,
          apiKey,
          contact,
          model: MODELO_COTIZACION,
        }).catch(() => null)
        const retryReply = (retryEco?.reply || "").trim()
        if (retryReply && normEco(retryReply) !== normEco(reply)) {
          let curado = blindarContactoComercial(
            corregirPedidoDeTelefono(
              honestarMencionesDeCorreo(quitarSignosApertura(normalizarFormatoWhatsApp(sanitizarVoseo(retryReply)))),
            ),
            false,
          )
          // El reintento corre DESPUÉS de 2.7c: la cura de placeholders se
          // aplica de nuevo aquí para que no se la salte.
          const curaEco = curarPlaceholdersDeLink(
            curado,
            retryEco?.toolCalls,
            quotePointers.find((qp) => !!qp.acceptanceUrl)?.acceptanceUrl,
          )
          if (curaEco.curado) curado = curaEco.texto
          reply = curado
        }
      }
    }

    // 3. Persistir turno en Supabase
    // En el historial el turno queda como UN texto (el marcador de
    // multi-mensaje — [---] o una línea de solo guiones — se convierte en
    // salto de párrafo).
    await appendTurnV3(contact, message, reply.replace(/\n\s*\[?-{3,}\]?\s*(?:\n|$)/g, "\n\n")).catch((err) => {
      console.error("[v3-bg] Error persistiendo turno:", err)
    })

    // 4. Enviar reply final vía push (solo si hay reply real)
    if (reply) {
      // MULTI-MENSAJE (Lalo 24-jul; ampliado Rodrigo 09-ago): además del
      // marcador [---] (corte duro), CADA PUNTO APARTE es una burbuja — "así
      // se ve más natural y el mensaje es menos largo". Los bloques
      // estructurados (resumen de precios con listas y totales) no se
      // fragmentan. Ver lib/burbujas.ts.
      // CANDADO DE UNA SOLA PUERTA (Eduardo 17-ago, v2 tras el caso Rodrigo):
      // el link de aceptación viaja SOLO en la plantilla con el botón "Pagar
      // aquí" — pero ÚNICAMENTE cuando la plantilla realmente salió en este
      // turno. La v1 recortaba siempre, y eso (a) dejaba el texto de entrega
      // huérfano (Rodrigo recibió "Listo! Aquí revisas…" dos veces, una sin
      // link) y (b) rompía el RESPALDO: si la plantilla falla, el link como
      // texto es el único camino y no se puede tocar.
      // Apagable con VICKY_UNA_PUERTA=0.
      let replyFinal = reply
      let plantillaSalio = (result.toolCalls || []).some(
        (c) =>
          c.name === "generar_link_cotizadora" &&
          c.ok &&
          Boolean((c.output as { plantillaEnviada?: boolean } | undefined)?.plantillaEnviada),
      )
      // La plantilla pudo salir en una pasada ANTERIOR del mismo drenaje (o un
      // turno atrás): la marca kv de la tool cubre esa ventana (10 min).
      if (!plantillaSalio) {
        const marca = await getKvValue(`plantilla_reciente_${contact}`).catch(() => null)
        if (marca && Date.now() - Number(marca) < 10 * 60 * 1000) plantillaSalio = true
      }
      if (plantillaSalio && (process.env.VICKY_UNA_PUERTA || "1").trim() !== "0") {
        const { quitarEntregaCompleta } = await import("@/lib/una-puerta-cotizacion")
        const r = quitarEntregaCompleta(reply)
        if (r.quitados > 0) {
          console.warn(`[una-puerta] entrega duplicada recortada para ${contact} (${r.quitados})`)
          replyFinal = r.limpio
        }
      }
      // CINTURÓN DE PRECIOS SOBRE EL UMBRAL (Lalo 18-ago, caso David Oviedo /
      // LC Ingeniería): con dotación declarada sobre el umbral el modelo llegó
      // a escribir un precio a mano ("$58.421/mes", 1,5 UF del tramo 21-50
      // viejo) pese al bloque del prompt y la directiva — tercera capa
      // determinista: ningún mensaje con precio sale de acá.
      if (dotacionDetectada && replyFinal) {
        const cinturon = cinturonPrecioSobreUmbral(replyFinal)
        if (cinturon.habiaPrecio) {
          console.warn(
            `[umbral-cinturon] precio en texto con dotación ${dotacionDetectada} sobre el umbral para ${contact} — respuesta reemplazada`,
          )
          replyFinal = cinturon.reemplazo
        }
      }
      const partes = partirEnBurbujas(replyFinal)
      // ¿Este turno ENTREGÓ algo crítico (cotización)? Esas respuestas salen
      // siempre: descartarlas dejaría al cliente sin su link.
      const turnoEntregaCotizacion = (result.toolCalls || []).some(
        (c) => c.name === "generar_link_cotizadora" && c.ok,
      )
      for (const [i, parte] of partes.entries()) {
        // RESPUESTA OBSOLETA (Eduardo 17-ago, caso "Rodrigo"→"Somos 20"): si
        // mientras se generaba (o durante la cadencia humana) llegó OTRO
        // mensaje del cliente, esta respuesta quedó vieja — mandar "¿y cuántas
        // personas?" cuando ya dijo "somos 20" se lee como no leer. Se
        // descarta lo no enviado; el próximo turno del drenaje procesa el
        // mensaje nuevo con TODO el historial (incluida esta respuesta
        // persistida) y contesta ambas cosas de una. El debounce de 1,5 s
        // cubre las ráfagas inmediatas; esto cubre la ventana de generación.
        if (!turnoEntregaCotizacion && (await inboxHasPending(contact))) {
          console.warn(
            `[v3-burst] respuesta obsoleta descartada para ${contact} (${partes.length - i} burbuja(s) sin enviar): llegó un mensaje nuevo durante la generación`,
          )
          break
        }
        if (HUMAN_DELAY_ON) {
          await sendTypingIndicator(contact, true).catch(() => {})
          await sleep(i === 0 ? humanDelayMs(parte) : Math.min(humanDelayMs(parte), 2500))
        }
        const sent = await sendBotmakerMessage(contact, parte)
        if (!sent) {
          console.error(
            `[v3-bg] No se pudo enviar reply final (parte ${i + 1}/${partes.length}) a Botmaker para ${contact}`,
          )
          break
        }
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
      // Un botón de cierre ("Elegimos otro proveedor" / "Ya no lo
      // necesitamos") ES un rechazo, aunque su texto no tenga ninguna de
      // las palabras del patrón. Ver lib/respuesta-boton.ts.
      const esRechazo =
        esTextoDeBotonDeCierre(message) ||
        (message.trim().length <= 60 &&
        /\b(no\s+gracias|no\s+(me|nos)\s+interesa|no\s+estoy\s+interesad\w+|ya\s+no\s+(lo\s+)?quiero|no\s+lo\s+quiero|no\s+quiero\s+(nada|seguir|avanzar)|no\s+necesito\s+(nada|informaci[oó]\w*|cotiz\w+|el\s+servicio)|no\s+insist\w+|dej\w+\s+de\s+(escribir\w*|hablar\w*|insistir\w*)|no\s+me\s+escrib\w+)\b/i.test(
          message,
        ))
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
      // Señal de espera implícita ("lo veo con mi jefe y te aviso", "la
      // próxima semana"…): UN toque único en el plazo inferido (misma vía que
      // el seguimiento consensuado). Sin señal: la conversación comercial se
      // ENROLA AL LOOP V2 (decisión Lalo 25-jul: el loop reemplaza TODOS los
      // toques anteriores — la escalera armFollowup queda muerta; con el flag
      // apagado, enrolarEnLoop es no-op y no se arma nada).
      const armarSegunSenal = async () => {
        const senal = clasificarSenalEspera(message, "cl", contact)
        if (senal) {
          await scheduleConsensualFollowup(contact, senal.cuando.toISOString())
          console.log(
            `[v3-followup] señal de espera '${senal.tipo}' → toque único ${senal.cuando.toISOString()} contact=${contact}`,
          )
        } else {
          await enrolarEnLoop(contact, "cl").catch(() => {})
        }
      }
      const perdidaPorBoton = cierrePorBoton(message) === "perdido"
      if (perdidaPorBoton) {
        // El cliente tocó "Elegimos otro proveedor" / "Ya no lo necesitamos"
        // en la plantilla de reactivación. Es la declaración de pérdida más
        // explícita que existe — más que cualquier texto libre— y hasta hoy no
        // cerraba NADA: el ciclo se apagaba solo por agotamiento ('agotado'),
        // que el Loop v2 no considera motivo de cierre. Resultado real
        // (56992047070): tocó el botón el 25-jul y el loop le escribió el
        // 27-jul preguntándole cuántas personas marcarían asistencia.
        await closeFollowup(contact, "perdido")
        if (quotePointer?.quoteId) {
          await marcarCotizacionRechazada(quotePointer.quoteId).catch(() => {})
        }
        console.log(`[v3-followup] botón de pérdida → ciclo cerrado contact=${contact}`)
      } else if (usoOptOut) {
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
          await armarSegunSenal()
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
        await armarSegunSenal()
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

    // Respuesta por BOTÓN: Botmaker no manda el texto sino el payload del
    // intent ({"button":"…","entities":"…","intent":"…"}). Se normaliza acá,
    // en la entrada, para que TODO lo de abajo —clasificador de rechazo,
    // modelo, historial— vea "Elegimos otro proveedor" y no el JSON crudo.
    // Ver lib/respuesta-boton.ts (caso 56992047070).
    const cierreBoton = cierrePorBoton(message)
    message = normalizarMensajeEntrante(message)

    // Canal de ORIGEN: si la acción de código nos dice por qué línea entró el
    // mensaje, lo persistimos — sendBotmakerMessage responde SIEMPRE por ese
    // canal (evita chats paralelos cuando el prefijo del número no calza con
    // la línea que eligió el cliente). Best-effort.
    const canalBody = (body.channelId || "").trim()
    if (contact && canalBody && canalCoherenteConContacto(contact, canalBody)) {
      setKvValue(`canal_origen_${contact}`, canalBody).catch(() => {})
    } else if (contact && canalBody) {
      // El body trae el canal de OTRO país (ej. contacto +57 con la línea +56):
      // el master bot de Botmaker ruteó el mensaje al bot equivocado (caso
      // María 23-jul, respuestas por la línea CL a una clienta de la línea CO).
      // No pisamos el origen; si aún no lo conocemos, lo resolvemos contra la
      // API de Botmaker (cubre también al +57 que legítimamente escribe al +56).
      const conocido = await getKvValue(`canal_origen_${contact}`).catch(() => null)
      if (!conocido) await detectarCanalOrigen(contact).catch(() => "")
    } else if ((contact.startsWith("57") && contact.length >= 12) || contact.startsWith("CO.")) {
      // Fallback (caso +573172822429): un +57 escribiendo SIN channelId puede
      // venir por la línea CHILENA — si respondemos por la línea CO, Meta
      // rechaza (sin sesión) y el cliente no recibe NADA. Detectamos su canal
      // real vía la API de Botmaker antes de procesar. Un lookup por mensaje,
      // solo para +57 sin channelId; sobra cuando las acciones de código ya
      // manden el canal.
      await detectarCanalOrigen(contact).catch(() => "")
    }

    // 2.1. Ruteo multi-país (19-jul): la acción de código de Botmaker es UNA
    // sola para las dos líneas y apunta acá, así que los mensajes colombianos
    // (+57) entran por este webhook. Sin este reenvío los atendía el flujo
    // chileno: prompt CL, precios en UF/CLP y respuestas por la línea +56
    // (caso Mauricio/Dahi Cream). Se reenvía el body CRUDO al webhook CO
    // (conserva audio/imagen) y se devuelve su respuesta tal cual.
    if ((contact.startsWith("57") && contact.length >= 12) || contact.startsWith("CO.")) {
      const origin = new URL(request.url).origin
      const r = await fetch(`${origin}/api/vic-botmaker-co`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-secret": getEnv("BOTMAKER_SECRET_CO"),
        },
        body: JSON.stringify(body),
        cache: "no-store",
      }).catch(() => null)
      if (r) {
        const data = await r.json().catch(() => ({ reply: "" }))
        console.log(`[v3-botmaker] contact=${contact} es CO → reenviado a vic-botmaker-co (${r.status})`)
        return NextResponse.json(data, { status: r.status })
      }
      console.error(`[v3-botmaker] contact=${contact} es CO pero el reenvío a vic-botmaker-co falló — se atiende con flujo CL como fallback`)
    }

    // MÉXICO (21-jul): números +52 (WhatsApp usa 521 + 10 dígitos, a veces 52
    // pelado). Mismo patrón de reenvío que Colombia. Sin fallback al flujo CL:
    // precios en UF a un mexicano es peor que un reintento.
    if ((contact.startsWith("521") && contact.length >= 13) || (contact.startsWith("52") && !contact.startsWith("521") && contact.length === 12) || contact.startsWith("MX.")) {
      const origin = new URL(request.url).origin
      const r = await fetch(`${origin}/api/vic-botmaker-mx`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-secret": getEnv("BOTMAKER_SECRET_MX"),
        },
        body: JSON.stringify(body),
        cache: "no-store",
      }).catch(() => null)
      if (r) {
        const data = await r.json().catch(() => ({ reply: "" }))
        console.log(`[v3-botmaker] contact=${contact} es MX → reenviado a vic-botmaker-mx (${r.status})`)
        return NextResponse.json(data, { status: r.status })
      }
      console.error(`[v3-botmaker] contact=${contact} es MX y el reenvío a vic-botmaker-mx falló — NO se atiende con flujo CL (queda para reintento del cliente)`)
      return NextResponse.json({ reply: "" })
    }

    // PERÚ (04-ago): números +51 (51 + 9 dígitos = 11). Mismo patrón de
    // reenvío que MX; el webhook PE parte en CONTENCIÓN (registra, avisa al
    // equipo y saluda 1 vez/24h) hasta que Vicky PE esté construida. Sin
    // fallback al flujo CL: precios en UF a un peruano no ayudan a nadie.
    if ((contact.startsWith("51") && contact.length >= 11 && !contact.startsWith("56")) || contact.startsWith("PE.")) {
      const origin = new URL(request.url).origin
      const secretPe =
        getEnv("BOTMAKER_SECRET_PE") ||
        ((await getKvValue("botmaker_secret_pe").catch(() => null)) || "")
      const r = await fetch(`${origin}/api/vic-botmaker-pe`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-secret": secretPe,
        },
        body: JSON.stringify(body),
        cache: "no-store",
      }).catch(() => null)
      if (r) {
        const data = await r.json().catch(() => ({ reply: "" }))
        console.log(`[v3-botmaker] contact=${contact} es PE → reenviado a vic-botmaker-pe (${r.status})`)
        return NextResponse.json(data, { status: r.status })
      }
      console.error(`[v3-botmaker] contact=${contact} es PE y el reenvío a vic-botmaker-pe falló — NO se atiende con flujo CL`)
      return NextResponse.json({ reply: "" })
    }

    // Envío de cotización PENDIENTE del botón de Zoho (ventana cerrada →
    // plantilla → el cliente respondió AHORA): el paquete PDF+link sale solo.
    // Fire-and-forget: jamás bloquea ni retrasa la respuesta de Vicky.
    consumirCotizacionPendiente(contact).catch(() => {})

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

    // 2.6. Foto/imagen o DOCUMENTO (PDF): si vino la URL, lo "leemos" con
    // visión (describirImagen soporta ambos desde el 25-jul: todo comprobante
    // va a Vicky y debe poder leer imagen y PDF) y el texto sigue el flujo
    // normal. Si además venía un caption, se conserva. Placeholders sin URL →
    // contexto accionable (documento) o pedir el mensaje por texto (imagen).
    const imageUrl = (body.imageUrl || body.imageURL || body.mediaUrl || body.mediaURL || "").trim()
    const fileUrl = (body.fileUrl || body.fileURL || body.documentUrl || body.documentURL || "").trim()
    const FILE_PLACEHOLDERS = ["__file__", "__document__", "__doc__", "__pdf__"]
    const IMG_PLACEHOLDERS = ["__image__", "__media__", "__photo__"]
    const esArchivoAdjunto = FILE_PLACEHOLDERS.includes(message.trim())
    // Caso Jessica/JEANSCO 24-jul: si Botmaker entrega SOLO el placeholder
    // (sin URL) o la lectura falla, NUNCA responder "no puedo visualizarlo" —
    // se convierte en contexto accionable para el modelo.
    const CONTEXTO_DOC_ILEGIBLE =
      "[El cliente envió un ARCHIVO adjunto que el sistema no puede visualizar (probablemente un PDF). NO le digas que no puedes verlo. Si el contexto de la conversación es de PAGO (acaba de pagar, habló de transferencia o comprobante), lo más probable es que sea su comprobante: agradécele el envío, llama registrar_comprobante_transferencia con montoDetectado 0 y detalle 'comprobante enviado como archivo adjunto', y sigue el flujo normal sin afirmar que el pago quedó confirmado. Si el contexto NO es de pago, agradécele y pregúntale con naturalidad qué contiene el documento para poder ayudarle.]"
    const mediaUrlEntrante = imageUrl || fileUrl
    if (mediaUrlEntrante) {
      // Última URL de media del contacto (best-effort): la lee
      // registrar_comprobante_transferencia para adjuntar el link del
      // comprobante al correo de cobranza (petición Lalo 03-ago).
      setKvValue(
        `media_reciente_${contact}`,
        JSON.stringify({ url: mediaUrlEntrante, at: new Date().toISOString() }),
      ).catch(() => {})
      sendTypingIndicator(contact).catch(() => {})
      const descripcion = await describirImagen(mediaUrlEntrante)
      const caption = IMG_PLACEHOLDERS.includes(message) || esArchivoAdjunto ? "" : message
      if (descripcion) {
        const bloque = esArchivoAdjunto || (!imageUrl && fileUrl)
          ? `[El cliente envió un DOCUMENTO (PDF) por WhatsApp. Contenido del documento]: ${descripcion}`
          : `[El cliente envió una imagen por WhatsApp. Contenido de la imagen]: ${descripcion}`
        message = caption ? `${caption}\n\n${bloque}` : bloque
        console.log(`[v3-botmaker] adjunto descrito contact=${contact} len=${descripcion.length}`)
      } else if (esArchivoAdjunto) {
        message = CONTEXTO_DOC_ILEGIBLE
      } else if (!caption) {
        await sendBotmakerMessage(
          contact,
          "Uy, no pude ver bien la imagen 🙈 ¿Me lo puedes contar por texto, por favor?",
        ).catch(() => {})
        return NextResponse.json({ reply: "" })
      } else {
        message = caption
      }
    } else if (esArchivoAdjunto) {
      message = CONTEXTO_DOC_ILEGIBLE
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
      // Loop v2 (flag LOOP_V2_ENABLED): el mensaje del cliente re-ancla su loop.
      resetLoop(contact).catch(() => {})
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
    // Loop v2 (flag LOOP_V2_ENABLED, no-op apagado): el mensaje entrante
    // re-ancla el loop del contacto (t0 = ahora, toque 1; con señal de
    // espera, t0 se corre al plazo inferido). Best-effort.
    resetLoop(contact, message).catch(() => {})

    // 6. Encolar el mensaje en el buffer de ráfaga (dedup de retries por hash).
    const messageHash = hashMessage(contact, message)
    await bufferInboundMessage(contact, message, messageHash)

    // 6-bis. ANTI-DUPLICADO TARDÍO (caso Iván Darío/Intelex 25-jul): el dedup
    // del buffer solo protege mientras la fila existe — drainInbox la BORRA, así
    // que un reintento de Botmaker 45 s después entra como mensaje nuevo y el
    // turno se procesa dos o tres veces (respuestas contradictorias y, si uno
    // falla, un "disculpa, tuve un inconveniente" encima de una conversación ya
    // respondida). Ventana de 2 min por hash, y SOLO para mensajes largos: un
    // "sí"/"ok"/"gracias" repetido es legítimo y debe pasar siempre.
    if (message.trim().length > 12) {
      const visto = await getKvValue(`msgseen_${messageHash}`).catch(() => null)
      const edadMs = visto ? Date.now() - Number(visto) : Infinity
      if (Number.isFinite(edadMs) && edadMs < 120_000) {
        console.warn(
          `[v3-botmaker] duplicado descartado contact=${contact} hash=${messageHash} edad=${Math.round(edadMs / 1000)}s`,
        )
        return NextResponse.json({ reply: "" })
      }
      await setKvValue(`msgseen_${messageHash}`, String(Date.now())).catch(() => {})
    }


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
