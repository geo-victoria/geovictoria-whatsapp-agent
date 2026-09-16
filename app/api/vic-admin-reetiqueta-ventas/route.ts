/**
 * ADMIN — PASE EN SECO DE RE-ETIQUETADO autónoma/asistida con la DEFINICIÓN
 * DE VICTORIA LUNA (correo 16-sep) y las cuatro decisiones de Lalo (SDR fuera,
 * evidencia anterior al pago con margen de 24 h para notas, mínimo de nota =
 * fecha/canal + resumen + gestión, desde el 17-ago).
 *
 * SOLO LECTURA sobre Zoho y el dash: por cada venta del universo de Vicky
 * (lib/ventas-vicky-universo, el mismo del informe en CLP) lee notas, llamadas
 * y reuniones del deal, evalúa cada nota humana con la rúbrica
 * (lib/nota-rubrica: determinista + Haiku, cacheada por nota) y clasifica con
 * la regla pura lib/gestion-venta-v3. Devuelve fila por venta con el
 * veredicto ACTUAL (criterio del 10-sep, el que hoy pinta el dash), el NUEVO y
 * la evidencia que lo sostiene o lo descarta. Persiste el veredicto nuevo en
 * vic_kv `venta_gestion_v3_<quoteId>` para que el pase sea repetible y para
 * que, cuando Lalo lo apruebe, dash y correo lo lean de ahí.
 *
 * El espejo NO decide (pedido de Victoria): aparece solo como auditoría
 * ("espejo dice…") para ver dónde la nueva regla y el WhatsApp del ejecutivo
 * no coinciden.
 *
 * GET ?key=<cron>[&desde=2026-08-17][&offset=0][&max=40][&csv=1][&refrescar=1]
 * Presupuesto 250 s: el pase completo se corre en 2-3 llamadas con offset.
 */
import { NextResponse } from "next/server"
import { getFollowupCronSecret, getKvValue, setKvValue } from "@/lib/supabase-persistence-v3"
import { getZohoAccessToken } from "@/lib/zoho-token"
import { universoVentasVicky, type VentaVicky } from "@/lib/ventas-vicky-universo"
import { gestionDeVentas } from "@/lib/gestion-ventas-datos"
import { rosterTelemarketing } from "@/lib/gestion-venta"
import { clasificarGestionV3, type NotaEvidencia, type LlamadaEvidencia, type ReunionEvidencia, type ResultadoV3 } from "@/lib/gestion-venta-v3"
import { evaluarNota, VERSION_RUBRICA } from "@/lib/nota-rubrica"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const PRESUPUESTO_MS = 250_000
const claveV3 = (quoteId: string): string => `venta_gestion_v3_${quoteId}`

async function autorizado(req: Request): Promise<boolean> {
  const secreto = await getFollowupCronSecret().catch(() => "")
  const cron = (process.env.CRON_SECRET || "").trim()
  const url = new URL(req.url)
  const dado = req.headers.get("x-cron-secret") || url.searchParams.get("key") || ""
  return Boolean(dado) && (dado === secreto || (Boolean(cron) && dado === cron))
}

type NotaZoho = { id?: string; Note_Title?: string | null; Note_Content?: string | null; Created_Time?: string; Created_By?: { id?: string; name?: string } | null }
type CallZoho = { id?: string; Call_Type?: string | null; Call_Start_Time?: string | null; Call_Duration?: string | null; Owner?: { id?: string; name?: string } | null }
type EventZoho = { id?: string; Event_Title?: string | null; Start_DateTime?: string | null; Owner?: { id?: string; name?: string } | null }

/** "mm:ss" · "hh:mm:ss" · segundos sueltos → segundos. */
function duracionSeg(v: unknown): number {
  const s = String(v ?? "").trim()
  if (!s) return 0
  if (/^\d+$/.test(s)) return Number(s)
  const partes = s.split(":").map((x) => Number(x))
  if (partes.some((x) => !Number.isFinite(x))) return 0
  return partes.reduce((acc, x) => acc * 60 + x, 0)
}

type Fila = {
  numero: string
  quoteId: string
  empresa: string
  tel: string
  dealId: string
  fechaPago: string
  atribucion: string
  cobradoClp: number
  mrrClp: number
  actual: string
  nuevo: string
  motivo: string
  evidencia: string[]
  descartada: string[]
  notasHumanas: number
  notasEspejo: number
  llamadas: number
  reuniones: number
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  const t0 = Date.now()
  const sp = new URL(req.url).searchParams
  const desde = (sp.get("desde") || "2026-08-17").trim()
  const offset = Math.max(0, Number(sp.get("offset") || 0) || 0)
  const max = Math.min(120, Math.max(1, Number(sp.get("max") || 40) || 40))
  const refrescar = sp.get("refrescar") === "1"
  const csv = sp.get("csv") === "1"
  const apiKey = (process.env.ANTHROPIC_API_KEY || "").trim()

  const u = await universoVentasVicky({ desde })
  if (!u) return NextResponse.json({ ok: false, error: "sin supabase o sin token zoho" }, { status: 503 })
  const lote: VentaVicky[] = u.universo.slice(offset, offset + max)

  // Veredicto ACTUAL (criterio 10-sep, el del dash) desde su propia caché/espejo.
  const actual = await gestionDeVentas(
    lote.map((v) => ({ quoteId: v.quoteId, tel: v.tel, dealId: v.dealId, fechaMs: v.fechaMs })),
    { maxZoho: 20 },
  ).catch(() => new Map<string, string>())

  const token = await getZohoAccessToken().catch(() => "")
  const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
  const H = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }
  const roster = rosterTelemarketing()
  const rosterIds = new Set(roster.map((r) => r.id).filter(Boolean))
  const nombreDe = (id: string, fallback?: string): string => roster.find((r) => r.id === id)?.nombre || fallback || id

  const coql = async (q: string): Promise<Array<Record<string, unknown>>> => {
    const r = await fetch(`${api}/crm/v3/coql`, { method: "POST", headers: H, cache: "no-store", body: JSON.stringify({ select_query: q }) }).catch(() => null)
    if (!r || r.status === 204) return []
    if (!r.ok) { console.error("[reetiqueta] COQL", r.status, q.slice(0, 120)); return [] }
    return (((await r.json().catch(() => ({}))) as { data?: Array<Record<string, unknown>> }).data) || []
  }

  const filas: Fila[] = []
  let truncado = false
  let notasEvaluadasModelo = 0
  let desdeCache = 0
  for (const v of lote) {
    if (Date.now() - t0 > PRESUPUESTO_MS) { truncado = true; break }
    const base = {
      numero: v.numero, quoteId: v.quoteId, empresa: v.empresa, tel: v.tel, dealId: v.dealId,
      fechaPago: v.fechaIso.slice(0, 16).replace("T", " "), atribucion: v.atribucion,
      cobradoClp: Number(v.caja?.montoClp || 0) || 0, mrrClp: Number(v.caja?.recurrenteClp || 0) || 0,
      actual: String(actual.get(v.quoteId) || "sd"),
    }
    if (!v.dealId) {
      filas.push({ ...base, nuevo: "sd", motivo: "sin deal asociado", evidencia: [], descartada: [], notasHumanas: 0, notasEspejo: 0, llamadas: 0, reuniones: 0 })
      continue
    }
    if (!refrescar) {
      const c = await getKvValue(claveV3(v.quoteId)).catch(() => null)
      if (c) {
        try {
          const j = JSON.parse(c) as ResultadoV3 & { notasHumanas?: number; notasEspejo?: number; llamadas?: number; reuniones?: number; rubrica?: string }
          if (j?.veredicto && j.rubrica === VERSION_RUBRICA) {
            desdeCache++
            filas.push({ ...base, nuevo: j.veredicto, motivo: j.motivo, evidencia: j.evidencia || [], descartada: j.descartada || [], notasHumanas: j.notasHumanas || 0, notasEspejo: j.notasEspejo || 0, llamadas: j.llamadas || 0, reuniones: j.reuniones || 0 })
            continue
          }
        } catch { /* recalcula */ }
      }
    }
    // Notas del deal (contenido completo).
    const rn = await fetch(`${api}/crm/v3/Deals/${v.dealId}/Notes?fields=Note_Title,Note_Content,Created_By,Created_Time&per_page=100`, { headers: H, cache: "no-store" }).catch(() => null)
    const notasZ: NotaZoho[] = rn?.ok ? (((await rn.json().catch(() => ({}))) as { data?: NotaZoho[] }).data || []) : []
    const notas: NotaEvidencia[] = []
    let notasHumanas = 0
    let notasEspejo = 0
    for (const n of notasZ) {
      const titulo = String(n.Note_Title || "")
      const autorId = String(n.Created_By?.id || "")
      const creadaMs = Date.parse(String(n.Created_Time || ""))
      const esEspejo = /\(espejo/i.test(titulo)
      if (esEspejo) { notasEspejo++; notas.push({ id: String(n.id || ""), autorId, autorNombre: "espejo", creadaMs, esEspejo: true, rubrica: null }); continue }
      if (!rosterIds.has(autorId)) { notas.push({ id: String(n.id || ""), autorId, autorNombre: n.Created_By?.name || undefined, creadaMs, esEspejo: false, rubrica: null }); continue }
      notasHumanas++
      const contenido = `${titulo}\n${String(n.Note_Content || "")}`.trim()
      const rubrica = await evaluarNota(String(n.id || ""), contenido, apiKey)
      if (rubrica && !/^(sgto|segui)/i.test(contenido) && contenido.length >= 12) notasEvaluadasModelo++
      notas.push({ id: String(n.id || ""), autorId, autorNombre: nombreDe(autorId, n.Created_By?.name || undefined), creadaMs, esEspejo: false, rubrica, extracto: contenido.replace(/\s+/g, " ").slice(0, 110) })
    }
    // Llamadas y reuniones colgadas del deal.
    const [calls, events] = await Promise.all([
      coql(`select id, Call_Type, Call_Start_Time, Call_Duration, Owner from Calls where What_Id = '${v.dealId}' limit 50`),
      coql(`select id, Event_Title, Start_DateTime, Owner from Events where What_Id = '${v.dealId}' limit 50`),
    ])
    const llamadas: LlamadaEvidencia[] = (calls as CallZoho[]).map((c) => ({
      id: String(c.id || ""), ownerId: String(c.Owner?.id || ""), inicioMs: Date.parse(String(c.Call_Start_Time || "")),
      duracionSeg: duracionSeg(c.Call_Duration), tipo: c.Call_Type || undefined,
    }))
    const reuniones: ReunionEvidencia[] = (events as EventZoho[]).map((e) => ({
      id: String(e.id || ""), ownerId: String(e.Owner?.id || ""), inicioMs: Date.parse(String(e.Start_DateTime || "")), titulo: e.Event_Title || undefined,
    }))
    const res = clasificarGestionV3({ pagoMs: v.fechaMs, notas, llamadas, reuniones, rosterIds })
    filas.push({ ...base, nuevo: res.veredicto, motivo: res.motivo, evidencia: res.evidencia, descartada: res.descartada, notasHumanas, notasEspejo, llamadas: llamadas.length, reuniones: reuniones.length })
    await setKvValue(claveV3(v.quoteId), JSON.stringify({ ...res, notasHumanas, notasEspejo, llamadas: llamadas.length, reuniones: reuniones.length, rubrica: VERSION_RUBRICA, at: new Date().toISOString() })).catch(() => null)
  }

  const cuenta = (k: "actual" | "nuevo") => {
    const m: Record<string, number> = {}
    for (const f of filas) m[f[k]] = (m[f[k]] || 0) + 1
    return m
  }
  const cambios = filas.filter((f) => f.actual !== f.nuevo)
  const transiciones: Record<string, number> = {}
  for (const f of cambios) transiciones[`${f.actual}→${f.nuevo}`] = (transiciones[`${f.actual}→${f.nuevo}`] || 0) + 1

  if (csv) {
    const esc = (s: unknown) => `"${String(s ?? "").replace(/"/g, '""')}"`
    const cab = ["numero", "empresa", "fechaPago", "atribucion", "cobradoClp", "mrrClp", "actual", "nuevo", "motivo", "evidencia", "descartada", "notasHumanas", "notasEspejo", "llamadas", "reuniones", "dealId"]
    const body = [cab.join(",")].concat(filas.map((f) => [f.numero, f.empresa, f.fechaPago, f.atribucion, f.cobradoClp, f.mrrClp, f.actual, f.nuevo, f.motivo, f.evidencia.join(" | "), f.descartada.join(" | "), f.notasHumanas, f.notasEspejo, f.llamadas, f.reuniones, f.dealId].map(esc).join(","))).join("\n")
    return new NextResponse(body, { headers: { "Content-Type": "text/csv; charset=utf-8" } })
  }
  return NextResponse.json({
    ok: true,
    desde,
    definicion: {
      asistida: "interacción bidireccional (respuesta del cliente, llamada contestada o reunión) + gestión documentada por TELEMARKETING antes del pago; nota mínima = fecha/canal + resumen + gestión; notas hasta 24 h después del pago si describen algo anterior",
      autonoma: "sin gestión, o solo intentos sin respuesta; las SDR y todo lo posterior al pago son postventa",
      revisar: "hay interacción comprobable sin nota que documente la gestión, o al revés",
      espejo: "NO decide (pedido de Victoria); el veredicto 'actual' es el del criterio vigente del dash (10-sep), que sí lo usa",
    },
    universo: u.universo.length,
    rango: { offset, max, procesadas: filas.length, truncado, siguienteOffset: offset + filas.length < u.universo.length ? offset + filas.length : null },
    resumen: { actual: cuenta("actual"), nuevo: cuenta("nuevo"), cambian: cambios.length, transiciones },
    desdeCache,
    notasEvaluadasModelo,
    excluidas: u.excluidas,
    filas,
    ms: Date.now() - t0,
  })
}
