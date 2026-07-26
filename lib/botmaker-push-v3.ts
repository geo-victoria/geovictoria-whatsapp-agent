/**
 * Helpers para enviar mensajes proactivos a Botmaker.
 *
 * El endpoint freeform `/v2.0/chats-actions/send-messages` permite mandar
 * mensajes de texto libre a una conversación EN CURSO (dentro de la ventana
 * de 24h del último mensaje del usuario, según WhatsApp Business).
 *
 * Lo usamos para entregar el reply de Vicky V3 fuera de la respuesta HTTP
 * del webhook de Botmaker, evitando timeouts cuando el procesamiento
 * (especialmente generación de cotización formal) tarda más que el
 * timeout del webhook.
 */

const BM_TOKEN = (process.env.BOTMAKER_ACCESS_TOKEN || "").trim()
const BM_CHANNEL_V3 = (process.env.BOTMAKER_CHANNEL_V3 || "").trim()

const BM_HEADERS = {
  "access-token": BM_TOKEN,
  "Content-Type": "application/json",
  Accept: "application/json",
}

const SEND_MESSAGES_URL =
  "https://api.botmaker.com/v2.0/chats-actions/send-messages"
const TYPING_URL =
  "https://api.botmaker.com/v2.0/chats-actions/send-read-typing-feedback"
// Notificaciones / plantillas HSM (mensajes proactivos FUERA de la ventana de
// 24h, ej. recordatorios de reunión). Endpoint de la API de Notificaciones de
// Botmaker (host distinto: go.botmaker.com).
const NOTIFICATIONS_URL = "https://go.botmaker.com/api/v1.0/intent/v2"

/** Normaliza el contactId al formato que espera Botmaker (sin "+"). */
function normalizeContactId(raw: string): string {
  return raw.replace(/^\+/, "").replace(/\D/g, "")
}

// ── Canal de ORIGEN por contacto (caso +573117482905, 21-jul) ───────────────
// Un colombiano puede escribirle a la línea CHILENA (o viceversa): si le
// respondemos por la línea "de su país" se abren DOS chats paralelos — él
// escribe en uno y Vicky contesta desde otro número. Regla WhatsApp: se
// responde por el MISMO canal donde el cliente escribió. El canal de origen
// se persiste en vic_kv (canal_origen_<contacto>) — lo setea el webhook cuando
// la acción de código manda `channelId`, o a mano para casos puntuales — y
// tiene precedencia sobre el channelId que pase el llamador. Lectura inline
// (sin importar supabase-persistence-v3, para no crear ciclo de imports).
const SUPABASE_URL_KV = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY_KV = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()

async function canalDeOrigen(contactId: string): Promise<string> {
  if (!SUPABASE_URL_KV || !SUPABASE_KEY_KV) return ""
  try {
    const r = await fetch(
      `${SUPABASE_URL_KV}/rest/v1/vic_kv?key=eq.canal_origen_${encodeURIComponent(contactId)}&select=value&limit=1`,
      {
        headers: { apikey: SUPABASE_KEY_KV, Authorization: `Bearer ${SUPABASE_KEY_KV}` },
        cache: "no-store",
      },
    )
    const rows = (await r.json().catch(() => [])) as Array<{ value?: string }>
    return (rows?.[0]?.value || "").trim()
  } catch {
    return ""
  }
}

/**
 * Envía un mensaje de texto a una conversación de WhatsApp vía Botmaker.
 *
 * WhatsApp interpreta:
 *   - `*texto*` como **negrita**
 *   - `_texto_` como _cursiva_
 *   - `~texto~` como ~tachado~
 *   - ```` ```texto``` ```` como código
 *
 * @param contactId Teléfono del cliente. Acepta con o sin "+".
 * @param text Mensaje a enviar (texto libre).
 * @returns true si Botmaker aceptó el envío (status 202), false en error.
 */
/**
 * Detección AUTOMÁTICA del canal de origen (fallback, caso +573172822429):
 * mientras las acciones de código de Botmaker no envíen `channelId`, se
 * consulta la API de mensajes por los últimos minutos y se busca el último
 * mensaje DEL USUARIO de este contacto — su chat.channelId es la línea por la
 * que escribió. Si se encuentra, se persiste en vic_kv (canal_origen_<c>) para
 * que todos los pushes salgan por ahí. Best-effort: sin token o sin hallazgo,
 * no hace nada.
 */
/** País por prefijo de un número WhatsApp (sin "+"): cl | co | mx | otro. */
function paisDeNumero(num: string): "cl" | "co" | "mx" | "otro" {
  if (num.startsWith("56")) return "cl"
  if (num.startsWith("57")) return "co"
  if (num.startsWith("52")) return "mx"
  return "otro"
}

/**
 * ¿El channelId que reporta la acción de código es coherente con el país del
 * contacto? El channelId termina en el número de la línea (ej.
 * "GeoVictoriaEspaol-whatsapp-56967308227"). Un contacto +57 con canal de la
 * línea +56 casi siempre es el master bot ruteando mal (caso María 23-jul):
 * ese canal NO debe persistirse como origen. Contactos de países sin línea
 * propia (Perú, EEUU...) escriben por cualquier línea, así que para ellos
 * cualquier canal es coherente.
 */
export function canalCoherenteConContacto(contactId: string, canal: string): boolean {
  const numCanal = (canal.match(/(\d+)\s*$/) || [])[1] || ""
  if (!numCanal) return true
  const paisContacto = paisDeNumero(normalizeContactId(contactId))
  if (paisContacto === "otro") return true
  return paisDeNumero(numCanal) === paisContacto
}

export async function detectarCanalOrigen(contactId: string): Promise<string> {
  if (!BM_TOKEN || !SUPABASE_URL_KV || !SUPABASE_KEY_KV) return ""
  const clean = normalizeContactId(contactId)
  try {
    const desde = new Date(Date.now() - 30 * 60 * 1000).toISOString()
    const r = await fetch(
      `https://api.botmaker.com/v2.0/messages?chat-platform=whatsapp&limit=250&from=${encodeURIComponent(desde)}`,
      { headers: { "access-token": BM_TOKEN, Accept: "application/json" }, cache: "no-store" },
    )
    const data = (await r.json().catch(() => ({}))) as {
      items?: Array<{
        from?: string
        creationTime?: string
        chat?: { contactId?: string; channelId?: string }
      }>
    }
    const delContacto = (data.items || [])
      .filter((m) => m.from === "user" && m.chat?.contactId === clean && m.chat?.channelId)
      .sort((a, b) => String(b.creationTime || "").localeCompare(String(a.creationTime || "")))
    const canal = delContacto[0]?.chat?.channelId || ""
    if (canal) {
      await fetch(`${SUPABASE_URL_KV}/rest/v1/vic_kv?on_conflict=key`, {
        method: "POST",
        headers: {
          apikey: SUPABASE_KEY_KV,
          Authorization: `Bearer ${SUPABASE_KEY_KV}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify({ key: `canal_origen_${clean}`, value: canal }),
        cache: "no-store",
      }).catch(() => {})
      console.log(`[botmaker-push] canal de origen detectado para ${clean}: ${canal}`)
    }
    return canal
  } catch (e) {
    console.error("[botmaker-push] detectarCanalOrigen falló:", e)
    return ""
  }
}

export async function sendBotmakerMessage(
  contactId: string,
  text: string,
  // Multi-país: channelId de la línea por la que responder. Default: línea
  // Chile (BOTMAKER_CHANNEL_V3), compatible con todos los llamadores actuales.
  channelId?: string,
): Promise<boolean> {
  if (!contactId || !text) {
    console.error("[botmaker-push] contactId y text son requeridos")
    return false
  }

  const cleanContact = normalizeContactId(contactId)
  // El canal de ORIGEN del contacto (si está registrado) manda sobre el del
  // llamador: se responde por donde el cliente escribió. EXCEPCIÓN (22-jul):
  // los números INTERNOS de aviso (QUOTE_NOTIFY_TO / VICKY_REPORT_PHONE) no
  // siguen el canal de origen — si un miembro del equipo prueba una línea
  // nueva como cliente, su canal_origen queda apuntando ahí y los avisos
  // internos empezarían a saltar de línea (pasó con la línea MX). Los avisos
  // del equipo van SIEMPRE por el canal que pida el llamador (o la línea CL).
  const internos = new Set(
    [process.env.QUOTE_NOTIFY_TO, process.env.VICKY_REPORT_PHONE]
      .map((n) => (n || "").trim().replace(/\D/g, ""))
      .filter(Boolean),
  )
  const origen = internos.has(cleanContact) ? "" : await canalDeOrigen(cleanContact)
  const canal = (origen || channelId || BM_CHANNEL_V3).trim()
  if (origen && origen !== (channelId || BM_CHANNEL_V3).trim()) {
    console.log(
      `[botmaker-push] contact=${cleanContact}: canal de origen ${origen} (override sobre ${channelId || "default"})`,
    )
  }
  if (!BM_TOKEN || !canal) {
    console.error(
      "[botmaker-push] BOTMAKER_ACCESS_TOKEN o channelId no configurados",
    )
    return false
  }

  try {
    const res = await fetch(SEND_MESSAGES_URL, {
      method: "POST",
      headers: BM_HEADERS,
      body: JSON.stringify({
        chat: { channelId: canal, contactId: cleanContact },
        messages: [{ text }],
      }),
      cache: "no-store",
    })

    // Botmaker devuelve 202 Accepted cuando el job de envío fue creado.
    // Aceptamos también 200 por si acaso.
    if (res.status !== 202 && res.status !== 200) {
      const body = await res.text().catch(() => "")
      console.error(
        `[botmaker-push] send-messages ${res.status} para ${cleanContact}:`,
        body.slice(0, 300),
      )
      return false
    }

    return true
  } catch (err) {
    console.error("[botmaker-push] Excepción al enviar mensaje:", err)
    return false
  }
}

/**
 * Número de WhatsApp del canal (sin "+"), que la API de notificaciones pide
 * como `chatChannelNumber`. Se setea explícito (BOTMAKER_CHANNEL_NUMBER) o se
 * extrae del channelId (ej. "GeoVictoriaEspaol-whatsapp-56967308227" →
 * "56967308227").
 */
function channelNumber(overrideNumero?: string): string {
  const explicitOverride = (overrideNumero || "").replace(/\D/g, "")
  if (explicitOverride) return explicitOverride
  const explicit = (process.env.BOTMAKER_CHANNEL_NUMBER || "").replace(/\D/g, "")
  if (explicit) return explicit
  const m = BM_CHANNEL_V3.match(/(\d{6,})\s*$/)
  return m ? m[1] : ""
}

/**
 * Envía una plantilla HSM de WhatsApp (mensaje proactivo aprobado por Meta) a
 * un contacto, vía la API de Notificaciones de Botmaker. Se usa para los
 * recordatorios de reunión, que salen fuera de la ventana de 24h y por eso NO
 * pueden ir como texto libre.
 *
 * @param contactId Teléfono del cliente (con o sin "+").
 * @param templateName Nombre de la plantilla aprobada (ruleNameOrId).
 * @param params Variables de la plantilla por NOMBRE (ej. { nombre, hora_reunion }).
 */
/**
 * Envía un ARCHIVO (PDF) por WhatsApp. Mismo ruteo de canal que
 * sendBotmakerMessage — se responde por donde el cliente escribió.
 *
 * POR QUÉ EXISTE (26-jul): el correo con la cotización sí se entrega, pero cae
 * en Promociones/Otros y el cliente reporta "no me llegó" (10 contactos entre
 * junio y julio). WhatsApp es el canal donde el cliente YA está hablando: darle
 * el PDF ahí evita la dependencia del correo por completo.
 *
 * El esquema `media` es el del OpenAPI oficial de Botmaker
 * (api.botmaker.com/v2.0/openapi.json): { filename, mimeType, url }, con
 * "application/pdf" dentro del enum de mimeTypes soportados.
 */
export async function sendBotmakerMedia(
  contactId: string,
  url: string,
  opts: { filename?: string; mimeType?: string; caption?: string; channelId?: string } = {},
): Promise<boolean> {
  if (!contactId || !url) {
    console.error("[botmaker-push] contactId y url son requeridos para media")
    return false
  }
  const cleanContact = normalizeContactId(contactId)
  const origen = await canalDeOrigen(cleanContact)
  const canal = (origen || opts.channelId || BM_CHANNEL_V3).trim()
  if (!BM_TOKEN || !canal) {
    console.error("[botmaker-push] BOTMAKER_ACCESS_TOKEN o channelId no configurados")
    return false
  }

  // El caption va como mensaje de texto aparte: el objeto `media` del esquema
  // no lo lleva, y mandarlo dentro haría que el archivo saliera sin contexto.
  const messages: Array<Record<string, unknown>> = []
  if (opts.caption) messages.push({ text: opts.caption })
  messages.push({
    media: {
      filename: opts.filename || "documento.pdf",
      mimeType: opts.mimeType || "application/pdf",
      url,
    },
  })

  try {
    const res = await fetch(SEND_MESSAGES_URL, {
      method: "POST",
      headers: BM_HEADERS,
      body: JSON.stringify({ chat: { channelId: canal, contactId: cleanContact }, messages }),
      cache: "no-store",
    })
    if (res.status !== 202 && res.status !== 200) {
      const body = await res.text().catch(() => "")
      console.error(
        `[botmaker-push] media ${res.status} para ${cleanContact}:`,
        body.slice(0, 300),
      )
      return false
    }
    return true
  } catch (e) {
    console.error("[botmaker-push] error enviando media:", e)
    return false
  }
}

export async function sendBotmakerTemplate(
  contactId: string,
  templateName: string,
  params: Record<string, string>,
  // Multi-país: channelId (ej. PERFIL_CO.canal.channelId) o número de la línea
  // por la que debe salir la plantilla. Default: la línea chilena, como siempre.
  channelId?: string,
): Promise<boolean> {
  if (!BM_TOKEN) {
    console.error("[botmaker-template] BOTMAKER_ACCESS_TOKEN no configurado")
    return false
  }
  if (!contactId || !templateName) {
    console.error("[botmaker-template] contactId y templateName son requeridos")
    return false
  }
  const cleanContact = normalizeContactId(contactId)
  const chatChannelNumber = channelNumber(channelId)
  if (!chatChannelNumber) {
    console.error("[botmaker-template] no se pudo determinar chatChannelNumber")
    return false
  }
  try {
    const res = await fetch(NOTIFICATIONS_URL, {
      method: "POST",
      headers: BM_HEADERS,
      body: JSON.stringify({
        chatPlatform: "whatsapp",
        chatChannelNumber,
        platformContactId: cleanContact,
        ruleNameOrId: templateName,
        params,
      }),
      cache: "no-store",
    })
    if (res.status !== 202 && res.status !== 200) {
      const body = await res.text().catch(() => "")
      console.error(
        `[botmaker-template] notification ${res.status} para ${cleanContact}:`,
        body.slice(0, 400),
      )
      return false
    }
    return true
  } catch (err) {
    console.error("[botmaker-template] Excepción al enviar plantilla:", err)
    return false
  }
}

/**
 * Activa/desactiva el indicador "Vicky está escribiendo..." del cliente.
 * Best-effort: no espera respuesta crítica, ignora errores.
 *
 * @param isTyping true para mostrar "escribiendo..." (al recibir un mensaje del
 *   usuario, antes de responder); false para apagarlo (una vez que Vicky ya
 *   respondió), así el indicador no queda colgado después del mensaje de Vicky.
 */
export async function sendTypingIndicator(
  contactId: string,
  isTyping = true,
  // Multi-país: canal de la línea (default: Chile).
  channelId?: string,
): Promise<void> {
  const canal = (channelId || BM_CHANNEL_V3).trim()
  if (!BM_TOKEN || !canal || !contactId) return
  const cleanContact = normalizeContactId(contactId)
  try {
    await fetch(TYPING_URL, {
      method: "POST",
      headers: BM_HEADERS,
      body: JSON.stringify({
        channelId: canal,
        contactId: cleanContact,
        typing: isTyping,
      }),
      cache: "no-store",
    })
  } catch {
    // Fire-and-forget: si falla, no es crítico.
  }
}
