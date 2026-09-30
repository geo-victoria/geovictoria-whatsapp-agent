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
 * El TURNO corre por lib/orquestador-turno con el perfil del país — el mismo
 * pipeline de Chile (el procesador propio de este archivo se retiró el 26-sep).
 * Acá queda la PUERTA, con el esqueleto endurecido de Chile:
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
 *   - body.simular === true: SÍNCRONO — corre el MISMO turno del cliente
 *     (lib/orquestador-turno) y persiste; solo sintéticos y probadores.
 *
 * Auth: header x-secret == BOTMAKER_SECRET_CO.
 */

import {
  cierrePorBoton,
  normalizarMensajeEntrante,
} from "@/lib/respuesta-boton"
import { NextResponse, after } from "next/server"
import { guardarOrigenAnuncio } from "@/lib/origen-anuncio"
import { PERFIL_CO } from "@/lib/paises/co"
import { procesarTurno, simularTurno } from "@/lib/orquestador-turno"
import { PERFIL_TURNO_CO } from "@/lib/paises/co/turno"
import {
  fetchHistoryV3,
  appendTurnV3,
  markUserActivity,
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
import { resetLoop } from "@/lib/loop-v2"
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
// Circuit-breaker (espejo del chileno): tras 2 errores seguidos en la misma
// conversación, se escala a humano UNA vez y luego se silencia (en CL este
// loop llegó a 60 mensajes idénticos en producción).
const ESCALADA_ERROR_CO =
  "Disculpa, sigo teniendo un problema técnico. Ya le avisé a un ejecutivo para que se comunique contigo a la brevedad 🙏"
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
  /** Solo con simular: transcripción del adjunto (reemplaza a la visión). */
  descripcionAdjunto?: string
  /** Meta Ads "Clic a WhatsApp": bloque referral del anuncio (Lalo 30-sep). */
  referral?: unknown
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
        // Orquestador único: el turno corre SIEMPRE por lib/orquestador-turno
        // (el mismo pipeline de Chile con el perfil del país). El procesador
        // propio de este webhook se retiró el 26-sep.
        await procesarTurno(contact, combinado, apiKey, PERFIL_TURNO_CO)
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
    // Patrón dual de PE: header x-secret == env O vic_kv (botmaker_secret_co) — la kv
    // permite rotar/probar (modo simulación E2E) sin deploy.
    const secret = (request.headers.get("x-secret") || "").trim()
    const kvSecret = ((await getKvValue("botmaker_secret_co").catch(() => null)) || "").trim()
    if (!SECRET_CO && !kvSecret) {
      return NextResponse.json({ ok: false, error: "BOTMAKER_SECRET_CO no configurado" }, { status: 503 })
    }
    if (!(SECRET_CO && secret === SECRET_CO) && !(kvSecret && secret === kvSecret)) {
      return NextResponse.json({ reply: "Unauthorized" }, { status: 401 })
    }

    const body = (await request.json().catch(() => ({}))) as BotmakerBody
    // Contactos SIN teléfono (números ocultos de Meta): llegan como
    // "CO.1945724922773240" y ese ID COMPLETO es la identidad del chat en
    // Botmaker — reducirlo a dígitos manda la respuesta a un chat FANTASMA
    // que el cliente jamás ve (caso CIMA 30-jul en CL; reincidencia CO
    // 08-ago con CO.1945724922773240). Mismo normalizado que el webhook CL.
    const contact = (body.contact || "").trim().replace(/^\+/, "")
    // Clic a WhatsApp de Meta Ads (Lalo 30-sep): la acción de código reenvía el
    // `referral` del anuncio en el primer mensaje. Se guarda en segundo plano
    // (solo si el contacto no tenía origen) y jamás toca la respuesta.
    if (body.referral && !body.simular) after(() => guardarOrigenAnuncio(contact, body.referral).then(() => undefined))

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
    const paisProb = contact && canalBody
      ? await (await import("@/lib/probador-pais")).paisProbador(contact).catch(() => null)
      : null
    if (contact && canalBody) {
      if (canalCoherenteConContacto(contact, canalBody, paisProb)) {
        setKvValue(`canal_origen_${contact}`, canalBody).catch(() => {})
      } else {
        // Canal de OTRO país para este contacto: probable misroute del master
        // bot (caso María 23-jul). No pisar el origen; si no lo conocemos,
        // resolverlo contra la API de Botmaker.
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
    // Simulación (E2E): `descripcionAdjunto` = lo que la visión habría leído
    // (mismo mecanismo que PE): así se prueba el bloque del adjunto y la
    // directiva del comprobante sin una URL pública.
    const descripcionSimulada = simulacion ? String(body.descripcionAdjunto || "").trim() : ""
    const mediaUrlEntrante = imageUrl || fileUrl || (descripcionSimulada ? "simulado://adjunto" : "")
    if (mediaUrlEntrante) {
      if (!descripcionSimulada) sendTypingIndicator(contact, true, CANAL_CO()).catch(() => {})
      const descripcion = descripcionSimulada || (await describirImagen(mediaUrlEntrante))
      const caption = IMG_PLACEHOLDERS.includes(message) || esArchivoAdjunto ? "" : message
      if (descripcion) {
        const bloque = esArchivoAdjunto || (!imageUrl && fileUrl)
          ? `[El cliente envió un DOCUMENTO (PDF) por WhatsApp. Contenido del documento]: ${descripcion}`
          : `[El cliente envió una imagen por WhatsApp. Contenido de la imagen]: ${descripcion}`
        // COMPROBANTE (21-sep, transferencia Bancolombia habilitada): la
        // directiva va EN el mensaje del adjunto, igual que en PE — sin ella el
        // modelo acusa recibo sin llamar registrar_comprobante_transferencia.
        const { directivaComprobante } = await import("@/lib/comprobante-directiva")
        const directivaPago = directivaComprobante(descripcion)
        message = caption ? `${caption}\n\n${bloque}${directivaPago}` : `${bloque}${directivaPago}`
        console.log(`[vic-co] adjunto descrito contact=${contact} len=${descripcion.length}${directivaPago ? " comprobante=si" : ""}`)
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

    // Modo simulación (pruebas E2E): corre el MISMO turno que el cliente —
    // lib/orquestador-turno con el perfil del país: prompt, tools, cinturones,
    // hitos y persistencia— y captura la respuesta. Acotado a sintéticos y
    // probadores internos: nunca ensucia el chat de un cliente real.
    if (simulacion) {
      const limpio = String(contact || "").replace(/\D/g, "")
      const prueba =
        /^57900000\d{3,4}$/.test(limpio) ||
        (await import("@/lib/funnel-analysis").then((m) => m.metricsContactSet()).catch(() => new Set<string>())).has(limpio)
      if (!prueba) {
        return NextResponse.json({ ok: false, error: "simulación solo para números de prueba y probadores internos", pais: "co" }, { status: 403 })
      }
      const cap = await simularTurno(contact, message, apiKey, PERFIL_TURNO_CO)
      const hist = await fetchHistoryV3(contact).catch(() => [])
      return NextResponse.json({ reply: cap.reply, tools: cap.tools, usage: cap.usage, pais: "co", simulacion: true, orquestador: true, conHistorial: true, turnosEnHistorial: hist.length })
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
