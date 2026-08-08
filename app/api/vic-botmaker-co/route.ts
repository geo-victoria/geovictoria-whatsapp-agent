/**
 * Webhook de la línea de WhatsApp de COLOMBIA (+57 318 107 0737).
 *
 * Ruta delgada por país: la acción de código de la línea CO apunta ACÁ; la
 * chilena sigue en /api/vic-botmaker-v3.
 *
 * OJO — el Master Bot de Botmaker rutea por ID DEL CANAL (la línea a la que el
 * cliente escribió), no por el prefijo del número. Un +56 que escriba al número
 * colombiano aterriza acá. Por eso este webhook REENVÍA al de su país todo lo
 * que no sea +57 (ver lib/ruteo-pais.ts): el prefijo decide QUÉ Vicky atiende
 * (prompt, moneda, NIT/RUT/RFC); el canal de origen decide POR QUÉ LÍNEA se
 * responde. Antes de abrir las líneas CO/MX esto sí era imposible por config.
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

import {
  cierrePorBoton,
  esTextoDeBotonDeCierre,
  normalizarMensajeEntrante,
} from "@/lib/respuesta-boton"
import { NextResponse, after } from "next/server"
import { runAgentLoop } from "@/lib/agent-loop"
import { urlsDeToolsDelTurno, vieneDeUnaTool } from "@/lib/links-de-tools"
import { detectarProcesoHumano, directivaProcesoHumano } from "@/lib/proceso-humano"
import { PERFIL_CO } from "@/lib/paises/co"
import { getSystemPromptCO, formatCotizacionExistenteCO } from "@/lib/paises/co/prompt"
import { umbralPrecios, formatUmbralParaPrompt, dotacionSobreUmbral, formatDirectivaSobreUmbral, derivacionDePais, paisConUmbral } from "@/lib/umbral-autonomia"
import { TOOL_SCHEMAS_CO, buildDispatchCO } from "@/lib/paises/co/tools"
import {
  fetchHistoryV3,
  appendTurnV3,
  markUserActivity,
  closeFollowup,
  scheduleConsensualFollowup,
  getQuotePointer,
  setKvValue,
  getKvValue,
} from "@/lib/supabase-persistence-v3"
import {
  hashMessage,
  acquireLock,
  releaseLock,
  bufferInboundMessage,
  drainInbox,
  inboxHasPending,
} from "@/lib/processing-lock-v3"
import { sendBotmakerMessage, sendTypingIndicator, detectarCanalOrigen, canalCoherenteConContacto } from "@/lib/botmaker-push-v3"
import { reenviarSiNoEsDeEstePais } from "@/lib/ruteo-pais"
import { resetLoop, clasificarSenalEspera, enrolarEnLoop } from "@/lib/loop-v2"
import { avisarEquipoInterno } from "@/lib/alerta-interna"
import { sanitizarVoseo, normalizarFormatoWhatsApp, quitarSignosApertura } from "@/lib/voseo-v3"
import { transcribirAudio } from "@/lib/transcribe-audio"
import { describirImagen } from "@/lib/describe-image"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const SECRET_CO = (process.env.BOTMAKER_SECRET_CO || "").trim()
const ENABLED = (process.env.VICKY_CO_ENABLED || "off").trim().toLowerCase() === "on"
const CANAL_CO = () => PERFIL_CO.canal.channelId

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
  // Documento adjunto (PDF, ej. comprobantes): URL si la acción la reenvía.
  fileUrl?: string
  fileURL?: string
  documentUrl?: string
  documentURL?: string
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
    const proceso = await detectarProcesoHumano(contact, "co").catch(() => null)
    if (proceso) history.push({ role: "assistant", content: directivaProcesoHumano(proceso) })
  }
  // Anti-amnesia (espejo CL): si ya existe una cotización formal, se inyecta
  // su estado al prompt (no re-pedir datos, no regenerar, reenviar el link).
  const quotePointer = await getQuotePointer(contact).catch(() => null)
  const contextoCotizacion = formatCotizacionExistenteCO(quotePointer || undefined)
  // Con formal vigente el turno ES de cotización aunque el mensaje no lo diga.
  const modelo =
    quotePointer || esFlujoCotizacionCO(message, history)
      ? MODELO_COTIZACION_CO
      : MODELO_SIMPLE_CO
  console.log(
    `[vic-co-modelo] contact=${contact} modelo=${modelo} flujoCotizacion=${modelo === MODELO_COTIZACION_CO} formal=${!!quotePointer}`,
  )
  // Umbral de venta autónoma (Lalo 08-ago, replicado de CL): bloque por
  // conversación + directiva determinista por dotación declarada, con la
  // tool de derivación de este país. Fail-open: sin datos, no acota nada.
  const umbralInfo = paisConUmbral(contact) ? await umbralPrecios(contact).catch(() => null) : null
  const derivPais = derivacionDePais(contact)
  const contextoUmbral = umbralInfo ? formatUmbralParaPrompt(umbralInfo.umbral, umbralInfo.origen, derivPais) : ""
  const textoCliente = [message, ...history.filter((m) => m.role === "user").map((m) => String(m.content || ""))].join("\n")
  const dotacionDetectada = umbralInfo ? dotacionSobreUmbral(textoCliente, umbralInfo.umbral) : null
  const directivaUmbral = dotacionDetectada && umbralInfo ? formatDirectivaSobreUmbral(dotacionDetectada, umbralInfo.umbral, derivPais) : ""
  const systemPromptCO = contextoUmbral + contextoCotizacion + getSystemPromptCO(contact, umbralInfo?.umbral) + contextoUmbral + directivaUmbral
  const dispatchCO = buildDispatchCO(contact)
  const result = await runAgentLoop({
    systemPrompt: systemPromptCO,
    history,
    userMessage: message,
    apiKey,
    contact,
    model: modelo,
    tools: {
      schemas: TOOL_SCHEMAS_CO as unknown as unknown[],
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
  const LINK_FABRICADO_CO =
    /https?:\/\/(?:drive|docs)\.google\.com\/\S+|https?:\/\/(?:www\.)?(?:dropbox|wetransfer|mega)\.[a-z]+\/\S+/gi
  if (LINK_FABRICADO_CO.test(reply)) {
    console.error(`[vic-co] LINK_FABRICADO contact=${contact} reply=${JSON.stringify(reply.slice(0, 300))}`)
    reply = reply.replace(LINK_FABRICADO_CO, "(te lo hago llegar enseguida)").trim()
  }
  // ALLOWLIST de dominios (caso Transportes Viig CL, 22-jul): todo link cuyo
  // dominio no esté en la lista blanca se considera fabricado y se retira.
  // PROCEDENCIA ANTES QUE DOMINIO (26-jul, espejo del webhook CL): una URL que
  // salió textual de una tool OK de este turno la produjo nuestro backend — se
  // respeta aunque su dominio no esté enumerado.
  const urlsDeToolsCo = urlsDeToolsDelTurno(result.toolCalls)
  // El dominio de la DEMO solo vale en su raíz (caso VMW Ingeniería 04-ago:
  // el modelo fabricó /checkout?quote=... sobre el dominio legítimo de la
  // demo y pasó el allowlist). Cualquier path/query en ese dominio que no
  // venga de una tool es fabricado.
  const DOMINIOS_VICKY_CO =
    /^https?:\/\/(?:(?:[a-z0-9-]+\.)*(?:geovictoria\.com|supabase\.co|wa\.me|cal\.com|mercadopago\.[a-z.]+|mpago\.[a-z]+|youtube\.com|youtu\.be)(?:[/?#]|$)|geovictoria-demo-agent\.vercel\.app\/?$)/i
  for (const u of reply.match(/https?:\/\/[^\s)]+/gi) || []) {
    if (DOMINIOS_VICKY_CO.test(u)) continue
    if (vieneDeUnaTool(u, urlsDeToolsCo)) {
      console.log(`[vic-co] LINK_DE_TOOL_RESCATADO contact=${contact} url=${u.slice(0, 140)}`)
      continue
    }
    console.error(`[vic-co] LINK_FUERA_DE_ALLOWLIST contact=${contact} url=${u.slice(0, 140)}`)
    reply = reply.split(u).join("(te lo hago llegar enseguida)").trim()
  }

  let toolCalls = (result.toolCalls || []) as ToolCallRecordCO[]

  // ── Guardrails anti-alucinación (espejo de 2.6b/2.6c chilenos) ──
  // Si el reply AFIRMA que una reunión quedó agendada o que el equipo lo va a
  // contactar, pero NINGUNA tool lo respalda este turno, se re-corre el loop
  // forzando la tool; si tampoco se concreta, NO se confirma en falso.
  // Como FUNCIONES de texto: se evalúan sobre el reply original Y sobre el del
  // reintento — si el reintento ya no afirma nada, ESA es la respuesta buena.
  const afirmaReunionListaEn = (t: string) =>
    /\breuni[oó]n\b[^.]{0,40}(qued[oó]|est[aá]|fue)[^.]{0,18}\b(agendad|reagendad|confirmad|coordinad)/i.test(t) ||
    /\b(agend[eé]|reagend[eé])(?![a-záéíóúñ])[^.]{0,25}\breuni[oó]n\b/i.test(t) ||
    /\bse\s+l[ao]\s+(agend[eé]|reagend[eé])/i.test(t)
  const afirmaContactoListoEn = (t: string) =>
    /\b(un\s+ejecutiv[oa]|el\s+equipo|nuestro\s+equipo|un\s+asesor|Laura)\b[^.]{0,50}\b(l[oe]\s+(contactar[aá]|llamar[aá]|va\s+a\s+(contactar|llamar))|se\s+(pondr[aá]|comunicar[aá]|contactar[aá]))/i.test(t)
  // Caso VMW Ingeniería (04-ago): el modelo afirmó "aquí pagas tu cotización"
  // + "te llegó el PDF a tu correo" con un link FABRICADO, sin llamar la tool.
  const afirmaCotizacionListaEn = (t: string) =>
    /\bcotizaci[oó]n\b[^.]{0,60}\b(formal|en\s+pdf)\b[^.]{0,50}\b(list[ao]|generad[ao]|enviad[ao]|qued[oó])/i.test(t) ||
    /\b(aqu[ií]|en\s+este\s+(link|enlace))\b[^.]{0,60}\b(pagas?|aceptas?)\b[^.]{0,40}\bcotizaci[oó]n\b/i.test(t) ||
    /\b(te\s+(lleg[oó]|envi[eé]|mand[eé])|ya\s+(te\s+)?(lleg[oó]|sali[oó]))\b[^.]{0,40}\b(pdf|cotizaci[oó]n)\b/i.test(t)
  const afirmaReunionLista = afirmaReunionListaEn(reply)
  const afirmaContactoListo = afirmaContactoListoEn(reply)
  const afirmaCotizacionLista = afirmaCotizacionListaEn(reply)
  const realAgenda = toolCalls.some(
    (c) => (c.name === "agendar_reunion" || c.name === "reagendar_reunion") && c.ok,
  )
  const realContacto = toolCalls.some(
    (c) => (c.name === "derivar_a_ejecutivo" || c.name === "agendar_reunion") && c.ok,
  )
  const realFormal = toolCalls.some(
    (c) => (c.name === "generar_link_cotizadora" || c.name === "actualizar_cotizacion") && c.ok,
  )
  const alucinacion =
    (afirmaReunionLista && !realAgenda) ||
    (!afirmaReunionLista && afirmaContactoListo && !realContacto) ||
    (afirmaCotizacionLista && !realFormal)
  if (alucinacion) {
    const FORZAR_TOOL =
      "\n\n# Instrucción de sistema (este turno)\n" +
      "Estás por confirmarle al cliente algo que NO puedes afirmar sin EJECUTAR la tool correspondiente. " +
      "Si confirmó un horario de reunión, llama agendar_reunion (o reagendar_reunion si ya tenía una). " +
      "Si pidió que lo contacten, llama derivar_a_ejecutivo con los datos que ya entregó. " +
      "Si le estás entregando la cotización formal o un link de pago, llama generar_link_cotizadora con los datos que ya te dio — JAMÁS escribas un link de memoria: el único link válido es el que devuelve la tool. " +
      "SOLO después de que la tool devuelva ok confirma, usando su mensajeParaProspecto. " +
      "Si faltan datos obligatorios, PÍDELOS en vez de afirmar que ya quedó listo."
    const retry = await runAgentLoop({
      systemPrompt: systemPromptCO + FORZAR_TOOL,
      history,
      userMessage: message,
      apiKey,
      contact,
      model: MODELO_COTIZACION_CO,
      tools: { schemas: TOOL_SCHEMAS_CO as unknown as unknown[], dispatch: dispatchCO },
    }).catch(() => null)
    const retryCalls = ((retry?.toolCalls || []) as ToolCallRecordCO[])
    const retryOk = retryCalls.some(
      (c) =>
        (c.name === "agendar_reunion" ||
          c.name === "reagendar_reunion" ||
          c.name === "derivar_a_ejecutivo" ||
          c.name === "generar_link_cotizadora" ||
          c.name === "actualizar_cotizacion") &&
        c.ok,
    )
    const retryReply = (retry?.reply || "").trim()
    if (retryOk && retryReply && retryReply !== AGENT_LOOP_EMPTY_FALLBACK) {
      console.warn(`[vic-co] ALUCINACION_RECUPERADA contact=${contact}: el reintento forzó la tool.`)
      reply = quitarSignosApertura(normalizarFormatoWhatsApp(sanitizarVoseo(retryReply)))
      toolCalls = retryCalls
    } else if (
      retryReply &&
      retryReply !== AGENT_LOOP_EMPTY_FALLBACK &&
      !afirmaReunionListaEn(retryReply) &&
      !afirmaContactoListoEn(retryReply) &&
      !afirmaCotizacionListaEn(retryReply)
    ) {
      // El reintento corrigió SIN tool: la afirmación original era ESPURIA —
      // no había ninguna reunión ni contacto en juego. Caso Juan Angel
      // (+573138157184, 24-jul): preguntó "Anual?" por el precio, el modelo
      // alucinó un contacto, y el enlatado de abajo le inventó una reunión
      // ("tu reunión quedó pendiente de registro") — respuesta del cliente:
      // "Cual reunión". El reintento que responde SIN agendar nada es el
      // resultado correcto, no un fallo.
      console.warn(
        `[vic-co] ALUCINACION_CORREGIDA_SIN_TOOL contact=${contact}: la afirmación era espuria; va la respuesta del reintento.`,
      )
      reply = quitarSignosApertura(normalizarFormatoWhatsApp(sanitizarVoseo(retryReply)))
      toolCalls = retryCalls
    } else {
      console.error(
        `[vic-co] ALUCINACION_SIN_TOOL contact=${contact} replyOriginal=${JSON.stringify(reply.slice(0, 300))}`,
      )
      // Auditoría 20-jul: el fallo técnico NO se le cobra al cliente
      // re-pidiéndole datos que ya están en el historial — se avisa al
      // equipo para completar el registro a mano.
      reply = afirmaReunionLista
        ? "Disculpa, tuve un problema técnico y tu reunión quedó pendiente de registro — ya avisé al equipo para dejarla agendada con lo que me indicaste. Te confirmo apenas esté lista, no necesitas reenviarme nada 🙌"
        : afirmaCotizacionLista
          ? "Disculpa, tu cotización formal quedó pendiente por un problema técnico — la estoy preparando con los datos que ya me diste y te la envío por aquí apenas esté lista. No necesitas reenviarme nada 🙌"
          : "Disculpa, tuve un problema técnico registrando tu solicitud — ya avisé al equipo para que igual te contacten con los datos que me diste. No necesitas reenviarme nada 🙌"
      await avisarEquipoInterno(
        `⚠️ Registro de ${afirmaReunionLista ? "REUNIÓN" : afirmaCotizacionLista ? "COTIZACIÓN FORMAL" : "CALLBACK"} falló (tras reintento, línea CO) — contacto +${contact}. El cliente quedó con la promesa: revisar la conversación en Botmaker y completar a mano.`,
      )
    }
  }
  // Telemetría de diagnóstico: si el turno tocó tools de agenda, dejar el
  // detalle exacto (input/output de cada tool) legible desde Supabase
  // (vic_kv.debug_last_co_tools) — los runtime logs de Vercel no siempre son
  // accesibles y estos flujos han tenido éxitos falsos difíciles de rastrear.
  if (toolCalls.some((c) => /reunion|disponibilidad/.test(c.name))) {
    setKvValue(
      "debug_last_co_tools",
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
    // Espejo del chileno (caso Rodrigo 17-jul): rechazo explícito → no re-armar.
    // Un botón de cierre ("Elegimos otro proveedor" / "Ya no lo
    // necesitamos") ES un rechazo, aunque su texto no tenga ninguna de
    // las palabras del patrón. Ver lib/respuesta-boton.ts.
    const esRechazo =
      esTextoDeBotonDeCierre(message) ||
      (message.trim().length <= 60 &&
      /\b(no\s+gracias|no\s+(me|nos)\s+interesa|no\s+estoy\s+interesad\w+|ya\s+no\s+(lo\s+)?quiero|no\s+lo\s+quiero|no\s+quiero\s+(nada|seguir|avanzar)|no\s+necesito\s+(nada|informaci[oó]\w*|cotiz\w+|el\s+servicio)|no\s+insist\w+|dej\w+\s+de\s+(escribir\w*|hablar\w*|insistir\w*)|no\s+me\s+escrib\w+)\b/i.test(
        message,
      ))
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
    // Señal de espera implícita ("lo veo con mi jefe", "la próxima semana"…):
    // UN toque único en el plazo inferido. Sin señal: la conversación
    // comercial se ENROLA AL LOOP V2 (decisión Lalo 25-jul: el loop reemplaza
    // TODOS los toques anteriores — la escalera armFollowup queda muerta).
    const armarSegunSenal = async () => {
      const senal = clasificarSenalEspera(message, "co", contact)
      if (senal) {
        await scheduleConsensualFollowup(contact, senal.cuando.toISOString(), "co")
        console.log(
          `[vic-co][followup] señal de espera '${senal.tipo}' → toque único ${senal.cuando.toISOString()} contact=${contact}`,
        )
      } else {
        await enrolarEnLoop(contact, "co").catch(() => {})
      }
    }
    if (callNoContactar) {
      await closeFollowup(contact, tipoNoContactar, "co")
      console.log(`[vic-co][followup] ${tipoNoContactar} (tool) → ciclo cerrado contact=${contact}`)
    } else if (segConsensuado) {
      const cuandoIso = (segConsensuado.output as { cuandoIso?: string } | undefined)?.cuandoIso
      if (cuandoIso) {
        await scheduleConsensualFollowup(contact, cuandoIso, "co")
        console.log(`[vic-co][followup] consensuado contact=${contact} cuando=${cuandoIso}`)
      } else {
        await armarSegunSenal()
      }
    } else if (usoCierre) {
      await closeFollowup(contact, "derivado", "co")
    } else if (esSoporte) {
      // Pidió soporte → cero seguimiento/proactividad aunque la conversación
      // sea comercial (decisión de costos 11-jul, igual que Chile).
      await closeFollowup(contact, "soporte", "co")
    } else if (reply && (!esDespedida || !!quotePointer) && esComercial) {
      // Espejo del chileno (caso Constanza 17-jul): con cotización FORMAL
      // vigente, la despedida corta ("muchas gracias") no frena la cadencia —
      // es recibo cortés, no cierre.
      await armarSegunSenal()
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
            console.error(`[vic-co] CIRCUIT_BREAKER contact=${contact}: errores en loop, silenciando (ya se escaló).`)
          } else {
            const errReply = dosErroresSeguidos ? ESCALADA_ERROR_CO : ERROR_GENERICO_CO
            await appendTurnV3(contact, combinado, errReply, "co").catch(() => {})
            await sendBotmakerMessage(contact, errReply, CANAL_CO()).catch(() => {})
          }
        } catch {
          await sendBotmakerMessage(contact, ERROR_GENERICO_CO, CANAL_CO()).catch(() => {})
        }
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

    // Respuesta por BOTÓN: Botmaker no manda el texto sino el payload del
    // intent ({"button":"…","entities":"…","intent":"…"}). Se normaliza acá,
    // en la entrada, para que TODO lo de abajo —clasificador de rechazo,
    // modelo, historial— vea "Elegimos otro proveedor" y no el JSON crudo.
    // Ver lib/respuesta-boton.ts (caso 56992047070).
    const cierreBoton = cierrePorBoton(message)
    message = normalizarMensajeEntrante(message)
    const audioUrl = (body.audioUrl || body.audioURL || "").trim()
    const simulacion = body.simular === true

    // Canal de ORIGEN (espejo del webhook CL): si la acción de código CO manda
    // channelId, se persiste — los pushes salen por la línea donde el cliente
    // escribió, aunque el prefijo del número sea de otro país.
    const canalBody = ((body as { channelId?: string }).channelId || "").trim()
    if (contact && canalBody) {
      if (canalCoherenteConContacto(contact, canalBody)) {
        setKvValue(`canal_origen_${contact}`, canalBody).catch(() => {})
      } else {
        // Canal de OTRO país para este contacto: probable misroute del master
        // bot (caso María 23-jul). No pisar el origen; si no lo conocemos,
        // resolverlo contra la API de Botmaker.
        const conocido = await getKvValue(`canal_origen_${contact}`).catch(() => null)
        if (!conocido) await detectarCanalOrigen(contact).catch(() => "")
      }
    }

    // Ruteo de retorno (26-jul): el Master Bot rutea por ID DEL CANAL, así que
    // un +56 o un +52 que escriba a la LÍNEA colombiana aterriza acá. Sin esto
    // recibía prompt colombiano, precios en COP y la pregunta por el NIT. Se
    // reenvía al webhook de su país (el body crudo conserva audio/imagen/PDF) y
    // se devuelve su respuesta tal cual. Va ANTES del gate de observación: el
    // país del contacto manda sobre el modo de esta línea.
    if (contact && !simulacion) {
      const ruteo = await reenviarSiNoEsDeEstePais({
        contact,
        paisLocal: "co",
        requestUrl: request.url,
        body,
        etiquetaLog: "[vic-co][ruteo]",
      })
      if (ruteo.reenviado) {
        if ("fallo" in ruteo) return NextResponse.json({ reply: "" })
        return NextResponse.json(ruteo.data, { status: ruteo.status })
      }
    }

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
        // Push + reply VACÍO: si además devolviéramos el texto en el JSON, la
        // acción de Botmaker podría entregarlo de nuevo (mensaje duplicado).
        if (!simulacion) await sendBotmakerMessage(contact, PIDE_TEXTO_CO, CANAL_CO()).catch(() => {})
        return NextResponse.json({ reply: simulacion ? PIDE_TEXTO_CO : "", pais: "co" })
      }
    }

    // Foto/imagen o DOCUMENTO PDF (paridad CL, 25-jul: todo comprobante va a
    // Vicky y debe poder leer imagen y PDF): se "lee" con visión y el texto
    // sigue el flujo normal. Con caption, se conservan ambos. Placeholder sin
    // URL → contexto accionable (documento) o pedir texto (imagen).
    const imageUrl = (body.imageUrl || body.imageURL || body.mediaUrl || body.mediaURL || "").trim()
    const fileUrl = (body.fileUrl || body.fileURL || body.documentUrl || body.documentURL || "").trim()
    const FILE_PLACEHOLDERS = ["__file__", "__document__", "__doc__", "__pdf__"]
    const IMG_PLACEHOLDERS = ["__image__", "__media__", "__photo__"]
    const esArchivoAdjunto = FILE_PLACEHOLDERS.includes(message.trim())
    const CONTEXTO_DOC_ILEGIBLE_CO =
      "[El cliente envió un ARCHIVO adjunto que el sistema no puede visualizar (probablemente un PDF). NO le digas que no puedes verlo. Si el contexto de la conversación es de PAGO (acaba de pagar o habló de transferencia/comprobante), lo más probable es que sea su comprobante: agradécele el envío, dile que quedó recibido y que el equipo de finanzas lo verificará — sin afirmar que el pago quedó confirmado. Si el contexto NO es de pago, agradécele y pregúntale con naturalidad qué contiene el documento para poder ayudarle.]"
    const mediaUrlEntrante = imageUrl || fileUrl
    if (mediaUrlEntrante) {
      sendTypingIndicator(contact, true, CANAL_CO()).catch(() => {})
      const descripcion = await describirImagen(mediaUrlEntrante)
      const caption = IMG_PLACEHOLDERS.includes(message) || esArchivoAdjunto ? "" : message
      if (descripcion) {
        const bloque = esArchivoAdjunto || (!imageUrl && fileUrl)
          ? `[El cliente envió un DOCUMENTO (PDF) por WhatsApp. Contenido del documento]: ${descripcion}`
          : `[El cliente envió una imagen por WhatsApp. Contenido de la imagen]: ${descripcion}`
        message = caption ? `${caption}\n\n${bloque}` : bloque
        console.log(`[vic-co] adjunto descrito contact=${contact} len=${descripcion.length}`)
      } else if (esArchivoAdjunto) {
        message = CONTEXTO_DOC_ILEGIBLE_CO
      } else if (!caption) {
        await capturarPayloadDebug(body)
        if (!simulacion) await sendBotmakerMessage(contact, PIDE_TEXTO_IMAGEN_CO, CANAL_CO()).catch(() => {})
        return NextResponse.json({ reply: simulacion ? PIDE_TEXTO_IMAGEN_CO : "", pais: "co" })
      } else {
        message = caption
      }
    } else if (esArchivoAdjunto) {
      message = CONTEXTO_DOC_ILEGIBLE_CO
    } else if (IMG_PLACEHOLDERS.includes(message)) {
      await capturarPayloadDebug(body)
      if (!simulacion) await sendBotmakerMessage(contact, PIDE_TEXTO_IMAGEN_CO, CANAL_CO()).catch(() => {})
      return NextResponse.json({ reply: simulacion ? PIDE_TEXTO_IMAGEN_CO : "", pais: "co" })
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
      console.warn(`[vic-co] INJECT bloqueado contact=${contact} msg=${JSON.stringify(message.slice(0, 150))}`)
      const neutro = "Te puedo ayudar con información sobre nuestro servicio de control de asistencia? 😊"
      if (simulacion) return NextResponse.json({ reply: neutro, pais: "co", simulacion: true })
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
        systemPrompt: await (async () => {
          // Espejo del camino real (umbral 08-ago): la simulación E2E debe
          // ver el mismo prompt que el cliente.
          const uInfo = paisConUmbral(contact) ? await umbralPrecios(contact).catch(() => null) : null
          const dP = derivacionDePais(contact)
          const cU = uInfo ? formatUmbralParaPrompt(uInfo.umbral, uInfo.origen, dP) : ""
          const dot = uInfo ? dotacionSobreUmbral(message, uInfo.umbral) : null
          const dir = dot && uInfo ? formatDirectivaSobreUmbral(dot, uInfo.umbral, dP) : ""
          return cU + getSystemPromptCO(contact, uInfo?.umbral) + cU + dir
        })(),
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
    // Loop v2 (flag LOOP_V2_ENABLED, no-op apagado): el mensaje entrante
    // re-ancla el loop del contacto (t0 = ahora, toque 1; con señal de
    // espera, t0 se corre al plazo inferido). Best-effort.
    resetLoop(contact, message).catch(() => {})

    const msgHash = hashMessage(contact, message)
    await bufferInboundMessage(contact, message, msgHash)

    // 6-bis. ANTI-DUPLICADO TARDÍO (caso Iván Darío/Intelex 25-jul): el dedup
    // del buffer solo protege mientras la fila existe — drainInbox la BORRA, así
    // que un reintento de Botmaker 45 s después entra como mensaje nuevo y el
    // turno se procesa dos o tres veces (respuestas contradictorias y, si uno
    // falla, un "disculpa, tuve un inconveniente" encima de una conversación ya
    // respondida). Ventana de 2 min por hash, y SOLO para mensajes largos: un
    // "sí"/"ok"/"gracias" repetido es legítimo y debe pasar siempre.
    if (message.trim().length > 12) {
      const visto = await getKvValue(`msgseen_${msgHash}`).catch(() => null)
      const edadMs = visto ? Date.now() - Number(visto) : Infinity
      if (Number.isFinite(edadMs) && edadMs < 120_000) {
        console.warn(
          `[vic-co] duplicado descartado contact=${contact} hash=${msgHash} edad=${Math.round(edadMs / 1000)}s`,
        )
        return NextResponse.json({ reply: "", pais: "co" })
      }
      await setKvValue(`msgseen_${msgHash}`, String(Date.now())).catch(() => {})
    }


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
