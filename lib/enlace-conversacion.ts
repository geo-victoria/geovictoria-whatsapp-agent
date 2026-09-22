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

export async function marcarRegistroConChat(
  modulo: "Leads" | "Deals",
  registroId: string,
  contact: string,
): Promise<boolean> {
  try {
    if (!registroId || !contact) return false
    const chat = await leerChat(chatRefDeContacto(contact))
    const url = urlChat(chat?.chatId || "")
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
