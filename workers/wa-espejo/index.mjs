/**
 * wa-espejo — espejo del WhatsApp Business de ejecutivos (lectura + envíos encolados).
 *
 * Corre como proceso persistente (Railway/Fly/VPS — NO Vercel: necesita un
 * WebSocket vivo). Se vincula a cada número corporativo como "dispositivo
 * vinculado" (mismo mecanismo que WhatsApp Web): el ejecutivo escanea UN QR
 * y sigue usando su celular como siempre. Todo mensaje entrante/saliente se
 * replica a Supabase (vic_wa_espejo_mensajes) como fuente de seguimiento.
 *
 * MULTI-SESIÓN: un solo proceso atiende varios números a la vez —
 * WA_SESSION_IDS="emujica,tmartinezq,alopez" (o WA_SESSION_ID para una sola).
 * Cada sesión tiene su propio socket, sus credenciales (vic_wa_espejo_estado,
 * particionadas por session_id) y su QR (vic_kv wa_espejo_qr_<session>).
 *
 * REGLAS:
 *  - El espejo es pasivo: no responde chats ni interviene conversaciones.
 *    ÚNICA escritura permitida (orden de Lalo 07-ago): despachar los envíos
 *    de cotización que el EDITOR del dashboard encola en vic_kv
 *    (wa_envio_<session>_*) — el vendedor aprieta el botón, su sesión manda
 *    el PDF. Ningún otro sendMessage debe existir ni agregarse.
 *  - markOnlineOnConnect: false — si el espejo se marcara "en línea", el
 *    celular del ejecutivo dejaría de recibir notificaciones push.
 *
 * Env requeridas:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 *   WA_SESSION_IDS (coma-separado) o WA_SESSION_ID
 */

import makeWASocket, {
  Browsers,
  initAuthCreds,
  BufferJSON,
  proto,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
} from "@whiskeysockets/baileys"
import pino from "pino"
import QRCode from "qrcode"

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim().replace(/\/$/, "")
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const SESIONES = (process.env.WA_SESSION_IDS || process.env.WA_SESSION_ID || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)

if (!SUPABASE_URL || !SUPABASE_KEY || !SESIONES.length) {
  console.error("Faltan env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, WA_SESSION_IDS")
  process.exit(1)
}

const logger = pino({ level: process.env.WA_LOG_LEVEL || "warn" })
const H = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
}

// ── Supabase helpers (REST, sin SDK) ────────────────────────────────────────

async function sb(path, init) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { ...H, ...(init?.headers || {}) } })
  if (!res.ok) {
    const cuerpo = await res.text().catch(() => "")
    throw new Error(`Supabase ${res.status} en ${path.split("?")[0]}: ${cuerpo.slice(0, 200)}`)
  }
  return res
}

async function kvGet(key) {
  try {
    const res = await sb(`vic_kv?key=eq.${encodeURIComponent(key)}&select=value,expires_at&limit=1`)
    const rows = await res.json()
    const row = rows[0]
    if (!row) return ""
    if (row.expires_at && Date.parse(row.expires_at) < Date.now()) return ""
    return String(row.value || "")
  } catch {
    return ""
  }
}

async function kvSet(key, value, ttlMinutos) {
  const body = { key, value }
  if (ttlMinutos) body.expires_at = new Date(Date.now() + ttlMinutos * 60_000).toISOString()
  await sb("vic_kv?on_conflict=key", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify(body),
  }).catch((e) => console.error("[kv]", e.message))
}

// ── Estado de autenticación de Baileys persistido en Supabase ───────────────
// Reemplaza useMultiFileAuthState: cada credencial/llave es una fila de
// vic_wa_espejo_estado serializada con BufferJSON (los Buffers no sobreviven
// JSON.stringify plano).

async function estadoGet(sessionId, categoria, clave) {
  const res = await sb(
    `vic_wa_espejo_estado?session_id=eq.${encodeURIComponent(sessionId)}&categoria=eq.${encodeURIComponent(categoria)}&clave=eq.${encodeURIComponent(clave)}&select=valor`,
  )
  const rows = await res.json()
  if (!rows.length || rows[0].valor == null) return null
  return JSON.parse(JSON.stringify(rows[0].valor), BufferJSON.reviver)
}

async function estadoSet(sessionId, categoria, clave, valor) {
  if (valor == null) {
    await sb(
      `vic_wa_espejo_estado?session_id=eq.${encodeURIComponent(sessionId)}&categoria=eq.${encodeURIComponent(categoria)}&clave=eq.${encodeURIComponent(clave)}`,
      { method: "DELETE" },
    )
    return
  }
  const serializado = JSON.parse(JSON.stringify(valor, BufferJSON.replacer))
  await sb("vic_wa_espejo_estado?on_conflict=session_id,categoria,clave", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({
      session_id: sessionId,
      categoria,
      clave,
      valor: serializado,
      updated_at: new Date().toISOString(),
    }),
  })
}

async function cargarAuthState(sessionId) {
  const credsGuardadas = await estadoGet(sessionId, "creds", "creds").catch(() => null)
  const creds = credsGuardadas || initAuthCreds()
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {}
          for (const id of ids) {
            let valor = await estadoGet(sessionId, `keys:${type}`, id).catch(() => null)
            if (type === "app-state-sync-key" && valor) {
              valor = proto.Message.AppStateSyncKeyData.fromObject(valor)
            }
            if (valor != null) data[id] = valor
          }
          return data
        },
        set: async (data) => {
          for (const type of Object.keys(data)) {
            for (const id of Object.keys(data[type])) {
              await estadoSet(sessionId, `keys:${type}`, id, data[type][id]).catch((e) =>
                console.error(`[${sessionId}] estado.set`, e.message),
              )
            }
          }
        },
      },
    },
    saveCreds: async () => {
      await estadoSet(sessionId, "creds", "creds", creds).catch((e) => console.error(`[${sessionId}] creds`, e.message))
    },
  }
}

// ── Extracción de texto del mensaje ─────────────────────────────────────────

function extraerTexto(message) {
  if (!message) return { tipo: "desconocido", texto: "" }
  if (message.conversation) return { tipo: "texto", texto: message.conversation }
  if (message.extendedTextMessage?.text) return { tipo: "texto", texto: message.extendedTextMessage.text }
  if (message.imageMessage) return { tipo: "imagen", texto: message.imageMessage.caption || "" }
  if (message.videoMessage) return { tipo: "video", texto: message.videoMessage.caption || "" }
  if (message.documentMessage) return { tipo: "documento", texto: message.documentMessage.fileName || "" }
  if (message.audioMessage) return { tipo: "audio", texto: "" }
  if (message.stickerMessage) return { tipo: "sticker", texto: "" }
  if (message.contactMessage) return { tipo: "contacto", texto: message.contactMessage.displayName || "" }
  if (message.locationMessage) return { tipo: "ubicacion", texto: "" }
  if (message.reactionMessage) return { tipo: "reaccion", texto: message.reactionMessage.text || "" }
  if (message.ephemeralMessage) return extraerTexto(message.ephemeralMessage.message)
  if (message.viewOnceMessage) return extraerTexto(message.viewOnceMessage.message)
  if (message.editedMessage) return extraerTexto(message.editedMessage.message?.protocolMessage?.editedMessage)
  const tipo = Object.keys(message)[0] || "desconocido"
  return { tipo, texto: "" }
}

// Artefactos de protocolo que no son conversación (el sync inicial los
// dispara a montones — caso piloto 05-ago: filas "desconocido" vacías).
// Teléfono real por chat @lid, aprendido de los senderPn entrantes.
const lidAFono = new Map()

const TIPOS_RUIDO = new Set(["reaccion", "protocolMessage", "senderKeyDistributionMessage", "messageContextInfo"])

// ── LID → número real (06-ago) ──────────────────────────────────────────────
// WhatsApp enruta muchos chats por su id de privacidad (@lid) y el teléfono
// real solo viaja aparte (key.senderPn en los mensajes entrantes, y el evento
// chats.phoneNumberShare). Sin esto, telefono_chat quedaba con los dígitos
// del LID y el dashboard no podía cruzar el chat con el cliente. El mapa se
// comparte entre sesiones vía vic_kv wa_lid_pn y cada aprendizaje rellena
// retroactivamente lo ya espejado de ese chat.
const lidPn = new Map()
let lidPnSucio = false

const soloDigitos = (jid) => String(jid || "").replace(/@.*$/, "").replace(/\D/g, "")

async function cargarLidPn() {
  try {
    const crudo = await kvGet("wa_lid_pn")
    for (const [lid, pn] of Object.entries(JSON.parse(crudo || "{}"))) lidPn.set(lid, pn)
    if (lidPn.size) console.log(`[lid] ${lidPn.size} mapeos LID→número cargados`)
  } catch {}
}

function aprenderLid(lidJid, pnJid) {
  const lid = soloDigitos(lidJid)
  const pn = soloDigitos(pnJid)
  if (!lid || !pn || lid === pn || lidPn.get(lid) === pn) return
  lidPn.set(lid, pn)
  lidPnSucio = true
  console.log(`[lid] aprendido ${lid}@lid → +${pn}`)
  // Backfill: los mensajes ya espejados de ese chat quedan cruzables.
  sb(`vic_wa_espejo_mensajes?chat_jid=eq.${encodeURIComponent(`${lid}@lid`)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ telefono_chat: pn }),
  }).catch((e) => console.error("[lid] backfill", e.message))
}

setInterval(() => {
  if (!lidPnSucio) return
  lidPnSucio = false
  kvSet("wa_lid_pn", JSON.stringify(Object.fromEntries(lidPn)))
}, 30_000)

// ── Resolución PROACTIVA número→LID (06-ago) ────────────────────────────────
// El LID de un chat que INICIA el vendedor recién se conoce cuando el cliente
// responde (caso Leyla/Neumasport: Rodrigo escribió y el chat quedó sin
// cruzar). Para no esperar, las sesiones conectadas consultan por USync
// (onWhatsApp — consulta pasiva de directorio, no envía nada ni notifica al
// cliente) los teléfonos de los contactos comerciales de Vicky que aún no
// tienen mapeo, y aprenden su LID al tiro.
let resolutorActivo = false
const resolutorTimers = new Map()

async function resolverContactosVicky(sock) {
  if (resolutorActivo) return
  resolutorActivo = true
  try {
    const res = await sb("vic_v3_conversations?select=contact&order=started_at.desc&limit=400")
    const contactos = (await res.json()).map((c) => soloDigitos(c.contact)).filter(Boolean)
    const mapeados = new Set(lidPn.values())
    const pendientes = [...new Set(contactos)].filter((t) => !mapeados.has(t)).slice(0, 200)
    let aprendidos = 0
    for (let i = 0; i < pendientes.length; i += 50) {
      const lote = pendientes.slice(i, i + 50).map((t) => `${t}@s.whatsapp.net`)
      const rs = await sock.onWhatsApp(...lote).catch(() => null)
      for (const r of rs || []) {
        if (r?.exists && r.lid) {
          aprenderLid(r.lid, r.jid)
          aprendidos++
        }
      }
      await new Promise((ok) => setTimeout(ok, 1500))
    }
    if (aprendidos) console.log(`[lid] resolutor proactivo: ${aprendidos} contactos mapeados`)
  } catch (e) {
    console.error("[lid] resolutor", e.message)
  } finally {
    resolutorActivo = false
  }
}

// ── Media (07-ago, pedido Lalo: leer comprobantes de pago) ──────────────────
// Imágenes, audios y documentos (PDF) se DESCARGAN y suben a Supabase Storage
// (bucket privado `wa-espejo`); un cron del agente en Vercel los lee (visión
// Claude / transcripción) y deja el texto en media_texto. El worker solo
// acarrea bytes — sin claves de IA acá. Best-effort: si la descarga falla, la
// fila se guarda igual (como antes, solo tipo + caption).
const MEDIA_TIPOS = new Set(["imagen", "audio", "documento"])
const MAX_MEDIA_BYTES = 12 * 1024 * 1024

function mediaInfo(message) {
  const im = message?.imageMessage
  const au = message?.audioMessage
  const doc = message?.documentMessage
  const mime = (im?.mimetype || au?.mimetype || doc?.mimetype || "").split(";")[0].trim()
  let ext = "bin"
  if (mime.includes("jpeg")) ext = "jpg"
  else if (mime.includes("png")) ext = "png"
  else if (mime.includes("webp")) ext = "webp"
  else if (mime.includes("pdf")) ext = "pdf"
  else if (mime.includes("ogg") || mime.includes("opus")) ext = "ogg"
  else if (mime.includes("aac")) ext = "aac"
  else if (mime.includes("mp4")) ext = "m4a"
  else if (mime.includes("mpeg")) ext = "mp3"
  return { mime: mime || "application/octet-stream", ext }
}

async function subirMedia(sessionId, m, tipo) {
  if (!MEDIA_TIPOS.has(tipo)) return null
  try {
    const buffer = await downloadMediaMessage(m, "buffer", {})
    if (!buffer || !buffer.length || buffer.length > MAX_MEDIA_BYTES) return null
    const { mime, ext } = mediaInfo(m.message)
    const msgIdSafe = String(m.key?.id || Date.now()).replace(/[^A-Za-z0-9_-]/g, "")
    const path = `${sessionId}/${msgIdSafe}.${ext}`
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/wa-espejo/${path}`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": mime,
        "x-upsert": "true",
      },
      body: buffer,
    })
    if (!res.ok) {
      console.error(`[${sessionId}] storage ${res.status}`, (await res.text().catch(() => "")).slice(0, 120))
      return null
    }
    return { path, mime }
  } catch (e) {
    console.error(`[${sessionId}] media`, e.message)
    return null
  }
}

async function guardarMensaje(sessionId, m) {
  const jid = m.key?.remoteJid || ""
  // status@broadcast = estados; newsletter = canales. No son conversaciones.
  if (!jid || jid === "status@broadcast" || jid.endsWith("@newsletter")) return
  const esGrupo = jid.endsWith("@g.us")
  const { tipo, texto } = extraerTexto(m.message)
  if (TIPOS_RUIDO.has(tipo)) return
  if (tipo === "desconocido" && !texto) return
  const esLid = jid.endsWith("@lid")
  // En chats @lid el número real viaja en senderPn (mensajes del cliente).
  if (esLid && !m.key?.fromMe && m.key?.senderPn) aprenderLid(jid, m.key.senderPn)
  const telefonoChat = esGrupo
    ? null
    : esLid
      ? lidPn.get(soloDigitos(jid)) || null
      : soloDigitos(jid) || null
  const enviadoAt = m.messageTimestamp
    ? new Date(Number(m.messageTimestamp) * 1000).toISOString()
    : new Date().toISOString()
  // Comprobantes y notas de voz: el archivo se sube a Storage y el cron
  // vic-wa-espejo-lector del agente lo convierte a texto (media_texto).
  const media = await subirMedia(sessionId, m, tipo)
  const fila = {
    session_id: sessionId,
    chat_jid: jid,
    msg_id: m.key?.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    from_me: Boolean(m.key?.fromMe),
    autor: m.pushName || (esGrupo ? (m.key?.participant || "").replace(/@.*$/, "") : null),
    telefono_chat: telefonoChat,
    es_grupo: esGrupo,
    tipo,
    texto: (texto || "").slice(0, 8000),
    media_path: media?.path || null,
    media_mime: media?.mime || null,
    enviado_at: enviadoAt,
    raw: JSON.parse(JSON.stringify({ key: m.key, pushName: m.pushName, messageTimestamp: m.messageTimestamp })),
  }
  await sb("vic_wa_espejo_mensajes?on_conflict=session_id,chat_jid,msg_id", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates" },
    body: JSON.stringify(fila),
  }).catch((e) => console.error(`[${sessionId}] mensaje`, e.message))
}

// ── Conexión por sesión ─────────────────────────────────────────────────────
//
// QR BAJO DEMANDA (06-ago): dejar 6 sesiones sin vincular pidiendo QR en loop
// toda la noche = cientos de intentos de pareo desde una misma IP — Meta lo
// castiga ("No se pudo vincular el dispositivo", caso Grey; y el corte del
// piloto). Una sesión SIN credenciales solo abre socket cuando la página del
// QR está abierta (la página estampa vic_kv wa_espejo_wake_<session>); si
// nadie mira, la sesión queda estacionada sin generar tráfico. Las sesiones
// YA vinculadas se conectan siempre y se reconectan solas.

const reiniciosPorSesion = new Map()

// ── Envío desde el WhatsApp del VENDEDOR (pedido Lalo 07-ago) ───────────────
//
// El editor de cotizaciones encola en vic_kv un trabajo con clave
// wa_envio_<session>_<ts> y la sesión CONECTADA de ese vendedor lo despacha:
// descarga el PDF vigente y lo manda como documento desde su propio número,
// con un mensaje corto. Es el ÚNICO caso en que el espejo escribe en WhatsApp
// — todo lo demás sigue siendo solo lectura. Estados del job (en el value):
// pendiente → enviando → enviado | error. El dashboard los sondea para dar
// feedback al vendedor.

const enviosTimers = new Map()
const enviosEnCurso = new Set()

async function procesarEnviosPendientes(sessionId, sock) {
  let rows = []
  try {
    const res = await sb(
      `vic_kv?key=like.wa_envio_${encodeURIComponent(sessionId)}_%25&select=key,value&limit=5`,
    )
    rows = await res.json()
  } catch {
    return
  }
  for (const row of rows) {
    const key = String(row.key)
    if (enviosEnCurso.has(key)) continue
    let job
    try {
      job = JSON.parse(String(row.value || ""))
    } catch {
      continue
    }
    if (!job || job.status !== "pendiente") continue
    enviosEnCurso.add(key)
    try {
      job.status = "enviando"
      await kvSet(key, JSON.stringify(job), 24 * 60)
      const telefono = String(job.to || "").replace(/\D/g, "")
      if (!telefono || !job.pdf_url) throw new Error("trabajo incompleto (to/pdf_url)")
      const pdfRes = await fetch(job.pdf_url)
      if (!pdfRes.ok) throw new Error(`descarga PDF ${pdfRes.status}`)
      const buf = Buffer.from(await pdfRes.arrayBuffer())
      await sock.sendMessage(`${telefono}@s.whatsapp.net`, {
        document: buf,
        mimetype: "application/pdf",
        fileName: job.filename || "Cotizacion GeoVictoria.pdf",
        caption: job.caption || "",
      })
      job.status = "enviado"
      job.sent_at = new Date().toISOString()
      await kvSet(key, JSON.stringify(job), 24 * 60)
      console.log(`[${sessionId}] cotización enviada a +${telefono} desde el WhatsApp del vendedor`)
    } catch (e) {
      job.status = "error"
      job.error = String(e?.message || e).slice(0, 200)
      await kvSet(key, JSON.stringify(job), 24 * 60)
      console.error(`[${sessionId}] envío de cotización falló:`, job.error)
    } finally {
      enviosEnCurso.delete(key)
    }
  }
}

async function tieneCredenciales(sessionId) {
  const creds = await estadoGet(sessionId, "creds", "creds").catch(() => null)
  // `registered` no siempre queda true en sesiones de dispositivo vinculado
  // (caso Grey/Daniela 06-ago: vinculadas, reinicio del worker las estacionó
  // como "sin vincular"). Una sesión con identidad (`me.id`) está vinculada.
  return Boolean(creds && (creds.registered || creds.me?.id))
}

async function paginaAbierta(sessionId) {
  return Boolean(await kvGet(`wa_espejo_wake_${sessionId}`))
}

async function esperarActivacion(sessionId) {
  await kvSet(
    `wa_espejo_status_${sessionId}`,
    JSON.stringify({ estado: "en_pausa_sin_vincular", at: new Date().toISOString() }),
  )
  console.log(`[${sessionId}] Sin vincular: estacionada hasta que abran su página de QR`)
  const timer = setInterval(async () => {
    if (await paginaAbierta(sessionId)) {
      clearInterval(timer)
      console.log(`[${sessionId}] Página de QR abierta — iniciando pareo`)
      conectar(sessionId).catch((e) => console.error(`[${sessionId}] conectar:`, e.message))
    }
  }, 15_000)
}

async function conectar(sessionId) {
  const { state, saveCreds } = await cargarAuthState(sessionId)
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }))

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    browser: Browsers.macOS("Chrome"),
    // CRÍTICO: en línea lo está el CELULAR del ejecutivo, no el espejo. Si el
    // espejo se marca online, el teléfono deja de recibir notificaciones push.
    markOnlineOnConnect: false,
    // Espeja desde la vinculación en adelante (sin historial completo).
    syncFullHistory: false,
    printQRInTerminal: false,
  })

  sock.ev.on("creds.update", saveCreds)

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update
    if (qr) {
      // El QR rota cada ~60s: se publica en vic_kv y la página admin lo pinta.
      const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 360 }).catch(() => "")
      await kvSet(`wa_espejo_qr_${sessionId}`, dataUrl, 5)
      await kvSet(`wa_espejo_status_${sessionId}`, JSON.stringify({ estado: "esperando_qr", at: new Date().toISOString() }))
      console.log(`[${sessionId}] QR publicado — escanear desde la página admin`)
    }
    if (connection === "open") {
      reiniciosPorSesion.set(sessionId, 0)
      await kvSet(`wa_espejo_qr_${sessionId}`, "", 1)
      await kvSet(
        `wa_espejo_status_${sessionId}`,
        JSON.stringify({ estado: "conectado", numero: sock.user?.id || "", at: new Date().toISOString() }),
      )
      console.log(`[${sessionId}] Conectado como ${sock.user?.id || "?"} (pasivo + cola de envíos)`)
    }
    if (connection === "close") {
      const codigo = lastDisconnect?.error?.output?.statusCode
      const cerroSesion = codigo === DisconnectReason.loggedOut
      if (cerroSesion) {
        // Desvinculado desde el teléfono (o por WhatsApp): credenciales fuera
        // y la sesión vuelve al estacionamiento — pedirá QR cuando alguien
        // abra su página, sin loops.
        console.error(`[${sessionId}] Sesión cerrada por WhatsApp/teléfono. Limpiando credenciales.`)
        await sb(`vic_wa_espejo_estado?session_id=eq.${encodeURIComponent(sessionId)}`, { method: "DELETE" }).catch(() => {})
        await kvSet(
          `wa_espejo_status_${sessionId}`,
          JSON.stringify({ estado: "sesion_cerrada", codigo, at: new Date().toISOString() }),
        )
        esperarActivacion(sessionId)
        return
      }
      // Sesión sin vincular y ya nadie mira la página → estacionar, no loopear.
      const vinculada = Boolean(state.creds?.registered)
      if (!vinculada && !(await paginaAbierta(sessionId))) {
        await kvSet(`wa_espejo_qr_${sessionId}`, "", 1)
        esperarActivacion(sessionId)
        return
      }
      const reinicios = (reiniciosPorSesion.get(sessionId) || 0) + 1
      reiniciosPorSesion.set(sessionId, reinicios)
      const espera = Math.min(60_000, 2_000 * 2 ** Math.min(reinicios, 5))
      await kvSet(
        `wa_espejo_status_${sessionId}`,
        JSON.stringify({ estado: "reconectando", codigo, at: new Date().toISOString() }),
      )
      console.error(`[${sessionId}] Conexión cerrada (código ${codigo}). Reintento en ${espera / 1000}s`)
      setTimeout(() => conectar(sessionId).catch((e) => console.error(`[${sessionId}]`, e.message)), espera)
    }
  })

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    // "notify" = mensajes nuevos en vivo; "append" = recuperados al reconectar.
    if (type !== "notify" && type !== "append") return
    for (const m of messages) {
      await guardarMensaje(sessionId, m).catch((e) => console.error(`[${sessionId}] upsert`, e.message))
    }
  })

  // WhatsApp comparte explícitamente el número detrás de un LID.
  sock.ev.on("chats.phoneNumberShare", ({ lid, jid }) => aprenderLid(lid, jid))

  // LLAMADAS de WhatsApp (07-ago, pedido Lalo: registrar los llamados de los
  // ejecutivos e identificar las llamadas con clientes con proceso). El
  // dispositivo vinculado recibe los eventos de llamada del número: se
  // registra cada transición (offer → accept/reject/timeout) con su call_id.
  // Solo llamadas de WHATSAPP — las de red celular no pasan por aquí.
  sock.ev.on("call", async (calls) => {
    for (const c of calls || []) {
      try {
        const jid = c.chatId || c.from || ""
        if (!jid || c.isGroup) continue
        const esLid = jid.endsWith("@lid")
        const telefono = esLid ? lidPn.get(soloDigitos(jid)) || null : soloDigitos(jid) || null
        await sb("vic_wa_espejo_llamadas?on_conflict=session_id,call_id,estado", {
          method: "POST",
          headers: { Prefer: "resolution=ignore-duplicates" },
          body: JSON.stringify({
            session_id: sessionId,
            call_id: c.id || `${Date.now()}`,
            chat_jid: jid,
            telefono,
            video: Boolean(c.isVideo),
            estado: c.status || "offer",
            at: c.date ? new Date(c.date).toISOString() : new Date().toISOString(),
          }),
        })
      } catch (e) {
        console.error(`[${sessionId}] llamada`, e.message)
      }
    }
  })

  // Resolutor proactivo: 30 s tras conectar y luego cada 5 min (el candado
  // resolutorActivo evita que varias sesiones consulten a la vez).
  clearInterval(resolutorTimers.get(sessionId))
  resolutorTimers.set(sessionId, setInterval(() => resolverContactosVicky(sock).catch(() => {}), 5 * 60_000))
  setTimeout(() => resolverContactosVicky(sock).catch(() => {}), 30_000)

  // Cola de envíos del vendedor: cada 15 s se despachan los trabajos
  // pendientes de ESTA sesión (reconectar rearma el timer con el sock nuevo).
  clearInterval(enviosTimers.get(sessionId))
  enviosTimers.set(sessionId, setInterval(() => procesarEnviosPendientes(sessionId, sock).catch(() => {}), 15_000))
}

console.log(`wa-espejo — ${SESIONES.length} sesión(es): ${SESIONES.join(", ")} — pasivo + cola de envíos del editor`)
await cargarLidPn()
for (const sessionId of SESIONES) {
  tieneCredenciales(sessionId)
    .then((vinculada) => (vinculada ? conectar(sessionId) : esperarActivacion(sessionId)))
    .catch((e) => console.error(`[${sessionId}] arranque:`, e.message))
}
