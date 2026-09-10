/**
 * ADMIN — VENTAS DE VICKY EN CLP, partidas en AUTÓNOMA y ASISTIDA
 * (pregunta de Lalo 10-sep: "cuántas ventas tiene Vicky en CLP… pagado, o
 * autónomo o asistido").
 *
 * Definiciones, las mismas que ya usan el dash y el cierre diario:
 *   · VENTA = cotización con Estado_Cotizacion "Pagada".
 *   · DE VICKY = el teléfono conversó con Vicky (mismo criterio del dash, que
 *     rescata las reactivadas de meses anteriores).
 *   · AUTÓNOMA / ASISTIDA = actividad del equipo de TELEMARKETING (lib/
 *     gestion-venta + lib/gestion-ventas-datos). Aleydis y Aracelli son SDR:
 *     su gestión es postventa y NO hace asistida una venta.
 *   · MONTOS = los de la Caja (vic_kv `venta_dash_v3_`): `montoClp` es el pago
 *     inicial COBRADO, `recurrenteClp` el MRR y `unicoClp` los pagos únicos.
 *
 * Solo CHILE: en CO/MX/PE los montos viven en los mismos campos pero en su
 * moneda, y sumarlos daría un número falso. Las excluidas se declaran.
 *
 * GET ?key=<cron>[&maxZoho=60][&desde=2026-01-01]
 * El tope de lecturas de Zoho por llamada deja ventas en "sd": la caché es
 * compartida con el dash, así que repetir la llamada completa el cuadro.
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret, getKvValue } from "@/lib/supabase-persistence-v3"
import { getZohoAccessToken } from "@/lib/zoho-token"
import { gestionDeVentas } from "@/lib/gestion-ventas-datos"
import type { GestionVenta } from "@/lib/gestion-venta"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const QUOTE_MODULE = (process.env.QUOTE_MODULE || "Cotizaciones_GeoVictoria").trim()

async function autorizado(req: Request): Promise<boolean> {
  const secreto = await getFollowupCronSecret().catch(() => "")
  const cron = (process.env.CRON_SECRET || "").trim()
  const auth = req.headers.get("authorization") || ""
  const url = new URL(req.url)
  const entregado =
    req.headers.get("x-cron-secret") || (auth.startsWith("Bearer ") ? auth.slice(7) : "") || url.searchParams.get("key") || ""
  return Boolean(entregado) && (entregado === secreto || (Boolean(cron) && entregado === cron))
}

type Q = {
  id?: string
  Numero_Cotizacion?: string
  Name?: string
  Tel_fono_Contacto?: string | null
  Fecha_Hora_Cotizacion?: string | null
  Created_Time?: string
  Intervenci_n_Humana?: string | null
  "Deal_Asociado.id"?: string | null
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  if (!SUPABASE_URL || !SUPABASE_KEY) return NextResponse.json({ ok: false, error: "sin supabase" }, { status: 503 })
  const sp = new URL(req.url).searchParams
  const desde = (sp.get("desde") || "2026-01-01").trim()
  const maxZoho = Math.min(120, Math.max(0, Number(sp.get("maxZoho") || 60)))
  const token = await getZohoAccessToken().catch(() => "")
  if (!token) return NextResponse.json({ ok: false, error: "sin token zoho" }, { status: 502 })
  const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
  const H = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }
  const h = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }

  // 1) Todas las cotizaciones PAGADAS (paginadas de 200 en 200).
  const pagadas: Q[] = []
  for (let off = 0; off < 2000; off += 200) {
    const r = await fetch(`${api}/crm/v3/coql`, {
      method: "POST", headers: H, cache: "no-store",
      body: JSON.stringify({
        select_query:
          `select id, Numero_Cotizacion, Name, Tel_fono_Contacto, Fecha_Hora_Cotizacion, Created_Time, Intervenci_n_Humana, Deal_Asociado.id ` +
          `from ${QUOTE_MODULE} where Estado_Cotizacion = 'Pagada' order by Created_Time desc limit ${off}, 200`,
      }),
    }).catch(() => null)
    if (!r?.ok || r.status === 204) break
    const lote = ((await r.json().catch(() => ({}))) as { data?: Q[] }).data || []
    pagadas.push(...lote)
    if (lote.length < 200) break
  }

  // 2) Montos de la Caja por cotización.
  type Caja = { montoClp?: number; recurrenteClp?: number; unicoClp?: number; pagoIso?: string; empresa?: string }
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

  // 3) ¿Conversó con Vicky? (criterio del dash) — por lotes de teléfonos.
  const tels = [...new Set(pagadas.map((q) => String(q.Tel_fono_Contacto || "").replace(/\D/g, "")).filter((t) => t.length >= 9))]
  const conChat = new Set<string>()
  for (let i = 0; i < tels.length; i += 100) {
    const lista = tels.slice(i, i + 100).map((t) => `"${t}"`).join(",")
    const r = await fetch(`${SUPABASE_URL}/rest/v1/vic_v3_conversations?contact=in.(${lista})&select=contact`, { headers: h, cache: "no-store" }).catch(() => null)
    if (!r?.ok) continue
    for (const c of ((await r.json().catch(() => [])) as Array<{ contact: string }>) || []) conChat.add(String(c.contact || "").replace(/\D/g, ""))
  }

  // 4) Universo: pagadas de Vicky, en Chile y desde la fecha pedida.
  const desdeMs = Date.parse(`${desde}T00:00:00Z`)
  let fueraDeChile = 0
  let sinConversacion = 0
  let sinMontoEnCaja = 0
  const universo = pagadas.filter((q) => {
    const tel = String(q.Tel_fono_Contacto || "").replace(/\D/g, "")
    const c = caja.get(String(q.id || ""))
    const ms = Date.parse(String(c?.pagoIso || q.Fecha_Hora_Cotizacion || q.Created_Time || ""))
    if (Number.isFinite(desdeMs) && Number.isFinite(ms) && ms < desdeMs) return false
    if (!tel.startsWith("56")) { fueraDeChile++; return false }
    if (!conChat.has(tel)) { sinConversacion++; return false }
    return true
  })

  const gestion = await gestionDeVentas(
    universo.map((q) => {
      const c = caja.get(String(q.id || ""))
      return {
        quoteId: String(q.id || ""),
        tel: String(q.Tel_fono_Contacto || "").replace(/\D/g, ""),
        dealId: String(q["Deal_Asociado.id"] || ""),
        fechaMs: Date.parse(String(c?.pagoIso || q.Fecha_Hora_Cotizacion || q.Created_Time || "")),
      }
    }),
    { maxZoho },
  ).catch(() => new Map<string, GestionVenta>())

  const cero = () => ({ ventas: 0, cobradoClp: 0, mrrClp: 0, unicoClp: 0 })
  const tot = { autonoma: cero(), asistida: cero(), sd: cero() }
  const porMes = new Map<string, { autonoma: number; asistida: number; sd: number }>()
  const detalleSd: string[] = []
  for (const q of universo) {
    const id = String(q.id || "")
    const c = caja.get(id)
    if (!c) { sinMontoEnCaja++; continue }
    const g = (gestion.get(id) || "sd") as GestionVenta
    const b = tot[g]
    b.ventas++
    b.cobradoClp += Number(c.montoClp || 0) || 0
    b.mrrClp += Number(c.recurrenteClp || 0) || 0
    b.unicoClp += Number(c.unicoClp || 0) || 0
    const mes = String(c.pagoIso || q.Fecha_Hora_Cotizacion || "").slice(0, 7)
    const m = porMes.get(mes) || { autonoma: 0, asistida: 0, sd: 0 }
    m[g] += Number(c.montoClp || 0) || 0
    porMes.set(mes, m)
    if (g === "sd" && detalleSd.length < 25) detalleSd.push(`${q.Numero_Cotizacion || id}`)
  }

  const suma = (k: "ventas" | "cobradoClp" | "mrrClp" | "unicoClp") => tot.autonoma[k] + tot.asistida[k] + tot.sd[k]
  return NextResponse.json({
    ok: true,
    desde,
    definiciones: {
      venta: "cotización Pagada",
      deVicky: "el teléfono conversó con Vicky (criterio del dash)",
      autonoma: "sin actividad del equipo de telemarketing, aunque haya traspaso; las SDR son postventa",
      montos: "cobradoClp = pago inicial cobrado · mrrClp = recurrente mensual · unicoClp = pagos únicos",
      soloChile: true,
    },
    total: { ventas: suma("ventas"), cobradoClp: suma("cobradoClp"), mrrClp: suma("mrrClp"), unicoClp: suma("unicoClp") },
    autonoma: tot.autonoma,
    asistida: tot.asistida,
    sinClasificar: tot.sd,
    porMesCobradoClp: Object.fromEntries([...porMes.entries()].sort()),
    excluidas: { fueraDeChile, sinConversacionConVicky: sinConversacion, sinMontoEnLaCaja: sinMontoEnCaja },
    pagadasLeidas: pagadas.length,
    sinClasificarDetalle: detalleSd,
    kvMuestra: (await getKvValue(`venta_dash_v3_${ids[0] || ""}`).catch(() => null)) ? "ok" : "sin muestra",
  })
}
