/**
 * ¿ESTA VENTA ES DE VICKY? — un solo criterio para los tres caminos.
 *
 * La regla es de Lalo (08-sep caso UDES "no quiero que estos casos le quiten
 * tasa a Vicky" y 09-sep caso GSL "agrega Seguridad GSL"): una cotización del
 * canal EJECUTIVO cuenta para Vicky si
 *   (a) hubo una cotización '100% Vicky' ANTERIOR en el mismo deal o teléfono
 *       (REEMISIÓN), o
 *   (b) Vicky MOSTRÓ PRECIO en el chat antes de esa emisión (caso C).
 *
 * Ya la aplicaban el dash, el cierre diario y el correo de PAGADA del
 * cotizador. El que se quedó atrás era el gate del ALTA POR CHAT, que miraba
 * `Intervenci_n_Humana` pelado — y por eso el 13-sep Mila Coffee House
 * (Vicky cotizó el 05-ago, Grey reemitió el 14-ago, la clienta pagó la de
 * Grey) recibió un correo interno que decía "Canal: VICKY (reemitida por
 * ejecutivo)" mientras el onboarding la trataba como ajena: los dos caminos
 * leían el MISMO hecho y concluían lo contrario. La clienta quedó con Vicky
 * prometiéndole en el chat una cuenta que nadie iba a crear.
 */

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()

/** Mensaje de Vicky con bloque de precio — la MISMA señal del dash
 *  (`fetchPreformAts`) y del endpoint vic-precio-mostrado. */
export async function precioMostradoPorVicky(
  tel: string,
  antesIso?: string,
): Promise<{ mostrado: boolean; at: string | null }> {
  const fono = String(tel || "").replace(/\D/g, "").replace(/^5656/, "56")
  if (fono.length < 9 || !SUPABASE_URL || !SUPABASE_KEY) return { mostrado: false, at: null }
  const H = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  try {
    const convs = (await fetch(
      `${SUPABASE_URL}/rest/v1/vic_v3_conversations?contact=eq.${fono}&select=id&limit=5`,
      { headers: H, cache: "no-store" },
    ).then((r) => (r.ok ? r.json() : []))) as Array<{ id: string }>
    if (!convs.length) return { mostrado: false, at: null }
    const ids = convs.map((c) => c.id).join(",")
    const antesMs = Date.parse(String(antesIso || ""))
    const filtroAntes = Number.isFinite(antesMs) ? `&at=lt.${encodeURIComponent(new Date(antesMs).toISOString())}` : ""
    const rows = (await fetch(
      `${SUPABASE_URL}/rest/v1/vic_v3_messages?conversation_id=in.(${ids})&role=eq.assistant` +
        `&or=(content.ilike.*Resumen%20mensual*,content.ilike.*Total%20mensual%20con%20IVA*,content.ilike.*UF%20%2B%20IVA%20al%20mes*)` +
        `${filtroAntes}&select=at&order=at.asc&limit=1`,
      { headers: H, cache: "no-store" },
    ).then((r) => (r.ok ? r.json() : []))) as Array<{ at: string }>
    return rows.length ? { mostrado: true, at: rows[0].at } : { mostrado: false, at: null }
  } catch {
    // Fail-closed: sin lectura no se inventa atribución.
    return { mostrado: false, at: null }
  }
}

export type Atribucion = { deVicky: boolean; motivo: string }

/**
 * Veredicto para UNA cotización pagada. `canalEjecutivo` ya calculado por el
 * caller (evita releer Zoho). Fail-closed: si no se puede verificar la
 * atribución, la venta queda como del ejecutivo — que es la conducta que ya
 * existía.
 */
export async function ventaEsDeVicky(
  quoteId: string,
  canalEjecutivo: boolean,
): Promise<Atribucion> {
  if (!canalEjecutivo) return { deVicky: true, motivo: "emitida por Vicky" }
  try {
    const { getZohoAccessToken } = await import("./zoho-token")
    const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
    const mod = (process.env.ZOHO_QUOTE_MODULE || "Cotizaciones_GeoVictoria").trim()
    const token = await getZohoAccessToken()
    const H = { Authorization: `Zoho-oauthtoken ${token}` }
    const r = await fetch(
      `${api}/crm/v3/${mod}/${quoteId}?fields=Deal_Asociado,Tel_fono_Contacto,Created_Time`,
      { headers: H, cache: "no-store" },
    )
    if (r.status !== 200) return { deVicky: false, motivo: "no verificable" }
    const q = ((await r.json().catch(() => ({}))) as {
      data?: Array<{ Deal_Asociado?: { id?: string } | null; Tel_fono_Contacto?: string | null; Created_Time?: string }>
    }).data?.[0]
    if (!q) return { deVicky: false, motivo: "no verificable" }
    const tel = String(q.Tel_fono_Contacto || "").replace(/\D/g, "").replace(/^5656/, "56")
    const nueve = tel.slice(-9)
    const dealId = q.Deal_Asociado?.id || ""
    const creada = String(q.Created_Time || "").slice(0, 19) + "+00:00"

    // (a) REEMISIÓN: cotización 100% Vicky anterior, mismo deal O teléfono.
    // OJO COQL: con 3+ condiciones la forma que acepta es ((A and B) and C).
    if (dealId || nueve) {
      const donde = dealId && nueve
        ? `(Deal_Asociado = '${dealId}' or Tel_fono_Contacto like '%${nueve}%')`
        : dealId
          ? `Deal_Asociado = '${dealId}'`
          : `Tel_fono_Contacto like '%${nueve}%'`
      const coql = `select id from ${mod} where ((${donde} and Intervenci_n_Humana = '100% Vicky') and Created_Time < '${creada}') limit 1`
      const rr = await fetch(`${api}/crm/v3/coql`, {
        method: "POST",
        headers: { ...H, "Content-Type": "application/json" },
        body: JSON.stringify({ select_query: coql }),
        cache: "no-store",
      })
      if (rr.status === 200) {
        const filas = ((await rr.json().catch(() => ({}))) as { data?: Array<{ id: string }> }).data || []
        if (filas.length) return { deVicky: true, motivo: `reemisión sobre ${filas[0].id}` }
      }
    }

    // (b) CASO C: Vicky mostró precio en el chat antes de la emisión.
    if (nueve) {
      const p = await precioMostradoPorVicky(tel, q.Created_Time)
      if (p.mostrado) return { deVicky: true, motivo: `precio mostrado ${String(p.at).slice(0, 10)}` }
    }
    return { deVicky: false, motivo: "canal ejecutivo sin atribución" }
  } catch {
    return { deVicky: false, motivo: "no verificable" }
  }
}
