/**
 * Marca una cotización de Zoho como Rechazada (pérdida declarada por el cliente:
 * se fue con la competencia / rechazo terminante). Best-effort: nunca rompe el
 * flujo del turno. Al quedar "Rechazada", el guard existente del cron de
 * reactivación la excluye de futuros toques, y el pipeline queda limpio.
 */
import { getZohoAccessToken } from "@/lib/zoho-token"

const QUOTE_MODULE = (process.env.ZOHO_QUOTE_MODULE || "Cotizaciones_GeoVictoria").trim()
const ZOHO_API_DOMAIN = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()

/**
 * ¿La cotización sigue ABIERTA para seguimiento comercial? (ni aceptada ni
 * rechazada). Lo usa el toque 22h50 antes de anunciar la llamada de la hora 23:
 * un cliente que ya aceptó/pagó (o que rechazó) NO recibe llamadas de venta,
 * aunque su cadencia se haya re-armado por seguir conversando post-venta
 * (caso real: Carlos, 15-jul). Conservador: ante error devuelve false (mejor
 * no llamar que llamar a un cliente que ya pagó).
 */
/**
 * Estado + descuento comiteado de la cotización, en una sola consulta. Para la
 * llamada de voz: si ya hay descuento acordado (por WhatsApp o una llamada
 * anterior), la llamada debe citar el precio VIGENTE, no el original — el
 * viernes 18 la voz citó $95.996 a un cliente cuya página ya mostraba $76.797
 * con 20%, porque solo recibía el monto pre-descuento.
 */
export async function estadoCotizacionParaSeguimiento(
  quoteId: string,
): Promise<{ abierta: boolean; pctComiteado: number }> {
  if (!quoteId) return { abierta: false, pctComiteado: 0 }
  try {
    const token = await getZohoAccessToken()
    const res = await fetch(
      `${ZOHO_API_DOMAIN}/crm/v3/${QUOTE_MODULE}/${quoteId}?fields=Estado_Cotizacion,Descuento_Recurrente_Pct`,
      {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        cache: "no-store",
      },
    )
    if (!res.ok) return { abierta: false, pctComiteado: 0 }
    const data = (await res.json().catch(() => ({}))) as {
      data?: Array<{ Estado_Cotizacion?: string; Descuento_Recurrente_Pct?: number }>
    }
    const estado = (data?.data?.[0]?.Estado_Cotizacion || "").toLowerCase()
    const pct = Number(data?.data?.[0]?.Descuento_Recurrente_Pct || 0) || 0
    return { abierta: estado !== "aceptada" && estado !== "rechazada", pctComiteado: pct }
  } catch {
    return { abierta: false, pctComiteado: 0 }
  }
}

export async function cotizacionAbiertaParaSeguimiento(quoteId: string): Promise<boolean> {
  if (!quoteId) return false
  try {
    const token = await getZohoAccessToken()
    const res = await fetch(
      `${ZOHO_API_DOMAIN}/crm/v3/${QUOTE_MODULE}/${quoteId}?fields=Estado_Cotizacion`,
      {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        cache: "no-store",
      },
    )
    if (!res.ok) return false
    const data = (await res.json().catch(() => ({}))) as {
      data?: Array<{ Estado_Cotizacion?: string }>
    }
    const estado = (data?.data?.[0]?.Estado_Cotizacion || "").toLowerCase()
    return estado !== "aceptada" && estado !== "rechazada"
  } catch {
    return false
  }
}

/**
 * ARREPENTIMIENTO POST-ACEPTACIÓN (Rodrigo 10-ago): el cliente aceptó, se
 * arrepintió y pidió cambios. La aceptada no se reabre (blueprint/NDV ya
 * corrieron), así que la emisión NUEVA la reemplaza y la anterior queda
 * Rechazada (el dashboard la muestra como perdida) — SOLO si estaba Aceptada
 * y SIN pago (ID_SO vacío). Una Emitida en comparación o una pagada jamás se
 * tocan. Best-effort: nunca rompe el flujo del turno.
 */
export async function rechazarAceptadaSuperada(quoteId: string): Promise<boolean> {
  if (!quoteId) return false
  try {
    const token = await getZohoAccessToken()
    const res = await fetch(
      `${ZOHO_API_DOMAIN}/crm/v3/${QUOTE_MODULE}/${quoteId}?fields=Estado_Cotizacion,ID_SO`,
      { headers: { Authorization: `Zoho-oauthtoken ${token}` }, cache: "no-store" },
    )
    if (!res.ok) return false
    const data = (await res.json().catch(() => ({}))) as {
      data?: Array<{ Estado_Cotizacion?: string; ID_SO?: unknown }>
    }
    const rec = data?.data?.[0]
    const estado = String(rec?.Estado_Cotizacion || "").toLowerCase()
    if (estado !== "aceptada" || rec?.ID_SO) return false
    const ok = await marcarCotizacionRechazada(quoteId)
    if (ok) console.log(`[zoho-quote] aceptada superada → Rechazada quoteId=${quoteId}`)
    return ok
  } catch {
    return false
  }
}

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
