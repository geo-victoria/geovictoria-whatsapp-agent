/**
 * Dashboard de embudo (Sankey) de las conversaciones de Vicky V3.
 *
 * GET /api/vic-funnel?key=<VIC_FUNNEL_KEY>
 *
 * Página HTML en vivo (Sankey con Plotly + KPIs + hallazgos). Lee la tabla
 * vic_v3_conversation_analysis, que puebla el cron /api/vic-funnel-cron cada
 * hora con la clasificación semántica (Claude). Jerarquía:
 *
 *   Conversaciones
 *     → Intención comercial → { Crosselling, Callback, Reunión, Cotización }
 *                                 Cotización → { Enviada, Fuga, Rechazo, Sin preform }
 *     → Soporte
 *     → No identificado
 */

import { isTestContact } from "@/lib/funnel-analysis"
import { getZohoAccessToken } from "@/lib/zoho-token"

export const dynamic = "force-dynamic"

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const FUNNEL_KEY = (process.env.VIC_FUNNEL_KEY || "").trim()
const QUOTE_MODULE = (process.env.ZOHO_QUOTE_MODULE || "Cotizaciones_GeoVictoria").trim()
const VICKY_CREATOR_ID = (process.env.VICKY_ZOHO_CREATOR_ID || "3525045000484500876").trim()
const ZOHO_API_DOMAIN = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()

// Cotizaciones formales creadas por Vicky en Zoho — fuente de verdad del CIERRE
// (aceptadas/pagadas). Best-effort: si Zoho no responde, la página igual carga y
// la sección de tasa de cierre indica que Zoho no está disponible. Se cuentan
// client-side (son decenas, no miles) para no depender de count() de COQL.
// Este dash es de Vicky CHILE: se excluyen las cotizaciones de conversaciones
// de la línea CO (por id) y los registros de prueba (por nombre).

// ── Ventas cerradas (pedido Lalo 20-jul): tabla con empresa, inicio de la
// conversación, fecha de pago, monto y tiempo a cierre. El monto se calcula
// desde los ítems congelados en Zoho (Subtotal_CLP del día de emisión):
// pago inicial = (Σ recurrentes × (1−dcto) + Σ pago único) × 1.19 — validado
// al peso contra Mercado Pago (COT233/COT242 = $29.163). Como una venta
// pagada es inmutable, cada fila se cachea en vic_kv (venta_dash_v2_<id>).
type RawAceptada = {
  id?: string
  Name?: string
  Numero_Cotizacion?: string
  Estado_Cotizacion?: string
  Intervenci_n_Humana?: string | null
  Fecha_Hora_Cotizacion?: string | null
  Tel_fono_Contacto?: string | null
  Created_Time?: string
  Modified_Time?: string
  Descuento_Recurrente_Pct?: number | null
  "Cuenta_Asociada.Account_Name"?: string | null
}

type VentaCerrada = {
  empresa: string
  numero: string
  inicioIso: string
  inicioAprox: boolean
  pagoIso: string
  montoClp: number
}

async function kvGet(key: string): Promise<string> {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/vic_kv?key=eq.${encodeURIComponent(key)}&select=value&limit=1`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      cache: "no-store",
    })
    const rows = r.ok ? ((await r.json()) as Array<{ value?: string }>) : []
    return rows[0]?.value || ""
  } catch {
    return ""
  }
}

async function kvSet(key: string, value: string): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/vic_kv?on_conflict=key`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({ key, value }),
    cache: "no-store",
  }).catch(() => {})
}

async function construirVentasCerradas(aceptadas: RawAceptada[]): Promise<VentaCerrada[]> {
  const token = await getZohoAccessToken().catch(() => "")
  const ventas: VentaCerrada[] = []
  for (const q of aceptadas) {
    const id = String(q.id || "")
    if (!id) continue
    const cacheKey = `venta_dash_v2_${id}`
    const cached = await kvGet(cacheKey)
    if (cached) {
      try {
        ventas.push(JSON.parse(cached) as VentaCerrada)
        continue
      } catch {
        // caché corrupta → recomputar
      }
    }
    // Monto: ítems del subform (getRecord completo, 1 sola vez por venta).
    let montoClp = 0
    if (token) {
      try {
        const r = await fetch(`${ZOHO_API_DOMAIN}/crm/v3/${QUOTE_MODULE}/${id}`, {
          headers: { Authorization: `Zoho-oauthtoken ${token}` },
          cache: "no-store",
        })
        const body = (await r.json().catch(() => null)) as {
          data?: Array<{
            Descuento_Recurrente_Pct?: number
            Detalle_Items_Cotizacion?: Array<{ Subtotal_CLP?: number; Es_Recurrente?: boolean }>
          }>
        } | null
        const rec = body?.data?.[0]
        const pct = Number(rec?.Descuento_Recurrente_Pct ?? q.Descuento_Recurrente_Pct ?? 0) || 0
        const items = rec?.Detalle_Items_Cotizacion || []
        const recurrente = items.filter((i) => i.Es_Recurrente).reduce((a, i) => a + (Number(i.Subtotal_CLP) || 0), 0)
        const unico = items.filter((i) => !i.Es_Recurrente).reduce((a, i) => a + (Number(i.Subtotal_CLP) || 0), 0)
        montoClp = Math.round((recurrente * (1 - pct / 100) + unico) * 1.19)
      } catch {
        montoClp = 0
      }
    }
    // Inicio de conversación: started_at por teléfono; fallback: creación de la cotización.
    const fono = digits(String(q.Tel_fono_Contacto || ""))
    let inicioIso = ""
    if (fono) {
      try {
        const r = await fetch(
          `${SUPABASE_URL}/rest/v1/vic_v3_conversations?contact=eq.${fono}&select=started_at&order=started_at.asc&limit=1`,
          { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, cache: "no-store" },
        )
        const rows = r.ok ? ((await r.json()) as Array<{ started_at?: string }>) : []
        inicioIso = rows[0]?.started_at || ""
      } catch {
        inicioIso = ""
      }
    }
    const inicioAprox = !inicioIso
    if (!inicioIso) inicioIso = String(q.Created_Time || "")
    const pagoIso = String(q.Fecha_Hora_Cotizacion || q.Modified_Time || "")
    const empresa =
      String(q["Cuenta_Asociada.Account_Name"] || "").trim() ||
      String(q.Name || "").replace(/^Cotización\s+/i, "").replace(/\s+-\s+\d{4}-\d{2}-\d{2}$/, "").trim() ||
      "(sin nombre)"
    const venta: VentaCerrada = {
      empresa,
      numero: String(q.Numero_Cotizacion || ""),
      inicioIso,
      inicioAprox,
      pagoIso,
      montoClp,
    }
    ventas.push(venta)
    if (montoClp > 0 && pagoIso) await kvSet(cacheKey, JSON.stringify(venta))
  }
  return ventas.sort((a, b) => (b.pagoIso || "").localeCompare(a.pagoIso || ""))
}

function fmtSantiago(iso: string): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "—"
  return d.toLocaleString("es-CL", {
    timeZone: "America/Santiago",
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function fmtDuracion(inicioIso: string, pagoIso: string): string {
  const a = new Date(inicioIso).getTime()
  const b = new Date(pagoIso).getTime()
  if (Number.isNaN(a) || Number.isNaN(b) || b <= a) return "—"
  const horasTotales = Math.floor((b - a) / 3600000)
  const dias = Math.floor(horasTotales / 24)
  const horas = horasTotales % 24
  if (dias === 0 && horas === 0) return `${Math.round((b - a) / 60000)} min`
  return dias === 0 ? `${horas}h` : `${dias}d ${horas}h`
}

function fmtDuracionMs(ms: number): string {
  if (!(ms > 0)) return "—"
  const horasTotales = Math.floor(ms / 3600000)
  const dias = Math.floor(horasTotales / 24)
  const horas = horasTotales % 24
  if (dias === 0 && horas === 0) return `${Math.round(ms / 60000)} min`
  return dias === 0 ? `${horas}h` : `${dias}d ${horas}h`
}

function renderVentasCerradas(ventas: VentaCerrada[]): string {
  if (!ventas.length) return ""
  // Tarjetas de tiempos (pedido Lalo 20-jul): promedio y mediana del tiempo
  // inicio de conversación → pago, sobre las ventas con ambas fechas válidas.
  const duraciones = ventas
    .map((v) => new Date(v.pagoIso).getTime() - new Date(v.inicioIso).getTime())
    .filter((ms) => Number.isFinite(ms) && ms > 0)
    .sort((a, b) => a - b)
  let tarjetasTiempos = ""
  if (duraciones.length) {
    const promedio = duraciones.reduce((a, b) => a + b, 0) / duraciones.length
    const mitad = Math.floor(duraciones.length / 2)
    const mediana =
      duraciones.length % 2 ? duraciones[mitad] : (duraciones[mitad - 1] + duraciones[mitad]) / 2
    const masRapida = duraciones[0]
    const masLenta = duraciones[duraciones.length - 1]
    const card = (label: string, value: string, color: string, sub?: string) =>
      `<div class="kpi"><div class="kpi-v" style="color:${color}">${value}</div><div class="kpi-l">${label}${sub ? ` <span class="pct">${sub}</span>` : ""}</div></div>`
    tarjetasTiempos = `<div class="kpis" style="margin-bottom:12px">
      ${card("Tiempo promedio a cierre", fmtDuracionMs(promedio), "#00838F", "inicio conversación → pago")}
      ${card("Mediana", fmtDuracionMs(mediana), "#27ae60", "la mitad de las ventas cierra antes de esto")}
      ${card("Más rápida", fmtDuracionMs(masRapida), "#8e44ad")}
      ${card("Más lenta", fmtDuracionMs(masLenta), "#e67e22")}
    </div>`
  }
  const filas = ventas
    .map(
      (v) => `<tr>
        <td>${v.empresa}${v.numero ? ` <span class="sub" style="display:inline">· ${v.numero}</span>` : ""}</td>
        <td>${fmtSantiago(v.inicioIso)}${v.inicioAprox ? " *" : ""}</td>
        <td>${fmtSantiago(v.pagoIso)}</td>
        <td style="text-align:right">${v.montoClp > 0 ? `$${v.montoClp.toLocaleString("es-CL")}` : "—"}</td>
        <td style="text-align:right"><b>${fmtDuracion(v.inicioIso, v.pagoIso)}</b></td>
      </tr>`,
    )
    .join("")
  const totalMonto = ventas.reduce((a, v) => a + (v.montoClp || 0), 0)
  return `<div class="card"><h2>Ventas cerradas <span class="pct" style="font-weight:400">— ${ventas.length} pagadas · $${totalMonto.toLocaleString("es-CL")} en pagos iniciales</span></h2>
  ${tarjetasTiempos}
  <div style="overflow-x:auto"><table class="tabla-ventas" style="width:100%;border-collapse:collapse;font-size:13px">
    <thead><tr style="text-align:left;border-bottom:2px solid #e3e7ea">
      <th style="padding:6px 8px">Empresa</th><th style="padding:6px 8px">Inicio conversación</th><th style="padding:6px 8px">Pago</th><th style="padding:6px 8px;text-align:right">Monto</th><th style="padding:6px 8px;text-align:right">Inicio → pago</th>
    </tr></thead>
    <tbody>${filas}</tbody>
  </table></div>
  <div class="sub" style="margin-top:8px">Monto = pago inicial (primer mes + pagos únicos, con descuento e IVA), calculado desde los ítems registrados en Zoho. Fechas en hora de Chile. * = sin conversación registrada: se usa la fecha de emisión de la cotización como inicio.</div>
</div>`
}

async function fetchCierreZoho(excludeIds: Set<string>): Promise<{
  total: number
  aceptadas: number
  // Desglose del campo "Intervención Humana" sobre las ACEPTADAS: cierres
  // 100% conducidos por Vicky vs los que necesitaron un humano (lo marca el
  // equipo comercial en Zoho, cotización por cotización).
  autonomas: number
  asistidas: number
  sinClasificar: number
  aceptadasList: RawAceptada[]
} | null> {
  try {
    const token = await getZohoAccessToken()
    const res = await fetch(`${ZOHO_API_DOMAIN}/crm/v3/coql`, {
      method: "POST",
      headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        select_query: `select id, Name, Numero_Cotizacion, Estado_Cotizacion, Intervenci_n_Humana, Fecha_Hora_Cotizacion, Tel_fono_Contacto, Created_Time, Modified_Time, Descuento_Recurrente_Pct, Cuenta_Asociada.Account_Name from ${QUOTE_MODULE} where Created_By = ${VICKY_CREATOR_ID} limit 200`,
      }),
      cache: "no-store",
    })
    if (!res.ok) return null
    const data = (await res.json().catch(() => null)) as { data?: RawAceptada[] } | null
    const quotes = (data?.data || []).filter((q) => {
      if (excludeIds.has(String(q.id || ""))) return false
      const nombre = String(q.Name || "").toLowerCase()
      return !nombre.includes("prueba") && !nombre.includes("huellerocompany")
    })
    const aceptadasList = quotes.filter((q) => String(q.Estado_Cotizacion || "").toLowerCase().includes("acept"))
    const marca = (q: { Intervenci_n_Humana?: string | null }) => String(q.Intervenci_n_Humana || "").toLowerCase()
    const autonomas = aceptadasList.filter((q) => marca(q).includes("100%")).length
    const asistidas = aceptadasList.filter((q) => marca(q).includes("intervenci")).length
    return {
      total: quotes.length,
      aceptadas: aceptadasList.length,
      autonomas,
      asistidas,
      sinClasificar: aceptadasList.length - autonomas - asistidas,
      aceptadasList,
    }
  } catch {
    return null
  }
}

// Conversaciones de Vicky COLOMBIA (línea +57): este dash es solo Chile, así
// que se excluyen del análisis, de las señales duras y del cierre en Zoho.
async function fetchExclusionesCO(): Promise<{
  convIds: Set<string>
  contacts: Set<string>
  quoteIds: Set<string>
}> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/vic_v3_conversations?select=id,contact,formal_quote_id&country=eq.co`,
    {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      cache: "no-store",
    },
  )
  const rows = res.ok
    ? ((await res.json()) as Array<{ id: string; contact: string; formal_quote_id: string | null }>)
    : []
  return {
    convIds: new Set(rows.map((r) => r.id)),
    contacts: new Set(rows.map((r) => digits(r.contact))),
    quoteIds: new Set(rows.map((r) => r.formal_quote_id || "").filter(Boolean)),
  }
}

// Mejoras aplicadas al agente (changelog curado, editable a mano — pídeme
// actualizarlo). Cada entrada lleva fecha para que no se lea como hallazgo
// vigente cuando ya fue resuelto.
const CURATED_FINDINGS: Array<{ fecha: string; titulo: string; detalle: string }> = [
  {
    fecha: "jul-2026",
    titulo: "Menos es más + micro-cierre en la captura de datos",
    detalle:
      "La mayor fuga era precio → datos (5 datos de golpe con RUT incluido). Ahora Vicky capta nombre/empresa temprano, valida el precio con un micro-cierre ('¿te hace sentido avanzar?') y al cierre pide solo RUT + email; ante objeción, negocia descuento en vez de perder al cliente. En medición (corte 02-jul).",
  },
  {
    fecha: "jun-2026",
    titulo: "Objeción al precio de compra del reloj se atacaba mal",
    detalle:
      "Cuando el cliente objetaba el reloj en venta, se descontaba el plan mensual (irrelevante al pago inicial). Resuelto: ahora Vicky pivotea a arriendo ante esa objeción.",
  },
  {
    fecha: "jun-2026",
    titulo: "Vicky ofrecía la compra del reloj sin que se la pidieran",
    detalle:
      "Ante '¿cuánto vale el reloj?' daba el precio de compra (8 UF). Resuelto: ahora responde solo arriendo salvo que el cliente pida comprar.",
  },
  {
    fecha: "jun-2026",
    titulo: "Dimensionamiento de relojes",
    detalle:
      "Se aceptaba 1 reloj para muchas personas con turnos (riesgo de fila). Resuelto: ahora pregunta por simultaneidad y sugiere 2.",
  },
  {
    fecha: "jun-2026",
    titulo: "Micro-plan para 1 trabajador",
    detalle:
      "Se agregó tarifa especial 0,25 UF (1 que marca + admin), sin descuento recurrente, para no perder micro-clientes.",
  },
]

type Row = {
  conversation_id: string
  contact: string
  grupo: string
  sub_bucket: string | null
  cotizacion_outcome: string | null
  motivo_no_cierre: string | null
  es_cliente_actual: boolean
  resumen: string | null
  hallazgos: Array<{ tipo: string; detalle: string }> | null
  analyzed_at: string | null
}

async function fetchAnalysis(): Promise<Row[]> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/vic_v3_conversation_analysis?select=conversation_id,contact,grupo,sub_bucket,cotizacion_outcome,motivo_no_cierre,es_cliente_actual,resumen,hallazgos,analyzed_at`,
    {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      cache: "no-store",
    },
  )
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return (await res.json()) as Row[]
}

const digits = (c: string) => (c || "").replace(/\D/g, "")

// Señales DETERMINISTAS (hechos en la base, no inferencia del LLM): contactos
// con cotización formal enviada (quote_pointers / formal_quote_id) y contactos
// con reunión agendada (vic_v3_meetings). Se imponen sobre la clasificación.
async function fetchHardSignals(): Promise<{ quote: Set<string>; meeting: Set<string> }> {
  const h = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  const get = async (path: string): Promise<{ contact: string }[]> => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: h, cache: "no-store" })
    return r.ok ? ((await r.json()) as { contact: string }[]) : []
  }
  const [qp, fq, mt] = await Promise.all([
    get("vic_v3_quote_pointers?select=contact"),
    get("vic_v3_conversations?select=contact&formal_quote_id=not.is.null"),
    get("vic_v3_meetings?select=contact"),
  ])
  return {
    quote: new Set([...qp, ...fq].map((x) => digits(x.contact))),
    meeting: new Set(mt.map((x) => digits(x.contact))),
  }
}

function page(html: string, status = 200): Response {
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } })
}

const esc = (s: unknown) =>
  String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

// Vista de detalle de UNA conversación: transcript + ficha del análisis. Se
// abre desde el listado de "Motivos de no-cierre".
async function renderConversation(convId: string, key: string): Promise<Response> {
  const h = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  const g = async (path: string): Promise<Record<string, unknown>[]> => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: h, cache: "no-store" })
    return r.ok ? ((await r.json()) as Record<string, unknown>[]) : []
  }
  const [msgs, ana] = await Promise.all([
    g(`vic_v3_messages?conversation_id=eq.${convId}&select=role,content,at&order=at.asc&limit=300`),
    g(`vic_v3_conversation_analysis?conversation_id=eq.${convId}&select=contact,resumen,motivo_no_cierre,sub_bucket,cotizacion_outcome&limit=1`),
  ])
  const a = ana[0] || {}
  const back = `/api/vic-funnel?key=${encodeURIComponent(key)}`
  const bubbles = msgs
    .map((m) => {
      const user = m.role === "user"
      return `<div class="msg ${user ? "u" : "a"}"><div class="who">${user ? "Cliente" : "Vicky"}</div><div class="txt">${esc(m.content)}</div></div>`
    })
    .join("")
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Conversación — Vicky</title>
<style>
  body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:0;background:#f5f6f8;color:#1f2733}
  .wrap{max-width:760px;margin:0 auto;padding:20px 16px 60px}
  a{color:#1565C0;text-decoration:none} a:hover{text-decoration:underline}
  .hd{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:14px 16px;margin-bottom:14px}
  .hd b{font-size:15px} .meta{color:#6b7280;font-size:13px;margin-top:4px}
  .chip{display:inline-block;background:#eef2ff;color:#3730a3;font-size:11px;padding:2px 8px;border-radius:99px;margin-right:6px}
  .msg{margin:8px 0;display:flex;flex-direction:column}
  .msg.u{align-items:flex-end} .msg.a{align-items:flex-start}
  .who{font-size:11px;color:#9ca3af;margin:0 6px 2px}
  .txt{max-width:78%;padding:9px 12px;border-radius:14px;font-size:14px;white-space:pre-wrap;word-wrap:break-word}
  .msg.u .txt{background:#d1e7ff} .msg.a .txt{background:#fff;border:1px solid #e5e7eb}
</style></head><body><div class="wrap">
  <p><a href="${back}">← Volver al embudo</a></p>
  <div class="hd">
    <b>Conversación · ${esc(a.contact || "")}</b>
    <div class="meta">
      ${a.sub_bucket ? `<span class="chip">${esc(a.sub_bucket)}</span>` : ""}
      ${a.cotizacion_outcome ? `<span class="chip">${esc(a.cotizacion_outcome)}</span>` : ""}
      ${a.motivo_no_cierre ? `<span class="chip">motivo: ${esc(a.motivo_no_cierre)}</span>` : ""}
    </div>
    ${a.resumen ? `<div class="meta">${esc(a.resumen)}</div>` : ""}
  </div>
  ${bubbles || "<p class='meta'>Sin mensajes.</p>"}
</div></body></html>`
  return page(html)
}

export async function GET(req: Request): Promise<Response> {
  const { searchParams } = new URL(req.url)
  const key = (searchParams.get("key") || "").trim()

  if (!FUNNEL_KEY) {
    return page("<h1>Falta configurar VIC_FUNNEL_KEY</h1><p>Define la variable de entorno VIC_FUNNEL_KEY en Vercel.</p>", 503)
  }
  if (key !== FUNNEL_KEY) {
    return page("<h1>No autorizado</h1><p>Falta o es incorrecto el parámetro <code>?key=</code>.</p>", 401)
  }

  const conv = (searchParams.get("conv") || "").replace(/[^a-fA-F0-9-]/g, "").trim()
  if (conv) return renderConversation(conv, key)

  let rows: Row[]
  let cierre: {
    total: number
    aceptadas: number
    autonomas: number
    asistidas: number
    sinClasificar: number
    aceptadasList: RawAceptada[]
  } | null = null
  let ventasHtml = ""
  try {
    const co = await fetchExclusionesCO()
    const [allRows, hard, cierreZoho] = await Promise.all([
      fetchAnalysis(),
      fetchHardSignals(),
      fetchCierreZoho(co.quoteIds),
    ])
    cierre = cierreZoho
    if (cierre?.aceptadasList?.length) {
      ventasHtml = renderVentasCerradas(await construirVentasCerradas(cierre.aceptadasList))
    }
    rows = allRows.filter(
      (r) =>
        !isTestContact(r.contact) &&
        !co.convIds.has(r.conversation_id) &&
        !co.contacts.has(digits(r.contact)),
    )
    // Hechos deterministas mandan sobre el LLM: cotización formal enviada y
    // reunión agendada se imponen aunque el modelo no las haya detectado.
    for (const r of rows) {
      const d = digits(r.contact)
      if (hard.quote.has(d)) {
        r.grupo = "comercial"
        r.sub_bucket = "cotizacion"
        r.cotizacion_outcome = "cotizacion_enviada"
        r.motivo_no_cierre = null
      } else if (hard.meeting.has(d)) {
        r.grupo = "comercial"
        r.sub_bucket = "reunion"
        r.cotizacion_outcome = null
        r.motivo_no_cierre = null
      }
    }
  } catch (e) {
    return page(`<h1>Error consultando datos</h1><pre>${String(e).slice(0, 300)}</pre>`, 500)
  }

  if (rows.length === 0) {
    return page(
      "<h1>Sin análisis todavía</h1><p>La tabla de análisis está vacía. Corre el cron una vez: <code>/api/vic-funnel-cron?key=&lt;VIC_FUNNEL_KEY&gt;&amp;all=1</code> (puede requerir varias llamadas para el histórico).</p>",
    )
  }

  const n = (pred: (r: Row) => boolean) => rows.filter(pred).length
  const total = rows.length
  const comercial = n((r) => r.grupo === "comercial")
  const soporte = n((r) => r.grupo === "soporte")
  const noId = n((r) => r.grupo === "no_identificado")

  const crosselling = n((r) => r.grupo === "comercial" && r.sub_bucket === "crosselling")
  const lead = n((r) => r.grupo === "comercial" && r.sub_bucket === "lead")
  const reunion = n((r) => r.grupo === "comercial" && r.sub_bucket === "reunion")
  const cotizacion = n((r) => r.grupo === "comercial" && r.sub_bucket === "cotizacion")
  const soloDudas = n((r) => r.grupo === "comercial" && r.sub_bucket === "solo_dudas")

  const cPreform = n((r) => r.sub_bucket === "cotizacion" && r.cotizacion_outcome === "preform_mostrado")
  const cEnviada = n((r) => r.sub_bucket === "cotizacion" && r.cotizacion_outcome === "cotizacion_enviada")
  const cAbandonado = n((r) => r.sub_bucket === "cotizacion" && r.cotizacion_outcome === "abandonado")

  // ── Motivos de no-cierre (flujo cotización que no terminó en envío) ──────
  const noCierre = rows.filter(
    (r) => r.sub_bucket === "cotizacion" && (r.cotizacion_outcome === "preform_mostrado" || r.cotizacion_outcome === "abandonado"),
  )
  const motivoCount = new Map<string, number>()
  for (const r of noCierre) {
    const m = r.motivo_no_cierre || "sin_motivo"
    motivoCount.set(m, (motivoCount.get(m) || 0) + 1)
  }
  // Orden por frecuencia; cap a 7 nodos + "otros" para mantener legible el Sankey.
  const motivosSorted = [...motivoCount.entries()].sort((a, b) => b[1] - a[1])
  const TOP_MOTIVOS = 7
  const topMotivos = motivosSorted.slice(0, TOP_MOTIVOS).map(([m]) => m)
  const hayOtros = motivosSorted.length > TOP_MOTIVOS
  const motivoBucket = (m: string) => (topMotivos.includes(m) ? m : "otros")

  // Hallazgos auto-detectados: agregados por tipo, con un ejemplo.
  const byTipo = new Map<string, { count: number; ejemplo: string }>()
  for (const r of rows) {
    for (const h of r.hallazgos || []) {
      if (!h || !h.tipo) continue
      const cur = byTipo.get(h.tipo) || { count: 0, ejemplo: h.detalle || "" }
      cur.count++
      if (!cur.ejemplo && h.detalle) cur.ejemplo = h.detalle
      byTipo.set(h.tipo, cur)
    }
  }
  const hallazgosAuto = [...byTipo.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 12)

  const lastUpdate = rows
    .map((r) => r.analyzed_at || "")
    .filter(Boolean)
    .sort()
    .slice(-1)[0]
  const lastUpdateStr = lastUpdate
    ? new Date(lastUpdate).toLocaleString("es-CL", { timeZone: "America/Santiago" })
    : "—"

  // ── Sankey ──────────────────────────────────────────────────────────────
  // Parte del total de conversaciones, que se abre en los 3 grupos. Comercial
  // se abre en 5 sub-buckets; "Flujo cotización" se abre en 3 estados. Soporte y
  // No identificado son sumideros (reciben flujo de la raíz → rinden su tamaño).
  const labels = [
    /* 0 */ "Conversaciones",
    /* 1 */ "Intención comercial", /* 2 */ "Soporte", /* 3 */ "No identificado",
    /* 4 */ "Crosselling", /* 5 */ "Lead (callback)", /* 6 */ "Reunión", /* 7 */ "Flujo cotización", /* 8 */ "Solo dudas",
    /* 9 */ "Vio precio, no avanzó", /* 10 */ "Cotización enviada", /* 11 */ "Se fue antes del precio",
  ]
  const col = {
    base: "#2F5496", com: "#1565C0", sop: "#00838F", noid: "#9E9E9E",
    good: "#2E7D32", best: "#1B5E20", warn: "#F9A825", bad: "#C62828", grey: "#9E9E9E",
  }
  const nodeColor = [
    col.base,
    col.com, col.sop, col.noid,
    col.good, col.warn, col.good, col.com, col.grey,
    col.good, col.best, col.bad,
  ]
  const mk = (s: number, t: number, v: number) => ({ s, t, v })
  const links = [
    mk(0, 1, comercial), mk(0, 2, soporte), mk(0, 3, noId),
    mk(1, 4, crosselling), mk(1, 5, lead), mk(1, 6, reunion), mk(1, 7, cotizacion), mk(1, 8, soloDudas),
    mk(7, 9, cPreform), mk(7, 10, cEnviada), mk(7, 11, cAbandonado),
  ].filter((l) => l.v > 0)

  // 3er nivel: Preform mostrado (9) y Abandonado (11) se abren por motivo de
  // no-cierre. Los nodos de motivo se agregan dinámicamente tras los 12 base.
  const motivoNodeNames = [...topMotivos, ...(hayOtros ? ["otros"] : [])]
  const motivoNodeIndex = new Map<string, number>()
  motivoNodeNames.forEach((m, i) => {
    motivoNodeIndex.set(m, labels.length + i)
    labels.push(m.replace(/_/g, " "))
    nodeColor.push("#A1887F")
  })
  // Cuenta por (estado, motivo) y crea los links estado→motivo.
  const pairCount = new Map<string, number>()
  for (const r of noCierre) {
    const stageNode = r.cotizacion_outcome === "preform_mostrado" ? 9 : 11
    const mNode = motivoNodeIndex.get(motivoBucket(r.motivo_no_cierre || "sin_motivo"))
    if (mNode === undefined) continue
    const key = `${stageNode}|${mNode}`
    pairCount.set(key, (pairCount.get(key) || 0) + 1)
  }
  for (const [key, v] of pairCount) {
    const [s, t] = key.split("|").map(Number)
    links.push(mk(s, t, v))
  }

  const kpiCard = (label: string, value: number | string, color: string, sub?: string) =>
    `<div class="kpi"><div class="kpi-v" style="color:${color}">${value}</div><div class="kpi-l">${label}${sub ? ` <span class="pct">${sub}</span>` : ""}</div></div>`
  const pct = (x: number) => (total ? `${Math.round((x / total) * 100)}%` : "")

  const html = `<!doctype html><html lang="es"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Embudo de conversaciones — Vicky</title>
<script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
<style>
  body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:0;background:#f5f6f8;color:#1f2733}
  .wrap{max-width:1080px;margin:0 auto;padding:24px 20px 60px}
  h1{font-size:22px;margin:0 0 4px} .sub{color:#6b7280;font-size:13px;margin-bottom:20px}
  .kpis{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:8px}
  .kpi{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px 18px;min-width:120px;flex:1}
  .kpi-v{font-size:28px;font-weight:700} .kpi-l{font-size:12px;color:#6b7280;margin-top:2px}
  .pct{color:#9ca3af} .tag{display:inline-block;background:#eef2ff;color:#3730a3;font-size:11px;padding:2px 8px;border-radius:99px}
  .card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:18px;margin-top:18px}
  .card h2{font-size:16px;margin:0 0 12px}
  #sankey{width:100%;height:480px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #eef0f2;vertical-align:top}
  th{color:#6b7280;font-weight:600;font-size:12px}
  td.num{text-align:right;font-weight:700;width:64px;color:#9A6700}
  code{background:#f3f4f6;padding:1px 5px;border-radius:4px;font-size:12px}
  a{color:#1565C0;text-decoration:none;font-weight:600} a:hover{text-decoration:underline}
  .kgroup{font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;margin:16px 0 6px}
  .bars{display:flex;flex-direction:column;gap:8px}
  .bar-row{display:grid;grid-template-columns:160px 1fr 40px;align-items:center;gap:10px;font-size:13px}
  .bar-track{background:#f1f3f5;border-radius:6px;height:18px;overflow:hidden}
  .bar-fill{background:#A1887F;height:100%;border-radius:6px}
  .bar-num{text-align:right;font-weight:700;color:#6d4c41}
  .foot{color:#9ca3af;font-size:11px;margin-top:24px;text-align:center}
</style></head><body><div class="wrap">
  <h1>Embudo de conversaciones — Vicky V3</h1>
  <div class="sub">Vicky CHILE — clientes reales (excluye pruebas internas y la línea de Colombia) · ${total} conversaciones · <span class="tag">actualizado por hora</span> · última actualización: ${lastUpdateStr}</div>

  <div class="kgroup">Por grupo · suman el total (${total})</div>
  <div class="kpis">
    ${kpiCard("Conversaciones", total, col.base)}
    ${kpiCard("Intención comercial", comercial, col.com, pct(comercial))}
    ${kpiCard("Soporte", soporte, col.sop, pct(soporte))}
    ${kpiCard("No identificado", noId, col.noid, pct(noId))}
  </div>
  <div class="kgroup">Dentro de intención comercial (${comercial})</div>
  <div class="kpis">
    ${kpiCard("Flujo cotización", cotizacion, col.com)}
    ${kpiCard("Reunión", reunion, col.good)}
    ${kpiCard("Lead (callback)", lead, col.warn)}
    ${kpiCard("Crosselling", crosselling, col.good)}
    ${kpiCard("Solo dudas", soloDudas, col.grey)}
  </div>
  <div class="kgroup">Flujo cotización y tasa de cierre (${cotizacion} conversaciones · cierre en vivo desde Zoho)</div>
  ${(() => {
    const vieronPrecio = cPreform + cEnviada
    const pasoPreform = vieronPrecio ? `${Math.round((cEnviada / vieronPrecio) * 100)}% de los que vieron precio` : ""
    const base = `
    ${kpiCard("Vio precio y NO avanzó", cPreform, col.warn, "quedó en preform")}
    ${kpiCard("Cotización enviada", cEnviada, col.best, pasoPreform)}
    ${kpiCard("Se fue ANTES del precio", cAbandonado, col.bad, "sin preform")}`
    if (!cierre) {
      return `<div class="kpis">${base}
  </div>
  <div class="sub" style="margin:-2px 0 10px">Zoho no disponible en esta carga — recarga para ver aceptadas y cierre.</div>`
    }
    const tasaAcept = cierre.total ? `${Math.round((cierre.aceptadas / cierre.total) * 100)}%` : ""
    const endToEnd = vieronPrecio ? Math.round((cierre.aceptadas / vieronPrecio) * 100) : 0
    // Autonomía del cierre: dos TASAS diferenciadas sobre la misma base del
    // cierre end-to-end (conversaciones que vieron precio → venta), según el
    // campo "Intervención Humana" de Zoho. Las aceptadas sin clasificar no
    // suman a ninguna de las dos (se informan aparte).
    const clasificadas = cierre.autonomas + cierre.asistidas
    const tasaAuto = vieronPrecio ? Math.round((cierre.autonomas / vieronPrecio) * 100) : 0
    const tasaAsis = vieronPrecio ? Math.round((cierre.asistidas / vieronPrecio) * 100) : 0
    const filaAutonomia = clasificadas
      ? `
    ${kpiCard("Tasa de cierre 100% Vicky", `${tasaAuto}%`, col.best, `${cierre.autonomas} aceptada${cierre.autonomas === 1 ? "" : "s"} sin humano · vio precio → venta`)}
    ${kpiCard("Tasa de cierre asistido", `${tasaAsis}%`, col.warn, `${cierre.asistidas} aceptada${cierre.asistidas === 1 ? "" : "s"} con intervención humana`)}`
      : ""
    const notaSinClasificar = cierre.sinClasificar > 0
      ? `<div class="sub" style="margin:-2px 0 10px">${cierre.sinClasificar} aceptada${cierre.sinClasificar === 1 ? "" : "s"} sin clasificar — marcar el campo <b>Intervención Humana</b> en la cotización (Zoho) para completar la autonomía del cierre.</div>`
      : ""
    return `<div class="kpis">${base}
    ${kpiCard("Cotizaciones en Zoho", cierre.total, col.com)}
    ${kpiCard("Aceptadas / pagadas", cierre.aceptadas, col.good, tasaAcept)}
    ${kpiCard("Cierre end-to-end", `${endToEnd}%`, col.best, "vio precio → venta")}${filaAutonomia}
  </div>
  ${notaSinClasificar}
  <div class="sub" style="margin:-2px 0 10px">Nota: los 3 primeros KPI cuentan <b>conversaciones</b>; los de Zoho cuentan <b>cotizaciones</b>. Una conversación puede generar más de una cotización (p. ej. un contacto que cotiza para 2 empresas), por eso pueden diferir levemente.</div>`
  })()}

  ${ventasHtml}

  <div class="card"><h2>Flujo del embudo</h2><div id="sankey"></div></div>

  <div class="card"><h2>Motivos de no-cierre <span class="pct" style="font-weight:400">— cotizaciones que no terminaron en envío (${noCierre.length})</span></h2>
    ${noCierre.length === 0 ? "<p class='sub'>Sin casos.</p>" : `<div class="bars">
      ${motivosSorted.map(([m, c]) => {
        const w = noCierre.length ? Math.round((c / motivosSorted[0][1]) * 100) : 0
        return `<div class="bar-row"><div>${m.replace(/_/g, " ")}</div><div class="bar-track"><div class="bar-fill" style="width:${w}%"></div></div><div class="bar-num">${c}</div></div>`
      }).join("")}
    </div>
    <div class="kgroup" style="margin-top:18px">Detalle (datos subyacentes)</div>
    <table><thead><tr><th>Motivo</th><th>Etapa</th><th>Qué ocurrió y por qué no avanzó</th><th></th></tr></thead><tbody>
      ${[...noCierre]
        .sort((a, b) => (a.motivo_no_cierre || "~").localeCompare(b.motivo_no_cierre || "~"))
        .map((r) => `<tr>
          <td><b>${esc((r.motivo_no_cierre || "sin motivo").replace(/_/g, " "))}</b></td>
          <td>${r.cotizacion_outcome === "preform_mostrado" ? "Vio precio, no avanzó" : "Se fue antes del precio"}</td>
          <td>${esc(r.resumen || "—")}</td>
          <td><a href="?key=${encodeURIComponent(key)}&conv=${esc(r.conversation_id)}">Ver →</a></td>
        </tr>`)
        .join("")}
    </tbody></table>`}
  </div>

  <div class="card"><h2>Hallazgos auto-detectados (por el análisis)</h2>
    ${hallazgosAuto.length === 0 ? "<p class='sub'>Sin hallazgos aún.</p>" : `<table><thead><tr><th>Patrón</th><th class="num">N°</th><th>Ejemplo</th></tr></thead><tbody>
      ${hallazgosAuto.map(([tipo, v]) => `<tr><td>${tipo.replace(/_/g, " ")}</td><td class="num">${v.count}</td><td>${v.ejemplo}</td></tr>`).join("")}
    </tbody></table>`}
  </div>

  <div class="card"><h2>Mejoras aplicadas al agente (changelog curado)</h2>
    <table><thead><tr><th>Fecha</th><th>Mejora</th><th>Detalle</th></tr></thead><tbody>
      ${CURATED_FINDINGS.map((f) => `<tr><td style="width:8%;white-space:nowrap">${f.fecha}</td><td style="width:30%"><b>${f.titulo}</b></td><td>${f.detalle}</td></tr>`).join("")}
    </tbody></table>
  </div>

  <div class="foot">Clasificación semántica con Claude · datos en vivo desde Supabase · Vicky V3 · GeoVictoria</div>
</div>
<script>
  var labels = ${JSON.stringify(labels)};
  var nodeColor = ${JSON.stringify(nodeColor)};
  var L = ${JSON.stringify(links)};
  var data = [{
    type: "sankey", orientation: "h",
    node: { label: labels, color: nodeColor, pad: 18, thickness: 18, line: { color: "#fff", width: 1 },
      hovertemplate: "%{label}: %{value}<extra></extra>" },
    link: { source: L.map(function(x){return x.s}), target: L.map(function(x){return x.t}),
      value: L.map(function(x){return x.v}), color: "rgba(47,84,150,0.16)",
      hovertemplate: "%{source.label} → %{target.label}: %{value}<extra></extra>" }
  }];
  Plotly.newPlot("sankey", data, { font: { size: 12 }, margin: { l: 0, r: 0, t: 8, b: 8 } }, { responsive: true, displayModeBar: false });
</script>
</body></html>`

  return page(html)
}
