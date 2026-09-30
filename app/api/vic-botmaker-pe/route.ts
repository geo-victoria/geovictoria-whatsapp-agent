/**
 * Webhook Botmaker — línea PERÚ (+51 922 067 167).
 *
 * PUERTA de la línea: auth, gate, ruteo por país, audio/adjuntos, ráfaga y
 * lock. El TURNO corre por lib/orquestador-turno con PERFIL_TURNO_PE — el
 * mismo pipeline de Chile (el procesador propio de este archivo se retiró el
 * 26-sep). DETRÁS DE UN GATE:
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
import { PERFIL_PE } from "@/lib/paises/pe"
import { procesarTurno, simularTurno } from "@/lib/orquestador-turno"
import { PERFIL_TURNO_PE } from "@/lib/paises/pe/turno"
import {
  fetchHistoryV3,
  appendTurnV3,
  markUserActivity,
  setKvValue,
  getKvValue,
} from "@/lib/supabase-persistence-v3"
import { resetLoop } from "@/lib/loop-v2"
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
import { avisarEquipoInterno } from "@/lib/alerta-interna"
import { transcribirAudio } from "@/lib/transcribe-audio"
import { describirImagen } from "@/lib/describe-image"
import { faseDelContacto } from "@/lib/onboarding-canal"

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
// Circuit-breaker (espejo del chileno): tras 2 errores seguidos en la misma
// conversación, se escala a humano UNA vez y luego se silencia.
const ESCALADA_ERROR_PE =
  "Disculpa, sigo teniendo un problema técnico. Ya le avisé a nuestro equipo para que se comunique contigo a la brevedad 🙏"
// Saludo de CONTENCIÓN (gate apagado) — texto original del 04-ago, sin claims.
const SALUDO_PE =
  "¡Hola! Gracias por escribir a GeoVictoria Perú 🙌 Somos especialistas en control de asistencia. " +
  "Cuéntame brevemente qué necesitas (cuántas personas trabajan contigo y si buscas app, web o reloj de control) " +
  "y uno de nuestros especialistas te contactará muy pronto para ayudarte."

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
  /** Solo con simular: transcripción del adjunto (reemplaza a la visión). */
  descripcionAdjunto?: string
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

/**
 * FASE ONBOARDING EN PERÚ (21-sep, Lalo "básicamente es lo mismo que hace
 * Vicky de Chile"): tras el pago el contacto pasa al agente de onboarding —
 * prompt y toolset propios (alta por chat con RUC/DNI, nómina, capacitación),
 * MISMO pipeline de salida. Cero maquinaria comercial: ni guardrails de
 * venta, ni loop, ni casuística. Antes el webhook PE no conocía la fase y el
 * "sí" del cliente lo recibía la vendedora, así que confirmar_alta_empresa
 * jamás corría (brecha 2 del levantamiento 21-sep).
 * Devuelve el reply YA enviado (o solo calculado en simulación).
 */
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
        // Orquestador único: el turno corre SIEMPRE por lib/orquestador-turno
        // (el mismo pipeline de Chile con el perfil del país). El procesador
        // propio de este webhook se retiró el 26-sep.
        await procesarTurno(contact, combinado, apiKey, PERFIL_TURNO_PE)
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
    const paisProb = contact && canalBody
      ? await (await import("@/lib/probador-pais")).paisProbador(contact).catch(() => null)
      : null
    if (contact && canalBody) {
      if (canalCoherenteConContacto(contact, canalBody, paisProb)) {
        setKvValue(`canal_origen_${contact}`, canalBody).catch(() => {})
      } else {
        const conocido = await getKvValue(`canal_origen_${contact}`).catch(() => null)
      // Un origen guardado que TAMPOCO calza con el país del contacto (quedó
      // mal por la regla vieja de Perú, 25-sep) se reemplaza por la línea del
      // país: sin esto las respuestas seguían saliendo por la línea chilena.
      if (conocido && !canalCoherenteConContacto(contact, conocido, paisProb)) {
        const { channelIdPorPais, paisLineaDeContacto } = await import("@/lib/linea-por-pais")
        const p = paisLineaDeContacto(contact)
        if (p === "pe" || p === "co" || p === "mx" || p === "cl") {
          await setKvValue(`canal_origen_${contact}`, channelIdPorPais(p)).catch(() => {})
          console.warn(`[canal-origen] ${contact}: origen guardado ${conocido} no calza con su país — repuesto a la línea de ${p.toUpperCase()}`)
        }
      }
        if (!conocido) await detectarCanalOrigen(contact).catch(() => "")
      }
    }

    // Ruteo de retorno (espejo del MX): el Master Bot rutea por ID DEL CANAL,
    // así que un +56/+57/+52 que escriba a la LÍNEA peruana aterriza acá. Se
    // reenvía al webhook de su país. Desde el 15-sep lib/ruteo-pais conoce
    // "pe": un +51 es local y se atiende acá (y un +51 que escribe a otra
    // línea llega reenviado desde ese webhook).
    if (contact && !simulacion) {
      const ruteo = await reenviarSiNoEsDeEstePais({
        contact,
        paisLocal: "pe",
        requestUrl: request.url,
        body,
        etiquetaLog: "[vic-pe][ruteo]",
      })
      if (ruteo.reenviado) {
        if ("fallo" in ruteo) return NextResponse.json({ reply: "" })
        return NextResponse.json(ruteo.data, { status: ruteo.status })
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
    // sigue el flujo normal. Desde el 15-sep PE cobra también por transferencia:
    // un comprobante (imagen o PDF) va a registrar_comprobante_transferencia.
    const imageUrl = (body.imageUrl || body.imageURL || body.mediaUrl || body.mediaURL || "").trim()
    const fileUrl = (body.fileUrl || body.fileURL || body.documentUrl || body.documentURL || "").trim()
    const FILE_PLACEHOLDERS = ["__file__", "__document__", "__doc__", "__pdf__"]
    const IMG_PLACEHOLDERS = ["__image__", "__media__", "__photo__"]
    const esArchivoAdjunto = FILE_PLACEHOLDERS.includes(message.trim())
    const CONTEXTO_DOC_ILEGIBLE_PE =
      "[El cliente envió un ARCHIVO adjunto que el sistema no puede visualizar (probablemente un PDF). NO le digas que no puedes verlo. Si el contexto de la conversación es de PAGO (acaba de aceptar, habló de transferencia o comprobante), lo más probable es que sea su comprobante: agradécele el envío, llama registrar_comprobante_transferencia con montoDetectado 0 y detalle 'comprobante enviado como archivo adjunto', y sigue el flujo normal sin afirmar que el pago quedó confirmado. Si el contexto NO es de pago, agradécele y pregúntale con naturalidad qué contiene el documento para poder ayudarle.]"
    // Simulación (E2E): `descripcionAdjunto` = lo que la visión habría leído de
    // la foto — el simulador no tiene URL pública y así se prueba el bloque
    // del adjunto (directivas de nómina y de comprobante) de punta a punta.
    const descripcionSimulada = simulacion ? String(body.descripcionAdjunto || "").trim() : ""
    const mediaUrlEntrante = imageUrl || fileUrl || (descripcionSimulada ? "simulado://adjunto" : "")
    if (mediaUrlEntrante) {
      if (!descripcionSimulada) sendTypingIndicator(contact, true, CANAL_PE()).catch(() => {})
      const descripcion = descripcionSimulada || (await describirImagen(mediaUrlEntrante))
      const caption = IMG_PLACEHOLDERS.includes(message) || esArchivoAdjunto ? "" : message
      if (descripcion) {
        const bloque = esArchivoAdjunto || (!imageUrl && fileUrl)
          ? `[El cliente envió un DOCUMENTO (PDF) por WhatsApp. Contenido del documento]: ${descripcion}`
          : `[El cliente envió una imagen por WhatsApp. Contenido de la imagen]: ${descripcion}`
        // ONBOARDING (paridad CL 25-ago): la directiva viaja EN el mensaje del
        // adjunto — si trae trabajadores, guardar_nomina corre SIEMPRE.
        const directivaNomina = (await faseDelContacto(contact).catch(() => "venta")) === "onboarding"
          ? "\n\n[DIRECTIVA OBLIGATORIA: si este contenido incluye trabajadores (DNI/correo/nombre), llama guardar_nomina AHORA con TODAS las filas transcritas — aunque creas que ya están cargados o el archivo se repita. Tu memoria no cuenta: solo lo guardado por la tool existe.]"
          : ""
        // COMPROBANTE (21-sep, E2E en sitio): la regla del prompt no alcanzó —
        // el modelo acusó recibo "por S/70" sin llamar la tool. La directiva va
        // EN el mensaje del adjunto (mismo patrón que la nómina).
        const { directivaComprobante } = await import("@/lib/comprobante-directiva")
        const directivaPago = directivaNomina ? "" : directivaComprobante(descripcion)
        message = caption ? `${caption}\n\n${bloque}${directivaNomina}${directivaPago}` : `${bloque}${directivaNomina}${directivaPago}`
        console.log(`[vic-pe] adjunto descrito contact=${contact} len=${descripcion.length}${directivaPago ? " comprobante=si" : ""}`)
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

    // Modo simulación (pruebas E2E): corre el MISMO turno que el cliente —
    // lib/orquestador-turno con el perfil del país: prompt, tools, cinturones,
    // hitos y persistencia— y captura la respuesta. Acotado a sintéticos y
    // probadores internos: nunca ensucia el chat de un cliente real.
    if (simulacion) {
      const limpio = String(contact || "").replace(/\D/g, "")
      const prueba =
        /^51900000\d{3}$/.test(limpio) ||
        (await import("@/lib/funnel-analysis").then((m) => m.metricsContactSet()).catch(() => new Set<string>())).has(limpio)
      if (!prueba) {
        return NextResponse.json({ ok: false, error: "simulación solo para números de prueba y probadores internos", pais: "pe" }, { status: 403 })
      }
      const cap = await simularTurno(contact, message, apiKey, PERFIL_TURNO_PE)
      const hist = await fetchHistoryV3(contact).catch(() => [])
      return NextResponse.json({ reply: cap.reply, tools: cap.tools, usage: cap.usage, pais: "pe", simulacion: true, orquestador: true, conHistorial: true, turnosEnHistorial: hist.length })
    }

    // ── Pipeline endurecido (herencia chilena) ──
    // El cliente habló → pausar cualquier cadencia en curso (best-effort; en
    // Fase 1b PE no arma cadencias, pero la señal de actividad se registra).
    await markUserActivity(contact, "pe").catch(() => {})
    // Loop v2 (herencia CL/CO): el mensaje entrante re-ancla el loop del
    // contacto (t0 = ahora; con señal de espera, t0 se corre al plazo).
    resetLoop(contact, message).catch(() => {})

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
