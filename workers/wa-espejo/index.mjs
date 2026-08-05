/**
 * wa-espejo — espejo SOLO LECTURA del WhatsApp Business de un ejecutivo.
 *
 * Corre como proceso persistente (Railway/Fly/VPS — NO Vercel: necesita un
 * WebSocket vivo). Se vincula al número corporativo como "dispositivo
 * vinculado" (mismo mecanismo que WhatsApp Web): el ejecutivo escanea UN QR
 * y sigue usando su celular como siempre. Todo mensaje entrante/saliente se
 * replica a Supabase (vic_wa_espejo_mensajes) como fuente de seguimiento.
 *
 * REGLAS INQUEBRANTABLES:
 *  - JAMÁS se envía un mensaje: no existe ninguna llamada a sendMessage en
 *    este proceso, y no debe agregarse nunca. El espejo es pasivo.
 *  - markOnlineOnConnect: false — si el espejo se marcara "en línea", el
 *    celular del ejecutivo dejaría de recibir notificaciones push.
 *  - Credenciales de la sesión viven en Supabase (vic_wa_espejo_estado):
 *    el proceso puede morir y renacer en otra máquina sin re-escanear.
 *
 * Env requeridas:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, WA_SESSION_ID (ej: "emujica")
 */

import makeWASocket, {
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
const SESSION_ID = (process.env.WA_SESSION_ID || "").trim()

if (!SUPABASE_URL || !SUPABASE_KEY || !SESSION_ID) {
  console.error("Faltan env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, WA_SESSION_ID")
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

async function estadoGet(categoria, clave) {
  const res = await sb(
    `vic_wa_espejo_estado?session_id=eq.${encodeURIComponent(SESSION_ID)}&categoria=eq.${encodeURIComponent(categoria)}&clave=eq.${encodeURIComponent(clave)}&select=valor`,
  )
  const rows = await res.json()
  if (!rows.length || rows[0].valor == null) return null
  return JSON.parse(JSON.stringify(rows[0].valor), BufferJSON.reviver)
}

async function estadoSet(categoria, clave, valor) {
  if (valor == null) {
    await sb(
      `vic_wa_espejo_estado?session_id=eq.${encodeURIComponent(SESSION_ID)}&categoria=eq.${encodeURIComponent(categoria)}&clave=eq.${encodeURIComponent(clave)}`,
      { method: "DELETE" },
    )
    return
  }
  const serializado = JSON.parse(JSON.stringify(valor, BufferJSON.replacer))
  await sb("vic_wa_espejo_estado?on_conflict=session_id,categoria,clave", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({
      session_id: SESSION_ID,
      categoria,
      clave,
      valor: serializado,
      updated_at: new Date().toISOString(),
    }),
  })
}

async function cargarAuthState() {
  const credsGuardadas = await estadoGet("creds", "creds").catch(() => null)
  const creds = credsGuardadas || initAuthCreds()
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {}
          for (const id of ids) {
            let valor = await estadoGet(`keys:${type}`, id).catch(() => null)
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
              await estadoSet(`keys:${type}`, id, data[type][id]).catch((e) =>
                console.error("[estado.set]", e.message),
              )
            }
          }
        },
      },
    },
    saveCreds: async () => {
      await estadoSet("creds", "creds", creds).catch((e) => console.error("[creds]", e.message))
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

async function guardarMensaje(m) {
  const jid = m.key?.remoteJid || ""
  // status@broadcast = estados; newsletter = canales. No son conversaciones.
  if (!jid || jid === "status@broadcast" || jid.endsWith("@newsletter")) return
  const esGrupo = jid.endsWith("@g.us")
  const { tipo, texto } = extraerTexto(m.message)
  // Reacciones y protocolos no aportan al seguimiento.
  if (tipo === "reaccion" || tipo === "protocolMessage" || tipo === "senderKeyDistributionMessage") return
  const telefonoChat = esGrupo ? null : jid.replace(/@.*$/, "").replace(/\D/g, "") || null
  const enviadoAt = m.messageTimestamp
    ? new Date(Number(m.messageTimestamp) * 1000).toISOString()
    : new Date().toISOString()
  const fila = {
    session_id: SESSION_ID,
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
  }).catch((e) => console.error("[mensaje]", e.message))
}

// ── Conexión ────────────────────────────────────────────────────────────────

let reinicios = 0

async function conectar() {
  const { state, saveCreds } = await cargarAuthState()
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }))

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    // CRÍTICO: en línea lo está el CELULAR del ejecutivo, no el espejo. Si el
    // espejo se marca online, el teléfono deja de recibir notificaciones push.
    markOnlineOnConnect: false,
    // v1: espeja desde la vinculación en adelante (sin historial completo).
    syncFullHistory: false,
    printQRInTerminal: false,
  })

  sock.ev.on("creds.update", saveCreds)

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update
    if (qr) {
      // El QR rota cada ~60s: se publica en vic_kv y la página admin lo pinta.
      const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 360 }).catch(() => "")
      await kvSet(`wa_espejo_qr_${SESSION_ID}`, dataUrl, 5)
      await kvSet(`wa_espejo_status_${SESSION_ID}`, JSON.stringify({ estado: "esperando_qr", at: new Date().toISOString() }))
      console.log(`[${SESSION_ID}] QR publicado — escanear desde la página admin`)
    }
    if (connection === "open") {
      reinicios = 0
      await kvSet(`wa_espejo_qr_${SESSION_ID}`, "", 1)
      await kvSet(
        `wa_espejo_status_${SESSION_ID}`,
        JSON.stringify({ estado: "conectado", numero: sock.user?.id || "", at: new Date().toISOString() }),
      )
      console.log(`[${SESSION_ID}] Conectado como ${sock.user?.id || "?"} (solo lectura)`)
    }
    if (connection === "close") {
      const codigo = lastDisconnect?.error?.output?.statusCode
      const cerroSesion = codigo === DisconnectReason.loggedOut
      await kvSet(
        `wa_espejo_status_${SESSION_ID}`,
        JSON.stringify({ estado: cerroSesion ? "sesion_cerrada" : "reconectando", codigo, at: new Date().toISOString() }),
      )
      if (cerroSesion) {
        // El ejecutivo desvinculó el dispositivo desde su celular: se limpia el
        // estado para que el próximo arranque pida QR de nuevo.
        console.error(`[${SESSION_ID}] Sesión cerrada desde el teléfono. Limpiando credenciales.`)
        await sb(`vic_wa_espejo_estado?session_id=eq.${encodeURIComponent(SESSION_ID)}`, { method: "DELETE" }).catch(() => {})
        process.exit(0) // el orquestador (Railway/Fly) lo reinicia y pide QR
      }
      reinicios += 1
      const espera = Math.min(60_000, 2_000 * 2 ** Math.min(reinicios, 5))
      console.error(`[${SESSION_ID}] Conexión cerrada (código ${codigo}). Reintento en ${espera / 1000}s`)
      setTimeout(conectar, espera)
    }
  })

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    // "notify" = mensajes nuevos en vivo; "append" = recuperados al reconectar.
    if (type !== "notify" && type !== "append") return
    for (const m of messages) {
      await guardarMensaje(m).catch((e) => console.error("[upsert]", e.message))
    }
  })
}

console.log(`wa-espejo — sesión "${SESSION_ID}" — SOLO LECTURA`)
conectar().catch((e) => {
  console.error("Fallo fatal al conectar:", e)
  process.exit(1)
})
