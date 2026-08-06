/**
 * wa-espejo — espejo SOLO LECTURA del WhatsApp Business de ejecutivos.
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
 * REGLAS INQUEBRANTABLES:
 *  - JAMÁS se envía un mensaje: no existe ninguna llamada a sendMessage en
 *    este proceso, y no debe agregarse nunca. El espejo es pasivo.
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
      console.log(`[${sessionId}] Conectado como ${sock.user?.id || "?"} (solo lectura)`)
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
}

console.log(`wa-espejo — ${SESIONES.length} sesión(es): ${SESIONES.join(", ")} — SOLO LECTURA`)
await cargarLidPn()
for (const sessionId of SESIONES) {
  tieneCredenciales(sessionId)
    .then((vinculada) => (vinculada ? conectar(sessionId) : esperarActivacion(sessionId)))
    .catch((e) => console.error(`[${sessionId}] arranque:`, e.message))
}
