/**
 * UNIVERSO DE VENTAS DE VICKY (Chile) — la misma lista que usa el informe
 * `vic-admin-ventas-vicky`, extraída para que el pase de re-etiquetado
 * (definición de Victoria Luna, 16-sep) trabaje sobre EXACTAMENTE las mismas
 * ventas y no sobre otra cuenta.
 *
 *   · VENTA = cotización con Estado_Cotizacion "Pagada".
 *   · DE VICKY = el teléfono conversó con Vicky Y la cotización le corresponde
 *     por la regla de atribución (Lalo 08/09-sep): emitida por Vicky,
 *     reemisión del ejecutivo sobre una de Vicky (mismo deal o teléfono), o
 *     precio mostrado por Vicky antes de la emisión ejecutiva.
 *   · MONTOS = los de la Caja (vic_kv `venta_dash_v3_`).
 *   · Solo CHILE.
 */
import { getZohoAccessToken } from "./zoho-token"

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const QUOTE_MODULE = (process.env.QUOTE_MODULE || "Cotizaciones_GeoVictoria").trim()
const digits = (s: unknown): string => String(s ?? "").replace(/\D/g, "")

export type QuoteRow = {
  id?: string
  Numero_Cotizacion?: string
  Name?: string
  Tel_fono_Contacto?: string | null
  Fecha_Hora_Cotizacion?: string | null
  Created_Time?: string
  Intervenci_n_Humana?: string | null
  "Deal_Asociado.id"?: string | null
  "Deal_Asociado.Deal_Name"?: string | null
}

export type Caja = { montoClp?: number; recurrenteClp?: number; unicoClp?: number; pagoIso?: string; empresa?: string }

export type Atribucion = "vicky" | "reemision" | "precio_mostrado" | "ejecutivo"

export type VentaVicky = {
  quoteId: string
  numero: string
  empresa: string
  tel: string
  dealId: string
  dealNombre: string
  /** Fecha del pago (Caja) o de la aceptación, ms. */
  fechaMs: number
  fechaIso: string
  atribucion: Atribucion
  caja: Caja | null
}

export type UniversoVentas = {
  universo: VentaVicky[]
  pagadasLeidas: number
  excluidas: { fueraDeChile: number; sinConversacionConVicky: number; canalEjecutivoSinAtribucion: number; canalEjecutivoDetalle: string[] }
}

export async function universoVentasVicky(opts: { desde?: string } = {}): Promise<UniversoVentas | null> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null
  const token = await getZohoAccessToken().catch(() => "")
  if (!token) return null
  const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
  const H = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }
  const h = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  const desde = (opts.desde || "2026-01-01").trim()

  // 1) Todas las cotizaciones PAGADAS.
  const pagadas: QuoteRow[] = []
  for (let off = 0; off < 2000; off += 200) {
    const r = await fetch(`${api}/crm/v3/coql`, {
      method: "POST", headers: H, cache: "no-store",
      body: JSON.stringify({
        select_query:
          `select id, Numero_Cotizacion, Name, Tel_fono_Contacto, Fecha_Hora_Cotizacion, Created_Time, Intervenci_n_Humana, Deal_Asociado.id, Deal_Asociado.Deal_Name ` +
          `from ${QUOTE_MODULE} where Estado_Cotizacion = 'Pagada' order by Created_Time desc limit ${off}, 200`,
      }),
    }).catch(() => null)
    if (!r?.ok || r.status === 204) break
    const lote = ((await r.json().catch(() => ({}))) as { data?: QuoteRow[] }).data || []
    pagadas.push(...lote)
    if (lote.length < 200) break
  }

  // 2) Caja por cotización.
  const caja = new Map<string, Caja>()
  const ids = pagadas.map((q) => String(q.id || "")).filter(Boolean)
  for (let i = 0; i < ids.length; i += 80) {
    const keys = ids.slice(i, i + 80).map((x) => `"venta_dash_v3_${x}"`).join(",")
    const r = await fetch(`${SUPABASE_URL}/rest/v1/vic_kv?key=in.(${keys})&select=key,value`, { headers: h, cache: "no-store" }).catch(() => null)
    if (!r?.ok) continue
    for (const row of ((await r.json().catch(() => [])) as Array<{ key: string; value: string }>) || []) {
      try { caja.set(String(row.key).replace(/^venta_dash_v3_/, ""), JSON.parse(String(row.value || "{}"))) } catch { /* corrupta */ }
    }
  }

  // 3) ¿Conversó con Vicky?
  const tels = [...new Set(pagadas.map((q) => digits(q.Tel_fono_Contacto)).filter((t) => t.length >= 9))]
  const conChat = new Set<string>()
  for (let i = 0; i < tels.length; i += 100) {
    const lista = tels.slice(i, i + 100).map((t) => `"${t}"`).join(",")
    const r = await fetch(`${SUPABASE_URL}/rest/v1/vic_v3_conversations?contact=in.(${lista})&select=contact`, { headers: h, cache: "no-store" }).catch(() => null)
    if (!r?.ok) continue
    for (const c of ((await r.json().catch(() => [])) as Array<{ contact: string }>) || []) conChat.add(digits(c.contact))
  }

  // 3-bis) Regla de atribución.
  const vickyPorDeal = new Map<string, number>()
  const vickyPorTel = new Map<string, number>()
  for (let off = 0; off < 2000; off += 200) {
    const r = await fetch(`${api}/crm/v3/coql`, {
      method: "POST", headers: H, cache: "no-store",
      body: JSON.stringify({
        select_query:
          `select id, Tel_fono_Contacto, Created_Time, Deal_Asociado.id from ${QUOTE_MODULE} ` +
          `where Intervenci_n_Humana = '100% Vicky' order by Created_Time desc limit ${off}, 200`,
      }),
    }).catch(() => null)
    if (!r?.ok || r.status === 204) break
    const lote = ((await r.json().catch(() => ({}))) as { data?: QuoteRow[] }).data || []
    for (const q of lote) {
      const ms = Date.parse(String(q.Created_Time || ""))
      if (!Number.isFinite(ms)) continue
      const d = String(q["Deal_Asociado.id"] || "")
      const t = digits(q.Tel_fono_Contacto)
      if (d && ms < (vickyPorDeal.get(d) ?? Infinity)) vickyPorDeal.set(d, ms)
      if (t && ms < (vickyPorTel.get(t) ?? Infinity)) vickyPorTel.set(t, ms)
    }
    if (lote.length < 200) break
  }
  const FIRMAS = ["Resumen mensual", "Total mensual con IVA", "UF + IVA al mes", "Total mensual"]
  const orFirmas = FIRMAS.map((f) => `content.ilike.*${encodeURIComponent(f)}*`).join(",")
  const primerPrecio = new Map<string, number>()
  {
    const porConv = new Map<string, number>()
    for (let p = 0; p < 5; p++) {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/vic_v3_messages?role=eq.assistant&or=(${orFirmas})&select=conversation_id,at&order=at.asc&limit=1000&offset=${p * 1000}`,
        { headers: h, cache: "no-store" },
      ).catch(() => null)
      if (!r?.ok) break
      const lote = ((await r.json().catch(() => [])) as Array<{ conversation_id?: string; at?: string }>) || []
      for (const f of lote) {
        const ms = Date.parse(String(f.at || ""))
        const cid = String(f.conversation_id || "")
        if (cid && Number.isFinite(ms) && ms < (porConv.get(cid) ?? Infinity)) porConv.set(cid, ms)
      }
      if (lote.length < 1000) break
    }
    const cids = [...porConv.keys()]
    for (let i = 0; i < cids.length; i += 200) {
      const lote = cids.slice(i, i + 200).map((x) => `"${x}"`).join(",")
      const r = await fetch(`${SUPABASE_URL}/rest/v1/vic_v3_conversations?id=in.(${lote})&select=id,contact`, { headers: h, cache: "no-store" }).catch(() => null)
      if (!r?.ok) continue
      for (const c of ((await r.json().catch(() => [])) as Array<{ id: string; contact: string }>) || []) {
        const tel = digits(c.contact)
        const ms = porConv.get(String(c.id)) ?? Infinity
        if (tel && Number.isFinite(ms) && ms < (primerPrecio.get(tel) ?? Infinity)) primerPrecio.set(tel, ms)
      }
    }
  }
  const atribucion = (q: QuoteRow): Atribucion => {
    if (/100%/.test(String(q.Intervenci_n_Humana || ""))) return "vicky"
    const ms = Date.parse(String(q.Created_Time || q.Fecha_Hora_Cotizacion || ""))
    const tel = digits(q.Tel_fono_Contacto)
    const d = String(q["Deal_Asociado.id"] || "")
    const antesVicky = Math.min(d ? (vickyPorDeal.get(d) ?? Infinity) : Infinity, tel ? (vickyPorTel.get(tel) ?? Infinity) : Infinity)
    if (Number.isFinite(ms) && antesVicky < ms) return "reemision"
    const pp = tel ? (primerPrecio.get(tel) ?? Infinity) : Infinity
    if (Number.isFinite(ms) && pp < ms) return "precio_mostrado"
    return "ejecutivo"
  }

  // 4) Filtro.
  const desdeMs = Date.parse(`${desde}T00:00:00Z`)
  const excluidas = { fueraDeChile: 0, sinConversacionConVicky: 0, canalEjecutivoSinAtribucion: 0, canalEjecutivoDetalle: [] as string[] }
  const universo: VentaVicky[] = []
  for (const q of pagadas) {
    const tel = digits(q.Tel_fono_Contacto)
    const id = String(q.id || "")
    const c = caja.get(id) || null
    const fechaIso = String(c?.pagoIso || q.Fecha_Hora_Cotizacion || q.Created_Time || "")
    const ms = Date.parse(fechaIso)
    if (Number.isFinite(desdeMs) && Number.isFinite(ms) && ms < desdeMs) continue
    if (!tel.startsWith("56")) { excluidas.fueraDeChile++; continue }
    if (!conChat.has(tel)) { excluidas.sinConversacionConVicky++; continue }
    const a = atribucion(q)
    if (a === "ejecutivo") {
      excluidas.canalEjecutivoSinAtribucion++
      if (excluidas.canalEjecutivoDetalle.length < 40) excluidas.canalEjecutivoDetalle.push(q.Numero_Cotizacion || id)
      continue
    }
    universo.push({
      quoteId: id,
      numero: q.Numero_Cotizacion || id,
      empresa: String(c?.empresa || q["Deal_Asociado.Deal_Name"] || q.Name || "").replace(/ - Cotización Vicky$/i, ""),
      tel,
      dealId: String(q["Deal_Asociado.id"] || ""),
      dealNombre: String(q["Deal_Asociado.Deal_Name"] || ""),
      fechaMs: ms,
      fechaIso,
      atribucion: a,
      caja: c,
    })
  }
  universo.sort((a, b) => a.fechaMs - b.fechaMs)
  return { universo, pagadasLeidas: pagadas.length, excluidas }
}
