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
export async function sendBotmakerMessage(
  contactId: string,
  text: string,
): Promise<boolean> {
  if (!BM_TOKEN || !BM_CHANNEL_V3) {
    console.error(
      "[botmaker-push] BOTMAKER_ACCESS_TOKEN o BOTMAKER_CHANNEL_V3 no configurados",
    )
    return false
  }
  if (!contactId || !text) {
    console.error("[botmaker-push] contactId y text son requeridos")
    return false
  }

  const cleanContact = normalizeContactId(contactId)

  try {
    const res = await fetch(SEND_MESSAGES_URL, {
      method: "POST",
      headers: BM_HEADERS,
      body: JSON.stringify({
        chat: { channelId: BM_CHANNEL_V3, contactId: cleanContact },
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
function channelNumber(): string {
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
export async function sendBotmakerTemplate(
  contactId: string,
  templateName: string,
  params: Record<string, string>,
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
  const chatChannelNumber = channelNumber()
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
): Promise<void> {
  if (!BM_TOKEN || !BM_CHANNEL_V3 || !contactId) return
  const cleanContact = normalizeContactId(contactId)
  try {
    await fetch(TYPING_URL, {
      method: "POST",
      headers: BM_HEADERS,
      body: JSON.stringify({
        channelId: BM_CHANNEL_V3,
        contactId: cleanContact,
        typing: isTyping,
      }),
      cache: "no-store",
    })
  } catch {
    // Fire-and-forget: si falla, no es crítico.
  }
}
