/**
 * Dueño (Owner) de una cotización en Zoho, por quoteId.
 *
 * Existe por el RELEVO DE EJECUTIVO CL (Lalo, 27-jul): todo lo NUEVO va a
 * Eddyluz Mujica y lo ya asignado queda con Anderson Díaz. Eso vuelve
 * imposible hardcodear "el ejecutivo de Chile": el dueño correcto depende de
 * CADA cotización. Quien presenta a un ejecutivo al cliente (el traspaso
 * post-pago, sobre todo) debe resolverlo acá y no asumirlo.
 *
 * Best-effort: cualquier fallo devuelve null y el llamador decide su fallback.
 */

import { getZohoAccessToken } from "./zoho-token"

const ZOHO_API_DOMAIN = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
const QUOTE_MODULE = (process.env.ZOHO_QUOTE_MODULE || "Cotizaciones_GeoVictoria").trim()

export async function ownerDeCotizacion(
  quoteId: string,
): Promise<{ email: string; nombre: string } | null> {
  try {
    if (!quoteId) return null
    const token = await getZohoAccessToken()
    const res = await fetch(`${ZOHO_API_DOMAIN}/crm/v3/coql`, {
      method: "POST",
      headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        select_query: `select Owner.email, Owner.full_name from ${QUOTE_MODULE} where id = '${quoteId}'`,
      }),
      cache: "no-store",
    })
    if (!res.ok) return null
    const rows = ((await res.json().catch(() => null))?.data || []) as Array<Record<string, string>>
    const email = (rows[0]?.["Owner.email"] || "").trim()
    if (!email) return null
    return { email, nombre: (rows[0]?.["Owner.full_name"] || email.split("@")[0]).trim() }
  } catch {
    return null
  }
}
