/**
 * Marca una cotización de Zoho como Rechazada (pérdida declarada por el cliente:
 * se fue con la competencia / rechazo terminante). Best-effort: nunca rompe el
 * flujo del turno. Al quedar "Rechazada", el guard existente del cron de
 * reactivación la excluye de futuros toques, y el pipeline queda limpio.
 */
import { getZohoAccessToken } from "@/lib/zoho-token"

const QUOTE_MODULE = (process.env.ZOHO_QUOTE_MODULE || "Cotizaciones_GeoVictoria").trim()
const ZOHO_API_DOMAIN = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()

export async function marcarCotizacionRechazada(quoteId: string): Promise<boolean> {
  if (!quoteId) return false
  try {
    const token = await getZohoAccessToken()
    const res = await fetch(`${ZOHO_API_DOMAIN}/crm/v3/${QUOTE_MODULE}/${quoteId}`, {
      method: "PUT",
      headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        data: [{ Estado_Cotizacion: "Rechazada" }],
        trigger: ["workflow"],
      }),
      cache: "no-store",
    })
    const data = (await res.json().catch(() => ({}))) as {
      data?: Array<{ status?: string }>
    }
    const ok = res.ok && data?.data?.[0]?.status === "success"
    if (!ok) console.warn(`[zoho-quote] no se pudo marcar Rechazada ${quoteId}:`, JSON.stringify(data).slice(0, 200))
    return ok
  } catch (e) {
    console.warn(`[zoho-quote] excepción marcando Rechazada ${quoteId}:`, e)
    return false
  }
}
