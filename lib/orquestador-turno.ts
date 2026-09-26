/**
 * ORQUESTADOR ÚNICO DEL TURNO (22-sep, paso 3 del orden de Lalo del 21-sep:
 * "un solo prompt y un solo funcionamiento global con variables por país").
 *
 * Este archivo ES el turno chileno de app/api/vic-botmaker-v3 (processOneTurn +
 * processBurst + la simulación), movido tal cual y parametrizado por un
 * PerfilTurno: prompt, tools, zona/documento, blindaje de soporte, canal de
 * salida y país de la persistencia/loop. Con PERFIL_TURNO_CL el comportamiento
 * es el que Chile tenía inline; PE/CO/MX pasan por acá con su perfil y reciben
 * TODOS los cinturones (2.4b→2.9), las directivas y la maquinaria de
 * seguimiento.
 *
 * Regla: lo que vive en este archivo NO se replica en ningún webhook. Un país
 * nuevo es un PerfilTurno, no un procesador propio.
 */
import { cierrePorBoton, esTextoDeBotonDeCierre } from "./respuesta-boton"
import { esContactoMeta, capturarCelularCL, guardarTelefonoMeta, telefonoAliasDe, canalMetaDe } from "./origen-canal"
import { runAgentLoop, type ConversationMessage } from "./agent-loop"
import { urlsDeToolsDelTurno, vieneDeUnaTool, curarPlaceholdersDeLink } from "./links-de-tools"
import { partirEnBurbujas } from "./burbujas"
import { faseDelContacto, armarOnboarding } from "./onboarding-canal"
import { lineaZonaHoraria } from "./paises/ficha-operativa"
import { honestarMencionesDeCorreo } from "./honestidad-entrega"
import { corregirPedidoDeTelefono } from "./no-pedir-telefono"
import { detectarProcesoHumano, directivaProcesoHumano } from "./proceso-humano"
import { directivaRutSinCorreo } from "./rut-sin-correo"
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
  closeFollowup,
  scheduleConsensualFollowup,
} from "./supabase-persistence-v3"
import { acquireLock, releaseLock, drainInbox, inboxHasPending } from "./processing-lock-v3"
import { sendBotmakerMessage, sendTypingIndicator } from "./botmaker-push-v3"
import {
  CONTEXTO_REENGANCHE as CONTEXTO_REENGANCHE_COMPARTIDO,
  directivaConsultiva as directivaConsultivaCompartida,
  directivaMarcaje as directivaMarcajeCompartida,
  type FichaTurno,
} from "./directivas-turno"
import { avisarEquipoInterno } from "./alerta-interna"
import { sanitizarVoseo, normalizarFormatoWhatsApp, quitarSignosApertura, blindarContactoComercial, blindarSoporteInventado } from "./voseo-v3"
import { directorioEjecutivos } from "./directorio-ejecutivos"
import { marcarCotizacionRechazada } from "./zoho-quote-status"
import { updateZohoLeadStatus } from "./zoho-leads"
import { clasificarSenalEspera, enrolarEnLoop } from "./loop-v2"
import { umbralPrecios, formatUmbralParaPrompt, dotacionSobreUmbral, formatDirectivaSobreUmbral, cinturonPrecioSobreUmbral, paisConUmbral, type DerivacionPais } from "./umbral-autonomia"
import { prometeContactoSinRegistro } from "./promesa-contacto"

export type PaisTurno = "cl" | "co" | "mx" | "pe"

export type ToolsTurno = { schemas: unknown[]; dispatch: (name: string, input: unknown) => Promise<unknown> }

export type PunteroCotizacion = {
  quoteId?: string
  acceptanceUrl?: string
  totalUf?: number | null
  totalClp?: number | null
}

/** Lo que cambia por país. Todo lo que NO está acá es comportamiento global. */
export type PerfilTurno = {
  pais: PaisTurno
  /** "comuna" (CL) · "distrito" (PE) · "ciudad" (CO/MX): ficha de las directivas del turno. */
  zona: FichaTurno["zona"]
  /** RUT · RUC · NIT · RFC */
  documento: FichaTurno["documento"]
  /** channelId de la línea por la que responde; undefined = línea por defecto (Chile). */
  channelId?: string
  /** System prompt base del país (ANTES de contextos y directivas del turno). */
  systemPrompt: (contact: string, umbral?: number) => string
  /** Set de tools del país; undefined = el set chileno por defecto de runAgentLoop. */
  tools?: (contact: string) => Promise<ToolsTurno> | ToolsTurno
  /** Derivación del umbral 21+ (tool y documento del país); undefined = Chile. */
  derivacion?: (contact: string) => DerivacionPais
  /** Ruteo Sonnet/Haiku por turno. */
  esFlujoCotizacion: (message: string, history: ConversationMessage[], prefEscalon: number, tieneCotizacion: boolean) => boolean
  /** Blindaje de soporte inventado con la tarjeta del país. */
  blindarSoporte: (reply: string, permitidos: Set<string>) => Promise<string> | string
  /** La certificación de la DT (documento chileno): link de respaldo y anexo automático. */
  certificacionDT: boolean
  /** Hito de intención por chat (RUT/RUC del cliente → CRM sin tool). */
  hitoPorChat: boolean
  /** Contexto de la cotización formal vigente; undefined = formato chileno (UF/CLP). */
  contextoCotizacionExistente?: (punteros: PunteroCotizacion[]) => string
}

// Lista blanca de correos reales para el blindaje de soporte inventado.
function emailsDirectorio(): Set<string> {
  return new Set(directorioEjecutivos().map((f) => f.email.toLowerCase()))
}

// Tope de largo del turno combinado (mismo valor que los webhooks).
const MAX_INPUT_CHARS = 2000

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
// Aviso previo a la emisión/actualización de la formal (Lalo 22-sep). Texto
// neutro para los cuatro países: nada de UF, RUT ni chilenismos.
const AVISO_PREPARANDO = "Perfecto, te preparo la cotización formal ahora mismo — dame un momento 🙌"
const AVISO_ACTUALIZANDO = "Dame un momento, dejo tu cotización actualizada 🙌"
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
// (03-sep, caída de la API de Claude) Antes decía "ya le avisé a un ejecutivo"
// y NO avisaba a nadie: quedaba una promesa falsa y el cliente esperando. Orden
// de Lalo: no hay que avisar a nadie, Vicky sigue ella. El texto ya no promete
// un humano — pide un momento y la conversación se retoma por el mismo chat en
// cuanto el cliente vuelve a escribir.
const ESCALADA_ERROR_MSG =
  "Disculpa, tengo un problema técnico y no logro leerte bien 🙏 Dame unos minutos y lo retomamos por acá mismo."

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
  // Nombre de la derivación en las tools clásicas de CO/MX/PE (mismo cierre).
  "derivar_a_ejecutivo",
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

// Contexto que se antepone al prompt cuando el cliente responde por PRIMERA vez a
// un toque de reactivación. Refuerza la excepción "REENGANCHE POR OFERTA" para que
// Vicky retome con continuidad: ofrecer el máximo si no lo tenía / recordar el
// plazo si ya estaba en el tope, siempre con sentido de caducidad.
// Texto único en lib/directivas-turno (22-sep): lo comparten los cuatro países.
const CONTEXTO_REENGANCHE = CONTEXTO_REENGANCHE_COMPARTIDO

// ── SIMULACIÓN (22-sep, banco de pruebas por país) ────────────────────
// El contacto en simulación se marca acá y procesarTurno captura la respuesta
// en vez de enviarla por Botmaker. Un solo mecanismo para los cuatro países.
const SIM_CONTACTOS = new Set<string>()
const SIM_CAPTURA = new Map<string, { reply: string; tools: string[] }>()
function simulando(contact: string): boolean {
  return SIM_CONTACTOS.has(contact)
}

/** Corre la tubería COMPLETA del turno sin enviar por Botmaker y devuelve lo capturado. */
export async function simularTurno(
  contact: string,
  message: string,
  apiKey: string,
  perfil: PerfilTurno = PERFIL_TURNO_CL,
): Promise<{ reply: string; tools: string[] }> {
  SIM_CONTACTOS.add(contact)
  SIM_CAPTURA.delete(contact)
  try {
    await procesarTurno(contact, message, apiKey, perfil)
  } finally {
    SIM_CONTACTOS.delete(contact)
  }
  const cap = SIM_CAPTURA.get(contact)
  SIM_CAPTURA.delete(contact)
  return { reply: cap?.reply || "", tools: cap?.tools || [] }
}

export async function procesarTurno(
  contact: string,
  message: string,
  apiKey: string,
  perfil: PerfilTurno = PERFIL_TURNO_CL,
): Promise<void> {
  try {
    // Tools del país (PE/CO/MX): el mismo set en el turno y en TODOS los
    // reintentos forzados. Chile (undefined) usa el set por defecto del loop.
    const toolsPais = perfil.tools ? await perfil.tools(contact) : null
    // 1. Cargar historial
    const history: ConversationMessage[] = await fetchHistoryV3(contact, 40)

    // 1.1. PROCESO ÚNICO (política Lalo 20-jul, caso Ingesub): conversación
    // NUEVA → ¿el contacto ya está siendo trabajado por un ejecutivo? Si sí,
    // se activa el candado comercial (el agent-loop retira las tools de
    // venta) y la directiva entra al historial — también en memoria para que
    // aplique desde ESTE primer turno.
    if (history.length === 0) {
      const proceso = await detectarProcesoHumano(contact, perfil.pais).catch(() => null)
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
    const contextoCotizacionExistente = perfil.contextoCotizacionExistente
      ? perfil.contextoCotizacionExistente(quotePointers)
      : quotePointers.length > 1
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
    const umbralInfo = paisConUmbral(contact)
      ? await umbralPrecios(contact).catch(() => null)
      : null
    const contextoUmbral = umbralInfo
      ? formatUmbralParaPrompt(umbralInfo.umbral, umbralInfo.origen, perfil.derivacion?.(contact))
      : ""
    // Ejecutivo asignado (caso Carlos/RCT 25-ago): con traspaso activo o
    // derivación sobre-umbral, el prompt recibe nombre/teléfono/correo REALES
    // del ejecutivo — sin esto el modelo improvisaba y llegó a dar el número
    // de la Mesa de Ayuda como si fuera el WhatsApp de la vendedora.
    const contextoEjecutivo = await (async () => {
      const { contextoEjecutivoAsignado } = await import("@/lib/ejecutivo-contexto")
      return contextoEjecutivoAsignado(contact)
    })().catch(() => "")
    const contextoCotizacion =
      contextoUmbral + contextoEjecutivo + (reengaged ? CONTEXTO_REENGANCHE : "") + contextoCotizacionExistente
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
      ? formatDirectivaSobreUmbral(dotacionDetectada, umbralInfo.umbral, perfil.derivacion?.(contact))
      : ""
    // Directiva determinista del marcaje (biblia 12-ago; caso "Mixto" 13-ago,
    // dos veces el mismo día): la regla del prompt sola no alcanza — cuando el
    // cliente ELIGE reloj o marcaje mixto en una respuesta corta, sin declarar
    // cantidades ni sedes, la orden imperativa entra al FINAL del prompt
    // (recencia, igual que la del umbral): 1 punto y 1 reloj asumidos, la
    // única pregunta permitida es la comuna.
    // Texto único en lib/directivas-turno (22-sep): Chile pasa "comuna" y el
    // string es byte a byte el que tenía inline.
    const directivaMarcaje = directivaMarcajeCompartida(message || "", perfil.zona)

    // Directiva determinista RUT-SIN-CORREO (Lalo 31-ago, prueba en vivo): la
    // regla de los tres escenarios del prompt no aguantó el primer caso real
    // (dio el RUT y Vicky respondió "Y tu email?"). El guion pide RUT + email
    // en todas partes, así que la orden va al FINAL, en el contexto inmediato.
    const directivaRutSolo = directivaRutSinCorreo(message || "", history, { documento: perfil.documento })

    // Directiva determinista POST-PAGO (Lalo 18-ago, caso +56978903360): el
    // pagador mandó el comprobante de COT339 y 11 minutos después Vicky le
    // habló como prospecto nuevo y le EMITIÓ una segunda cotización duplicada.
    // Con la marca kv del comprobante fresca (48 h), el contacto está en MODO
    // POST-VENTA: nada de cotizar ni armar valores salvo pedido explícito
    // para OTRA empresa. (La marca la deja registrar_comprobante_transferencia
    // junto con cerrar el loop del remitente.)
    let directivaPostPago = ""
    // MARCA DE PAGO REAL, separada del string de directivas (bug del 11-sep,
    // caso Pabla Solis): `directivaPostPago` acumula TAMBIÉN cliente existente
    // y casuística, así que un TRABAJADOR preguntando por sus marcaciones dejaba
    // el string no vacío y el cinturón de pago-declarado leía eso como "pago
    // verificado" → le respondió "¡Confirmado, tu pago ya quedó registrado!".
    // Solo las dos marcas kv de pago (comprobante_ok_ / pago_online_) la ponen.
    let pagoMarcadoReciente = false
    // CLIENTE EXISTENTE (Lalo 08-sep): número de una cuenta que ya es cliente
    // → soporte/postventa, jamás prospecto (lib/cliente-existente, cache 24 h).
    try {
      const { detectarClienteExistente, directivaClienteExistente } = await import("@/lib/cliente-existente")
      const ce = await detectarClienteExistente(contact)
      if (ce) directivaPostPago += directivaClienteExistente(ce)
    } catch { /* sin señal: prospecto */ }
    // CASUÍSTICA DEL CHAT (Lalo 08-sep): trabajador con problema de marcación,
    // cliente pidiendo la baja, busca empleo, spam… — directiva determinista
    // al final del prompt (lib/casuistica-contacto, puro; calibrado con los
    // 136 "No Calificado" de jun-sep). Los efectos (sin lead, sin traspaso,
    // loop cerrado) corren después de responder, fuera del camino del cliente.
    let casuisticaTurno: import("@/lib/casuistica-contacto").Casuistica | null = null
    try {
      const { clasificarCasuistica, directivaCasuistica } = await import("@/lib/casuistica-contacto")
      const mensajesCliente = [
        ...history.filter((m) => m.role === "user").map((m) => String(m.content || "")).filter((t) => !t.startsWith("[REGISTRO INTERNO")),
        message || "",
      ]
      const cas = clasificarCasuistica(mensajesCliente)
      if (cas.tipo !== "prospecto") {
        directivaPostPago += directivaCasuistica(cas)
        if (!cas.esProspecto) casuisticaTurno = cas
      }
    } catch { /* sin señal: prospecto */ }
    try {
      const marcaComprobante = await getKvValue(`comprobante_ok_${contact}`)
      if (marcaComprobante) {
        const parsed = JSON.parse(marcaComprobante) as { at?: string; numero?: string }
        const edadMs = parsed.at ? Date.now() - new Date(parsed.at).getTime() : Number.POSITIVE_INFINITY
        if (edadMs < 48 * 60 * 60 * 1000) {
          pagoMarcadoReciente = true
          directivaPostPago =
            `\n\n[DIRECTIVA POST-VENTA — obligatoria] Este contacto ACABA de enviar el comprobante de pago de su cotización (${parsed.numero || "registrada"}). Estás en MODO POST-VENTA: NO cotices, NO armes valores, NO preguntes dotación ni marcaje y NO emitas ninguna cotización nueva — su compra YA está cerrada. Acompáñalo con el onboarding y responde sus dudas. SOLO si pide EXPLÍCITAMENTE cotizar para OTRA empresa distinta (con sus palabras, no por iniciativa tuya) puedes volver al flujo de venta.`
        }
      }
      // MÉTODO DE PAGO (P1 27-ago, caso EMD: pagó con TARJETA y Vicky le pidió
      // el comprobante de transferencia). La marca pago_online_ la deja el
      // post-pago SOLO con pago verificado en MercadoPago.
      if (!directivaPostPago) {
        const marcaOnline = await getKvValue(`pago_online_${contact}`)
        if (marcaOnline) {
          const p = JSON.parse(marcaOnline) as { at?: string }
          const edadMs = p.at ? Date.now() - new Date(p.at).getTime() : Number.POSITIVE_INFINITY
          if (edadMs < 48 * 60 * 60 * 1000) {
            pagoMarcadoReciente = true
            directivaPostPago =
              `\n\n[DIRECTIVA POST-VENTA — obligatoria] Este contacto PAGÓ ONLINE (tarjeta vía MercadoPago) y su pago está CONFIRMADO automáticamente. JAMÁS le pidas comprobante de transferencia ni digas que falta validar el pago. Estás en MODO POST-VENTA: NO cotices ni armes valores nuevos — acompáñalo con el onboarding y responde sus dudas. SOLO si pide EXPLÍCITAMENTE cotizar para OTRA empresa vuelves al flujo de venta.`
          }
        }
      }
    } catch { /* sin marca, sin directiva */ }

    // LA PRIMERA SEÑAL CIERRA EL PAGO (Lalo 26-sep, caso NelNav COT1649): además
    // de las dos marcas de arriba, un pago APROBADO en Mercado Pago cierra el
    // pago en este mismo turno aunque todavía no se haya registrado. Se consulta
    // MP solo si el cliente declara pago, manda un adjunto o salió al checkout.
    // Si el cierre viene de MP, el registro (post-pago + alta) se lanza en
    // paralelo y el modelo ya responde como post-venta: nunca pide comprobante.
    let registroPagoEnCurso: Promise<unknown> | null = null
    try {
      const { senalDePago, directivaPagoCerrado } = await import("@/lib/pago-cerrado")
      const pd = await import("@/lib/pago-declarado")
      const adjunto = /^\[El cliente envi[oó] (una imagen|un documento|un archivo)/i.test(String(message || ""))
      let salioAlCheckout = false
      if (quotePointer?.quoteId && !pagoMarcadoReciente) {
        salioAlCheckout = Boolean(await getKvValue(`pf_${quotePointer.quoteId}_salida_mp`).catch(() => null))
      }
      const senal = await senalDePago(contact, {
        quoteId: quotePointer?.quoteId,
        consultarMP: pd.clienteDeclaraPago(message) || adjunto || salioAlCheckout,
      })
      if (senal) {
        pagoMarcadoReciente = true
        directivaPostPago = directivaPagoCerrado(senal)
        console.log(`[pago-cerrado] ${contact}: pago cerrado por ${senal.fuente} (${senal.at})`)
        if (senal.fuente === "mercado_pago" && quotePointer?.quoteId) {
          registroPagoEnCurso = pd.verificarPagoDeclarado(quotePointer.quoteId, 55_000).catch(() => null)
        }
      }
    } catch (e) {
      console.warn(`[pago-cerrado] ${contact}: no se pudo evaluar la señal de pago:`, e instanceof Error ? e.message : e)
    }

    // Directiva determinista de la ETAPA CONSULTIVA (Eduardo 14-ago, caso
    // Rodrigo): Vicky preguntó por la operación, el cliente respondió, y ella
    // volvió a preguntar lo mismo con otras palabras. Si en el historial YA
    // hay una pregunta consultiva suya y este mensaje es la respuesta del
    // cliente, se prohíbe repreguntar: toca parafrasear y mostrar el menú.
    const directivaConsultiva = directivaConsultivaCompartida(history || [])

    // 2. Ruteo de modelo: Sonnet SOLO para el flujo de cotización; Haiku el resto.
    const prefEscalonPre = await getPrefEscalon(contact).catch(() => 0)
    const modelo = perfil.esFlujoCotizacion(message, history, prefEscalonPre, !!quotePointer)
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
    // TAP DEL QUICK-REPLY del alta (híbrido 28-ago): "Crear mi cuenta" viene
    // de la plantilla QR — el intent de Botmaker responde con el flow en
    // sesión (bloque #altaflow), así que Vicky CALLA para no duplicar. Desde el
    // 21-sep vive en lib/onboarding-altaflow-tap (compartido con Perú).
    if (enOnboarding) {
      const { manejarTapAltaQr } = await import("@/lib/onboarding-altaflow-tap")
      if (await manejarTapAltaQr(contact, message, perfil.pais === "pe" ? "pe" : "cl")) return
    }
    const onboarding = enOnboarding ? await armarOnboarding(contact) : null
    // DIRECTIVA DEL ADMINISTRADOR POR CONTACTO (Lalo 08-sep, caso Camila /
    // METALMAQ: el modelo insistía en contar 12 trabajadores y mandarla a
    // revisar la página mientras el admin le decía otra cosa por push). vic_kv
    // `directiva_admin_<fono>` = texto que se pega AL FINAL del system prompt
    // (venta u onboarding) como orden que gana sobre todo lo demás. Se borra
    // dejando la kv vacía. Sin kv, nada cambia.
    let directivaAdmin = ""
    try {
      const da = (await getKvValue(`directiva_admin_${contact}`)) || ""
      if (da.trim()) directivaAdmin = `\n\n[DIRECTIVA DEL ADMINISTRADOR — obligatoria, prevalece sobre cualquier otra regla] ${da.trim()}`
    } catch { /* sin directiva */ }

    // AVISO PREVIO A LA EMISIÓN (Lalo 22-sep): la formal tarda 10-20 s (Zoho,
    // PDF, correo) y el cliente veía solo "escribiendo…". Justo cuando arranca
    // generar_link_cotizadora / actualizar_cotizacion sale UN mensaje corto,
    // una sola vez por turno (los reintentos forzados no lo repiten). En
    // simulación no se manda. Alcance: global.
    let avisoPrevioEnviado = false
    const alIniciarTool = async (toolName: string) => {
      if (avisoPrevioEnviado || simulando(contact)) return
      if (toolName !== "generar_link_cotizadora" && toolName !== "actualizar_cotizacion") return
      avisoPrevioEnviado = true
      const aviso = toolName === "actualizar_cotizacion" ? AVISO_ACTUALIZANDO : AVISO_PREPARANDO
      await sendBotmakerMessage(contact, aviso, perfil.channelId).catch(() => false)
      console.log(`[v3-bg] aviso previo (${toolName}) enviado a ${contact}`)
    }

    // Correr el agent
    const result = await runAgentLoop({
      alIniciarTool,
      systemPrompt: onboarding
        ? onboarding.systemPrompt + directivaAdmin
        : contextoCotizacion + (perfil.systemPrompt(contact, umbralInfo?.umbral) + lineaZonaHoraria(perfil.pais)) + contextoUmbral + directivaUmbral + directivaMarcaje + directivaConsultiva + directivaPostPago + directivaRutSolo + directivaAdmin + (await directivaCanalMeta(contact)),
      history,
      userMessage: message,
      apiKey,
      contact,
      // Onboarding siempre con el modelo grande: recopila datos de un alta
      // irreversible, no es un turno "simple".
      model: onboarding ? MODELO_COTIZACION : modelo,
      ...(onboarding ? { tools: onboarding.tools } : toolsPais ? { tools: toolsPais } : {}),
    })

    let reply = (result.reply || "").trim()

    // TURNO VACÍO SIN TOOLS (26-sep): el modelo cerró sin texto y el agent-loop
    // lo convirtió en "tuve un problema procesando tu mensaje" — seis casos en
    // dos semanas, tres después de una pregunta real ("me acomoda la opción 2…",
    // "Iquique, Tarapacá", una planilla). Un reintento con la orden explícita
    // de contestar; si el cliente solo agradeció o se despidió y sigue vacío,
    // un cierre cordial en vez del error.
    if (reply === AGENT_LOOP_EMPTY_FALLBACK && !((result.toolCalls || []) as ToolCallRecord[]).some((c) => c.ok)) {
      console.warn(`[v3-bg] TURNO_VACIO contact=${contact}: reintento con orden de contestar`)
      const retryVacio = await runAgentLoop({
        alIniciarTool,
        systemPrompt:
          (onboarding
            ? onboarding.systemPrompt + directivaAdmin
            : contextoCotizacion + (perfil.systemPrompt(contact, umbralInfo?.umbral) + lineaZonaHoraria(perfil.pais)) + contextoUmbral + directivaUmbral + directivaMarcaje + directivaConsultiva + directivaPostPago + directivaRutSolo + directivaAdmin) +
          "\n\n# Instrucción de sistema (este turno)\nTu turno anterior quedó VACÍO. Responde en texto al ÚLTIMO mensaje del cliente, breve y concreto; si corresponde una tool, úsala y entrega su mensajeParaProspecto. Nunca cierres el turno sin texto.",
        history,
        userMessage: message,
        apiKey,
        contact,
        model: onboarding ? MODELO_COTIZACION : modelo,
        ...(onboarding ? { tools: onboarding.tools } : toolsPais ? { tools: toolsPais } : {}),
      }).catch(() => null)
      const r2 = (retryVacio?.reply || "").trim()
      if (retryVacio && r2 && r2 !== AGENT_LOOP_EMPTY_FALLBACK) {
        reply = r2
        result.toolCalls = retryVacio.toolCalls
      } else {
        const { esCortesia } = await import("@/lib/rechazo-cliente")
        if (esCortesia(message)) reply = "Quedo atenta por aquí para lo que necesites 😊"
      }
    }

    // HITO DE INTENCIÓN SIN TOOL (arreglo 2, Lalo 07-sep, caso Conbes): con
    // RUT del cliente en el chat, el CRM nace ya — no espera a que Vicky
    // llame una tool. Best-effort en paralelo; una vez por conversación.
    if (casuisticaTurno) {
      const cas = casuisticaTurno
      void import("@/lib/casuistica-runtime")
        .then((m) => m.aplicarCasuisticaNoProspecto(contact, cas, "webhook"))
        .catch(() => undefined)
    } else if (!enOnboarding && perfil.hitoPorChat) {
      void import("@/lib/hito-por-chat")
        .then((m) => m.hitoIntencionDesdeChat(contact))
        .catch(() => undefined)
    }

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
      // CONVENCIÓN DE NIVEL DE LOG EN LOS CINTURONES (04-sep).
      // Un cinturón que ataja algo NO es una falla: es el sistema haciendo su
      // pega — el cliente recibió la respuesta corregida y nadie tiene que ir
      // a apagar un incendio. Por eso todos los cinturones de este archivo van
      // en `warn`: quedan escritos y buscables, pero fuera del panel de
      // errores de Vercel, que es el que dispara las alertas al equipo. Un
      // tercio del ruido que le llegaba a Rodrigo eran cinturones exitosos.
      // En `error` se queda SOLO lo que de verdad se rompió y nadie atajó:
      // los "Reintento forzado ... falló", el fallo al persistir el turno, el
      // fallo al enviar la respuesta y el CIRCUIT_BREAKER.
      console.warn(
        `[v3-bg] LINK_FABRICADO contact=${contact} replyOriginal=${JSON.stringify(reply.slice(0, 300))}`,
      )
      const esContextoCert = /certificaci|direcci[oó]n del trabajo|\bDT\b|resoluci[oó]n/i.test(reply)
      if (esContextoCert && perfil.certificacionDT) {
        reply = reply.replace(
          LINK_FABRICADO,
          "https://www.dt.gob.cl/legislacion/1624/articles-127208_recurso_1.pdf",
        )
      } else {
        reply = reply.replace(LINK_FABRICADO, "(te lo hago llegar enseguida)").trim()
      }
    }

    // 2.4b-bis. GUARDIA MESA DE AYUDA EN CONVERSACIÓN COMERCIAL (26-ago, caso
    // Cowork/Ariel; segundo incidente tras Tamara 25-ago): el modelo presentó
    // "Eddyluz Mujica al +56 9 4401 3873" — nombre inventado + el número de la
    // MESA DE AYUDA como si fuera del ejecutivo (el sorteo real era Anderson).
    // Determinista: el número de la Mesa solo puede aparecer si ESTE turno
    // corrió consultar_agente_soporte; si no, la ORACIÓN que lo contiene se
    // retira completa (recortar solo el número deja frases cojas), con
    // fallback honesto si la respuesta queda vacía.
    {
      const MESA_RE = /(\+?\s?56\s?9?\s?4401\s?3873|944013873|4401\s?3873)/
      const huboSoporteTurno = (result.toolCalls || []).some(
        (c) => c.name === "consultar_agente_soporte" && c.ok,
      )
      if (!huboSoporteTurno && MESA_RE.test(reply)) {
        console.warn(
          `[v3-bg] MESA_EN_COMERCIAL contact=${contact} replyOriginal=${JSON.stringify(reply.slice(0, 250))}`,
        )
        const frases = reply.split(/(?<=[.!?😊🙌🙏])\s+|\n+/)
        const limpias = frases.filter((f) => !MESA_RE.test(f))
        reply = limpias.join("\n").trim()
        if (!reply) reply = "Nuestro ejecutivo se va a contactar contigo en breve por este mismo medio 😊"
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
      /^https?:\/\/(?:(?:[a-z0-9-]+\.)*(?:geovictoria\.com|supabase\.co|dt\.gob\.cl|wa\.me|cal\.com|mercadopago\.[a-z.]+|mpago\.[a-z]+|youtube\.com|youtu\.be|hubspotusercontent-na1\.net)(?:[/?#]|$)|geovictoria-demo-agent\.vercel\.app\/?$)/i
    for (const u of reply.match(/https?:\/\/[^\s)]+/gi) || []) {
      if (DOMINIOS_VICKY.test(u)) continue
      if (vieneDeUnaTool(u, urlsDeTools)) {
        console.log(`[v3-bg] LINK_DE_TOOL_RESCATADO contact=${contact} url=${u.slice(0, 140)}`)
        continue
      }
      console.warn(`[v3-bg] LINK_FUERA_DE_ALLOWLIST contact=${contact} url=${u.slice(0, 140)}`)
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
    // Procedencia HISTORIAL (27-ago, caso Mesa Incógnita): un link que VICKY
    // MISMA ya le envió antes a este contacto no es alucinación — es el
    // re-envío del link de siempre. El puntero cubría esto, pero los punteros
    // de cotizaciones viejas se pierden (COT379 era del 05-ago) y el cinturón
    // fusilaba el re-envío legítimo con la disculpa enlatada — TRES veces,
    // mientras el cliente contaba que se fue a la competencia por falta de
    // seguimiento. El riesgo Multirut (reusar link viejo para una cotización
    // NUEVA) queda cubierto por el resto del embudo: acá solo se aceptan URLs
    // EXACTAS ya enviadas por el asistente en esta conversación.
    const urlsEnHistorial =
      urlsCotizadorReply.length > 0 &&
      urlsCotizadorReply.every((u) =>
        history.some((h) => h.role === "assistant" && String(h.content || "").includes(u)),
      )
    // (los reintentos forzados son del flujo de VENTA: re-corren el loop con el
    // prompt y las tools de venta, así que en fase onboarding no deben disparar)
    if (
      !enOnboarding &&
      hasCotizacionUrl &&
      !realCotizacion &&
      !reenviaLinkConocido &&
      !urlsVienenDeTools &&
      !urlsEnHistorial
    ) {
      console.warn(
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
          contextoCotizacion + (perfil.systemPrompt(contact, umbralInfo?.umbral) + lineaZonaHoraria(perfil.pais)) + contextoUmbral + directivaUmbral + FORZAR_TOOL_COTIZACION,
        history,
        userMessage: message,
        apiKey,
        contact,
        model: MODELO_COTIZACION,
        alIniciarTool,
        ...(toolsPais ? { tools: toolsPais } : {}),
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
        // CONTENCIÓN HONESTA + ROMPE-LOOP + AVISO INTERNO (27-ago, casos Mesa
        // Incógnita y Renca 29-jul): la disculpa vieja MENTÍA ("tuve un
        // problema generando tu cotización" ante un "holaa") y le pedía
        // trabajo al cliente ("¿me confirmas otra vez?"). Y sin rompe-loop
        // salió dos veces seguidas al mismo cliente. Ahora: texto neutro que
        // no inventa una emisión en curso; si la contención ya salió hace
        // poco, no se repite — se avisa al equipo (respaldo real) y se dice.
        const CONTENCION_VIEJA =
          "Disculpa, tuve un problema generando tu cotización formal. ¿Me confirmas otra vez para procesarla?"
        const CONTENCION_URL =
          "Perdón, se me enredó el sistema con este mensaje 🙈 ¿Me repites en una línea qué necesitas? Te respondo al tiro."
        const contencionReciente = history
          .slice(-6)
          .some(
            (h) =>
              h.role === "assistant" &&
              (String(h.content || "").includes(CONTENCION_URL) ||
                String(h.content || "").includes(CONTENCION_VIEJA)),
          )
        void avisarEquipoInterno(
          `⚠️ Cinturón de URL contuvo la respuesta a +${contact} (${contencionReciente ? "REINCIDENTE — revisar el chat ya" : "primera vez en la conversación"}). ` +
            `Borrador del modelo: "${reply.slice(0, 180)}"`,
        ).catch(() => false)
        reply = contencionReciente
          ? "Le pedí una mano a nuestro equipo para responderte bien esto — te escribimos enseguida 🙌"
          : CONTENCION_URL
      }
    }

    // 2.5-bis. NINGÚN PRECIO SALE SIN RESPALDO (04-sep, caso Carlos/Anton Paar).
    //
    // Vicky le dijo que su plan subía de $43.781 a "$47.642 con 6 personas".
    // Falso: el tramo 3-10 es FIJO. Nadie calculó ese número — el modelo lo
    // compuso, y el cliente bajó su pedido de 6 personas a 5 por una cifra
    // inventada (la cachó dos veces: "creo que subió el precio").
    //
    // Misma regla de procedencia que el cinturón de URLs: un monto vale si lo
    // produjo una tool de precio de ESTE turno, o si Vicky ya se lo había
    // dicho antes a este contacto (repetir el precio vigente es legítimo).
    {
      const { chequearPreciosDelReply } = await import("@/lib/precio-sin-tool")
      const toolsOk = (toolCalls || []).filter((c) => c.ok).map((c) => c.name)
      const histAsistente = history
        .filter((h) => h.role === "assistant")
        .map((h) => String(h.content || ""))
      const chequeo = chequearPreciosDelReply(reply, toolsOk, histAsistente)
      if (!enOnboarding && chequeo.hayInventado) {
        console.warn(
          `[v3-bg] PRECIO_SIN_TOOL contact=${contact} montos=${JSON.stringify(chequeo.inventados)} replyOriginal=${JSON.stringify(reply.slice(0, 300))}`,
        )
        const FORZAR_TOOL_PRECIO =
          "\n\n# Instrucción de sistema (este turno)\n" +
          "Tu borrador anterior AFIRMÓ un precio que ninguna tool calculó en este turno y que " +
          "tú nunca le habías dicho a este cliente. PROHIBIDO componer, estimar o extrapolar " +
          "precios: el motor es la única fuente. Si el cliente pregunta por un valor nuevo " +
          "(otra dotación, otra configuración), llama AHORA la tool que corresponde " +
          "(cotizar_referencial o actualizar_cotizacion) y entrega su cifra tal cual. Si el " +
          "precio no cambió, dilo sin inventar una cifra nueva."
        const retryP = await runAgentLoop({
          systemPrompt:
            contextoCotizacion + (perfil.systemPrompt(contact, umbralInfo?.umbral) + lineaZonaHoraria(perfil.pais)) + contextoUmbral + directivaUmbral + FORZAR_TOOL_PRECIO,
          history,
          userMessage: message,
          apiKey,
          contact,
          model: MODELO_COTIZACION,
          alIniciarTool,
          ...(toolsPais ? { tools: toolsPais } : {}),
        }).catch(() => null)
        const rReply = (retryP?.reply || "").trim()
        const rTools = ((retryP?.toolCalls || []) as ToolCallRecord[]).filter((c) => c.ok).map((c) => c.name)
        const rOk = rReply && !chequearPreciosDelReply(rReply, rTools, histAsistente).hayInventado
        if (rOk) {
          console.warn(`[v3-bg] PRECIO_RECUPERADO contact=${contact}`)
          reply = rReply
          if (retryP?.toolCalls) result.toolCalls = retryP.toolCalls
        } else {
          // El precio equivocado a un cliente que está por pagar es peor que
          // una demora: se contiene y el equipo se entera (mismo criterio que
          // el cinturón de URLs).
          reply =
            "Déjame confirmarte el valor exacto con el sistema para no darte una cifra equivocada — te lo digo en un momento 🙌"
        }
        void avisarEquipoInterno(
          `⚠️ PRECIO SIN RESPALDO a +${contact}: el modelo afirmó ${chequeo.inventados.join(", ")} sin tool. ` +
            `${rOk ? "Recuperado con la tool en el reintento." : "CONTENIDO — revisar el chat."}`,
        ).catch(() => false)
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
    // AMPLIADO 26-ago (caso Leonardo/Rovira COT905): el modelo prometió "20%
    // menos durante los primeros 6 meses" — la forma "X% menos" no matcheaba
    // y la promesa salió sin tool (la formal nació con otro %). Se suman
    // "dcto", "rebaja", "off" y "X% menos" (esta última exige señal de precio
    // en el contexto para no confundirse con pitches tipo "30% menos de
    // atrasos").
    const PCT_DESCUENTO_RE =
      /(\d{1,3})\s*%\s*(?:de\s+)?(?:descuento|dcto|rebaja|off)|(?:descuento|dcto|rebaja)\s+del?\s+(\d{1,3})\s*%|(\d{1,3})\s*%\s*menos/gi
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
      // La forma "X% menos" solo cuenta con señal de PRECIO alrededor (evita
      // falsos positivos de pitch: "un 30% menos de atrasos").
      if (m[3] !== undefined && !/\$|\bprecio|\bplan\b|mensual|\buf\b|\biva\b|paga/i.test(contexto)) continue
      ofrecePctDescuento = true
      if (pctNegociado === null) pctNegociado = Number(m[1] ?? m[2] ?? m[3])
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
    // DOS MULETILLAS DISTINTAS (14-sep, caso Dubraska): la que nombra el
    // DESCUENTO siempre es de negociación; la genérica ("déjame confirmarte el
    // valor con el sistema") la produce el cinturón de PRECIO en turnos que no
    // tienen nada que ver — a ella, que preguntó si hay que devolver el reloj
    // arrendado, la genérica la mandó al enlatado "tu cotización ya quedó con
    // el mejor precio… ¿te contacto con un ejecutivo?". La genérica solo cuenta
    // como muletilla de descuento si el turno REALMENTE trata de descuento.
    const muletillaDescuentoExplicita =
      /perm[ií]teme\s+procesar\s+el\s+descuento/i.test(reply) ||
      /d[eé]jame\s+(confirmar(te)?|revisar|procesar|chequear)\b[^.]{0,40}\b(descuento|porcentaje)\b/i.test(reply) ||
      /voy\s+a\s+revisar\b[^.]{0,30}\bdescuento\b/i.test(reply)
    const muletillaValorGenerica =
      /d[eé]jame\s+(confirmar(te)?|revisar|procesar|chequear)\b[^.]{0,40}\bel\s+sistema\b/i.test(reply) ||
      /voy\s+a\s+revisar\b[^.]{0,30}\bel\s+sistema\b/i.test(reply)
    const turnoHablaDeDescuento =
      /descuento|dcto|rebaj|m[aá]s\s+barat|precio\s+especial|mejor\s+precio/i.test(String(message || "")) ||
      /descuento|dcto|rebaj/i.test(reply)
    const pareceMuletillaDescuento =
      muletillaDescuentoExplicita || (muletillaValorGenerica && turnoHablaDeDescuento)
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
    // OJO (caso Ivanna 27-ago): la sola PALABRA "descuento" NO es pedir rebaja
    // — "¿en cuánto queda la cuota cuando pasen los 6 meses del descuento?" es
    // una pregunta INFORMATIVA sobre el descuento ya comiteado, y con el match
    // amplio anulaba la exención de recapitulación benigna (la respuesta con
    // los números reales se reemplazaba por la enlatada "ya quedó con el mejor
    // precio"). Pedir rebaja exige forma de PETICIÓN.
    const pideRebaja =
      /\b((alg[uú]n|otro|m[aá]s|mejor)\s+descuento|descuento\s+adicional|(quiero|dame|dan|das|hay|tienes?|tienen|hacen|har[ií]an|aplican?|manejan)\s+(alg[uú]n\s+|un\s+|el\s+|m[aá]s\s+)?descuento|rebaj\w+|m[aá]s\s+barat\w+|muy\s+caro|me\s+lo\s+dejar?[ií]?a?s\b|d[eé]jamelo\s+(a|en)\b|baj[ae]\w*\s+(el\s+)?precio)/i.test(
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
            contextoCotizacion + (perfil.systemPrompt(contact, umbralInfo?.umbral) + lineaZonaHoraria(perfil.pais)) + contextoUmbral + directivaUmbral + FORZAR_TOOL_DESCUENTO,
          history,
          userMessage: message,
          apiKey,
          contact,
          model: MODELO_COTIZACION,
          alIniciarTool,
          ...(toolsPais ? { tools: toolsPais } : {}),
        }).catch((e) => {
          console.error(`[v3-bg] Reintento forzado de descuento falló:`, e)
          return null
        })
        if (retry) {
          const retryReply = (retry.reply || "").trim()
          const retryTools = (retry.toolCalls || []) as ToolCallRecord[]
          const retryReal = retryTools.some(
            (c) =>
              // PRE-formal solo cuenta la tool REFERENCIAL (01-sep, caso
              // Rodrigo/$62.758): sin formal en ESTA conversación, el modelo
              // llamó consultar_siguiente_descuento y escaló sobre una
              // cotización VIEJA de otra prueba del mismo RUT — número real
              // pero de otra configuración, incoherente con todo lo conversado.
              (tieneFormal
                ? c.name === "consultar_siguiente_descuento" ||
                  c.name === "aplicar_siguiente_descuento" ||
                  c.name === "consultar_descuento_referencial"
                : c.name === "consultar_descuento_referencial" ||
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

      // ROMPE-LOOP ROBUSTO (27-ago, caso Mesa Incógnita: NUEVE muletillas
      // idénticas seguidas — el chequeo por "último mensaje exacto" no bastó y
      // el cliente terminó contratando a la competencia). Ahora se cuentan
      // TODAS las contenciones de este guardrail en los últimos 6 mensajes del
      // asistente; a la segunda, se escala con aviso interno REAL y no se
      // vuelve a mandar ningún enlatado.
      const TEXTOS_CONTENCION_DESCUENTO = [
        ...MULETILLAS_DESCUENTO,
        "Para no darte más vueltas con los números",
        "Ese es el mejor precio que te puedo ofrecer",
        "Tu cotización ya quedó con el mejor precio",
        "No quiero marearte con vueltas de números",
      ]
      const contencionesRecientes = history
        .filter((h) => h.role === "assistant")
        .slice(-6)
        .filter((h) => TEXTOS_CONTENCION_DESCUENTO.some((t) => String(h.content || "").includes(t))).length
      if (!recuperado && contencionesRecientes >= 2) {
        console.warn(
          `[v3-bg] LOOP_DESCUENTO_ESCALADO contact=${contact} contenciones=${contencionesRecientes}`,
        )
        void avisarEquipoInterno(
          `🔁 Guardrail de descuento atascado con +${contact} (${contencionesRecientes} contenciones recientes) — revisar el chat YA. ` +
            `Último mensaje del cliente: "${String(message || "").slice(0, 140)}"`,
        ).catch(() => false)
        reply =
          "Le pedí a nuestro equipo que revise tu caso para darte una respuesta bien precisa — te escribimos enseguida 🙌"
      } else if (recuperado) {
        // ya tenemos un % real desde la tool; no aplicar muletilla.
      } else if (MULETILLAS_DESCUENTO.has(ultimoAsistente || "")) {
        // (B2) Ya pedimos "procesar el descuento" el turno anterior: romper el
        // loop cerrando hacia una decisión o derivación.
        console.warn(
          `[v3-bg] LOOP_MULETILLA_ROTO contact=${contact} replyOriginal=${JSON.stringify(reply.slice(0, 300))}`,
        )
        reply =
          "Para no darte más vueltas con los números: te dejo el mejor precio que te ofrecí y te paso la cotización formal, o si prefieres te contacto con un ejecutivo para revisar el precio. Cómo prefieres?"
      } else if (committedRecPct >= 20) {
        // En el tope ya no hay margen y el prompt prohíbe volver a llamar la
        // tool: en vez de la muletilla "permíteme procesar el descuento" (paso
        // intermedio que sobra acá), declina firme en UNA sola frase.
        console.warn(
          `[v3-bg] TOPE_DECLINE_LIMPIO contact=${contact} replyOriginal=${JSON.stringify(reply.slice(0, 300))}`,
        )
        reply =
          "Ese es el mejor precio que te puedo ofrecer: 20% de descuento en el plan mensual. Lo tomas así, o prefieres que te contacte un ejecutivo para revisarlo?"
      } else if (tieneFormal) {
        // Post-formal: el descuento ya está cerrado en la cotización. NO metas la
        // muletilla "permíteme procesar el descuento" (paso intermedio que aquí
        // sobra y confunde —p. ej. cuando el cliente solo se está despidiendo—):
        // cierra suave hacia la decisión o la derivación.
        console.warn(
          `[v3-bg] POST_FORMAL_NO_MULETILLA contact=${contact} replyOriginal=${JSON.stringify(reply.slice(0, 300))}`,
        )
        reply =
          "Tu cotización ya quedó con el mejor precio que te ofrecí. Si quieres revisarla o ajustar algo, te puedo contactar con un ejecutivo. ¿Cómo prefieres seguir?"
      } else {
        // DERIVA CORREGIDA (27-ago): el comentario histórico de este branch
        // decía "tampoco mandamos la muletilla" pero el código la mandaba —
        // era LA muletilla que atrapó a Mesa Incógnita 9 veces. Ahora cierra
        // hacia una DECISIÓN, honesto y sin "procesar en el sistema".
        console.warn(
          `[v3-bg] DESCUENTO_SIN_TOOL contact=${contact} replyOriginal=${JSON.stringify(reply.slice(0, 400))}`,
        )
        reply =
          "No quiero marearte con vueltas de números: puedo dejarte la cotización formal con el mejor precio que te ofrecí, o contactarte con un ejecutivo para revisarlo. ¿Qué prefieres?"
      }
    }

    // 2.6b'. Cinturón de TELÉFONOS DE EJECUTIVOS (P1 27-ago, caso RCT: Vicky
    // presentó el número de la Mesa de Ayuda como si fuera el de Tamara,
    // habiendo dado el correcto antes — 3 casos de números mezclados en el
    // catastro de Rodrigo). Fuente única: lib/directorio-ejecutivos. Si la
    // respuesta nombra a UN ejecutivo del directorio junto a un número que no
    // es el suyo (ni oficial en contexto de soporte, ni aportado por el
    // cliente), el número se corrige por el del directorio y se avisa interno.
    try {
      const { corregirTelefonosEjecutivos } = await import("@/lib/directorio-ejecutivos")
      const numerosCliente = new Set<string>([contact.replace(/\D/g, "")])
      const sumar = (texto: string) => {
        for (const m of texto.match(/\+?\d[\d\s.-]{7,}\d/g) || []) {
          const d = m.replace(/\D/g, "")
          if (d.length >= 8) numerosCliente.add(d)
        }
      }
      for (const h of history) if (h.role === "user") sumar(String(h.content || ""))
      sumar(String(message || ""))
      const fix = corregirTelefonosEjecutivos(reply, numerosCliente)
      if (fix.correcciones.length > 0) {
        console.warn(
          `[v3-bg] TELEFONO_EJECUTIVO_CORREGIDO contact=${contact} ${JSON.stringify(fix.correcciones)}`,
        )
        void avisarEquipoInterno(
          `📵 Corregí un teléfono mal atribuido en el chat con +${contact}: ` +
            fix.correcciones.map((c) => `${c.nombre}: "${c.malo}" → ${c.bueno}`).join("; "),
        ).catch(() => false)
        reply = fix.reply
      }
    } catch { /* cinturón best-effort: jamás bloquea la respuesta */ }

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
        systemPrompt: contextoCotizacion + (perfil.systemPrompt(contact, umbralInfo?.umbral) + lineaZonaHoraria(perfil.pais)) + contextoUmbral + directivaUmbral + FORZAR_TOOL_AGENDA,
        history,
        userMessage: message,
        apiKey,
        contact,
        model: MODELO_COTIZACION,
        alIniciarTool,
        ...(toolsPais ? { tools: toolsPais } : {}),
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
        console.warn(
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
        // 10-sep: la alerta sola no persigue a nadie (12 casos en 30 días).
        // Promesa PENDIENTE en el vigía → vence en 2 h hábiles, alerta con
        // dueño y cae en la Cartera hasta que alguien la agende.
        try {
          const { registrarPromesa } = await import("@/lib/promesas")
          await registrarPromesa({ contact, tipo: "callback", detalle: "reunión pendiente de registro (el modelo no ejecutó agendar_reunion)", horasHabiles: 2 })
        } catch { /* best-effort */ }
      }
    }

    // 2.6b'. CAPACITACIÓN "AGENDADA" SIN TOOL (05-sep, prueba E1): la reserva
    // en Bookings falló, la tool devolvió el error con la orden "NO afirmes
    // que quedó agendada", y el modelo respondió "Déjame confirmarte la hora
    // por este chat: tu capacitación queda agendada para mañana 08…". Sin
    // reserva no hay invitación, ni link de Teams, ni correo del jefe, y el
    // cliente quedó esperando una capacitación que no existe. Gemelo del
    // cinturón de reuniones, para la fase de onboarding: afirmar agenda de
    // capacitación exige agendar_capacitacion ok en ESTE turno (o que la
    // capacitación ya estuviera agendada antes — ahí recordarla es legítimo).
    if (enOnboarding) {
      const afirmaCapacitacion =
        /capacitaci[oó]n[^.\n]{0,80}\b(qued[oó]|queda|est[aá])\s+(agendad|confirmad|reservad|lista)/i.test(reply) ||
        /\b(qued[oó]|queda)\s+agendad[ao]\b[^.\n]{0,60}\bcapacitaci[oó]n/i.test(reply) ||
        /\bte\s+(la\s+)?agend[eé]\b[^.\n]{0,60}\bcapacitaci[oó]n/i.test(reply)
      // E10 05-sep: "Listo, cancelé la capacitación del martes…" pasó el filtro
      // porque solo miraba "quedó cancelada" — la primera persona también cuenta.
      const afirmaCambio = /capacitaci[oó]n[^.\n]{0,80}\bqued[oó]\s+(reagendad|cambiad|movid|cancelad)/i.test(reply) ||
        /\bqued[oó]\s+(reagendad|cancelad)[ao]\b[^.\n]{0,60}\bcapacitaci[oó]n/i.test(reply) ||
        /\b(?:ya\s+)?(?:la\s+|te\s+la\s+)?(cancel[eé]|reagend[eé]|mov[ií]|cambi[eé])\b[^.\n]{0,60}\bcapacitaci[oó]n/i.test(reply) ||
        /\bcapacitaci[oó]n[^.\n]{0,60}\b(cancelada|reagendada|anulada)\b/i.test(reply)
      const cambioReal = toolCalls.some((c) => (c.name === "reagendar_capacitacion" || c.name === "cancelar_capacitacion") && c.ok)
      if (afirmaCambio && !cambioReal) {
        console.warn(`[v3-bg] ALUCINACIÓN_REAGENDA contact=${contact} replyOriginal=${JSON.stringify(reply.slice(0, 400))}`)
        reply =
          "El cambio de tu capacitación todavía no quedó tomado en la agenda — no te lo doy por hecho hasta que entre. Te lo confirmo por este mismo chat en un momento 🙌"
        await avisarEquipoInterno(
          `⚠️ CAPACITACIÓN: el modelo afirmó un cambio/cancelación sin tool — contacto +${contact}. Revisar el chat y la reserva en Bookings.`,
        ).catch(() => false)
      }
      const agendoReal = toolCalls.some((c) => c.name === "agendar_capacitacion" && c.ok)
      let yaEstabaAgendada = false
      if (afirmaCapacitacion && !agendoReal) {
        try {
          const { claveCapacitacion } = await import("@/lib/onboarding/fase")
          const raw = (await getKvValue(claveCapacitacion(contact))) || ""
          yaEstabaAgendada = /"bookingId"\s*:\s*"[^"]+"/.test(raw)
        } catch { /* sin kv, se trata como no agendada */ }
      }
      if (afirmaCapacitacion && !agendoReal && !yaEstabaAgendada) {
        console.warn(`[v3-bg] ALUCINACIÓN_CAPACITACION contact=${contact} replyOriginal=${JSON.stringify(reply.slice(0, 400))}`)
        reply =
          "La hora todavía no quedó tomada en la agenda — no te la doy por confirmada hasta que entre. Te la confirmo por este mismo chat en un momento; no necesitas hacer nada 🙌"
        await avisarEquipoInterno(
          `⚠️ CAPACITACIÓN sin reserva real — contacto +${contact}: el modelo la dio por agendada sin que agendar_capacitacion tuviera éxito. Revisar el chat y agendar a mano en Bookings.`,
        ).catch(() => false)
      }
    }

    // 2.6b''. Guardrail "COTIZACIÓN ACTUALIZADA" SIN TOOL (27-ago, caso
    // Guillermo/Genesys COT956): el cliente pidió la variante solo-app, el
    // modelo anunció "te envío la cotización actualizada solo con app" y
    // despachó el PDF VIGENTE (reloj) sin actualizar nada — cliente con un
    // documento etiquetado al revés. Anunciar "actualizada/nueva versión"
    // exige que actualizar_cotizacion (o una emisión) haya corrido DE VERDAD
    // en este turno. Gemelo del guardrail de reunión agendada.
    const ANUNCIA_ACTUALIZADA_RE =
      /cotizaci[oó]n\s+(actualizada|modificada|corregida)|actualic[eé]\s+(tu|la)\s+cotizaci[oó]n|te\s+(env[ií]o|mando|mand[eé]|acabo\s+de\s+mandar)\s+la\s+cotizaci[oó]n\s+actualizada|nueva\s+versi[oó]n\s+de\s+(tu|la)\s+cotizaci[oó]n/i
    // aplicar_siguiente_descuento y anualizar_cotizacion TAMBIÉN regeneran la
    // cotización (falso positivo 01-sep: la promesa post-llamada aplicó el 10%
    // de verdad y el guardrail igual reemplazó el anuncio por la pregunta
    // enlatada — trabajo bien hecho, celado por el guardia).
    const actualizoReal = toolCalls.some(
      (c) =>
        (c.name === "actualizar_cotizacion" ||
          c.name === "generar_link_cotizadora" ||
          c.name === "aplicar_siguiente_descuento" ||
          c.name === "anualizar_cotizacion") &&
        c.ok,
    )
    if (!enOnboarding && ANUNCIA_ACTUALIZADA_RE.test(reply) && !actualizoReal) {
      console.warn(
        `[v3-bg] ACTUALIZADA_SIN_TOOL contact=${contact} replyOriginal=${JSON.stringify(reply.slice(0, 300))}`,
      )
      // ESCAPE DEL BUCLE (01-sep, caso Lalo post-llamada): el cliente dijo
      // "sí" DOS veces y esta guarda le repitió la misma pregunta enlatada —
      // la tool seguía sin correr bien y no había salida. A la segunda vez en
      // 30 min: honestidad + aviso interno (patrón del guardrail de agenda),
      // jamás la misma pregunta de nuevo.
      const kvLoop = `act_sin_tool_${contact}`
      const previa = Number((await getKvValue(kvLoop).catch(() => null)) || 0)
      const reciente = previa > 0 && Date.now() - previa < 30 * 60 * 1000
      if (reciente) {
        reply =
          "Disculpa, tuve un problema técnico al actualizar tu cotización — ya le avisé al equipo y te la hago llegar corregida apenas esté lista, no necesitas confirmarme nada más 🙌"
        await setKvValue(kvLoop, "0").catch(() => {})
        await avisarEquipoInterno(
          `⚠️ ACTUALIZACIÓN de cotización FALLÓ dos veces seguidas — contacto +${contact}. El cliente ya confirmó el cambio y quedó con la promesa: revisar la conversación y actualizar/enviar a mano.`,
        ).catch(() => {})
      } else {
        await setKvValue(kvLoop, String(Date.now())).catch(() => {})
        reply =
          "Ojo conmigo, para ser bien precisa: tu cotización formal sigue siendo la vigente — todavía no la he actualizado. ¿Quieres que la deje con esta nueva configuración? Me confirmas y la actualizo al tiro, y te llega el documento corregido 😊"
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
    // CASO FRANCISCA (14-sep, +56956387811): preguntó "cuando podrian
    // instalarlo?" dos minutos después de recibir su cotización y este
    // cinturón le tapó la respuesta con el enlatado del rescate — porque el
    // detector incluía la forma GENÉRICA "el equipo te va a contactar", que
    // es justo la respuesta CORRECTA a una pregunta de plazo. Y de paso
    // registró una promesa falsa y le cerró el loop.
    // La regla vive en lib/promesa-contacto (PURA, con tests): la afirmación
    // EXPLÍCITA de registro siempre cuenta; la genérica cuenta salvo que el
    // cliente esté preguntando un plazo operativo y nunca haya pedido que lo
    // contacten. Mismo patrón que `turnoHablaDeDescuento` del 14-sep.
    const textosClienteTurno = history
      .filter((m) => m.role === "user")
      .map((m) => String(m.content || ""))
      .concat([String(message || "")])
    const afirmaCallbackListoEn = (t: string) =>
      prometeContactoSinRegistro(t, {
        mensajeCliente: String(message || ""),
        textosCliente: textosClienteTurno,
      })
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
      // Traspaso ya ACTIVO (caso Rosa 10-sep: "ya está escalado para que
      // Paola te llame"): forzar la tool volvería a derivar. El rescate lo
      // resuelve como reclamo al vendedor vigente, sin reintento.
      let ptvActivo = false
      try {
        const { getSupabaseRows } = await import("@/lib/rescate-callback")
        ptvActivo = (await getSupabaseRows<{ id: string }>(`vic_ptv?contact=eq.${contact}&estado=eq.activo&select=id&limit=1`)).length > 0
      } catch { /* sin lectura: se reintenta como siempre */ }
      if (ptvActivo) callbackRecuperado = true
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
      const retry = callbackRecuperado ? null : await runAgentLoop({
        systemPrompt: contextoCotizacion + (perfil.systemPrompt(contact, umbralInfo?.umbral) + lineaZonaHoraria(perfil.pais)) + contextoUmbral + directivaUmbral + FORZAR_TOOL_CALLBACK,
        history,
        userMessage: message,
        apiKey,
        contact,
        model: MODELO_COTIZACION,
        alIniciarTool,
        ...(toolsPais ? { tools: toolsPais } : {}),
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
      if (!callbackRecuperado || ptvActivo) {
        console.warn(
          `[v3-bg] ALUCINACIÓN_CALLBACK contact=${contact} ptvActivo=${ptvActivo} replyOriginal=${JSON.stringify(reply.slice(0, 400))}`,
        )
        // RESCATE DETERMINISTA (10-sep, casos Daniela y Rosa; 17 enlatados en
        // 30 días sin lead ni traspaso detrás): el código hace el traspaso
        // (escalera + tómbola + vic_ptv + loop cerrado) o, si no se puede,
        // deja la promesa pendiente en el vigía y cierra el loop. El texto
        // al cliente es el canónico del traspaso o uno honesto — nunca más
        // "ya le avisé al equipo" con la bandeja como único rastro.
        const { rescatarCallback } = await import("@/lib/rescate-callback")
        const textosCliente = textosClienteTurno
        const rescate = await rescatarCallback({
          contact,
          pais: perfil.pais,
          textosCliente,
          replyModelo: reply,
        }).catch(() => null)
        if (rescate?.via === "reafirmacion") {
          // El vendedor vigente recibió la promesa y la alerta; el texto del
          // modelo se conserva pero sin prometer horas que no controlamos.
          reply = reply.replace(/\bHOY\b/g, "hoy").replace(/\s*sin falta\b/gi, "")
        } else if (rescate?.reply) {
          reply = rescate.reply
        } else {
          reply =
            "Dejé registrada tu solicitud de contacto con los datos que me diste. Te confirmo por aquí apenas la tome un ejecutivo; no necesitas reenviarme nada 🙌"
          await avisarEquipoInterno(
            `⚠️ Registro de CALLBACK falló (tras reintento y rescate) — contacto +${contact}. Revisar la conversación en Botmaker y registrar el lead a mano.`,
          )
        }
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
    if (perfil.pais === "mx") reply = (await import("./paises/mx/nombre-equipo")).nombreEquipoMX(reply)

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
        console.warn(
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
    // EXCEPCIÓN (15-sep, caso Juan Manuel/ATTEX; mismo defecto el 11-ago con
    // Tamara y el 01-sep con Anderson): con el traspaso v2 (03-ago) el
    // ejecutivo se PRESENTA antes del pago, con nombre y WhatsApp. Cuando el
    // cliente después pregunta "¿tienen mi número?, ¿quién me llama?", el
    // modelo responde con el teléfono correcto del directorio (y el cinturón
    // 2.6b' lo garantiza), y este blindaje lo pisaba con el de la Mesa de
    // Ayuda: "Tamara Martinez · WhatsApp +56 9 4401 3873". El cliente que
    // escribía ahí caía en soporte. Con vic_ptv ACTIVO el ejecutivo ya fue
    // presentado por nosotros mismos: su número puede salir. Sin traspaso, la
    // regla del 17-jul sigue intacta.
    let contactoTraspasado = false
    try {
      const { getSupabaseRows } = await import("@/lib/rescate-callback")
      contactoTraspasado =
        (await getSupabaseRows<{ id: string }>(`vic_ptv?contact=eq.${contact}&estado=eq.activo&select=id&limit=1`)).length > 0
    } catch { /* sin lectura: se blinda como siempre */ }
    reply = blindarContactoComercial(reply, contactoTraspasado)
    // 2.8b. Blindaje de SOPORTE INVENTADO (Lalo 01-sep, caso Jeshu): fijos
    // +56 2 alucinados → fono real de la Mesa de Ayuda; correos
    // @geovictoria.com desconocidos → soporte@. Siempre activo.
    // Los correos @geovictoria.com que el propio CLIENTE escribió en este
    // turno o dejó en su borrador de alta son suyos, no inventados (E12
    // 05-sep: el alias egomez+vickydoce@ del admin salía como soporte@).
    const permitidos = emailsDirectorio()
    // Toda persona real de la organización (usuarios activos de Zoho, con
    // cache) — caso Conbes 07-sep: el directorio estático no tenía a Aracelli
    // y su correo salió como soporte@. Best-effort: sin Zoho, solo directorio.
    try {
      const { emailsEquipoZoho } = await import("@/lib/emails-equipo")
      for (const e of await emailsEquipoZoho()) permitidos.add(e)
    } catch { /* fail-open */ }
    for (const m of String(message || "").match(/[a-z0-9._%+-]+@geovictoria\.com/gi) || []) permitidos.add(m.toLowerCase())
    if (enOnboarding) {
      try {
        const { claveBorrador } = await import("@/lib/onboarding/fase")
        const raw = (await getKvValue(claveBorrador(contact))) || ""
        const em = String((JSON.parse(raw || "{}") as { admin?: { email?: string } })?.admin?.email || "").toLowerCase()
        if (em) permitidos.add(em)
      } catch { /* sin borrador */ }
    }
    reply = await perfil.blindarSoporte(reply, permitidos)

    // 2.7-bis. LA CERTIFICACIÓN DE LA DT SE ADJUNTA, NO SE CUENTA (Lalo
    // 14-sep). Dos veces el mismo punto: el 02-sep Vicky ofreció tres veces
    // "te envío el documento" sin llamar enviar_certificacion, y hoy (Dubraska,
    // taller en Antofagasta) el cliente preguntó "¿este sistema está vinculado
    // con DT?" y la respuesta citó bien la Resolución Exenta N°38 pero llegó
    // sin el documento. En el prompt la regla es CONDICIONAL ("si pide
    // respaldo"), así que depende del criterio del modelo — y ya falló dos
    // veces. Acá solo se ANEXA lo que falta: una respuesta que ya trae el link
    // no se toca, y el texto del modelo nunca se reemplaza.
    if (reply && perfil.certificacionDT) {
      try {
        const { conCertificacionSiFalta } = await import("@/lib/certificacion-dt")
        const cert = conCertificacionSiFalta(message, reply)
        if (cert.anexado) {
          reply = cert.texto
          console.log("[cert-dt] documento anexado", { contact })
        }
      } catch (e) {
        console.error("[cert-dt] falló el cinturón", e)
      }
    }

    // 2.8-bis. PAGO DECLARADO → VERIFICAR, NUNCA CREER (Lalo 10-sep, caso
    // Eduardo Guzmán): "Ya está pagado" 2 min después de salir al checkout y
    // el modelo respondió "veo que el pago está procesado" + instructivo de
    // acceso inventado (app, credenciales, "la contraseña salió por correo").
    // Orden: "primero confirma que haya pagado y luego invoca a Vicky
    // Onboarding" y "nunca podemos dar instrucciones como esa". En fase de
    // VENTA la cuenta no existe: cualquier instrucción de acceso o afirmación
    // de pago confirmado se reemplaza; si el cliente declara pago, se verifica
    // contra Mercado Pago (el cotizador deja Pagada y dispara el post-pago,
    // que manda el kickoff del alta por su propio camino).
    // El cinturón NO corre con casuística de NO-PROSPECTO (trabajador, cliente
    // pidiendo soporte, ex empleado…): ahí no hay pago que confirmar ni link que
    // ofrecer, y hablarle de pagos es exactamente el error del caso Pabla Solis.
    if (!enOnboarding && reply && !(casuisticaTurno && !casuisticaTurno.esProspecto)) {
      try {
        const pd = await import("@/lib/pago-declarado")
        const declara = pd.clienteDeclaraPago(message)
        const teatro = pd.afirmaPagoConfirmado(reply) || pd.pareceInstruccionDeAcceso(reply)
        if (declara || teatro) {
          let pagado = pagoMarcadoReciente
          let motivo = pagado ? "marca_kv" : "sin_cotizacion"
          if (!pagado && quotePointer?.quoteId) {
            const v = await pd.verificarPagoDeclarado(quotePointer.quoteId)
            pagado = v.pagado
            motivo = v.motivo
          }
          // CARRERA (26-sep, caso NelNav COT1649): el cliente escribió "ya pagué"
          // 3 min después de un débito aprobado; la verificación no alcanzó a
          // verlo, el post-pago estampó `pago_online_` 22 s ANTES de que saliera
          // esta respuesta, y el modelo le pidió "el comprobante de transferencia"
          // justo después de la plantilla "tu pago quedó registrado". Se relee la
          // marca fresca antes de responder.
          if (!pagado) {
            const marca = String((await getKvValue(`pago_online_${contact}`).catch(() => null)) || "")
            const comp = String((await getKvValue(`comprobante_ok_${contact}`).catch(() => null)) || "")
            if (marca && (!quotePointer?.quoteId || marca.includes(quotePointer.quoteId))) {
              pagado = true
              motivo = "marca_kv_fresca"
            } else if (comp && Date.now() - Date.parse(String((() => { try { return JSON.parse(comp).at } catch { return "" } })())) < 60 * 60_000) {
              // Comprobante registrado en ESTE turno (la tool lo estampa al instante).
              pagado = true
              motivo = "comprobante_fresco"
            }
          }
          if (pagado && (declara || teatro)) {
            reply = pd.textoPagoConfirmado()
            console.log(`[pago-declarado] ${contact}: pago verificado (${motivo}) — respuesta canónica, el post-pago manda el kickoff`)
          } else if (
            declara &&
            !teatro &&
            // Si en el turno se registró el comprobante (tool ok), la respuesta del
            // modelo es la correcta y no se toca.
            !((result.toolCalls || []) as ToolCallRecord[]).some((c) => c.ok && c.name === "registrar_comprobante_transferencia")
          ) {
            // El cliente dice que pagó y no se ve el pago: sale el texto canónico
            // (tarjeta se confirma sola / transferencia → comprobante), nunca lo
            // que improvise el modelo (NelNav: pidió comprobante de transferencia
            // a quien había pagado con débito por Mercado Pago).
            console.warn(`[pago-declarado] ${contact}: el cliente declara pago sin pago verificado (${motivo}) — texto canónico`)
            reply = pd.textoPagoNoVerificado({ link: quotePointer?.acceptanceUrl })
          } else if (teatro) {
            console.warn(`[pago-declarado] ${contact}: teatro de pago/acceso sin pago verificado (${motivo}) — respuesta reemplazada`)
            reply = pd.textoPagoNoVerificado({ link: quotePointer?.acceptanceUrl })
            void avisarEquipoInterno(
              `⚠️ +${contact}: Vicky iba a afirmar pago/dar instrucciones de acceso SIN pago verificado (${motivo}). Se reemplazó por el texto de verificación. Cotización ${quotePointer?.quoteId || "sin puntero"}.`,
            ).catch(() => {})
          }
        }
      } catch (e) {
        console.warn(`[pago-declarado] ${contact}: error en el cinturón:`, e instanceof Error ? e.message : e)
      }
    }

    // 2.8-bis. PAGO CERRADO = JAMÁS PEDIR COMPROBANTE (Lalo 26-sep, "que la
    // primera señal cierre el pago"): con cualquier señal de pago (marca kv o
    // pago aprobado en MP), una respuesta que pida comprobante, transferencia o
    // que pague se reemplaza por la confirmación canónica. Se relee la marca
    // fresca: el registro puede haber terminado MIENTRAS el modelo respondía.
    if (!enOnboarding && reply) {
      try {
        const pc = await import("@/lib/pago-cerrado")
        if (pc.pideComprobanteOPago(reply)) {
          const registroTool = ((result.toolCalls || []) as ToolCallRecord[]).some(
            (c) => c.ok && c.name === "registrar_comprobante_transferencia",
          )
          const senal = pagoMarcadoReciente ? true : Boolean(await pc.senalDePago(contact, { quoteId: quotePointer?.quoteId }))
          if (senal && !registroTool) {
            const pd = await import("@/lib/pago-declarado")
            console.warn(`[pago-cerrado] ${contact}: la respuesta pedía comprobante/pago con el pago cerrado — reemplazada`)
            reply = pd.textoPagoConfirmado()
          }
        }
      } catch (e) {
        console.warn(`[pago-cerrado] ${contact}: error en el cinturón:`, e instanceof Error ? e.message : e)
      }
    }

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
        console.warn(`[v3-bg] ECO_DETECTADO contact=${contact}: reply idéntico al turno anterior, reintentando.`)
        const FORZAR_NO_ECO =
          "\n\n# Instrucción de sistema (este turno)\n" +
          "Tu borrador REPITE EXACTAMENTE tu mensaje anterior. El cliente acaba de decirte algo nuevo: respóndele a ESO, corto y natural. " +
          "Si confirmó un supuesto que tu cotización vigente ya incluía, dilo en una frase (los números no cambian, NO vuelvas a pegar el resumen) y avanza al paso siguiente."
        const retryEco = await runAgentLoop({
          systemPrompt:
            contextoCotizacion + (perfil.systemPrompt(contact, umbralInfo?.umbral) + lineaZonaHoraria(perfil.pais)) + contextoUmbral + directivaUmbral + FORZAR_NO_ECO,
          history,
          userMessage: message,
          apiKey,
          contact,
          model: MODELO_COTIZACION,
          alIniciarTool,
          ...(toolsPais ? { tools: toolsPais } : {}),
        }).catch(() => null)
        const retryReply = (retryEco?.reply || "").trim()
        if (retryReply && normEco(retryReply) !== normEco(reply)) {
          let curado = await perfil.blindarSoporte(blindarContactoComercial(
            corregirPedidoDeTelefono(
              honestarMencionesDeCorreo(quitarSignosApertura(normalizarFormatoWhatsApp(sanitizarVoseo(retryReply)))),
            ),
            contactoTraspasado,
          ), emailsDirectorio())
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

    // 2.9. ÚLTIMO FILTRO: ningún link de cotización inventado sale de acá.
    //
    // El 03-sep Andrea y Andrés recibieron `/q/COT-310` y `/q/COT000394` —
    // links que nunca existieron, compuestos por el modelo cuando la tool de
    // emisión no corrió. El cinturón de URLs los caza, pero se le escaparon
    // por dos rendijas: el reintento ANTI-ECO de más arriba no vuelve a
    // pasar por él, y su excepción de "link que Vicky ya envió antes"
    // bendecía para siempre a un falso que ya había salido una vez.
    //
    // Por eso este chequeo vive al FINAL, en el único punto por donde pasa
    // todo lo que se envía: cubre cada rama de arriba y cualquiera que se
    // agregue mañana. Es puro y determinista (firma HMAC del código corto,
    // sin red): un link legítimo pasa aunque Zoho o el cotizador estén caídos.
    {
      const { linksInvalidos } = await import("@/lib/link-cotizacion")
      const malos = linksInvalidos(reply)
      if (malos.length) {
        console.warn(
          `[v3-bg] LINK_INVENTADO_BLOQUEADO contact=${contact} links=${JSON.stringify(malos)} reply=${JSON.stringify(reply.slice(0, 240))}`,
        )
        const puntero = quotePointers.find((qp) => !!qp.acceptanceUrl)?.acceptanceUrl || ""
        if (puntero) {
          // Hay cotización de verdad: se entrega SU link (el largo no depende
          // de /q/ ni de Zoho). El cliente nunca se queda sin nada.
          for (const malo of malos) reply = reply.split(malo).join(puntero)
          console.warn(`[v3-bg] LINK_SUSTITUIDO_POR_PUNTERO contact=${contact}`)
        } else {
          // No hay cotización: prometer un link seria repetir el caso Andrea.
          reply =
            "Dame un momento y te dejo tu cotización lista — te la mando por acá en cuanto la tenga 🙌"
        }
        void avisarEquipoInterno(
          `⚠️ LINK INVENTADO bloqueado a +${contact}: ${malos.join(", ")}. ` +
            (puntero ? "Se entregó el link real de su cotización." : "NO hay cotización emitida — revisar el chat."),
        ).catch(() => false)
      }
    }

    // 3. Persistir turno en Supabase
    // En el historial el turno queda como UN texto (el marcador de
    // multi-mensaje — [---] o una línea de solo guiones — se convierte en
    // salto de párrafo).
    await appendTurnV3(contact, message, reply.replace(/\n\s*\[?-{3,}\]?\s*(?:\n|$)/g, "\n\n"), perfil.pais).catch((err) => {
      console.error("[v3-bg] Error persistiendo turno:", err)
    })
    // TELÉFONO DECLARADO POR UN CONTACTO DE META (Lalo 15-sep: "que se
    // declare, se valide y se guarde en Phone"): determinista, sin tool —
    // celular chileno válido en el mensaje del cliente → alias kv + Phone del
    // lead (si ya existe). El PSID sigue siendo la identidad del chat.
    if (esContactoMeta(contact)) {
      void capturarTelefonoDeclarado(contact, message).catch(() => undefined)
    }

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
      // MÉXICO (Lalo 24-sep): "reloj" a secas jamás — "reloj checador" o "checador".
      if (perfil.pais === "mx" && replyFinal) {
        const { nombreEquipoMX } = await import("./paises/mx/nombre-equipo")
        replyFinal = nombreEquipoMX(replyFinal)
      }
      let partes = partirEnBurbujas(replyFinal)
      // ONBOARDING: máximo 3 burbujas por turno (tope 2 del 24-ago, piloto
      // "5 mensajes no leídos"; subido a 3 el 25-ago — el mensaje de la
      // nómina son 3 párrafos y Lalo los quiere como burbujas separadas).
      // Las dos primeras quedan solas y el resto se compacta en la tercera.
      if (enOnboarding && partes.length > 3) {
        partes = [partes[0], partes[1], partes.slice(2).join("\n\n")]
      }
      // ¿Este turno ENTREGÓ algo crítico? Esas respuestas salen siempre:
      // descartarlas deja al cliente sin lo que pidió.
      //
      // 14-sep (caso Dubraska, taller en Antofagasta): faltaba `cotizar_referencial`
      // y por eso la clienta ELIGIÓ PLAN SIN VER NINGÚN PRECIO. Escribió
      // "ANTOFAGASTA" (13:03:29) y "merced 370" diez segundos después; el
      // bloque con las dos opciones —0,95 UF con reloj y 0,55 UF solo app— se
      // generó para el primer mensaje y se descartó ENTERO al detectar el
      // segundo. En Botmaker solo salió la pregunta del turno siguiente,
      // "¿con cuál de las dos avanzamos?", sin las dos. El precio es
      // exactamente igual de crítico que el link.
      const TOOLS_CRITICAS = new Set([
        "generar_link_cotizadora",
        "cotizar_referencial",
        "consultar_descuento_referencial",
        "aplicar_siguiente_descuento",
        "enviar_certificacion",
        "enviar_ficha_reloj",
        "actualizar_cotizacion",
      ])
      const turnoEntregaCotizacion = (result.toolCalls || []).some(
        (c) => TOOLS_CRITICAS.has(c.name) && c.ok,
      )
      if (simulando(contact)) {
        SIM_CAPTURA.set(contact, {
          reply,
          tools: (result.toolCalls || []).map((c) => String(c.name)),
        })
      }
      for (const [i, parte] of partes.entries()) {
        if (simulando(contact)) break
        // RESPUESTA OBSOLETA (Eduardo 17-ago, caso "Rodrigo"→"Somos 20"): si
        // mientras se generaba (o durante la cadencia humana) llegó OTRO
        // mensaje del cliente, esta respuesta quedó vieja — mandar "¿y cuántas
        // personas?" cuando ya dijo "somos 20" se lee como no leer. Se
        // descarta lo no enviado; el próximo turno del drenaje procesa el
        // mensaje nuevo con TODO el historial (incluida esta respuesta
        // persistida) y contesta ambas cosas de una. El debounce de 1,5 s
        // cubre las ráfagas inmediatas; esto cubre la ventana de generación.
        // Y JAMÁS a mitad de turno (misma cicatriz, 14-sep 12:52): al llegar
        // "es un taller mecanico" mientras salía la lista de métodos de
        // marcaje, se envió el encabezado ("las formas más usadas son:") y se
        // descartaron las opciones — un mensaje partido por la mitad es peor
        // que uno desactualizado. El descarte solo puede ocurrir ANTES de la
        // primera burbuja; una vez que el turno empezó a salir, sale entero.
        if (i === 0 && !turnoEntregaCotizacion && (await inboxHasPending(contact))) {
          console.warn(
            `[v3-burst] respuesta obsoleta descartada para ${contact} (${partes.length} burbuja(s) sin enviar): llegó un mensaje nuevo durante la generación`,
          )
          // El historial no puede decir que se envió (26-sep, pruebas de
          // Priscila): sin esto el turno siguiente daba por contestadas las
          // preguntas anteriores.
          const { marcarUltimaRespuestaNoEnviada } = await import("@/lib/supabase-persistence-v3")
          await marcarUltimaRespuestaNoEnviada(contact, perfil.pais)
          break
        }
        if (HUMAN_DELAY_ON) {
          await sendTypingIndicator(contact, true, perfil.channelId).catch(() => {})
          await sleep(i === 0 ? humanDelayMs(parte) : Math.min(humanDelayMs(parte), 2500))
        }
        const sent = await sendBotmakerMessage(contact, parte, perfil.channelId)
        if (!sent) {
          console.error(
            `[v3-bg] No se pudo enviar reply final (parte ${i + 1}/${partes.length}) a Botmaker para ${contact}`,
          )
          break
        }
      }

      // EL PDF VIAJA CON EL LINK (Lalo 31-ago): cuando el turno entrega la
      // aceptación online, el documento va TAMBIÉN como archivo en el chat —
      // no como un link más. El cliente que quiere leer la propuesta la abre
      // ahí mismo, sin salir de WhatsApp ni buscar el correo (que cae en
      // Promociones — diagnóstico 26-jul). Va DESPUÉS del texto para que el
      // mensaje explique el archivo y no al revés. Best-effort absoluto: si
      // el envío falla, el link ya salió y la venta sigue.
      try {
        const entregaCot = (result.toolCalls || []).some(
          (c) => (c.name === "generar_link_cotizadora" || c.name === "actualizar_cotizacion") && c.ok,
        )
        if (entregaCot && !simulando(contact)) {
          let pdfUrl = extractPdfUrl(result.toolCalls as ToolCallRecord[] | undefined) || ""
          let numero = ""
          if (!pdfUrl) {
            const puntero = await getQuotePointer(contact).catch(() => null)
            pdfUrl = String(puntero?.pdfUrl || "")
            numero = String(puntero?.quoteId || "")
          }
          // Anti-repetición: el mismo archivo no se manda dos veces (un
          // reintento del turno, o una actualización que no cambió el PDF).
          // La marca es la URL misma: cada regeneración trae nombre nuevo.
          const marcaPdf = pdfUrl ? `pdfwa_${pdfUrl.split("/").pop()}` : ""
          const yaEnviado = marcaPdf ? await getKvValue(marcaPdf).catch(() => null) : null
          if (pdfUrl && !yaEnviado) {
            const { sendBotmakerMedia } = await import("@/lib/botmaker-push-v3")
            const ok = await sendBotmakerMedia(contact, pdfUrl, {
              ...(perfil.channelId ? { channelId: perfil.channelId } : {}),
              filename: `Cotizacion_GeoVictoria${numero ? `_${numero}` : ""}.pdf`,
              mimeType: "application/pdf",
            })
            if (ok && marcaPdf) await setKvValue(marcaPdf, new Date().toISOString()).catch(() => {})
            console.log(`[v3-bg] PDF adjunto ${ok ? "enviado" : "FALLÓ"} a ${contact}: ${pdfUrl}`)
          }
        }
      } catch (e) {
        console.warn(`[v3-bg] adjunto del PDF falló para ${contact}:`, e instanceof Error ? e.message : e)
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
        const senal = clasificarSenalEspera(message, perfil.pais, contact)
        if (senal) {
          await scheduleConsensualFollowup(contact, senal.cuando.toISOString(), perfil.pais)
          console.log(
            `[v3-followup] señal de espera '${senal.tipo}' → toque único ${senal.cuando.toISOString()} contact=${contact}`,
          )
        } else {
          await enrolarEnLoop(contact, perfil.pais).catch(() => {})
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
        await closeFollowup(contact, "perdido", perfil.pais)
        if (quotePointer?.quoteId) {
          await marcarCotizacionRechazada(quotePointer.quoteId).catch(() => {})
        }
        console.log(`[v3-followup] botón de pérdida → ciclo cerrado contact=${contact}`)
      } else if (usoOptOut) {
        await closeFollowup(contact, tipoNoContactar, perfil.pais)
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
          await scheduleConsensualFollowup(contact, cuandoIso, perfil.pais)
          console.log(
            `[v3-followup] consensuado → toque único programado contact=${contact} cuando=${cuandoIso}`,
          )
        } else {
          // Sin fecha válida: no apagamos la cadencia (mejor cae al flujo normal).
          await armarSegunSenal()
        }
      } else if (usoCierre) {
        await closeFollowup(contact, "derivado", perfil.pais)
      } else if (esSoporte) {
        // Pidió soporte → CERO seguimiento/proactividad, aunque la conversación
        // tenga historial comercial (decisión de costos 11-jul: antes esta rama
        // solo aplicaba si NO era comercial, y bastaba un estimado viejo en el
        // historial para que el turno de soporte re-armara la cadencia — de ahí
        // los nudges "¿cómo le fue con su problema de…?"). El cierre con razón
        // 'soporte' también lo excluye de la reactivación HSM.
        await closeFollowup(contact, "soporte", perfil.pais)
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
    // El registro del pago aprobado en MP (post-pago + alta) se lanzó antes del
    // modelo; se espera acá, DESPUÉS de responder, para que no quede a medias.
    if (registroPagoEnCurso) await Promise.race([registroPagoEnCurso, new Promise((r) => setTimeout(r, 30_000))])
    console.log(
      `[v3-bg] DONE pais=${perfil.pais} contact=${contact} iters=${result.iterations} tools=${result.toolCalls?.length || 0} pdf=${!!pdfUrl}`,
    )
  } catch (err) {
    console.error(`[v3-bg] Error procesando ${contact}:`, err)
    // Límite de gasto / credencial de la API del modelo → correo inmediato
    // (26-sep, ráfaga muda del 22-sep).
    void import("@/lib/alarma-api-modelo").then((m) => m.alarmarErrorApiModelo(err, contact)).catch(() => undefined)
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
      await appendTurnV3(contact, message, errReply, perfil.pais).catch(() => {})
      if (simulando(contact)) SIM_CAPTURA.set(contact, { reply: errReply, tools: [] })
      else await sendBotmakerMessage(contact, errReply, perfil.channelId).catch(() => {})
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
export async function procesarRafaga(
  contact: string,
  apiKey: string,
  seedMessage: string | undefined,
  perfil: PerfilTurno = PERFIL_TURNO_CL,
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
      await procesarTurno(contact, combinado, apiKey, perfil)

      if (++turns >= MAX_BURST_TURNS) {
        // Salvaguarda: liberar y dejar que el próximo mensaje continúe el drenaje.
        console.warn(`[v3-burst] tope de turnos alcanzado contact=${contact}`)
        return
      }
    }
  } finally {
    sendTypingIndicator(contact, false, perfil.channelId).catch(() => {})
    if (holdsLock) await releaseLock(contact).catch(() => {})
  }
}


// ── Perfil CHILE = el comportamiento que el webhook tenía inline ──────────
export const PERFIL_TURNO_CL: PerfilTurno = {
  pais: "cl",
  zona: "comuna",
  documento: "RUT",
  systemPrompt: (contact, umbral) => getSystemPromptV3(contact, umbral),
  esFlujoCotizacion,
  blindarSoporte: (reply, permitidos) => blindarSoporteInventado(reply, permitidos),
  certificacionDT: true,
  hitoPorChat: true,
}

/**
 * Interruptor por país para que un webhook delegue acá (vic_kv `orquestador_<cc>` /
 * env VICKY_ORQUESTADOR_<CC>). Con `contact`, un PROBADOR interno marcado para
 * ese país (vic-admin-probador) pasa por el orquestador aunque el interruptor
 * esté apagado: se prueba la experiencia nueva desde un teléfono real sin
 * cambiar lo que ven los clientes (Lalo 24-sep, Rodrigo probando México).
 */
export async function orquestadorActivo(pais: PaisTurno, contact?: string): Promise<boolean> {
  const env = (process.env[`VICKY_ORQUESTADOR_${pais.toUpperCase()}`] || "").trim().toLowerCase()
  if (env === "on" || env === "1") return true
  if (contact) {
    const { paisProbador } = await import("./probador-pais")
    if ((await paisProbador(contact).catch(() => null)) === pais) return true
  }
  if (env === "off" || env === "0") return false
  const kv = ((await getKvValue(`orquestador_${pais}`).catch(() => null)) || "").trim().toLowerCase()
  return kv === "on" || kv === "1"
}

/**
 * DIRECTIVA DE CANAL para contactos de Messenger/Instagram (15-sep). Misma
 * Vicky, mismas tools: lo único distinto es que acá NO hay número de teléfono
 * — se pide y se valida antes de la formal (la tool se niega sin él) — y que
 * fuera de la ventana de 24 h Meta no deja escribir (nada de "te escribo
 * mañana": todo lo proactivo posterior sale por WhatsApp).
 */
export async function directivaCanalMeta(contact: string): Promise<string> {
  if (!esContactoMeta(contact)) return ""
  const canal = canalMetaDe(contact) === "instagram" ? "INSTAGRAM (mensaje directo)" : "FACEBOOK MESSENGER"
  const alias = await telefonoAliasDe(contact).catch(() => "")
  let lineaPerfil = ""
  try {
    const { perfilMeta } = await import("@/lib/meta-graph")
    const p = await perfilMeta(contact)
    if (p && (p.firstName || p.lastName)) {
      const extras = [p.locale ? `idioma/región del perfil ${p.locale}` : "", typeof p.timezone === "number" ? `zona horaria UTC${p.timezone >= 0 ? "+" : ""}${p.timezone}` : ""].filter(Boolean).join(", ")
      lineaPerfil = `\n- Según su perfil de ${canal === "INSTAGRAM (mensaje directo)" ? "Instagram" : "Facebook"} se llama ${[p.firstName, p.lastName].filter(Boolean).join(" ")}${extras ? ` (${extras})` : ""}. Úsalo para saludar; si en el chat dice otro nombre, manda el del chat.`
    }
  } catch { /* sin perfil */ }
  return `

CANAL DE ESTA CONVERSACIÓN: ${canal} de la página de GeoVictoria Chile — NO es WhatsApp.${lineaPerfil}
- Vendes exactamente igual que por WhatsApp (mismas herramientas, mismos precios, mismas reglas).
- ${alias ? `El cliente ya declaró su WhatsApp: +${alias}. Úsalo como su teléfono en toda herramienta.` : "NO TIENES SU NÚMERO DE TELÉFONO. Antes de emitir la cotización formal pídele su WhatsApp (celular chileno +56 9…): explícale que por WhatsApp le llega la cotización formal, el link de pago y el acompañamiento de la activación. Sin ese número la cotización formal no se puede emitir; no lo inventes ni uses otro."}
- Respuestas cortas (se leen en el celular): máximo 4 oraciones por mensaje, sin negritas ni asteriscos.
- Por este canal solo puedes escribir dentro de las 24 horas siguientes al último mensaje del cliente; no prometas escribirle tú "mañana" por aquí.`
}

/** Celular chileno declarado por un contacto Meta → alias kv + Phone del lead. */
export async function capturarTelefonoDeclarado(contact: string, mensaje: string): Promise<void> {
  const fono = capturarCelularCL(mensaje)
  if (!fono) return
  const previo = await telefonoAliasDe(contact).catch(() => "")
  if (previo === fono) return
  await guardarTelefonoMeta(contact, fono)
  console.log(`[v3] contacto Meta ${contact}: WhatsApp declarado +${fono}`)
  // Phone del lead de Vicky (si ya nació): best-effort, jamás toca la conversación.
  try {
    const leadId = ((await getKvValue(`zoho_lead_${contact}`).catch(() => null)) || "").trim()
    if (leadId && /^\d{15,}$/.test(leadId)) {
      const { getZohoAccessToken } = await import("@/lib/zoho-token")
      const token = await getZohoAccessToken()
      const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
      await fetch(`${api}/crm/v3/Leads/${leadId}`, {
        method: "PUT",
        headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ data: [{ id: leadId, Phone: `+${fono}` }], trigger: ["blueprint"] }),
      })
    }
  } catch (e) {
    console.warn("[v3] Phone del lead desde Meta:", e instanceof Error ? e.message : e)
  }
}
