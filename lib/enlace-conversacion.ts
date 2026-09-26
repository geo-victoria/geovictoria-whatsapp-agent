/**
 * El registro de Zoho queda marcado con la conversación de la que nació
 * (orden de Lalo, 15-ago). El campo es `Conversaci_n_Botmaker` — verificado
 * el 15-ago contra el CRM: de los dos campos con nombre casi igual en Leads,
 * ese es el que está poblado; `Conversaci_n_en_Botmaker` está vacío en el
 * 100% de los registros.
 *
 * Best-effort puro: nunca lanza. Si Botmaker no responde el chatId, el
 * conciliador lo completa en su próxima vuelta.
 */
import { chatRefDeContacto, leerChat } from "./botmaker-agentes"

const CAMPO = (process.env.ZOHO_CAMPO_LINK_CHAT || "Conversaci_n_Botmaker").trim()

export function urlChat(chatId: string): string {
  return chatId ? `https://go.botmaker.com/#/chats/${chatId}` : ""
}

/**
 * URL de la conversación de un contacto en Botmaker (26-sep, orden de Lalo:
 * "que en el deal o en la nota siempre vaya la URL de la conversación").
 * Caché en vic_kv `chat_url_<contact>` (el chatId de Botmaker no cambia).
 * Resuelve el chat por la línea de ORIGEN si se conoce (bot único: un +51 puede
 * escribir a la línea chilena) y cae a la línea del país del contacto.
 */
export async function urlChatDeContacto(contact: string): Promise<string> {
  const c = String(contact || "").trim()
  if (!c) return ""
  try {
    const { getKvValue, setKvValue } = await import("./supabase-persistence-v3")
    const cache = String((await getKvValue(`chat_url_${c}`).catch(() => null)) || "")
    if (cache.startsWith("https://")) return cache
    const refs: string[] = []
    const origen = String((await getKvValue(`canal_origen_${c}`).catch(() => null)) || "")
    const numLinea = (origen.match(/(\d+)\s*$/) || [])[1] || ""
    const esIdSinNumero = /^\s*[A-Z]{2}\./i.test(c)
    if (numLinea) refs.push(`${numLinea}:${esIdSinNumero ? c : c.replace(/\D/g, "")}`)
    const porPais = chatRefDeContacto(c)
    if (porPais && !refs.includes(porPais)) refs.push(porPais)
    for (const ref of refs) {
      const chat = await leerChat(ref).catch(() => null)
      const url = urlChat(chat?.chatId || "")
      if (url) {
        await setKvValue(`chat_url_${c}`, url).catch(() => {})
        return url
      }
    }
  } catch {}
  return ""
}

/** Cabecera que abre toda nota de conversación de Vicky: el link directo al chat. */
export function cabeceraEnlaceChat(url: string): string {
  return url ? `Conversación en Botmaker: ${url}\n\n` : ""
}

export async function marcarRegistroConChat(
  modulo: "Leads" | "Deals",
  registroId: string,
  contact: string,
): Promise<boolean> {
  try {
    if (!registroId || !contact) return false
    const url = await urlChatDeContacto(contact)
    if (!url) return false
    const { getZohoAccessToken } = await import("./zoho-token")
    const token = await getZohoAccessToken()
    const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
    const r = await fetch(`${api}/crm/v3/${modulo}/${registroId}`, {
      method: "PUT",
      headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        data: [{ id: registroId, [CAMPO]: url }],
        // Marcar el chat no puede re-sortear al dueño.
        skip_feature_execution: [{ name: "assignment_rules" }],
      }),
    })
    return r.ok
  } catch {
    return false
  }
}
