/**
 * Dueño (Owner) de una cotización en Zoho, por quoteId.
 *
 * Existe por el RELEVO DE EJECUTIVO CL (Lalo, 27-jul): el dueño correcto
 * depende de CADA cotización. Quien presenta a un ejecutivo al cliente (el
 * traspaso post-pago, sobre todo) debe resolverlo acá y no asumirlo.
 *
 * 27-ago (caso Moncada/Anderson): el COQL v3 NO expande el lookup Owner en
 * este módulo ("Owner.full_name → column given seems to be invalid"), así que
 * la versión COQL devolvía null SIEMPRE y el traspaso post-pago presentaba al
 * fallback (Eddyluz) en todos los pagos con dueño humano. Se resuelve con un
 * GET del registro (?fields=Owner), que sí trae name/email/id.
 *
 * Best-effort: cualquier fallo devuelve null y el llamador decide su fallback.
 */

import { getZohoAccessToken } from "./zoho-token"

const ZOHO_API_DOMAIN = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
const QUOTE_MODULE = (process.env.ZOHO_QUOTE_MODULE || "Cotizaciones_GeoVictoria").trim()

export async function ownerDeCotizacion(
  quoteId: string,
): Promise<{ email: string; nombre: string; id: string } | null> {
  try {
    if (!quoteId) return null
    const token = await getZohoAccessToken()
    const res = await fetch(`${ZOHO_API_DOMAIN}/crm/v3/${QUOTE_MODULE}/${quoteId}?fields=Owner`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      cache: "no-store",
    })
    // OJO Zoho: 204 = registro inexistente (res.ok true) — sin data no hay dueño.
    if (!res.ok || res.status === 204) return null
    const fila = (((await res.json().catch(() => null)) as {
      data?: Array<{ Owner?: { name?: string; email?: string; id?: string } | null }>
    } | null)?.data || [])[0]
    const email = (fila?.Owner?.email || "").trim()
    if (!email) return null
    return {
      email,
      nombre: (fila?.Owner?.name || "").trim() || email.split("@")[0],
      id: (fila?.Owner?.id || "").trim(),
    }
  } catch {
    return null
  }
}
