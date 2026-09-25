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

import { cierrePorBoton, normalizarMensajeEntrante } from "@/lib/respuesta-boton"
import { NextResponse, after } from "next/server"

import { faseDelContacto } from "@/lib/onboarding-canal"

import { fetchHistoryV3, getFollowupCronSecret, appendTurnV3, setKvValue, getKvValue } from "@/lib/supabase-persistence-v3"
import { acquireLock, hashMessage, bufferInboundMessage, drainInbox } from "@/lib/processing-lock-v3"
import { sendBotmakerMessage, sendTypingIndicator, detectarCanalOrigen, canalCoherenteConContacto } from "@/lib/botmaker-push-v3"

import { consumirCotizacionPendiente } from "@/lib/enviar-cotizacion-wa"

import { transcribirAudio } from "@/lib/transcribe-audio"
import { contactoEnMudo } from "@/lib/mudo-contacto"
import { describirImagen } from "@/lib/describe-image"

import { markUserActivity, confirmMeetingAttendance } from "@/lib/supabase-persistence-v3"
import { resetLoop } from "@/lib/loop-v2"

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

// EL TURNO VIVE EN lib/orquestador-turno (22-sep, paso 3 del orden de Lalo):
// este archivo es solo la PUERTA chilena — validación, ruteo por país, adjuntos,
// buffer de ráfaga y lock. processOneTurn/processBurst/simulación se movieron
// tal cual y corren con PERFIL_TURNO_CL (comportamiento idéntico al inline).
import { procesarRafaga, simularTurno, PERFIL_TURNO_CL } from "@/lib/orquestador-turno"

const GENERIC_ERROR_MSG =
  "Tuve un problema técnico momentáneo. ¿Podrías repetir tu mensaje?"

// Contrato del webhook de Botmaker (el turno ya no lo necesita: vive acá).
type BotmakerRequest = {
  contact?: string
  message?: string
  channelId?: string
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
}

// ── Guardrails de seguridad ───────────────────────────────────────────
const MAX_INPUT_CHARS = 2000
// OJO (28-ago, caso pantallazo del correo de bienvenida): `INSTRUC` pelado
// atrapaba la palabra chilena de todos los días "instrucciones" ("no me
// llegaron las instrucciones") y el cliente recibía "formato no válido". Se
// exige la frase de inyección real (EN o ES), no la palabra suelta.
const INJECT_RE =
  /###|\bIGNORE\s+(?:ALL\s+|PREVIOUS\s+)?INSTRUCTIONS?\b|\bDUMP\b|IGNORA(?:R)?\s+(?:TODAS\s+)?(?:LAS\s+)?INSTRUCCIONES|SYSTEM PROMPT|\bPROMPT\b|\\u202|<script|DROP\s+TABLE|DELETE\s+FROM|UNION\s+SELECT/i

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

// ── Webhook entrypoint ────────────────────────────────────────────────
export async function POST(request: Request): Promise<NextResponse> {
  try {
    // 1. Validar secret
    const secret = request.headers.get("x-secret") || ""
    const expected = getEnv("BOTMAKER_SECRET")
    // 2. Validar body
    const body = (await request.json()) as BotmakerRequest & { simular?: boolean }
    let authSim = false
    if (body.simular === true) {
      const cronHdr = request.headers.get("x-cron-secret") || ""
      const cronSec = cronHdr ? await getFollowupCronSecret().catch(() => "") : ""
      authSim = Boolean(cronHdr && cronSec && cronHdr === cronSec)
    }
    if (expected && secret !== expected && !authSim) {
      return NextResponse.json(
        { reply: "Unauthorized" },
        { status: 401 },
      )
    }
    const contact = normalizeContact(body.contact || "")
    let message = (body.message || "").trim()

    // Respuesta por BOTÓN: Botmaker no manda el texto sino el payload del
    // intent ({"button":"…","entities":"…","intent":"…"}). Se normaliza acá,
    // en la entrada, para que TODO lo de abajo —clasificador de rechazo,
    // modelo, historial— vea "Elegimos otro proveedor" y no el JSON crudo.
    // Ver lib/respuesta-boton.ts (caso 56992047070).
    const cierreBoton = cierrePorBoton(message)
    message = normalizarMensajeEntrante(message)

    if (body.simular === true) {
      const sintetico = /^56900000\d{3}$/.test(contact)
      const interno = sintetico
        ? true
        : (await import("@/lib/funnel-analysis").then((m) => m.metricsContactSet()).catch(() => new Set<string>())).has(contact)
      if (!contact || !message || !interno) {
        return NextResponse.json({ ok: false, error: "simulación solo para números sintéticos 56900000xxx o probadores internos" }, { status: 403 })
      }
      const apiKeySim = getEnv("ANTHROPIC_API_KEY")
      if (!apiKeySim) return NextResponse.json({ ok: false, error: "sin ANTHROPIC_API_KEY" }, { status: 500 })
      const cap = await simularTurno(contact, message, apiKeySim, PERFIL_TURNO_CL)
      const hist = await fetchHistoryV3(contact, 40).catch(() => [])
      return NextResponse.json({
        reply: cap?.reply || "",
        tools: cap?.tools || [],
        pais: "cl",
        simulacion: true,
        conHistorial: true,
        turnosEnHistorial: hist.length,
      })
    }

    // Canal de ORIGEN: si la acción de código nos dice por qué línea entró el
    // mensaje, lo persistimos — sendBotmakerMessage responde SIEMPRE por ese
    // canal (evita chats paralelos cuando el prefijo del número no calza con
    // la línea que eligió el cliente). Best-effort.
    const canalBody = (body.channelId || "").trim()
    const paisProb = contact && canalBody
      ? await (await import("@/lib/probador-pais")).paisProbador(contact).catch(() => null)
      : null
    if (contact && canalBody && canalCoherenteConContacto(contact, canalBody, paisProb)) {
      setKvValue(`canal_origen_${contact}`, canalBody).catch(() => {})
    } else if (contact && canalBody) {
      // El body trae el canal de OTRO país (ej. contacto +57 con la línea +56):
      // el master bot de Botmaker ruteó el mensaje al bot equivocado (caso
      // María 23-jul, respuestas por la línea CL a una clienta de la línea CO).
      // No pisamos el origen; si aún no lo conocemos, lo resolvemos contra la
      // API de Botmaker (cubre también al +57 que legítimamente escribe al +56).
      const conocido = await getKvValue(`canal_origen_${contact}`).catch(() => null)
      // Un origen guardado que TAMPOCO calza con el país del contacto (quedó
      // mal por la regla vieja de Perú, 25-sep) se reemplaza por la línea del
      // país: sin esto las respuestas seguían saliendo por la línea chilena.
      if (conocido && !canalCoherenteConContacto(contact, conocido, paisProb)) {
        const { channelIdPorPais, paisDeNumero } = await import("@/lib/linea-por-pais")
        const p = paisDeNumero(contact.replace(/\D/g, ""))
        if (p === "pe" || p === "co" || p === "mx" || p === "cl") {
          await setKvValue(`canal_origen_${contact}`, channelIdPorPais(p)).catch(() => {})
          console.warn(`[canal-origen] ${contact}: origen guardado ${conocido} no calza con su país — repuesto a la línea de ${p.toUpperCase()}`)
        }
      }
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

    // 2.0-bis. PROBADOR DE OTRO PAÍS (21-sep, Lalo "quiero poder probar desde
    // mi teléfono"): un contacto marcado en vic_kv `probador_pais_<fono>` se
    // rutea al webhook de ESE país aunque su prefijo sea chileno, así el equipo
    // puede probar Perú de punta a punta con un +56. Las ramas por prefijo de
    // abajo quedan intactas: sin marca vigente este bloque no hace nada.
    {
      const { paisProbador } = await import("@/lib/probador-pais")
      const overridePais = await paisProbador(contact).catch(() => null)
      if (overridePais && overridePais !== "cl") {
        const { WEBHOOK_POR_PAIS, SECRET_ENV_POR_PAIS } = await import("@/lib/ruteo-pais")
        const secret =
          getEnv(SECRET_ENV_POR_PAIS[overridePais]) ||
          ((await getKvValue(SECRET_ENV_POR_PAIS[overridePais].toLowerCase()).catch(() => null)) || "")
        const destino = WEBHOOK_POR_PAIS[overridePais]
        if (!secret) {
          console.error(`[v3-botmaker] contact=${contact} PROBADOR de ${overridePais.toUpperCase()} pero falta el secret — se atiende con flujo CL`)
        } else {
          const r = await fetch(`${new URL(request.url).origin}${destino}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-secret": secret },
            body: JSON.stringify(body),
            cache: "no-store",
          }).catch(() => null)
          if (r) {
            const data = await r.json().catch(() => ({ reply: "" }))
            console.log(`[v3-botmaker] contact=${contact} PROBADOR de ${overridePais.toUpperCase()} → reenviado a ${destino} (${r.status})`)
            return NextResponse.json(data, { status: r.status })
          }
          console.error(`[v3-botmaker] contact=${contact} PROBADOR de ${overridePais.toUpperCase()} y el reenvío a ${destino} falló — NO se atiende con flujo CL`)
          return NextResponse.json({ reply: "" })
        }
      }
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
      // ANTI-DUPLICADO DE ADJUNTOS (05-sep, prueba E2E de Lalo): el mismo
      // comprobante entró dos veces —una por el webhook MX (que lo reenvía
      // acá) y otra por el CL, con 1 s de diferencia— y se procesó COMPLETO
      // dos veces: dos correos a cobranza, dos "Estado → Pagada". El dedup
      // por hash del texto no lo atrapa porque cada corrida describe la
      // imagen con la visión y el texto nunca sale idéntico. La URL del
      // adjunto sí es la misma: esa es la llave. Ventana de 5 minutos.
      {
        const { createHash } = await import("crypto")
        const llaveMedia = `msgseen_media_${createHash("sha256").update(`${contact}:${mediaUrlEntrante}`).digest("hex").slice(0, 16)}`
        const vistoMedia = await getKvValue(llaveMedia).catch(() => null)
        const edadMedia = vistoMedia ? Date.now() - Number(vistoMedia) : Infinity
        if (Number.isFinite(edadMedia) && edadMedia < 300_000) {
          console.warn(`[v3-botmaker] adjunto duplicado descartado contact=${contact} edad=${Math.round(edadMedia / 1000)}s`)
          return NextResponse.json({ reply: "" })
        }
        await setKvValue(llaveMedia, String(Date.now())).catch(() => {})
      }
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
        // ONBOARDING (25-ago): la regla del system prompt no basta contra la
        // inercia del historial ("ya los cargué") — la directiva viaja EN el
        // mensaje del adjunto: si trae trabajadores, la tool corre SIEMPRE
        // (el upsert por RUT hace inofensivo repetir).
        const directivaNomina = (await faseDelContacto(contact).catch(() => "venta")) === "onboarding"
          ? "\n\n[DIRECTIVA OBLIGATORIA: si este contenido incluye trabajadores (RUT/correo/nombre), llama guardar_nomina AHORA con TODAS las filas transcritas — aunque creas que ya están cargados o el archivo se repita. Tu memoria no cuenta: solo lo guardado por la tool existe.]"
          : ""
        message = caption ? `${caption}\n\n${bloque}${directivaNomina}` : `${bloque}${directivaNomina}`
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

    // 2.6-bis. MUDO TEMPORAL (04-sep, pedido de Lalo): la línea de Vicky usada
    // como BUZÓN. Todo lo de arriba ya corrió —la nota de voz quedó
    // transcrita, la captura y el PDF descritos con visión—, así que el
    // material queda en el historial en texto y se puede leer después. Lo
    // único que se corta es la respuesta: ni modelo, ni tools, ni maquinaria
    // proactiva (por eso va ANTES de markUserActivity y resetLoop: un reenvío
    // no debe re-anclar la cadencia y agendarle un toque a los 10 minutos).
    // El mudo lleva su vencimiento adentro y tope de 12 h — ver lib/mudo-contacto.
    if (await contactoEnMudo(contact)) {
      await appendTurnV3(
        contact,
        message,
        "[Vicky en mudo: mensaje recibido y transcrito, sin respuesta]",
      ).catch(() => {})
      console.log(`[v3-botmaker] contacto ${contact} EN MUDO — guardado sin responder (${message.length} chars)`)
      return NextResponse.json({ reply: "" })
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

    // 3. Guardrails de input (largo + prompt injection). El tope de largo NO
    // aplica a adjuntos descritos: ese texto lo generamos NOSOTROS (visión +
    // directiva) y puede superar el tope legítimamente — se recorta en vez de
    // rechazar (28-ago: el pantallazo largo de un correo devolvía "formato no
    // válido" al cliente).
    const esAdjuntoDescrito = message.startsWith("[El cliente envió")
    if (!esAdjuntoDescrito && message.length > MAX_INPUT_CHARS) {
      return NextResponse.json({
        reply: "El formato del mensaje no es válido.",
      })
    }
    if (esAdjuntoDescrito && message.length > MAX_INPUT_CHARS * 3) {
      message = message.slice(0, MAX_INPUT_CHARS * 3)
    }
    if (INJECT_RE.test(message)) {
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

    // 6-bis. RESPUESTA DE CAMPAÑA DE DESCUENTO (26-ago): los botones de la
    // plantilla `vicky_campana_dcto_v1` llegan como payload y se resuelven
    // DETERMINISTAS acá, sin lock ni modelo — el % lo aplica el backend.
    // Solo intercepta si el contacto tiene campaña sembrada en vic_kv.
    try {
      const { procesarRespuestaCampana } = await import("@/lib/campana-descuento")
      const camp = await procesarRespuestaCampana(contact, message)
      if (camp.atendida) {
        console.log(`[v3-campana] respuesta de campaña de ${contact} atendida determinista`)
        const { appendTurnV3 } = await import("@/lib/supabase-persistence-v3")
        if (camp.respuesta) {
          await sendBotmakerMessage(contact, camp.respuesta).catch(() => false)
          await appendTurnV3(contact, message, camp.respuesta, "cl").catch(() => {})
        }
        return NextResponse.json({ reply: "" })
      }
    } catch (e) {
      console.error("[v3-campana] error procesando respuesta de campaña:", e instanceof Error ? e.message : e)
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
    after(procesarRafaga(contact, apiKey, message, PERFIL_TURNO_CL))

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
