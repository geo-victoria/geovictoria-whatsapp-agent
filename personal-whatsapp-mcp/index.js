#!/usr/bin/env node
// Puente MCP para WhatsApp personal.
// - `node index.js link`  → vincula tu cuenta escaneando el QR (Dispositivos vinculados)
// - `node index.js`       → servidor MCP por stdio para Claude (usa la sesión guardada)
// Todo corre localmente: la sesión queda en ./auth y los mensajes en ./messages.jsonl

import path from "node:path"
import fs from "node:fs"
import { fileURLToPath } from "node:url"
import pino from "pino"
import qrcodeTerminal from "qrcode-terminal"
import makeWASocket, { useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } from "@whiskeysockets/baileys"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const AUTH_DIR = path.join(ROOT, "auth")
const STORE_FILE = path.join(ROOT, "messages.jsonl")
const MAX_PER_CHAT = 500

const mode = process.argv[2] === "link" ? "link" : "serve"
// En modo serve, stdout es del protocolo MCP: todo log va a stderr
const log = (...a) => console.error(...a)
const logger = pino({ level: "silent" })

// ─── Almacén de chats y mensajes ─────────────────────────────────────────────
const chats = new Map() // jid → { name, messages: [{ id, fromMe, sender, text, ts }] }

function chatOf(jid) {
  if (!chats.has(jid)) chats.set(jid, { name: "", messages: [] })
  return chats.get(jid)
}

function remember(jid, msg, persist = true) {
  const c = chatOf(jid)
  if (msg.id && c.messages.some((m) => m.id === msg.id)) return
  c.messages.push(msg)
  if (c.messages.length > MAX_PER_CHAT) c.messages.splice(0, c.messages.length - MAX_PER_CHAT)
  if (persist) {
    try { fs.appendFileSync(STORE_FILE, JSON.stringify({ jid, ...msg }) + "\n") } catch {}
  }
}

function loadStore() {
  if (!fs.existsSync(STORE_FILE)) return
  for (const line of fs.readFileSync(STORE_FILE, "utf8").split("\n")) {
    if (!line.trim()) continue
    try {
      const { jid, ...msg } = JSON.parse(line)
      remember(jid, msg, false)
    } catch {}
  }
}

function textOf(m) {
  const msg = m.message || {}
  return (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    (msg.imageMessage ? "[imagen]" : "") ||
    (msg.videoMessage ? "[video]" : "") ||
    (msg.audioMessage ? "[audio]" : "") ||
    (msg.documentMessage ? `[documento: ${msg.documentMessage.fileName || ""}]` : "") ||
    (msg.stickerMessage ? "[sticker]" : "")
  )
}

function recordMessage(m) {
  const jid = m.key?.remoteJid
  if (!jid || jid === "status@broadcast") return
  const text = textOf(m)
  if (!text) return
  const c = chatOf(jid)
  if (m.pushName && !m.key.fromMe && !c.name) c.name = m.pushName
  remember(jid, {
    id: m.key.id,
    fromMe: !!m.key.fromMe,
    sender: m.key.fromMe ? "" : m.pushName || "",
    text,
    ts: Number(m.messageTimestamp) || Math.floor(Date.now() / 1000),
  })
}

// ─── Conexión WhatsApp (Baileys, dispositivo vinculado) ──────────────────────
let sock

async function connect(onQr) {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const { version } = await fetchLatestBaileysVersion()
  sock = makeWASocket({
    version,
    auth: state,
    logger,
    markOnlineOnConnect: false,
    syncFullHistory: false,
  })
  sock.ev.on("creds.update", saveCreds)
  sock.ev.on("messaging-history.set", ({ chats: hChats = [], contacts = [], messages = [] }) => {
    for (const c of hChats) if (c.id && c.name && !chatOf(c.id).name) chatOf(c.id).name = c.name
    for (const ct of contacts) {
      const nm = ct.name || ct.notify
      if (ct.id && nm && !chatOf(ct.id).name) chatOf(ct.id).name = nm
    }
    for (const m of messages) recordMessage(m)
  })
  sock.ev.on("contacts.upsert", (cts) => {
    for (const ct of cts) {
      const nm = ct.name || ct.notify
      if (ct.id && nm && !chatOf(ct.id).name) chatOf(ct.id).name = nm
    }
  })
  sock.ev.on("messages.upsert", ({ messages }) => {
    for (const m of messages) recordMessage(m)
  })

  return new Promise((resolve) => {
    sock.ev.on("connection.update", (u) => {
      if (u.qr && onQr) onQr(u.qr)
      if (u.connection === "open") {
        log("✅ WhatsApp conectado")
        resolve()
      }
      if (u.connection === "close") {
        const code = u.lastDisconnect?.error?.output?.statusCode
        if (code === DisconnectReason.loggedOut) {
          log("❌ Sesión cerrada desde el teléfono. Borra la carpeta auth/ y corre `node index.js link` de nuevo.")
          process.exit(1)
        }
        log("Conexión caída, reintentando...")
        connect(onQr)
      }
    })
  })
}

// ─── Resolución de destinatarios ─────────────────────────────────────────────
function resolveChat(input) {
  if (input.includes("@")) return input
  const digits = input.replace(/[^0-9]/g, "")
  if (digits.length >= 8 && /^[+0-9\s()-]+$/.test(input)) return `${digits}@s.whatsapp.net`
  const q = input.toLowerCase()
  for (const [jid, c] of chats) {
    if (c.name && c.name.toLowerCase().includes(q)) return jid
  }
  return null
}

const fmtTs = (ts) => new Date(ts * 1000).toLocaleString("es-CL", { timeZone: "America/Santiago" })

// ─── Modo link: vincular la cuenta ───────────────────────────────────────────
if (mode === "link") {
  console.log("Abre WhatsApp en tu teléfono → Ajustes → Dispositivos vinculados → Vincular dispositivo,")
  console.log("y escanea el QR que aparecerá aquí:\n")
  await connect((qr) => qrcodeTerminal.generate(qr, { small: true }))
  console.log("\n✅ Cuenta vinculada. La sesión quedó guardada en ./auth")
  console.log("Ahora conecta el MCP a Claude (ver README) y déjalo correr con: node index.js")
  setTimeout(() => process.exit(0), 3000)
} else {
  // ─── Modo serve: servidor MCP ──────────────────────────────────────────────
  if (!fs.existsSync(path.join(AUTH_DIR, "creds.json"))) {
    log("No hay sesión de WhatsApp vinculada. Corre primero: node index.js link")
    process.exit(1)
  }
  loadStore()
  connect(() => log("La sesión expiró: corre `node index.js link` de nuevo."))

  const server = new McpServer({ name: "whatsapp-personal", version: "1.0.0" })

  server.tool(
    "listar_chats",
    "Lista los chats recientes de WhatsApp con su último mensaje",
    { limite: z.number().int().min(1).max(100).optional() },
    async ({ limite = 20 }) => {
      const rows = [...chats.entries()]
        .filter(([, c]) => c.messages.length > 0)
        .sort((a, b) => (b[1].messages.at(-1)?.ts || 0) - (a[1].messages.at(-1)?.ts || 0))
        .slice(0, limite)
        .map(([jid, c]) => {
          const m = c.messages.at(-1)
          return `${c.name || jid} (${jid}) — ${fmtTs(m.ts)}: ${m.fromMe ? "yo: " : ""}${m.text.slice(0, 80)}`
        })
      return {
        content: [{
          type: "text",
          text: rows.join("\n") || "Sin mensajes aún. El puente acumula mensajes mientras está corriendo.",
        }],
      }
    }
  )

  server.tool(
    "leer_mensajes",
    "Lee los últimos mensajes de un chat. Acepta nombre de contacto, teléfono (56912345678) o jid",
    { chat: z.string(), limite: z.number().int().min(1).max(200).optional() },
    async ({ chat, limite = 30 }) => {
      const jid = resolveChat(chat)
      const c = jid ? chats.get(jid) : null
      if (!c || c.messages.length === 0) {
        return { content: [{ type: "text", text: `No encontré mensajes para "${chat}".` }] }
      }
      const rows = c.messages
        .slice(-limite)
        .map((m) => `[${fmtTs(m.ts)}] ${m.fromMe ? "Yo" : m.sender || c.name || jid}: ${m.text}`)
      return { content: [{ type: "text", text: `Chat: ${c.name || jid}\n\n${rows.join("\n")}` }] }
    }
  )

  server.tool(
    "buscar_mensajes",
    "Busca un texto en todos los mensajes guardados",
    { consulta: z.string(), limite: z.number().int().min(1).max(100).optional() },
    async ({ consulta, limite = 20 }) => {
      const q = consulta.toLowerCase()
      const hits = []
      for (const [jid, c] of chats) {
        for (const m of c.messages) {
          if (m.text.toLowerCase().includes(q)) {
            hits.push(`[${fmtTs(m.ts)}] ${c.name || jid} — ${m.fromMe ? "Yo" : m.sender || ""}: ${m.text}`)
          }
        }
      }
      hits.sort()
      return {
        content: [{
          type: "text",
          text: hits.slice(-limite).join("\n") || `Sin resultados para "${consulta}".`,
        }],
      }
    }
  )

  server.tool(
    "enviar_mensaje",
    "Envía un mensaje de WhatsApp desde tu cuenta personal. Acepta nombre, teléfono o jid como destinatario",
    { chat: z.string(), texto: z.string() },
    async ({ chat, texto }) => {
      const jid = resolveChat(chat)
      if (!jid) {
        return {
          content: [{ type: "text", text: `No pude resolver "${chat}". Usa el teléfono (ej: 56912345678) o un nombre que aparezca en listar_chats.` }],
          isError: true,
        }
      }
      await sock.sendMessage(jid, { text: texto })
      remember(jid, { id: `local-${Date.now()}`, fromMe: true, sender: "", text: texto, ts: Math.floor(Date.now() / 1000) })
      return { content: [{ type: "text", text: `Enviado a ${chats.get(jid)?.name || jid}: "${texto}"` }] }
    }
  )

  await server.connect(new StdioServerTransport())
  log("Servidor MCP whatsapp-personal listo (stdio)")
}
