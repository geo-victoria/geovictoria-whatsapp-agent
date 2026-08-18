/**
 * Webhook Botmaker — línea PERÚ (+51 922 067 167).
 *
 * FASE 1b (05-ago): el agente real de Vicky PE vive acá (patrón
 * vic-botmaker-mx: runAgentLoop + prompt PE + buildDispatchPE, pipeline
 * endurecido heredado de Chile), DETRÁS DE UN GATE para desplegar oscuro:
 *
 *   GATE: env VICKY_PE_ENABLED === "on"  O  vic_kv vicky_pe_enabled === "on".
 *   - APAGADO (default): el handler se comporta EXACTAMENTE como la
 *     contención del 04-ago — saludo honesto 1 vez por 24 h + persistir el
 *     historial (country "pe") + aviso interno para atender a mano.
 *   - ENCENDIDO: Vicky PE atiende de verdad. Se enciende SIN deploy
 *     escribiendo la kv (Fase 3, con el VB de Diego).
 *
 * HEREDA EL ESQUELETO ENDURECIDO DE CHILE/MX (mismas piezas, misma razón):
 * asíncrono con after() + push por el canal PE, buffer + dedup por hash,
 * lock por contacto (ráfagas = un turno combinado), typing indicator,
 * saneadores (voseo/formato/apertura), guardrails anti-alucinación y
 * circuit-breaker de errores.
 *
 * DIFERENCIAS PE (Fase 1b, a propósito):
 *   - SIN cotización formal (llega en Fase 2): el cierre es derivar a la
 *     ejecutiva → no hay quote pointer ni anti-amnesia de formal.
 *   - SIN proactividad automática (loop v2 / followup cron): esos crons no
 *     tienen textos ni identidad peruana todavía — enrolar mandaría copy
 *     chileno a un peruano. Las señales se procesan igual (opt-out cierra el
 *     ciclo; el seguimiento consensuado avisa al equipo para retomar a mano).
 *
 * Auth: header x-secret == env BOTMAKER_SECRET_PE o vic_kv botmaker_secret_pe
 * (misma validación que la contención — la kv permite rotar sin deploy).
 */

import { normalizarMensajeEntrante } from "@/lib/respuesta-boton"
import { NextResponse, after } from "next/server"
import { runAgentLoop } from "@/lib/agent-loop"
import { urlsDeToolsDelTurno, vieneDeUnaTool } from "@/lib/links-de-tools"
import { detectarProcesoHumano, directivaProcesoHumano } from "@/lib/proceso-humano"
import { PERFIL_PE } from "@/lib/paises/pe"
import { getSystemPromptPE } from "@/lib/paises/pe/prompt"
import { umbralPrecios, formatUmbralParaPrompt, dotacionSobreUmbral, formatDirectivaSobreUmbral, cinturonPrecioSobreUmbral, derivacionDePais, paisConUmbral } from "@/lib/umbral-autonomia"
import { TOOL_SCHEMAS_PE, buildDispatchPE } from "@/lib/paises/pe/tools"
import {
  fetchHistoryV3,
  appendTurnV3,
  markUserActivity,
  closeFollowup,
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
import { partirEnBurbujas } from "@/lib/burbujas"
import { paisDeContacto, WEBHOOK_POR_PAIS, SECRET_ENV_POR_PAIS } from "@/lib/ruteo-pais"
import { avisarEquipoInterno } from "@/lib/alerta-interna"
import { sanitizarVoseo, normalizarFormatoWhatsApp, quitarSignosApertura } from "@/lib/voseo-v3"
import { transcribirAudio } from "@/lib/transcribe-audio"
import { describirImagen } from "@/lib/describe-image"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const CANAL_PE = () => PERFIL_PE.canal.channelId

const BURST_DEBOUNCE_MS = Number(process.env.BURST_DEBOUNCE_MS || 1500)
const MAX_BURST_TURNS = 10
const MAX_INPUT_CHARS = 4000
const HOLD_TTL_MS = 24 * 60 * 60 * 1000

// Guardrail anti prompt-injection (espejo del chileno): mensajes que intentan
// extraer el prompt o inyectar instrucciones no se procesan con el agente.
const INJECT_RE =
  /###|IGNORE|DUMP|INSTRUC|SYSTEM PROMPT|\bPROMPT\b|\\u202|<script|DROP\s+TABLE|DELETE\s+FROM|UNION\s+SELECT/i

// ── Textos de la línea PE (peruano neutro cordial) ──────────────────────────
const PIDE_TEXTO_PE =
  "Disculpa — por ahora no puedo escuchar notas de voz 🙏 Me lo escribes por texto, por favor?"
const PIDE_TEXTO_IMAGEN_PE =
  "No pude ver bien la imagen 🙈 Me lo cuentas por texto, por favor?"
const ERROR_GENERICO_PE =
  "Disculpa, tuve un inconveniente para procesar tu mensaje. Me lo repites, por favor? 🙏"
// Despedida limpia si el modelo registró un opt-out y el turno quedó sin texto
// (herencia del guardrail 2.6d chileno).
const OPTOUT_GOODBYE_PE =
  "Entendido, no te contactaremos más. Si en el futuro lo necesitas, aquí estaré. Que te vaya muy bien! 🙌"
// Circuit-breaker (espejo del chileno): tras 2 errores seguidos en la misma
// conversación, se escala a humano UNA vez y luego se silencia.
const ESCALADA_ERROR_PE =
  "Disculpa, sigo teniendo un problema técnico. Ya le avisé a nuestro equipo para que se comunique contigo a la brevedad 🙏"
// Fallback que emite lib/agent-loop.ts cuando el turno termina SIN texto final.
// Copia literal — mantener en sync con agent-loop.
const AGENT_LOOP_EMPTY_FALLBACK =
  "Disculpa, tuve un problema procesando tu mensaje. ¿Puedes repetirlo o decirme con qué te puedo ayudar?"

// Saludo de CONTENCIÓN (gate apagado) — texto original del 04-ago, sin claims.
const SALUDO_PE =
  "¡Hola! Gracias por escribir a GeoVictoria Perú 🙌 Somos especialistas en control de asistencia. " +
  "Cuéntame brevemente qué necesitas (cuántas personas trabajan contigo y si buscas app, web o reloj de control) " +
  "y uno de nuestros especialistas te contactará muy pronto para ayudarte."

// Tools que cierran el ciclo de contacto: la conversación quedó en manos
// humanas (la ejecutiva PE la retoma).
const FOLLOWUP_CLOSING_TOOLS_PE = new Set(["derivar_a_ejecutivo"])

type ToolCallRecordPE = { name: string; ok: boolean; output?: unknown }

// ── Ruteo de modelo por turno (paridad CL/CO/MX, decisión de costos 11-jul) ──
// Sonnet SOLO en el flujo de cotización (precios/configuración), donde la
// calidad es crítica; Haiku para el resto (saludos, FAQ) — 3× más barato.
const MODELO_COTIZACION_PE = (
  process.env.ANTHROPIC_SALES_AGENT_MODEL_V3 || "claude-sonnet-4-5-20250929"
).trim()
const MODELO_SIMPLE_PE = (
  process.env.ANTHROPIC_SALES_AGENT_MODEL_SIMPLE || "claude-haiku-4-5-20251001"
).trim()

// El mensaje entrante pinta cotización/precio (marcadores PE: soles, RUC,
// mensualidad; sin UF ni NIT ni RFC).
const COTIZ_MSG_RE_PE =
  /cotiz|precio|cu[aá]nto|cuesta|\bvale\b|\bvalor\b|\bcaro\b|barat|descuento|rebaj|presupuesto|plan|oferta|pago inicial|mensualidad|\bsoles?\b|reloj|\bRUC\b|\d+\s*(trabajador|persona|emplead|colaborador|usuario)|somos\s+\d+/i
// La ÚLTIMA respuesta de Vicky ya estaba cotizando (sigue el flujo aunque el
// cliente solo conteste "sí"/"listo"/un dato suelto como el correo o el RUC).
const COTIZ_HIST_RE_PE =
  /cotiz|\/mes|pago inicial|mensualidad|instalaci[oó]n|\bplan\b|\bpunto|marca|reloj|\bRUC\b|correo|cu[aá]nt[ao]s?\s+person|trabajador|usuario/i

function esFlujoCotizacionPE(
  message: string,
  history: Array<{ role: string; content: string }>,
): boolean {
  if (COTIZ_MSG_RE_PE.test(message)) return true
  const lastAssistant =
    [...history].reverse().find((m) => m.role === "assistant")?.content || ""
  return COTIZ_HIST_RE_PE.test(lastAssistant)
}

type BotmakerBody = {
  contact?: string
  message?: string
  audioUrl?: string
  audioURL?: string
  imageUrl?: string
  imageURL?: string
  mediaUrl?: string
  mediaURL?: string
  fileUrl?: string
  fileURL?: string
  documentUrl?: string
  documentURL?: string
  channelId?: string
  simular?: boolean
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Secret de la línea PE: env o vic_kv (misma validación que la contención —
 * la kv permite configurar/rotar sin deploy). */
async function secretValido(recibido: string): Promise<boolean> {
  const env = (process.env.BOTMAKER_SECRET_PE || "").trim()
  if (env && recibido === env) return true
  const kv = ((await getKvValue("botmaker_secret_pe").catch(() => null)) || "").trim()
  return Boolean(kv && recibido === kv)
}

/** GATE de encendido: env VICKY_PE_ENABLED o vic_kv vicky_pe_enabled — la kv
 * permite prender/apagar Vicky PE sin deploy (Fase 3). */
async function vickyPeEncendida(): Promise<boolean> {
  if ((process.env.VICKY_PE_ENABLED || "").trim().toLowerCase() === "on") return true
  const kv = ((await getKvValue("vicky_pe_enabled").catch(() => null)) || "").trim().toLowerCase()
  return kv === "on"
}

/** Guarda el último payload no procesable en vic_kv para diagnóstico. */
async function capturarPayloadDebug(body: unknown): Promise<void> {
  try {
    await setKvValue(
      "debug_last_pe_payload",
      JSON.stringify({ at: new Date().toISOString(), body }).slice(0, 4000),
    )
  } catch {
    // best-effort
  }
}

async function processOneTurnPE(contact: string, message: string, apiKey: string): Promise<void> {
  const history = await fetchHistoryV3(contact)
  // PROCESO ÚNICO (espejo CL/MX): conversación nueva con ejecutivo ya
  // trabajando al contacto → directiva informativa en el historial.
  if (history.length === 0) {
    const proceso = await detectarProcesoHumano(contact, "pe").catch(() => null)
    if (proceso) history.push({ role: "assistant", content: directivaProcesoHumano(proceso) })
  }
  // PE sin cotización formal (Fase 2): no hay quote pointer que inyectar.
  const modelo = esFlujoCotizacionPE(message, history) ? MODELO_COTIZACION_PE : MODELO_SIMPLE_PE
  console.log(
    `[vic-pe-modelo] contact=${contact} modelo=${modelo} flujoCotizacion=${modelo === MODELO_COTIZACION_PE}`,
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
  const systemPromptPE = contextoUmbral + getSystemPromptPE(contact, umbralInfo?.umbral) + contextoUmbral + directivaUmbral
  const dispatchPE = buildDispatchPE(contact)
  const result = await runAgentLoop({
    systemPrompt: systemPromptPE,
    history,
    userMessage: message,
    apiKey,
    contact,
    model: modelo,
    tools: {
      schemas: TOOL_SCHEMAS_PE as unknown as unknown[],
      dispatch: dispatchPE,
    },
  })
  // El fallback del agent-loop viene con '¿' de apertura: comparar ANTES de
  // sanear (quitarSignosApertura rompería la igualdad).
  const rawReply = (result.reply || "").trim() === AGENT_LOOP_EMPTY_FALLBACK ? "" : result.reply || ""
  let reply = quitarSignosApertura(normalizarFormatoWhatsApp(sanitizarVoseo(rawReply)))

  // ALLOWLIST de dominios (herencia caso Transportes Viig CL, 22-jul): en PE
  // las tools NO devuelven links (sin formal, sin agenda) — cualquier URL del
  // modelo que no venga de una tool de este turno es fabricada y se retira.
  const urlsDeToolsPe = urlsDeToolsDelTurno(result.toolCalls)
  const DOMINIOS_VICKY_PE =
    /^https?:\/\/(?:[a-z0-9-]+\.)*(?:geovictoria\.com|supabase\.co|wa\.me|youtube\.com|youtu\.be)(?:[/?#]|$)/i
  for (const u of reply.match(/https?:\/\/[^\s)]+/gi) || []) {
    if (DOMINIOS_VICKY_PE.test(u)) continue
    if (vieneDeUnaTool(u, urlsDeToolsPe)) {
      console.log(`[vic-pe] LINK_DE_TOOL_RESCATADO contact=${contact} url=${u.slice(0, 140)}`)
      continue
    }
    console.error(`[vic-pe] LINK_FUERA_DE_ALLOWLIST contact=${contact} url=${u.slice(0, 140)}`)
    reply = reply.split(u).join("(te lo hago llegar enseguida)").trim()
  }

  let toolCalls = (result.toolCalls || []) as ToolCallRecordPE[]

  // ── Guardrail anti-alucinación (espejo 2.6b/2.6c chilenos, adaptado PE) ──
  // Si el reply AFIRMA que el equipo/la ejecutiva lo va a contactar (o que una
  // reunión quedó coordinada), pero NINGUNA tool lo respalda este turno, se
  // re-corre el loop forzando derivar_a_ejecutivo (en PE no hay tool de
  // agenda: TODA promesa de contacto humano pasa por la derivación).
  const afirmaContactoListoEn = (t: string) =>
    /\b(la\s+ejecutiva|una?\s+ejecutiv[oa]|el\s+equipo|nuestro\s+equipo|un\s+asesor)\b[^.]{0,60}\b(te\s+(contactar[aá]|llamar[aá]|escribir[aá]|va\s+a\s+(contactar|llamar))|se\s+(pondr[aá]|comunicar[aá]|contactar[aá]))/i.test(t) ||
    /\breuni[oó]n\b[^.]{0,40}(qued[oó]|est[aá]|fue)[^.]{0,18}\b(agendad|coordinad|confirmad)/i.test(t) ||
    /\bquedaste\s+registrad|\bte\s+dej[eé]\s+registrad/i.test(t)
  const afirmaContactoListo = afirmaContactoListoEn(reply)
  const realContacto = toolCalls.some((c) => c.name === "derivar_a_ejecutivo" && c.ok)
  if (afirmaContactoListo && !realContacto) {
    const FORZAR_TOOL =
      "\n\n# Instrucción de sistema (este turno)\n" +
      "Estás por confirmarle al cliente que la ejecutiva o el equipo lo contactará, pero NO puedes afirmarlo sin EJECUTAR la tool derivar_a_ejecutivo. " +
      "Llámala con los datos que ya entregó (incluida la preferencia de horario si pidió reunión) y SOLO después confirma, usando su mensajeParaProspecto. " +
      "Si faltan datos obligatorios, PÍDELOS en vez de afirmar que ya quedó listo."
    const retry = await runAgentLoop({
      systemPrompt: systemPromptPE + FORZAR_TOOL,
      history,
      userMessage: message,
      apiKey,
      contact,
      model: MODELO_COTIZACION_PE,
      tools: { schemas: TOOL_SCHEMAS_PE as unknown as unknown[], dispatch: dispatchPE },
    }).catch(() => null)
    const retryCalls = ((retry?.toolCalls || []) as ToolCallRecordPE[])
    const retryOk = retryCalls.some((c) => c.name === "derivar_a_ejecutivo" && c.ok)
    const retryReply = (retry?.reply || "").trim()
    if (retryOk && retryReply && retryReply !== AGENT_LOOP_EMPTY_FALLBACK) {
      console.warn(`[vic-pe] ALUCINACION_RECUPERADA contact=${contact}: el reintento forzó la tool.`)
      reply = quitarSignosApertura(normalizarFormatoWhatsApp(sanitizarVoseo(retryReply)))
      toolCalls = retryCalls
    } else if (
      retryReply &&
      retryReply !== AGENT_LOOP_EMPTY_FALLBACK &&
      !afirmaContactoListoEn(retryReply)
    ) {
      // El reintento corrigió SIN tool: la afirmación original era espuria
      // (caso Juan Angel CO, 24-jul) — va la respuesta del reintento.
      console.warn(
        `[vic-pe] ALUCINACION_CORREGIDA_SIN_TOOL contact=${contact}: la afirmación era espuria; va la respuesta del reintento.`,
      )
      reply = quitarSignosApertura(normalizarFormatoWhatsApp(sanitizarVoseo(retryReply)))
      toolCalls = retryCalls
    } else {
      console.error(
        `[vic-pe] ALUCINACION_SIN_TOOL contact=${contact} replyOriginal=${JSON.stringify(reply.slice(0, 300))}`,
      )
      // Auditoría 20-jul: el fallo técnico NO se le cobra al cliente
      // re-pidiéndole datos — se avisa al equipo para completar a mano.
      reply =
        "Disculpa, tuve un problema técnico registrando tu solicitud — ya avisé al equipo para que igual te contacten con los datos que me diste. No necesitas reenviarme nada 🙌"
      await avisarEquipoInterno(
        `⚠️ Registro de CONTACTO falló (tras reintento, línea PE) — contacto +${contact}. El cliente quedó con la promesa de contacto: revisar la conversación en Botmaker y completar a mano (ejecutiva PE).`,
      )
    }
  }

  // Opt-out con turno sin texto → despedida limpia, no un mensaje de error.
  const callNoContactar = toolCalls.find((c) => c.name === "marcar_no_contactar" && c.ok)
  if (callNoContactar && (!reply.trim() || reply === ERROR_GENERICO_PE)) {
    reply = OPTOUT_GOODBYE_PE
  }
  if (!reply.trim()) reply = ERROR_GENERICO_PE

  await appendTurnV3(contact, message, reply, "pe").catch((e) =>
    console.error(`[vic-pe] error persistiendo turno contact=${contact}:`, e),
  )

  // ── Señales de ciclo de contacto (best-effort) ──
  // OJO Fase 1b: PE NO se enrola en el loop v2 ni en el followup automático —
  // esos crons generan textos con identidad chilena para países desconocidos
  // (identidadPorPais/TEXTOS sin caso "pe") y mandarían copy chileno a un
  // peruano. Hasta que existan textos PE (Fase 3), la proactividad es del
  // equipo humano: el seguimiento consensuado se avisa por el canal interno.
  try {
    const tipoNoContactar =
      (callNoContactar?.output as { tipo?: string } | undefined)?.tipo === "perdido"
        ? "perdido"
        : "opt_out"
    const segConsensuado = toolCalls.find((c) => c.name === "programar_seguimiento" && c.ok)
    const usoCierre = toolCalls.some((c) => FOLLOWUP_CLOSING_TOOLS_PE.has(c.name) && c.ok)
    if (callNoContactar) {
      await closeFollowup(contact, tipoNoContactar, "pe")
      console.log(`[vic-pe][followup] ${tipoNoContactar} (tool) → ciclo cerrado contact=${contact}`)
    } else if (segConsensuado) {
      const cuandoIso = (segConsensuado.output as { cuandoIso?: string } | undefined)?.cuandoIso
      await avisarEquipoInterno(
        `🇵🇪 SEGUIMIENTO ACORDADO (línea PE, sin push automático en Fase 1b): +${contact} quedó de retomar el ${cuandoIso || "(fecha no legible)"} — agendar el re-contacto a mano (ejecutiva PE).`,
      ).catch(() => {})
      console.log(`[vic-pe][followup] consensuado contact=${contact} cuando=${cuandoIso} (aviso interno)`)
    } else if (usoCierre) {
      await closeFollowup(contact, "derivado", "pe")
      console.log(`[vic-pe][followup] derivado → ciclo cerrado contact=${contact}`)
    }
    // else: sin cadencia automática que armar en PE (ver comentario de arriba).
  } catch (err) {
    console.error(`[vic-pe][followup] error actualizando seguimiento contact=${contact}:`, err)
  }
  // CINTURÓN DE PRECIOS SOBRE EL UMBRAL (Lalo 18-ago, paridad CL — caso
  // David Oviedo): con dotación declarada sobre el umbral, ningún mensaje
  // con precio sale al cliente aunque el modelo lo escriba a mano.
  if (dotacionDetectada && reply) {
    const cinturon = cinturonPrecioSobreUmbral(reply)
    if (cinturon.habiaPrecio) {
      console.warn(`[umbral-cinturon] precio en texto con dotación ${dotacionDetectada} sobre el umbral para ${contact} — respuesta reemplazada`)
      reply = cinturon.reemplazo
    }
  }
  // Burbujas por punto aparte (Rodrigo 09-ago, paridad CL): cada párrafo
  // es un mensaje; los bloques estructurados no se fragmentan.
  let sent = true
  for (const [bi, burbuja] of partirEnBurbujas(reply).entries()) {
    if (bi > 0) await sendTypingIndicator(contact, true).catch(() => {})
    sent = await sendBotmakerMessage(contact, burbuja, CANAL_PE())
    if (!sent) break
  }
  console.log(
    `[vic-pe] turno contact=${contact} iter=${result.iterations} tools=${result.toolCalls.map((t) => t.name).join(",") || "-"} sent=${sent}`,
  )
}

// Espejo de processBurst chileno/MX (misma semántica de lock/carrera/tope).
async function processBurstPE(contact: string, apiKey: string, seedMessage?: string): Promise<void> {
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
        await processOneTurnPE(contact, combinado, apiKey)
      } catch (err) {
        console.error(`[vic-pe] error en turno contact=${contact}:`, err)
        // Circuit-breaker (espejo CL): si los últimos turnos ya fueron errores,
        // no repetir el fallback en loop — escalar UNA vez y luego silenciar.
        try {
          const recientes = await fetchHistoryV3(contact, 6).catch(() => [])
          const esError = (t?: string) => t === ERROR_GENERICO_PE || t === ESCALADA_ERROR_PE
          const ultimos = recientes
            .filter((m) => m.role === "assistant")
            .slice(-2)
            .map((m) => m.content?.trim())
          const dosErroresSeguidos = ultimos.length >= 2 && ultimos.every(esError)
          if (dosErroresSeguidos && ultimos[ultimos.length - 1] === ESCALADA_ERROR_PE) {
            console.error(`[vic-pe] CIRCUIT_BREAKER contact=${contact}: errores en loop, silenciando (ya se escaló).`)
          } else {
            const errReply = dosErroresSeguidos ? ESCALADA_ERROR_PE : ERROR_GENERICO_PE
            await appendTurnV3(contact, combinado, errReply, "pe").catch(() => {})
            await sendBotmakerMessage(contact, errReply, CANAL_PE()).catch(() => {})
          }
        } catch {
          await sendBotmakerMessage(contact, ERROR_GENERICO_PE, CANAL_PE()).catch(() => {})
        }
      }

      if (++turns >= MAX_BURST_TURNS) {
        console.warn(`[vic-pe] tope de turnos de ráfaga alcanzado contact=${contact}`)
        return
      }
    }
  } finally {
    sendTypingIndicator(contact, false, CANAL_PE()).catch(() => {})
    if (holdsLock) await releaseLock(contact).catch(() => {})
  }
}

/** CONTENCIÓN (gate apagado) — comportamiento EXACTO del handler del 04-ago:
 * saludo honesto 1 vez por 24 h + persistir + aviso interno. */
async function responderContencion(body: BotmakerBody): Promise<NextResponse> {
  // IDs anónimos de Meta ("CO.…"): conservar CRUDOS o la respuesta se va a un
  // chat fantasma (caso CIMA 30-jul; reincidencia CO 08-ago). Igual que CL.
  const contact = (body.contact || "").trim().replace(/^\+/, "")
  const message = (body.message || "").toString().slice(0, 2000)
  if (!contact) return NextResponse.json({ reply: "" })

  const adjunto = body.audioURL ? " [nota de voz]" : body.fileUrl ? " [documento]" : body.imageUrl ? " [imagen]" : ""
  const holdKey = `pe_hold_${contact}`
  const ya = await getKvValue(holdKey).catch(() => null)
  const dentroDeHold = Boolean(ya && Date.now() - new Date(ya).getTime() < HOLD_TTL_MS)
  const reply = dentroDeHold ? "" : SALUDO_PE

  // Historial primero (best-effort): cuando Vicky PE despierte, sabrá todo.
  await appendTurnV3(contact, `${message || adjunto.trim() || "(sin texto)"}${message ? adjunto : ""}`, reply || "(sin respuesta — contención PE)", "pe").catch(() => {})
  if (!dentroDeHold) await setKvValue(holdKey, new Date().toISOString()).catch(() => {})

  await avisarEquipoInterno(
    `🇵🇪 LÍNEA PERÚ (Vicky PE apagada — atender a mano): +${contact} escribió: ` +
      `${(message || adjunto.trim() || "(sin texto)").slice(0, 300)}`,
  ).catch(() => {})

  console.log(`[vicky-pe-hold] contact=${contact} msg=${JSON.stringify(message).slice(0, 80)}${adjunto} saludo=${reply ? "si" : "no"}`)
  return NextResponse.json({ reply })
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const secret = (request.headers.get("x-secret") || "").trim()
    if (!(await secretValido(secret))) {
      return NextResponse.json({ reply: "" }, { status: 401 })
    }

    const body = (await request.json().catch(() => null)) as BotmakerBody | null
    if (!body) return NextResponse.json({ reply: "" }, { status: 400 })

    // ── GATE de encendido: apagado (default) = contención EXACTA del 04-ago.
    const simulacion = body.simular === true
    const encendida = await vickyPeEncendida()
    if (!encendida && !simulacion) {
      return responderContencion(body)
    }

    // IDs anónimos de Meta ("CO.…"): conservar CRUDOS o la respuesta se va a un
  // chat fantasma (caso CIMA 30-jul; reincidencia CO 08-ago). Igual que CL.
  const contact = (body.contact || "").trim().replace(/^\+/, "")
    let message = (body.message || "").trim()

    // Respuesta por BOTÓN: Botmaker manda el payload del intent, no el texto.
    // Se normaliza en la entrada para que todo lo de abajo vea el texto real
    // y no el JSON crudo (ver lib/respuesta-boton.ts). PE aún no manda
    // plantillas con botones, pero el saneo es gratis y a prueba de futuro.
    message = normalizarMensajeEntrante(message)
    const audioUrl = (body.audioUrl || body.audioURL || "").trim()

    // Canal de ORIGEN (espejo CL/MX): si la acción de código PE manda
    // channelId, se persiste — los pushes salen por la línea donde escribió.
    const canalBody = (body.channelId || "").trim()
    if (contact && canalBody) {
      if (canalCoherenteConContacto(contact, canalBody)) {
        setKvValue(`canal_origen_${contact}`, canalBody).catch(() => {})
      } else {
        const conocido = await getKvValue(`canal_origen_${contact}`).catch(() => null)
        if (!conocido) await detectarCanalOrigen(contact).catch(() => "")
      }
    }

    // Ruteo de retorno (espejo del MX): el Master Bot rutea por ID DEL CANAL,
    // así que un +56/+57/+52 que escriba a la LÍNEA peruana aterriza acá. Se
    // reenvía al webhook de su país (lib/ruteo-pais no conoce "pe" todavía,
    // así que el forward se arma acá con sus mismos mapas exportados). Un +51
    // devuelve "desconocido" en paisDeContacto → se atiende localmente, que
    // es exactamente lo que corresponde.
    if (contact && !simulacion) {
      const paisAjeno = paisDeContacto(contact)
      if (paisAjeno === "cl" || paisAjeno === "co" || paisAjeno === "mx") {
        const destino = WEBHOOK_POR_PAIS[paisAjeno]
        const secretDestino = (process.env[SECRET_ENV_POR_PAIS[paisAjeno]] || "").trim()
        if (!secretDestino) {
          console.error(`[vic-pe][ruteo] contact=${contact} es ${paisAjeno.toUpperCase()} pero falta ${SECRET_ENV_POR_PAIS[paisAjeno]} — no se puede reenviar.`)
          return NextResponse.json({ reply: "" })
        }
        const origin = new URL(request.url).origin
        const r = await fetch(`${origin}${destino}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-secret": secretDestino },
          body: JSON.stringify(body),
          cache: "no-store",
        }).catch(() => null)
        if (!r) {
          // Ante fallo del reenvío NO se atiende con flujo PE (cotizar en la
          // moneda equivocada es peor que un reintento del cliente).
          console.error(`[vic-pe][ruteo] contact=${contact} es ${paisAjeno.toUpperCase()} y el reenvío falló — no se atiende con flujo PE.`)
          return NextResponse.json({ reply: "" })
        }
        const data = await r.json().catch(() => ({ reply: "" }))
        console.log(`[vic-pe][ruteo] contact=${contact} es ${paisAjeno.toUpperCase()} → reenviado a ${destino} (${r.status})`)
        return NextResponse.json(data, { status: r.status })
      }
    }

    if (!contact) return NextResponse.json({ ok: false, error: "contact requerido" }, { status: 400 })

    const apiKey = (process.env.ANTHROPIC_API_KEY || "").trim()
    if (!apiKey) {
      return NextResponse.json({ ok: false, error: "ANTHROPIC_API_KEY no configurada" }, { status: 503 })
    }

    // Nota de voz: transcribir y seguir como texto (herencia chilena). Si la
    // transcripción falla, pedir texto; NUNCA procesar el placeholder.
    if (audioUrl && (!message || message === "__audio__")) {
      sendTypingIndicator(contact, true, CANAL_PE()).catch(() => {})
      const transcript = await transcribirAudio(audioUrl)
      if (transcript) {
        message = transcript
        console.log(`[vic-pe] audio transcrito contact=${contact} len=${transcript.length}`)
      } else {
        if (!simulacion) await sendBotmakerMessage(contact, PIDE_TEXTO_PE, CANAL_PE()).catch(() => {})
        return NextResponse.json({ reply: simulacion ? PIDE_TEXTO_PE : "", pais: "pe" })
      }
    }

    // Foto/imagen o DOCUMENTO (paridad CL/MX): se "lee" con visión y el texto
    // sigue el flujo normal. En PE aún no hay flujo de comprobantes (sin pago
    // en línea): un documento ilegible se pregunta con naturalidad.
    const imageUrl = (body.imageUrl || body.imageURL || body.mediaUrl || body.mediaURL || "").trim()
    const fileUrl = (body.fileUrl || body.fileURL || body.documentUrl || body.documentURL || "").trim()
    const FILE_PLACEHOLDERS = ["__file__", "__document__", "__doc__", "__pdf__"]
    const IMG_PLACEHOLDERS = ["__image__", "__media__", "__photo__"]
    const esArchivoAdjunto = FILE_PLACEHOLDERS.includes(message.trim())
    const CONTEXTO_DOC_ILEGIBLE_PE =
      "[El cliente envió un ARCHIVO adjunto que el sistema no puede visualizar (probablemente un PDF). NO le digas que no puedes verlo: agradécele el envío y pregúntale con naturalidad qué contiene el documento para poder ayudarle.]"
    const mediaUrlEntrante = imageUrl || fileUrl
    if (mediaUrlEntrante) {
      sendTypingIndicator(contact, true, CANAL_PE()).catch(() => {})
      const descripcion = await describirImagen(mediaUrlEntrante)
      const caption = IMG_PLACEHOLDERS.includes(message) || esArchivoAdjunto ? "" : message
      if (descripcion) {
        const bloque = esArchivoAdjunto || (!imageUrl && fileUrl)
          ? `[El cliente envió un DOCUMENTO (PDF) por WhatsApp. Contenido del documento]: ${descripcion}`
          : `[El cliente envió una imagen por WhatsApp. Contenido de la imagen]: ${descripcion}`
        message = caption ? `${caption}\n\n${bloque}` : bloque
        console.log(`[vic-pe] adjunto descrito contact=${contact} len=${descripcion.length}`)
      } else if (esArchivoAdjunto) {
        message = CONTEXTO_DOC_ILEGIBLE_PE
      } else if (!caption) {
        await capturarPayloadDebug(body)
        if (!simulacion) await sendBotmakerMessage(contact, PIDE_TEXTO_IMAGEN_PE, CANAL_PE()).catch(() => {})
        return NextResponse.json({ reply: simulacion ? PIDE_TEXTO_IMAGEN_PE : "", pais: "pe" })
      } else {
        message = caption
      }
    } else if (esArchivoAdjunto) {
      message = CONTEXTO_DOC_ILEGIBLE_PE
    } else if (IMG_PLACEHOLDERS.includes(message)) {
      await capturarPayloadDebug(body)
      if (!simulacion) await sendBotmakerMessage(contact, PIDE_TEXTO_IMAGEN_PE, CANAL_PE()).catch(() => {})
      return NextResponse.json({ reply: simulacion ? PIDE_TEXTO_IMAGEN_PE : "", pais: "pe" })
    }

    if (!message || message === "__audio__") {
      await capturarPayloadDebug(body)
      return NextResponse.json({ ok: false, error: "message requerido" }, { status: 400 })
    }

    // Anti prompt-injection (espejo CL): no se procesa con el agente.
    if (INJECT_RE.test(message)) {
      console.warn(`[vic-pe] INJECT bloqueado contact=${contact} msg=${JSON.stringify(message.slice(0, 150))}`)
      const neutro = "Te puedo ayudar con información sobre nuestro servicio de control de asistencia? 😊"
      if (simulacion) return NextResponse.json({ reply: neutro, pais: "pe", simulacion: true })
      await sendBotmakerMessage(contact, neutro, CANAL_PE()).catch(() => {})
      return NextResponse.json({ reply: "" })
    }

    // Modo simulación (pruebas E2E): síncrono, sin lock, sin persistir. Corre
    // AUNQUE el gate esté apagado — así se prueba Vicky PE en oscuro.
    if (simulacion) {
      const modeloSim = esFlujoCotizacionPE(message, []) ? MODELO_COTIZACION_PE : MODELO_SIMPLE_PE
      const result = await runAgentLoop({
        systemPrompt: await (async () => {
          // Espejo del camino real (umbral 08-ago): la simulación E2E debe
          // ver el mismo prompt que el cliente.
          const uInfo = paisConUmbral(contact) ? await umbralPrecios(contact).catch(() => null) : null
          const dP = derivacionDePais(contact)
          const cU = uInfo ? formatUmbralParaPrompt(uInfo.umbral, uInfo.origen, dP) : ""
          const dot = uInfo ? dotacionSobreUmbral(message, uInfo.umbral) : null
          const dir = dot && uInfo ? formatDirectivaSobreUmbral(dot, uInfo.umbral, dP) : ""
          return cU + getSystemPromptPE(contact, uInfo?.umbral) + cU + dir
        })(),
        history: [],
        userMessage: message,
        apiKey,
        contact,
        model: modeloSim,
        tools: { schemas: TOOL_SCHEMAS_PE as unknown as unknown[], dispatch: buildDispatchPE(contact) },
      })
      // Mismos guardrails de texto final del camino real (comparación ANTES
      // de sanear; opt-out sin texto → despedida).
      const simRaw =
        (result.reply || "").trim() === AGENT_LOOP_EMPTY_FALLBACK ? "" : result.reply || ""
      let reply = quitarSignosApertura(normalizarFormatoWhatsApp(sanitizarVoseo(simRaw)))
      const simToolCalls = (result.toolCalls || []) as ToolCallRecordPE[]
      if (
        simToolCalls.some((c) => c.name === "marcar_no_contactar" && c.ok) &&
        (!reply.trim() || reply === ERROR_GENERICO_PE)
      ) {
        reply = OPTOUT_GOODBYE_PE
      }
      if (!reply.trim()) reply = ERROR_GENERICO_PE
      return NextResponse.json({
        reply,
        handoff: result.handoff,
        pais: "pe",
        simulacion: true,
        modelo: modeloSim,
      })
    }

    // ── Pipeline endurecido (herencia chilena) ──
    // El cliente habló → pausar cualquier cadencia en curso (best-effort; en
    // Fase 1b PE no arma cadencias, pero la señal de actividad se registra).
    await markUserActivity(contact, "pe").catch(() => {})

    const msgHash = hashMessage(contact, message)
    await bufferInboundMessage(contact, message, msgHash)

    // Anti-duplicado tardío (caso Iván Darío/Intelex 25-jul): ventana de 2 min
    // por hash, SOLO para mensajes largos (un "sí"/"ok" repetido es legítimo).
    if (message.trim().length > 12) {
      const visto = await getKvValue(`msgseen_${msgHash}`).catch(() => null)
      const edadMs = visto ? Date.now() - Number(visto) : Infinity
      if (Number.isFinite(edadMs) && edadMs < 120_000) {
        console.warn(
          `[vic-pe] duplicado descartado contact=${contact} hash=${msgHash} edad=${Math.round(edadMs / 1000)}s`,
        )
        return NextResponse.json({ reply: "", pais: "pe" })
      }
      await setKvValue(`msgseen_${msgHash}`, String(Date.now())).catch(() => {})
    }

    const lockResult = await acquireLock(contact, msgHash)
    if (!lockResult.acquired) {
      console.log(`[vic-pe] ${contact}: mensaje encolado, ya hay un procesador activo`)
      return NextResponse.json({ reply: "" })
    }

    sendTypingIndicator(contact, true, CANAL_PE()).catch(() => {})
    console.log(`[vic-pe] IN contact=${contact} msg=${JSON.stringify(message.slice(0, 60))}`)
    after(processBurstPE(contact, apiKey, message))

    return NextResponse.json({ reply: "" })
  } catch (err) {
    console.error("[vic-pe] error en webhook:", err)
    return NextResponse.json({ reply: ERROR_GENERICO_PE, pais: "pe" }, { status: 200 })
  }
}
