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

import { createHash } from "node:crypto"

import { isTestContact, testContactSet } from "@/lib/funnel-analysis"
import { getZohoAccessToken } from "@/lib/zoho-token"

export const dynamic = "force-dynamic"

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const FUNNEL_KEY = (process.env.VIC_FUNNEL_KEY || "").trim()
// Clave de acceso humano al dashboard (pedido Lalo 04-ago). El ?key= sigue
// vigente para consumidores máquina (cron del resumen, links del correo).
const DASH_CLAVE = (process.env.VIC_DASH_CLAVE || "GeoVictoria2026!").trim()
const authToken = () => createHash("sha256").update(`${DASH_CLAVE}|${FUNNEL_KEY}|vic-dash`).digest("hex")
const cookieDe = (req: Request, nombre: string): string => {
  const jar = req.headers.get("cookie") || ""
  const m = jar.match(new RegExp(`(?:^|;\\s*)${nombre}=([^;]+)`))
  return m ? m[1] : ""
}
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
  Onboarding_Link?: string | null
  "Owner.first_name"?: string | null
  "Owner.last_name"?: string | null
  "Deal_Asociado.Stage"?: string | null
  "Deal_Asociado.id"?: string | null
}

type VentaCerrada = {
  empresa: string
  numero: string
  inicioIso: string
  inicioAprox: boolean
  pagoIso: string
  montoClp: number
  /** Desglose del pago inicial (pedido Lalo 04-ago): fee que queda como
   * recurrencia mensual vs pagos por una sola vez (reloj/envío/instalación). */
  recurrenteClp: number
  unicoClp: number
  usuarios: string
  descuentoPct: number
  /** id de la conversación de WhatsApp, para el link "ver conversación". */
  convId: string
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

async function kvSet(key: string, value: string, expiresAt?: string): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/vic_kv?on_conflict=key`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(expiresAt ? { key, value, expires_at: expiresAt } : { key, value }),
    cache: "no-store",
  }).catch(() => {})
}

async function construirVentasCerradas(aceptadas: RawAceptada[]): Promise<VentaCerrada[]> {
  const token = await getZohoAccessToken().catch(() => "")
  const ventas: VentaCerrada[] = []
  for (const q of aceptadas) {
    const id = String(q.id || "")
    if (!id) continue
    const cacheKey = `venta_dash_v3_${id}`
    const cached = await kvGet(cacheKey)
    if (cached) {
      try {
        const venta = JSON.parse(cached) as VentaCerrada
        // Caché de antes del desglose único/recurrente (04-ago): se salta el
        // push para recomputarla una vez con los campos nuevos.
        if (typeof venta.recurrenteClp === "number" && typeof venta.unicoClp === "number") {
          // Ventas cacheadas antes de que existiera el link a la conversación:
          // se les completa el convId una vez y se re-cachean.
          if (!venta.convId) {
            venta.convId = ""
            const fonoCache = digits(String(q.Tel_fono_Contacto || ""))
            if (fonoCache) {
              const r = await fetch(
                `${SUPABASE_URL}/rest/v1/vic_v3_conversations?contact=eq.${fonoCache}&select=id&order=started_at.asc&limit=1`,
                { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, cache: "no-store" },
              ).catch(() => null)
              const rows = r?.ok ? ((await r.json().catch(() => [])) as Array<{ id?: string }>) : []
              venta.convId = String(rows[0]?.id || "")
              if (venta.convId) await kvSet(cacheKey, JSON.stringify(venta))
            }
          }
          ventas.push(venta)
          continue
        }
      } catch {
        // caché corrupta → recomputar
      }
    }
    // Monto: ítems del subform (getRecord completo, 1 sola vez por venta).
    let montoClp = 0
    let recurrenteClp = 0
    let unicoClp = 0
    let usuarios = "—"
    let descuentoPct = 0
    if (token) {
      try {
        const r = await fetch(`${ZOHO_API_DOMAIN}/crm/v3/${QUOTE_MODULE}/${id}`, {
          headers: { Authorization: `Zoho-oauthtoken ${token}` },
          cache: "no-store",
        })
        const body = (await r.json().catch(() => null)) as {
          data?: Array<{
            Descuento_Recurrente_Pct?: number
            Detalle_Items_Cotizacion?: Array<{
              Subtotal_CLP?: number
              Es_Recurrente?: boolean
              Codigo_Item?: string
              Modalidad?: string
              Cantidad?: number
            }>
          }>
        } | null
        const rec = body?.data?.[0]
        const pct = Number(rec?.Descuento_Recurrente_Pct ?? q.Descuento_Recurrente_Pct ?? 0) || 0
        descuentoPct = pct
        const items = rec?.Detalle_Items_Cotizacion || []
        // Usuarios/tramo: del ítem de asistencia — "Por usuario" trae la
        // cantidad real; "Fijo" es el plan de tarifa fija del tramo 1-10.
        const asistencia = items.find((i) => (i.Codigo_Item || "") === "asistencia")
        if (asistencia) {
          usuarios =
            String(asistencia.Modalidad || "").toLowerCase() === "fijo"
              ? "1-10 (tarifa fija)"
              : `${Number(asistencia.Cantidad) || 0}`
        }
        const recurrente = items.filter((i) => i.Es_Recurrente).reduce((a, i) => a + (Number(i.Subtotal_CLP) || 0), 0)
        const unico = items.filter((i) => !i.Es_Recurrente).reduce((a, i) => a + (Number(i.Subtotal_CLP) || 0), 0)
        recurrenteClp = Math.round(recurrente * (1 - pct / 100) * 1.19)
        unicoClp = Math.round(unico * 1.19)
        montoClp = recurrenteClp + unicoClp
      } catch {
        montoClp = 0
        recurrenteClp = 0
        unicoClp = 0
      }
    }
    // Inicio de conversación: started_at por teléfono; fallback: creación de
    // la cotización. El id de esa conversación alimenta el link "ver conversación".
    const fono = digits(String(q.Tel_fono_Contacto || ""))
    let inicioIso = ""
    let convId = ""
    if (fono) {
      try {
        const r = await fetch(
          `${SUPABASE_URL}/rest/v1/vic_v3_conversations?contact=eq.${fono}&select=id,started_at&order=started_at.asc&limit=1`,
          { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, cache: "no-store" },
        )
        const rows = r.ok ? ((await r.json()) as Array<{ id?: string; started_at?: string }>) : []
        inicioIso = rows[0]?.started_at || ""
        convId = String(rows[0]?.id || "")
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
      recurrenteClp,
      unicoClp,
      usuarios,
      descuentoPct,
      convId,
    }
    ventas.push(venta)
    if (montoClp > 0 && pagoIso) await kvSet(cacheKey, JSON.stringify(venta))
  }
  return ventas.sort((a, b) => (b.pagoIso || "").localeCompare(a.pagoIso || ""))
}

/** Fee mensual RECURRENTE por contacto (pedido Lalo 04-ago): suma de los ítems
 * Es_Recurrente del subform de la cotización, con descuento y con IVA — deja
 * fuera compra/envío/instalación del reloj. Caché por quote en vic_kv (48 h);
 * los que falten se completan de a poco en cargas siguientes (tope por carga
 * para no reventar el tiempo de la función). */
async function fetchFeesMensuales(
  pares: Array<{ contact: string; quoteId: string }>,
): Promise<Map<string, { uf: number | null; clp: number | null }>> {
  const out = new Map<string, { uf: number | null; clp: number | null }>()
  if (!pares.length) return out
  const hSb = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  const cache = new Map<string, { uf: number | null; clp: number | null }>()
  const ids = [...new Set(pares.map((p) => p.quoteId))]
  for (let i = 0; i < ids.length; i += 80) {
    const keys = ids.slice(i, i + 80).map((id) => `"fee_mes_v1_${id}"`).join(",")
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/vic_kv?key=in.(${keys})&expires_at=gt.${new Date().toISOString()}&select=key,value`,
      { headers: hSb, cache: "no-store" },
    ).catch(() => null)
    const rows = r?.ok ? ((await r.json().catch(() => [])) as Array<{ key: string; value: string }>) : []
    for (const row of rows) {
      try {
        cache.set(String(row.key).replace(/^fee_mes_v1_/, ""), JSON.parse(row.value) as { uf: number | null; clp: number | null })
      } catch {}
    }
  }
  const faltantes = ids.filter((id) => !cache.has(id)).slice(0, 36)
  if (faltantes.length) {
    const token = await getZohoAccessToken().catch(() => "")
    if (token) {
      for (let i = 0; i < faltantes.length; i += 6) {
        await Promise.all(
          faltantes.slice(i, i + 6).map(async (id) => {
            try {
              const r = await fetch(`${ZOHO_API_DOMAIN}/crm/v3/${QUOTE_MODULE}/${id}`, {
                headers: { Authorization: `Zoho-oauthtoken ${token}` },
                cache: "no-store",
              })
              const body = (await r.json().catch(() => null)) as {
                data?: Array<{
                  Descuento_Recurrente_Pct?: number
                  Detalle_Items_Cotizacion?: Array<{ Subtotal_UF?: number; Subtotal_CLP?: number; Es_Recurrente?: boolean }>
                }>
              } | null
              const rec = body?.data?.[0]
              if (!rec) return
              const pct = Number(rec.Descuento_Recurrente_Pct ?? 0) || 0
              const recurrentes = (rec.Detalle_Items_Cotizacion || []).filter((it) => it.Es_Recurrente)
              const uf = recurrentes.reduce((a, it) => a + (Number(it.Subtotal_UF) || 0), 0)
              const clp = recurrentes.reduce((a, it) => a + (Number(it.Subtotal_CLP) || 0), 0)
              const fee = {
                uf: uf ? Number((uf * (1 - pct / 100) * 1.19).toFixed(2)) : null,
                clp: clp ? Math.round(clp * (1 - pct / 100) * 1.19) : null,
              }
              cache.set(id, fee)
              await kvSet(`fee_mes_v1_${id}`, JSON.stringify(fee), new Date(Date.now() + 48 * 3600e3).toISOString())
            } catch {}
          }),
        )
      }
    }
  }
  for (const p of pares) {
    const fee = cache.get(p.quoteId)
    if (fee && (fee.uf || fee.clp) && !out.has(p.contact)) out.set(p.contact, fee)
  }
  return out
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

function renderVentasCerradas(ventas: VentaCerrada[], key: string): string {
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
        <td>${v.empresa}${v.numero ? ` <span class="sub" style="display:inline">· ${v.numero}</span>` : ""}${v.convId ? `<div style="margin-top:2px"><a href="?key=${encodeURIComponent(key)}&conv=${encodeURIComponent(v.convId)}" style="font-size:12px;font-weight:400">ver conversación →</a></div>` : ""}</td>
        <td>${fmtSantiago(v.inicioIso)}${v.inicioAprox ? " *" : ""}</td>
        <td>${fmtSantiago(v.pagoIso)}</td>
        <td style="text-align:center">${v.usuarios || "—"}</td>
        <td style="text-align:center">${v.descuentoPct > 0 ? `${v.descuentoPct}%` : "—"}</td>
        <td style="text-align:right">${v.unicoClp > 0 ? `$${v.unicoClp.toLocaleString("es-CL")}` : "—"}</td>
        <td style="text-align:right">${v.recurrenteClp > 0 ? `$${v.recurrenteClp.toLocaleString("es-CL")}/mes` : "—"}</td>
        <td style="text-align:right"><b>${fmtDuracion(v.inicioIso, v.pagoIso)}</b></td>
      </tr>`,
    )
    .join("")
  const totalUnico = ventas.reduce((a, v) => a + (v.unicoClp || 0), 0)
  const totalRecurrente = ventas.reduce((a, v) => a + (v.recurrenteClp || 0), 0)
  return `<div class="card"><h2>Ventas cerradas <span class="pct" style="font-weight:400">— ${ventas.length} pagadas · $${totalUnico.toLocaleString("es-CL")} en pagos únicos · $${totalRecurrente.toLocaleString("es-CL")}/mes de recurrencia</span></h2>
  ${tarjetasTiempos}
  <div style="overflow-x:auto"><table class="tabla-ventas" style="width:100%;border-collapse:collapse;font-size:13px">
    <thead><tr style="text-align:left;border-bottom:2px solid #e3e7ea">
      <th style="padding:6px 8px">Empresa</th><th style="padding:6px 8px">Inicio conversación</th><th style="padding:6px 8px">Pago</th><th style="padding:6px 8px;text-align:center">Usuarios</th><th style="padding:6px 8px;text-align:center">Dcto.</th><th style="padding:6px 8px;text-align:right">Pago único</th><th style="padding:6px 8px;text-align:right">Recurrencia</th><th style="padding:6px 8px;text-align:right">Inicio → pago</th>
    </tr></thead>
    <tbody>${filas}</tbody>
  </table></div>
  <div class="sub" style="margin-top:8px">Pago único = compra/envío/instalación del reloj (con IVA), se paga una sola vez. Recurrencia = fee mensual de módulos y arriendos (con descuento e IVA); el pago inicial del cliente suma ambos. Calculado desde los ítems registrados en Zoho. Fechas en hora de Chile. * = sin conversación registrada: se usa la fecha de emisión de la cotización como inicio.</div>
</div>`
}

// ── Filtro Desde–Hasta (pedido Lalo 27-jul) ─────────────────────────────────
// El rango se interpreta en hora de CHILE (UTC-4): desde las 00:00 del "desde"
// hasta las 23:59:59 del "hasta". Aplica sobre la fecha de INICIO de la
// conversación (Sankey y KPIs) y la fecha de CREACIÓN de la cotización (cierre
// y ventas cerradas). La sección "Funnel por origen" queda fuera del filtro a
// propósito: sus conjuntos (toque 0, asignados) son acumulados del programa y
// partirlos por fecha con precisión requiere datos que ese fetch no trae.
type RangoFechas = { desdeMs: number; hastaMs: number; desdeStr: string; hastaStr: string; etiqueta: string }

function parseRango(searchParams: URLSearchParams): RangoFechas | null {
  const fecha = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : "")
  const desde = fecha(searchParams.get("desde"))
  const hasta = fecha(searchParams.get("hasta"))
  if (!desde && !hasta) return null
  const desdeMs = desde ? Date.parse(`${desde}T00:00:00-04:00`) : 0
  const hastaMs = hasta ? Date.parse(`${hasta}T23:59:59.999-04:00`) : Number.MAX_SAFE_INTEGER
  if (Number.isNaN(desdeMs) || Number.isNaN(hastaMs) || desdeMs > hastaMs) return null
  const etiqueta = desde && hasta ? `${desde} → ${hasta}` : desde ? `desde ${desde}` : `hasta ${hasta}`
  return { desdeMs, hastaMs, desdeStr: desde, hastaStr: hasta, etiqueta }
}

const enRango = (iso: string | null | undefined, r: RangoFechas): boolean => {
  const t = Date.parse(String(iso || ""))
  return Number.isFinite(t) && t >= r.desdeMs && t <= r.hastaMs
}

/** id de conversación → started_at, para filtrar el análisis por fecha. */
async function fetchFechasConversaciones(): Promise<Map<string, string>> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/vic_v3_conversations?select=id,started_at&limit=10000`,
    {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      cache: "no-store",
    },
  )
  const out = new Map<string, string>()
  if (!res.ok) return out
  const rows = (await res.json().catch(() => [])) as Array<{ id?: string; started_at?: string }>
  for (const r of rows) if (r.id) out.set(r.id, r.started_at || "")
  return out
}

async function fetchCierreZoho(paisPorQuote: Map<string, Pais>, pais: Pais, rango: RangoFechas | null): Promise<{
  total: number
  aceptadas: number
  // Desglose del campo "Intervención Humana" sobre las ACEPTADAS: cierres
  // 100% conducidos por Vicky vs los que necesitaron un humano (lo marca el
  // equipo comercial en Zoho, cotización por cotización).
  autonomas: number
  asistidas: number
  sinClasificar: number
  aceptadasList: RawAceptada[]
  todasList: RawAceptada[]
  /** Emitidas del rango (base del KPI "Cotizaciones en Zoho") — se expone la
   * lista para poder re-filtrar por Estado/Propietario globales. */
  quotesList: RawAceptada[]
} | null> {
  try {
    const token = await getZohoAccessToken()
    const res = await fetch(`${ZOHO_API_DOMAIN}/crm/v3/coql`, {
      method: "POST",
      headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        select_query: `select id, Name, Numero_Cotizacion, Estado_Cotizacion, Intervenci_n_Humana, Fecha_Hora_Cotizacion, Tel_fono_Contacto, Created_Time, Modified_Time, Descuento_Recurrente_Pct, Cuenta_Asociada.Account_Name, Onboarding_Link, Owner.first_name, Owner.last_name, Deal_Asociado.Stage, Deal_Asociado.id from ${QUOTE_MODULE} where Created_By = ${VICKY_CREATOR_ID} limit 200`,
      }),
      cache: "no-store",
    })
    if (!res.ok) return null
    const data = (await res.json().catch(() => null)) as { data?: RawAceptada[] } | null
    const universo = (data?.data || []).filter((q) => {
      // País de la cotización: el de su conversación de origen; si no está
      // ligada, por prefijo del teléfono (histórico: Chile por defecto).
      const tel = String(q.Tel_fono_Contacto || "").replace(/\D/g, "")
      const paisQuote: Pais = paisPorQuote.get(String(q.id || "")) || paisDeTelefono(tel) || "cl"
      if (paisQuote !== pais) return false
      const nombre = String(q.Name || "").toLowerCase()
      if (nombre.includes("prueba") || nombre.includes("huellerocompany")) return false
      return true
    })
    // Filtro Desde–Hasta con DOS relojes (pedido Lalo 31-jul): las emitidas
    // filtran por fecha de EMISIÓN (Created_Time); las aceptadas/pagadas por
    // fecha de PAGO (Fecha_Hora_Cotizacion, con Modified_Time de respaldo —
    // la misma fecha que muestra la columna "Pago" de la tabla de ventas).
    // Una cotización emitida un día anterior pero pagada dentro del rango
    // CUENTA como pago del rango (caso Ayres/Cofradía del 31-jul).
    const quotes = universo.filter((q) => !rango || enRango(q.Created_Time, rango))
    const aceptadasList = universo
      .filter((q) => String(q.Estado_Cotizacion || "").toLowerCase().includes("acept"))
      .filter((q) => !rango || enRango(q.Fecha_Hora_Cotizacion || q.Modified_Time, rango))
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
      // Universo completo SIN filtro de fechas: lo consume el Listado
      // comercial (esa sección filtra en el navegador).
      todasList: universo,
      quotesList: quotes,
    }
  } catch {
    return null
  }
}

// País de cada conversación/contacto/cotización, para partir el dashboard por
// línea de Vicky (CL/CO/PE/MX). El país viene de vic_v3_conversations.country;
// si falta, se resuelve por prefijo telefónico (y Chile como último recurso,
// que es el comportamiento histórico del dash).
async function fetchPaisesConversaciones(): Promise<{
  paisPorConv: Map<string, Pais>
  paisPorContacto: Map<string, Pais>
  paisPorQuote: Map<string, Pais>
}> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/vic_v3_conversations?select=id,contact,country,formal_quote_id&limit=10000`,
    {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      cache: "no-store",
    },
  )
  const rows = res.ok
    ? ((await res.json()) as Array<{ id: string; contact: string; country: string | null; formal_quote_id: string | null }>)
    : []
  const paisPorConv = new Map<string, Pais>()
  const paisPorContacto = new Map<string, Pais>()
  const paisPorQuote = new Map<string, Pais>()
  for (const r of rows) {
    const declarado = String(r.country || "").toLowerCase()
    const p: Pais = (declarado in PAISES ? declarado : paisDeTelefono(digits(r.contact)) || "cl") as Pais
    paisPorConv.set(r.id, p)
    paisPorContacto.set(digits(r.contact), p)
    if (r.formal_quote_id) paisPorQuote.set(r.formal_quote_id, p)
  }
  return { paisPorConv, paisPorContacto, paisPorQuote }
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
  accionable: string | null
  hallazgos: Array<{ tipo: string; detalle: string }> | null
  analyzed_at: string | null
}

async function fetchAnalysis(): Promise<Row[]> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/vic_v3_conversation_analysis?select=conversation_id,contact,grupo,sub_bucket,cotizacion_outcome,motivo_no_cierre,es_cliente_actual,resumen,accionable,hallazgos,analyzed_at`,
    {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      cache: "no-store",
    },
  )
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return (await res.json()) as Row[]
}

const digits = (c: string) => (c || "").replace(/\D/g, "")

// ── Branding GeoVictoria (skill geovictoria-design, 04-ago) ─────────────────
// BR Sonoma para títulos, Nunito para UI; paleta oficial: #ffbb00 (CTA),
// #00aff2 (links/data), #646464 (SOLO tipografía), blanco de fondo. Assets
// servidos desde /public/gv/.
const GV_FONT_CSS = `
  @font-face{font-family:"BR Sonoma";src:url("/gv/fonts/BRSonoma-SemiBold.otf") format("opentype");font-weight:600;font-display:swap}
  @font-face{font-family:"BR Sonoma";src:url("/gv/fonts/BRSonoma-Bold.otf") format("opentype");font-weight:700;font-display:swap}
  @font-face{font-family:"Nunito";src:url("/gv/fonts/Nunito-Regular.ttf") format("truetype");font-weight:400;font-display:swap}
  @font-face{font-family:"Nunito";src:url("/gv/fonts/Nunito-SemiBold.ttf") format("truetype");font-weight:600;font-display:swap}
  @font-face{font-family:"Nunito";src:url("/gv/fonts/Nunito-Bold.ttf") format("truetype");font-weight:700;font-display:swap}`
const GV_BODY_FONT = `"Nunito",-apple-system,Segoe UI,Roboto,Arial,sans-serif`
const GV_TITLE_FONT = `"BR Sonoma","Nunito",-apple-system,Segoe UI,Roboto,Arial,sans-serif`

// ── Países soportados por el dashboard (pedido Lalo 04-ago: sumar PE y MX) ──
type Pais = "cl" | "co" | "pe" | "mx"
const PAISES: Record<Pais, { nombre: string; label: string; bandera: string; prefijo: string }> = {
  cl: { nombre: "CHILE", label: "Chile", bandera: "🇨🇱", prefijo: "56" },
  co: { nombre: "COLOMBIA", label: "Colombia", bandera: "🇨🇴", prefijo: "57" },
  pe: { nombre: "PERÚ", label: "Perú", bandera: "🇵🇪", prefijo: "51" },
  mx: { nombre: "MÉXICO", label: "México", bandera: "🇲🇽", prefijo: "52" },
}
/** País por prefijo telefónico ("" si no calza con ninguno soportado). */
const paisDeTelefono = (tel: string): Pais | "" => {
  if (tel.startsWith("56")) return "cl"
  if (tel.startsWith("57")) return "co"
  if (tel.startsWith("521") || (tel.startsWith("52") && tel.length === 12)) return "mx"
  if (tel.startsWith("51")) return "pe"
  return ""
}

// ── Funnel por ORIGEN (pedido Lalo 21-jul): outbound (leads asignados) vs
// inbound (el cliente llegó solo). Señales:
//   - vic_outbound_cadence: un registro por toque 0 enviado → contacto OUTBOUND.
//   - Leads Zoho "1. No contactado" de Vicky: asignados aún sin toque.
//   - vic_v3_conversations.last_user_at: el contacto RESPONDIÓ alguna vez.
async function fetchOrigenFunnel(pais: Pais): Promise<{
  toque0: Set<string>
  sinContactar: number
  asignadosTotal: number
  convertidos: Set<string>
  respondio: Set<string>
  /** Teléfonos detrás de los contadores, para poder intersectarlos con los
   * filtros globales de Estado/Propietario (los números de arriba se mantienen
   * como fuente de verdad cuando no hay filtro). */
  asignados: Set<string>
  sinContactarTels: Set<string>
}> {
  const h = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  // Universo CERRADO por prefijo (22-jul): cada país cuenta SOLO su prefijo
  // (+56 CL, +57 CO, +51 PE, +52 MX).
  const delPais = (c: string) => paisDeTelefono(c) === pais
  // Inicio del programa outbound actual (primer lead asignado a Vicky):
  // excluye los leads de la era telemarketing 2025 que también son de Vicky.
  const PROGRAMA_DESDE = "2026-07-16T00:00:00-04:00"
  const [cadRes, convRes, leadsRes, convertedRes] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/vic_outbound_cadence?select=contact`, { headers: h, cache: "no-store" }),
    fetch(`${SUPABASE_URL}/rest/v1/vic_v3_conversations?select=contact,last_user_at`, { headers: h, cache: "no-store" }),
    (async () => {
      try {
        const token = await getZohoAccessToken()
        // TODOS los leads vivos de Vicky (cualquier estado): el conteo por
        // estado '1. No contactado' subcontaba los asignados (fix 22-jul).
        return await fetch(`${ZOHO_API_DOMAIN}/crm/v3/coql`, {
          method: "POST",
          headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            select_query: `select id, Phone from Leads where Owner.id = ${VICKY_CREATOR_ID} and Created_Time > '${PROGRAMA_DESDE}' limit 200`,
          }),
          cache: "no-store",
        })
      } catch {
        return null
      }
    })(),
    (async () => {
      try {
        // Leads CONVERTIDOS a deal (les mandamos cotización): desaparecen de
        // las consultas normales de Leads pero SON leads asignados (fix
        // 22-jul, pedido Lalo: "considera también los convertidos").
        const token = await getZohoAccessToken()
        const criteria = encodeURIComponent(`(Owner.id:equals:${VICKY_CREATOR_ID})`)
        return await fetch(
          `${ZOHO_API_DOMAIN}/crm/v3/Leads/search?criteria=${criteria}&converted=true&fields=id,Phone,Created_Time&per_page=200`,
          { headers: { Authorization: `Zoho-oauthtoken ${token}` }, cache: "no-store" },
        )
      } catch {
        return null
      }
    })(),
  ])
  const cad = cadRes.ok ? ((await cadRes.json()) as Array<{ contact: string }>) : []
  const convs = convRes.ok
    ? ((await convRes.json()) as Array<{ contact: string; last_user_at: string | null }>)
    : []
  const toque0 = new Set(cad.map((c) => digits(c.contact)).filter((c) => c && delPais(c) && !isTestContact(c)))
  // Unión por teléfono: cadencia + leads vivos + convertidos (sin duplicar).
  const asignados = new Set<string>(toque0)
  const sinContactarTels = new Set<string>()
  let sinContactar = 0
  if (leadsRes && leadsRes.ok) {
    const data = (await leadsRes.json().catch(() => ({}))) as {
      data?: Array<{ Phone?: string | null }>
    }
    for (const l of data?.data || []) {
      const tel = digits(String(l.Phone || ""))
      if (tel && delPais(tel) && !isTestContact(tel)) asignados.add(tel)
      if (tel && delPais(tel)) sinContactarTels.add(tel)
    }
    sinContactar = (data?.data || []).filter((l) => delPais(digits(String(l.Phone || "")))).length
  }
  // Set aparte de CONVERTIDOS (hecho duro de Zoho: el lead pasó a deal porque
  // se le envió cotización) — etapa propia del funnel desde el 22-jul.
  const convertidos = new Set<string>()
  if (convertedRes && convertedRes.ok) {
    const data = (await convertedRes.json().catch(() => ({}))) as {
      data?: Array<{ Phone?: string | null; Created_Time?: string }>
    }
    for (const l of data?.data || []) {
      if (String(l.Created_Time || "") < "2026-07-16") continue
      const tel = digits(String(l.Phone || ""))
      if (tel && delPais(tel) && !isTestContact(tel)) {
        asignados.add(tel)
        convertidos.add(tel)
      }
    }
  }
  return {
    toque0,
    sinContactar,
    asignadosTotal: asignados.size,
    convertidos,
    respondio: new Set(convs.filter((c) => c.last_user_at).map((c) => digits(c.contact))),
    asignados,
    sinContactarTels,
  }
}

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

// ── LISTADO COMERCIAL VIVO (pedido Lalo 03-ago) ─────────────────────────────
// Una fila por caso comercial con su estado más avanzado, la fecha/hora de ESE
// estado, el estado del registro en Zoho y el propietario. Filtros de fecha,
// estado y propietario en el navegador (la sección trae los últimos 30 días).
// Escalera de estados (cada uno pisa al anterior):
//   Sin contactar → Contactado → En levantamiento → Preform enviado →
//   Formal enviada → Aceptada → Pagada

type FilaListado = {
  empresa: string
  contacto: string
  estado: string
  fechaIso: string
  estadoZoho: string
  propietario: string
  /** Inicio de la conversación (o creación del lead si nunca conversó). */
  primerContactoIso: string
  /** id de la conversación para el link al chat (vista ?conv= del embudo). */
  convId: string
  /** Próxima acción para el ejecutivo: la del análisis LLM, o un respaldo
   * determinístico por estado si la conversación aún no fue analizada. */
  accionable: string
  /** Resumen del análisis, como tooltip del accionable. */
  resumen: string
  /** Última respuesta del cliente y último mensaje de la conversación — junto
   * con fechaIso y primerContactoIso definen la "actividad" del caso para el
   * filtro global Desde–Hasta. */
  lastUserIso: string
  updatedIso: string
  /** Último contacto real con el cliente: lo más reciente entre el chat de
   * WhatsApp y la actividad registrada en Zoho (lead/deal/cotización). */
  ultimoContactoIso: string
  /** Link directo al registro en Zoho: deal → lead → cotización. */
  zohoUrl: string
}

/** Máximo de fechas ISO comparando por instante real (los formatos mezclan
 * offsets de Supabase y Zoho — la comparación lexicográfica miente). */
function maxIso(...vals: Array<string | null | undefined>): string {
  let best = ""
  let bestT = -Infinity
  for (const v of vals) {
    const s = String(v || "")
    const t = Date.parse(s)
    if (Number.isFinite(t) && t > bestT) {
      bestT = t
      best = s
    }
  }
  return best
}

// El org es el mismo que usan los correos del PTV y el dashboard viejo.
const ZOHO_CRM_URL = "https://crm.zoho.com/crm/org685875245"
function zohoUrlDe(dealId?: string | null, leadId?: string | null, quoteId?: string | null): string {
  if (dealId) return `${ZOHO_CRM_URL}/tab/Potentials/${dealId}`
  if (leadId) return `${ZOHO_CRM_URL}/tab/Leads/${leadId}`
  if (quoteId) return `${ZOHO_CRM_URL}/tab/${QUOTE_MODULE}/${quoteId}`
  return ""
}

/** Respaldo determinístico del accionable cuando el análisis aún no corre. */
function accionableFallback(estado: string, motivo: string | null): string {
  switch (estado) {
    case "Pagada":
      return "Venta cerrada: llamar para dar la bienvenida y acompañar el onboarding."
    case "Aceptada":
      return "Aceptó la cotización: contactar para ayudarle a completar el pago."
    case "Formal enviada":
      return "Cotización en su correo: llamar para resolver dudas y empujar el cierre."
    case "Preform enviado":
      return `Vio el precio y no pidió la formal${motivo ? ` (motivo: ${motivo.replace(/_/g, " ")})` : ""}: llamar para destrabar.`
    case "En levantamiento":
      return "Conversación activa con Vicky: intervenir solo si se estanca."
    case "Contactado":
      return "Respondió sin entrar a cotizar: retomar el interés con una llamada."
    default:
      return "No respondió el toque inicial: intentar una llamada directa."
  }
}

type ConvListado = { id: string; contact: string; started_at: string | null; last_user_at: string | null; updated_at: string | null }

async function fetchConvsListado(): Promise<ConvListado[]> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/vic_v3_conversations?select=id,contact,started_at,last_user_at,updated_at&order=started_at.desc&limit=2000`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, cache: "no-store" },
  )
  return res.ok ? ((await res.json().catch(() => [])) as ConvListado[]) : []
}

/** Último mensaje de PRECIO por contacto (el preform del chat), con timestamp
 * real desde vic_v3_messages — misma señal que usa el conteo de preforms. */
async function fetchPreformAts(convs: ConvListado[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const porConvId = new Map(convs.map((c) => [c.id, c.contact]))
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/vic_v3_messages?role=eq.assistant&or=(content.ilike.*Resumen%20mensual*,content.ilike.*Total%20mensual%20con%20IVA*)&select=conversation_id,at&order=at.desc&limit=1000`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, cache: "no-store" },
  )
  if (!res.ok) return out
  const rows = (await res.json().catch(() => [])) as Array<{ conversation_id: string; at: string }>
  for (const r of rows) {
    const contact = porConvId.get(r.conversation_id)
    // order=at.desc: la primera aparición por contacto es su último preform.
    if (contact && !out.has(digits(contact))) out.set(digits(contact), r.at)
  }
  return out
}

type LeadListado = {
  id?: string
  Full_Name?: string
  Company?: string | null
  Phone?: string | null
  Lead_Status?: string | null
  Created_Time?: string
  Last_Activity_Time?: string | null
  "Owner.first_name"?: string | null
  "Owner.last_name"?: string | null
  /** Shape del search API (los convertidos vienen por search, no por COQL). */
  Owner?: { name?: string } | null
  Converted_Deal?: { id?: string } | null
}

function propietarioDeLead(l: LeadListado): string {
  return (
    `${l["Owner.first_name"] || ""} ${l["Owner.last_name"] || ""}`.trim() ||
    String(l.Owner?.name || "").trim() ||
    "—"
  )
}

/** Leads del flujo de Vicky (vivos + convertidos) de los últimos 30 días, y
 * los deals creados por Vicky (para etapa/dueño de los preform sin quote). */
async function fetchZohoListado(contactosConocidos: Set<string>): Promise<{
  leads: LeadListado[]
  dealsPorId: Map<string, { stage: string; owner: string; lastActivity: string }>
}> {
  const leads: LeadListado[] = []
  const dealsPorId = new Map<string, { stage: string; owner: string; lastActivity: string }>()
  try {
    const token = await getZohoAccessToken()
    const H = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }
    // split("T")[0] y no slice: el guard de funnel-filtro-fechas prohíbe el
    // patrón del bug de inputs; acá es un literal para COQL, no un value de UI.
    const desde = new Date(Date.now() - 30 * 24 * 3600e3).toISOString().split("T")[0]
    const [vivosRes, convertidosRes, dealsRes] = await Promise.all([
      fetch(`${ZOHO_API_DOMAIN}/crm/v3/coql`, {
        method: "POST", headers: H, cache: "no-store",
        body: JSON.stringify({
          select_query: `select id, Full_Name, Company, Phone, Lead_Status, Created_Time, Last_Activity_Time, Owner.first_name, Owner.last_name from Leads where Created_By = ${VICKY_CREATOR_ID} and Created_Time >= '${desde}T00:00:00-04:00' limit 200`,
        }),
      }),
      // Convertidos: la búsqueda por criterio trae TODOS los de la org; se
      // filtran después por los contactos que conocemos de las conversaciones.
      fetch(
        `${ZOHO_API_DOMAIN}/crm/v3/Leads/search?criteria=${encodeURIComponent(`(Created_Time:greater_equal:${desde}T00:00:00-04:00)`)}&converted=true&fields=id,Full_Name,Company,Phone,Lead_Status,Created_Time,Last_Activity_Time,Converted_Deal,Owner&per_page=200`,
        { headers: H, cache: "no-store" },
      ),
      fetch(`${ZOHO_API_DOMAIN}/crm/v3/coql`, {
        method: "POST", headers: H, cache: "no-store",
        body: JSON.stringify({
          select_query: `select id, Stage, Last_Activity_Time, Owner.first_name, Owner.last_name from Deals where Created_By = ${VICKY_CREATOR_ID} and Created_Time >= '${desde}T00:00:00-04:00' limit 200`,
        }),
      }),
    ])
    if (vivosRes.ok && vivosRes.status !== 204) {
      const d = (await vivosRes.json().catch(() => ({}))) as { data?: LeadListado[] }
      leads.push(...(d?.data || []))
    }
    if (convertidosRes.ok && convertidosRes.status !== 204) {
      const d = (await convertidosRes.json().catch(() => ({}))) as { data?: LeadListado[] }
      for (const l of d?.data || []) {
        if (contactosConocidos.has(digits(String(l.Phone || "")))) leads.push(l)
      }
    }
    if (dealsRes.ok && dealsRes.status !== 204) {
      const d = (await dealsRes.json().catch(() => ({}))) as {
        data?: Array<{ id: string; Stage?: string; Last_Activity_Time?: string; "Owner.first_name"?: string; "Owner.last_name"?: string }>
      }
      for (const dl of d?.data || []) {
        dealsPorId.set(String(dl.id), {
          stage: String(dl.Stage || ""),
          owner: `${dl["Owner.first_name"] || ""} ${dl["Owner.last_name"] || ""}`.trim(),
          lastActivity: String(dl.Last_Activity_Time || ""),
        })
      }
    }
    // Deals de leads convertidos que NO creó Vicky (caso Chanares 03-ago: la
    // SDR convirtió el lead a mano y el deal quedó fuera del COQL por
    // Created_By) — se completan por id para que el listado muestre SIEMPRE
    // la etapa y el dueño del deal cuando el lead ya es deal.
    const faltantes = [
      ...new Set(
        leads
          .map((l) => String(l.Converted_Deal?.id || ""))
          .filter((id) => id && !dealsPorId.has(id)),
      ),
    ].slice(0, 50)
    if (faltantes.length) {
      const rExtra = await fetch(`${ZOHO_API_DOMAIN}/crm/v3/coql`, {
        method: "POST",
        headers: { Authorization: `Zoho-oauthtoken ${await getZohoAccessToken()}`, "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          select_query: `select id, Stage, Last_Activity_Time, Owner.first_name, Owner.last_name from Deals where id in (${faltantes.join(",")}) limit ${faltantes.length}`,
        }),
      })
      if (rExtra.ok && rExtra.status !== 204) {
        const d = (await rExtra.json().catch(() => ({}))) as {
          data?: Array<{ id: string; Stage?: string; Last_Activity_Time?: string; "Owner.first_name"?: string; "Owner.last_name"?: string }>
        }
        for (const dl of d?.data || []) {
          dealsPorId.set(String(dl.id), {
            stage: String(dl.Stage || ""),
            owner: `${dl["Owner.first_name"] || ""} ${dl["Owner.last_name"] || ""}`.trim(),
            lastActivity: String(dl.Last_Activity_Time || ""),
          })
        }
      }
    }
  } catch (e) {
    console.warn("[vic-funnel] listado Zoho falló:", e instanceof Error ? e.message : e)
  }
  return { leads, dealsPorId }
}

function empresaDeQuote(q: RawAceptada): string {
  return (
    String(q["Cuenta_Asociada.Account_Name"] || "").trim() ||
    String(q.Name || "").replace(/^Cotización\s+/i, "").replace(/\s+-\s+\d{4}-\d{2}-\d{2}$/, "").trim() ||
    "(sin nombre)"
  )
}

function construirListadoComercial(params: {
  quotes: RawAceptada[]
  leads: LeadListado[]
  dealsPorId: Map<string, { stage: string; owner: string; lastActivity: string }>
  convs: ConvListado[]
  preformAt: Map<string, string>
  analysisRows: Row[]
  pais: Pais
}): FilaListado[] {
  const { quotes, leads, dealsPorId, convs, preformAt, analysisRows, pais } = params
  const delPais = (c: string) => paisDeTelefono(c) === pais
  const testSet = testContactSet()
  const convPorContacto = new Map(convs.map((c) => [digits(c.contact), c]))
  const analisisPorContacto = new Map(analysisRows.map((r) => [digits(r.contact), r]))
  const corte30d = Date.now() - 30 * 24 * 3600e3
  const filas: FilaListado[] = []
  const cubiertos = new Set<string>()
  const leadPorTel = new Map<string, LeadListado>()
  for (const l of leads) {
    const t = digits(String(l.Phone || ""))
    if (t && !leadPorTel.has(t)) leadPorTel.set(t, l)
  }

  // 1. Cotizaciones (formal en adelante). ÚLTIMA quote por contacto; las sin
  //    teléfono van como fila propia.
  const quotesOrdenadas = [...quotes].sort((a, b) => String(b.Created_Time || "").localeCompare(String(a.Created_Time || "")))
  for (const q of quotesOrdenadas) {
    const tel = digits(String(q.Tel_fono_Contacto || ""))
    if (tel && (!delPais(tel) || isTestContact(tel, testSet))) continue
    if (tel && cubiertos.has(tel)) continue
    if (Date.parse(String(q.Created_Time || "")) < corte30d) continue
    if (tel) cubiertos.add(tel)
    const pagada = Boolean(String(q.Onboarding_Link || "").trim())
    const aceptada = String(q.Estado_Cotizacion || "").toLowerCase().includes("acept")
    const estado = pagada ? "Pagada" : aceptada ? "Aceptada" : "Formal enviada"
    const fechaIso = pagada || aceptada
      ? String(q.Fecha_Hora_Cotizacion || q.Modified_Time || q.Created_Time || "")
      : String(q.Created_Time || "")
    const conv = tel ? convPorContacto.get(tel) : undefined
    const ana = tel ? analisisPorContacto.get(tel) : undefined
    filas.push({
      empresa: empresaDeQuote(q),
      contacto: tel ? `+${tel}` : "—",
      estado,
      fechaIso,
      estadoZoho: String(q["Deal_Asociado.Stage"] || "").trim() || "—",
      propietario: `${q["Owner.first_name"] || ""} ${q["Owner.last_name"] || ""}`.trim() || "—",
      primerContactoIso: String(conv?.started_at || ""),
      convId: String(conv?.id || ""),
      accionable: String(ana?.accionable || "").trim() || accionableFallback(estado, ana?.motivo_no_cierre || null),
      resumen: String(ana?.resumen || ""),
      lastUserIso: String(conv?.last_user_at || ""),
      updatedIso: String(conv?.updated_at || ""),
      ultimoContactoIso: maxIso(
        conv?.updated_at,
        q.Modified_Time,
        tel ? leadPorTel.get(tel)?.Last_Activity_Time : "",
        (() => {
          const dealId = String(q["Deal_Asociado.id"] || "") || String((tel && leadPorTel.get(tel)?.Converted_Deal?.id) || "")
          return dealId ? dealsPorId.get(dealId)?.lastActivity : ""
        })(),
      ),
      zohoUrl: zohoUrlDe(
        String(q["Deal_Asociado.id"] || "") || String((tel && leadPorTel.get(tel)?.Converted_Deal?.id) || ""),
        String((tel && leadPorTel.get(tel)?.id) || ""),
        String(q.id || ""),
      ),
    })
  }

  // 2. Preform sin formal: el precio se mostró en el chat y no hay quote.
  for (const [tel, at] of preformAt) {
    if (cubiertos.has(tel) || !delPais(tel) || isTestContact(tel, testSet)) continue
    if (Date.parse(at) < corte30d) continue
    cubiertos.add(tel)
    const lead = leads.find((l) => digits(String(l.Phone || "")) === tel)
    const deal = lead?.Converted_Deal?.id ? dealsPorId.get(String(lead.Converted_Deal.id)) : undefined
    const conv = convPorContacto.get(tel)
    const ana = analisisPorContacto.get(tel)
    filas.push({
      empresa: String(lead?.Company || "").trim() || "(por identificar)",
      contacto: `+${tel}`,
      estado: "Preform enviado",
      fechaIso: at,
      estadoZoho: deal?.stage || String(lead?.Lead_Status || "").trim() || "—",
      propietario: deal?.owner || (lead ? propietarioDeLead(lead) : "—"),
      primerContactoIso: String(conv?.started_at || lead?.Created_Time || ""),
      convId: String(conv?.id || ""),
      accionable: String(ana?.accionable || "").trim() || accionableFallback("Preform enviado", ana?.motivo_no_cierre || null),
      resumen: String(ana?.resumen || ""),
      lastUserIso: String(conv?.last_user_at || ""),
      updatedIso: String(conv?.updated_at || ""),
      ultimoContactoIso: maxIso(conv?.updated_at, lead?.Last_Activity_Time, deal?.lastActivity),
      zohoUrl: zohoUrlDe(String(lead?.Converted_Deal?.id || ""), String(lead?.id || ""), null),
    })
  }

  // 3. Leads sin precio aún: Sin contactar / Contactado / En levantamiento.
  for (const l of leads) {
    const tel = digits(String(l.Phone || ""))
    if (!tel || cubiertos.has(tel) || !delPais(tel) || isTestContact(tel, testSet)) continue
    if (Date.parse(String(l.Created_Time || "")) < corte30d) continue
    cubiertos.add(tel)
    const conv = convPorContacto.get(tel)
    const ana = analisisPorContacto.get(tel)
    const respondio = Boolean(conv?.last_user_at)
    const enLevantamiento = respondio && ana?.sub_bucket === "cotizacion"
    const estadoLead = !respondio ? "Sin contactar" : enLevantamiento ? "En levantamiento" : "Contactado"
    // Lead ya CONVERTIDO a deal (p. ej. por una SDR): el estado en Zoho y el
    // propietario son los del DEAL, no los del lead congelado (caso Chanares:
    // el dash decía "4. Calificado / —" mientras el deal era de Grey).
    const deal = l.Converted_Deal?.id ? dealsPorId.get(String(l.Converted_Deal.id)) : undefined
    filas.push({
      empresa: String(l.Company || "").trim() || String(l.Full_Name || "").trim() || "(por identificar)",
      contacto: `+${tel}`,
      estado: estadoLead,
      fechaIso: respondio ? String(conv?.last_user_at || "") : String(l.Created_Time || ""),
      estadoZoho: deal?.stage || String(l.Lead_Status || "").trim() || "—",
      propietario: deal?.owner || propietarioDeLead(l),
      primerContactoIso: String(conv?.started_at || l.Created_Time || ""),
      convId: String(conv?.id || ""),
      accionable: String(ana?.accionable || "").trim() || accionableFallback(estadoLead, ana?.motivo_no_cierre || null),
      resumen: String(ana?.resumen || ""),
      lastUserIso: String(conv?.last_user_at || ""),
      updatedIso: String(conv?.updated_at || ""),
      ultimoContactoIso: maxIso(conv?.updated_at, l.Last_Activity_Time, deal?.lastActivity),
      zohoUrl: zohoUrlDe(String(l.Converted_Deal?.id || ""), String(l.id || ""), null),
    })
  }

  return filas.sort((a, b) => b.fechaIso.localeCompare(a.fechaIso))
}

/** Escalera de estados del listado — también alimenta el filtro global. */
const ESTADOS_LISTADO = ["Sin contactar", "Contactado", "En levantamiento", "Preform enviado", "Formal enviada", "Aceptada", "Pagada"]

// ── COLA DE GESTIÓN (pedido Lalo 04-ago): la vista principal del dash es una
// lista de trabajo — a quién llamar/contactar AHORA, segmentado por tipo de
// accionable (derivado por regla desde la escalera) y por horario.
type TipoAccion = { id: string; label: string; emoji: string; prioridad: number }
const TIPOS_ACCION: TipoAccion[] = [
  { id: "cerrar_pago", label: "Cerrar pago", emoji: "💰", prioridad: 7 },
  { id: "completar_datos", label: "Completar datos", emoji: "📋", prioridad: 6 },
  { id: "empujar_cotizacion", label: "Empujar cotización", emoji: "📄", prioridad: 5 },
  { id: "destrabar_precio", label: "Destrabar precio", emoji: "🔓", prioridad: 4 },
  { id: "primer_contacto", label: "Primer contacto", emoji: "📞", prioridad: 3 },
  { id: "retomar", label: "Retomar interés", emoji: "🔄", prioridad: 2 },
  { id: "bienvenida", label: "Bienvenida post-venta", emoji: "🎉", prioridad: 1 },
]

/** Tipo de acción por regla determinística (estado + señales del accionable). */
function tipoAccionDe(f: FilaListado): TipoAccion | null {
  const texto = `${f.accionable} ${f.resumen}`.toLowerCase()
  const faltanDatos = /\brut\b|correo|email|completar datos|faltan? dato/.test(texto)
  const t = (id: string) => TIPOS_ACCION.find((x) => x.id === id) || null
  switch (f.estado) {
    case "Aceptada":
      return t("cerrar_pago")
    case "Pagada": {
      // Bienvenida solo la primera semana; después sale de la cola.
      const dias = (Date.now() - Date.parse(f.fechaIso || "")) / 864e5
      return Number.isFinite(dias) && dias <= 7 ? t("bienvenida") : null
    }
    case "Formal enviada":
      return faltanDatos ? t("completar_datos") : t("empujar_cotizacion")
    case "Preform enviado":
      return faltanDatos ? t("completar_datos") : t("destrabar_precio")
    case "Sin contactar":
      return t("primer_contacto")
    case "Contactado":
    case "En levantamiento":
      return t("retomar")
    default:
      return null
  }
}

const TZ_OFFSET: Record<Pais, number> = { cl: -4, co: -5, pe: -5, mx: -6 }

/** Hora local del cliente (por prefijo del teléfono) y si es llamable ahora
 * (L-V, 8-18 h local; los feriados por país quedan para vic_holidays). */
function horaLocalCliente(tel: string, paisDash: Pais): { hora: string; llamable: boolean } {
  const p = paisDeTelefono(tel) || paisDash
  const d = new Date(Date.now() + TZ_OFFSET[p] * 3600e3)
  const h = d.getUTCHours()
  const dow = d.getUTCDay()
  return {
    hora: `${String(h).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`,
    llamable: dow >= 1 && dow <= 5 && h >= 8 && h < 18,
  }
}

/** Caso listo para gestionar — lo consumen la vista HTML, el modo JSON del
 * dash y el resumen diario por correo. */
type CasoGestion = {
  empresa: string
  contacto: string
  propietario: string
  convId: string
  tipoId: string
  tipoLabel: string
  tipoEmoji: string
  prioridad: number
  urgencia: string
  urgenciaColor: string
  horaLocal: string
  llamable: boolean
  monto: string
  diasSinContacto: number
  accionable: string
  resumen: string
  score: number
  /** Columnas heredadas del listado comercial (fusión 04-ago). */
  primerContactoIso: string
  estado: string
  fechaEstadoIso: string
  /** Último contacto real (chat o actividad en Zoho) — manda en la columna
   * Estado y en el contador de días sin contacto. */
  ultimoContactoIso: string
  estadoZoho: string
  /** Link directo al registro en Zoho (deal → lead → cotización). */
  zohoUrl: string
  /** Ya marcada como gestionada (se muestra atenuada, con deshacer). */
  gestionado: boolean
}

function construirCasosGestion(params: {
  filas: FilaListado[]
  gestionados: Map<string, string>
  montos: Map<string, { uf: number | null; clp: number | null }>
  pais: Pais
}): { casos: CasoGestion[]; nGestionados: number } {
  const { filas, gestionados, montos, pais } = params
  const conTipo = filas
    // Deal en "Cierre Perdido" en Zoho → fuera de la cola de gestión (pedido
    // Lalo 05-ago): la oportunidad ya se dio por perdida, no hay acción.
    .filter((f) => !/perdido/i.test(f.estadoZoho))
    .map((f) => ({ f, tipo: tipoAccionDe(f) }))
    .filter((x): x is { f: FilaListado; tipo: TipoAccion } => x.tipo !== null)
  const nGestionados = conTipo.filter((x) => gestionados.has(digits(x.f.contacto))).length

  const diasSin = (f: FilaListado) => {
    const t = Date.parse(f.ultimoContactoIso || f.updatedIso || f.fechaIso || "")
    return Number.isFinite(t) ? (Date.now() - t) / 864e5 : 99
  }
  const casos = conTipo.map(({ f, tipo }) => {
    const d = digits(f.contacto)
    const dias = diasSin(f)
    const limite = tipo.prioridad >= 5 ? 1 : 2 // los calientes vencen antes
    const urg = dias > limite * 2 ? { label: "Vencido", color: "#C62828" } : dias > limite ? { label: "Hoy", color: "#F9A825" } : { label: "Al día", color: "#2E7D32" }
    const m = montos.get(d)
    // La UF existe solo en Chile (pedido Lalo 04-ago): en CO/MX el monto es
    // moneda local con $, en PE con S/ — venga en el campo que venga (los
    // punteros de esos países guardan el monto local en uf o en clp).
    const simbolo = pais === "pe" ? "S/ " : "$"
    const montoTxt =
      pais === "cl"
        ? m?.uf
          ? `UF ${m.uf.toLocaleString("es-CL", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`
          : m?.clp
            ? `$${Math.round(m.clp).toLocaleString("es-CL")}`
            : "—"
        : m?.clp
          ? `${simbolo}${Math.round(m.clp).toLocaleString("es-CL")}`
          : m?.uf
            ? `${simbolo}${Math.round(m.uf).toLocaleString("es-CL")}`
            : "—"
    const montoUF = m?.uf || (m?.clp ? m.clp / 40000 : 0)
    const hl = horaLocalCliente(d, pais)
    return {
      empresa: f.empresa,
      contacto: d,
      propietario: f.propietario,
      convId: f.convId,
      tipoId: tipo.id,
      tipoLabel: tipo.label,
      tipoEmoji: tipo.emoji,
      prioridad: tipo.prioridad,
      urgencia: urg.label,
      urgenciaColor: urg.color,
      horaLocal: hl.hora,
      llamable: hl.llamable,
      monto: montoTxt,
      diasSinContacto: Math.round(dias * 10) / 10,
      accionable: f.accionable,
      resumen: f.resumen,
      score: tipo.prioridad * 100 + Math.min(montoUF, 50) * 2 + Math.min(dias, 14),
      primerContactoIso: f.primerContactoIso,
      estado: f.estado,
      fechaEstadoIso: f.fechaIso,
      ultimoContactoIso: f.ultimoContactoIso,
      estadoZoho: f.estadoZoho,
      zohoUrl: f.zohoUrl,
      gestionado: gestionados.has(d),
    }
  })
  casos.sort((a, b) => b.prioridad - a.prioridad || b.score - a.score)
  return { casos, nGestionados }
}

function renderColaGestion(casos: CasoGestion[], nGestionados: number, key: string, descargaQS = ""): string {
  const activos = casos.filter((c) => !c.gestionado)
  const fila = (c: CasoGestion): string => {
    const dias = c.diasSinContacto
    // "Listo" (✔/↩) en grande, primera columna de la fila.
    const btn = c.gestionado
      ? `<button class="btnGest" data-contact="${esc(c.contacto)}" data-estado="gestionado" title="Deshacer: volver a la cola" style="background:#fff3e0;color:#7a4b00;border:1px solid #ffcc80;border-radius:8px;padding:8px 12px;font-size:17px;cursor:pointer">↩</button>`
      : `<button class="btnGest" data-contact="${esc(c.contacto)}" title="Pendiente — al gestionarlo márcalo acá (pide registro y guarda nota en Zoho)" style="background:#fffdf5;color:#92700c;border:1px dashed #d4b106;border-radius:8px;padding:8px 12px;font-size:17px;cursor:pointer">⏳</button>`
    // WhatsApp reconocible pero compacto (solo el ícono, en verde oficial).
    const btnWa = `<a href="https://wa.me/${esc(c.contacto)}" target="_blank" title="Abrir chat de WhatsApp" style="background:#25D366;color:#ffffff;text-decoration:none;padding:8px 11px;border-radius:8px;font-size:16px;display:inline-block;white-space:nowrap">💬</a>`
    // Fecha compacta apilada (fecha arriba, hora abajo) — usa la mitad de ancho.
    const fechaCompacta = (iso: string) => {
      const [fp, ...hp] = fmtSantiago(iso).split(", ")
      return `${fp}<div class="sub" style="margin:0;font-size:11px">${hp.join(", ")}</div>`
    }
    return `<tr data-contact="${esc(c.contacto)}"${c.gestionado ? ` class="filaGest" style="opacity:.4;display:none"` : ""}>
          <td class="tdBtn" style="white-space:nowrap;vertical-align:middle">${btn}</td>
          <td class="tdEmp">${esc(c.empresa)}<div class="sub" style="margin:0;font-size:12px">+${esc(c.contacto)} · ${esc(c.propietario)}</div>${(() => {
            const links = [
              c.convId ? `<a href="?key=${encodeURIComponent(key)}&conv=${encodeURIComponent(c.convId)}" style="font-size:13px">📄 ver chat</a>` : "",
              c.zohoUrl ? `<a href="${esc(c.zohoUrl)}" target="_blank" rel="noopener" title="Abrir el registro en Zoho CRM" style="font-size:13px">🔗 Zoho</a>` : "",
            ].filter(Boolean).join(" · ")
            return links ? `<div style="margin-top:3px">${links}</div>` : ""
          })()}</td>
          <td data-l="Primer contacto" style="white-space:nowrap">${c.primerContactoIso ? fechaCompacta(c.primerContactoIso) : "—"}</td>
          <td data-l="Estado"><span class="tag">${esc(c.estado)}</span></td>
          <td data-l="Últ. actividad" style="white-space:nowrap" title="última actividad con el cliente: llamada, WhatsApp o nota/comentario del ejecutivo en Zoho">hace ${dias < 1 ? `${Math.round(dias * 24)} h` : `${Math.round(dias)} d`}${c.ultimoContactoIso ? `<div class="sub" style="margin:2px 0 0;font-size:11px">${fmtSantiago(c.ultimoContactoIso)}</div>` : ""}</td>
          <td data-l="Recurrente" style="white-space:nowrap;text-align:right">${c.monto}</td>
          <td data-l="Accionable">${esc(c.accionable)}${c.resumen ? `<div class="sub" style="margin:2px 0 0;font-size:12px">${esc(c.resumen)}</div>` : ""}</td>
          <td class="tdWa" style="white-space:nowrap;vertical-align:middle;padding-left:10px">${btnWa}</td>
        </tr>`
  }
  const secciones = TIPOS_ACCION.map((tipo) => {
    const grupo = activos.filter((c) => c.tipoId === tipo.id)
    const grupoGest = casos.filter((c) => c.gestionado && c.tipoId === tipo.id)
    if (!grupo.length && !grupoGest.length) return ""
    return `<div class="kgroup" style="margin-top:14px">${tipo.emoji} ${tipo.label} — ${grupo.length}</div>
    <div style="overflow-x:auto"><table>
      <thead><tr><th>Comentarios</th><th>Empresa / contacto · ejecutivo</th><th>Primer contacto</th><th>Estado</th><th>Última actividad en Zoho</th><th style="text-align:right">Recurrente</th><th style="width:38%">Accionable</th><th style="padding-left:10px">WA</th></tr></thead>
      <tbody>${grupo.map(fila).join("")}${grupoGest.map(fila).join("")}</tbody>
    </table></div>`
  }).join("")

  return `<style>.colaGest table th,.colaGest table td{padding:7px 6px;font-size:12.5px}
  /* Celular: cada fila de la cola se vuelve una tarjeta apilada. */
  @media (max-width:640px){
    .colaGest thead{display:none}
    .colaGest table,.colaGest tbody{display:block;width:100%}
    .colaGest tr{display:block;box-sizing:border-box;border:1px solid #dfe2e7;border-radius:12px;margin:0 0 10px;padding:10px 12px;background:#fff;position:relative}
    .colaGest table td{display:block;border:0;padding:2px 0;font-size:13px;white-space:normal !important;text-align:left !important;max-width:none !important}
    .colaGest td[data-l]::before{content:attr(data-l) ": ";font-size:11px;font-weight:700;color:#9aa0a8}
    .colaGest td.tdBtn{position:absolute;top:10px;right:12px;width:auto;padding:0}
    .colaGest td.tdWa{position:absolute;top:60px;right:12px;width:auto;padding:0 !important}
    .colaGest td.tdEmp{padding-right:70px;font-weight:700;min-height:44px}
    .colaGest td.tdEmp .sub{font-weight:400}
  }</style>
  <div class="card colaGest"><h2>📞 Para gestionar hoy <span class="pct" style="font-weight:400">— ${activos.length} oportunidades con acción pendiente${nGestionados ? ` · ${nGestionados} gestionadas · <a href="#" id="lnkVerGest" style="font-size:13px">mostrar</a>` : ""}</span>${descargaQS ? `<span style="float:right;font-weight:400;font-size:13px"><a href="?${descargaQS}&formato=csv" title="Descargar la cola completa en Excel (CSV)">⬇️ Excel</a> · <a href="?${descargaQS}&formato=impresion" target="_blank" title="Vista de impresión para guardar como PDF">🖨️ PDF</a></span>` : ""}</h2>
  ${activos.length || nGestionados ? secciones : `<p class="sub" style="margin:0">Nada pendiente con los filtros actuales. 🎉</p>`}
  <script>
    (function () {
      var KEYQ = "?key=${encodeURIComponent(key)}";
      // Viñeta flotante para el registro de gestión (en vez del prompt nativo).
      var pop = document.createElement("div");
      pop.style.cssText = "position:absolute;z-index:50;display:none;background:#fff;border:1px solid #d0d5db;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.18);padding:12px;width:300px;max-width:calc(100vw - 16px);box-sizing:border-box";
      pop.innerHTML = '<div style="font-size:13px;font-weight:600;margin-bottom:6px">Registro de la gestión <span style="color:#c62828">*</span></div>' +
        '<div style="font-size:12px;color:#6b7280;margin-bottom:6px">¿Qué hiciste o qué acordaste con el cliente? Se guarda como nota en Zoho.</div>' +
        '<textarea id="popNota" rows="3" style="width:100%;box-sizing:border-box;font-size:13px;padding:6px;border:1px solid #d0d5db;border-radius:6px;resize:vertical"></textarea>' +
        '<div style="margin-top:8px;display:flex;gap:8px;justify-content:flex-end">' +
        '<button id="popCancelar" style="background:#f3f4f6;color:#374151;border:1px solid #d0d5db;border-radius:6px;padding:5px 12px;font-size:12px;cursor:pointer">Cancelar</button>' +
        '<button id="popGuardar" style="background:#ffbb00;color:#fff;border:0;border-radius:6px;padding:5px 14px;font-size:12px;font-weight:700;cursor:pointer">Guardar ✔</button></div>';
      document.body.appendChild(pop);
      var nota = pop.querySelector("#popNota");
      var btnActual = null;
      function cerrar() { pop.style.display = "none"; nota.value = ""; nota.style.borderColor = "#d0d5db"; btnActual = null; }
      function abrir(b) {
        btnActual = b;
        var r = b.getBoundingClientRect();
        pop.style.display = "block";
        var left = r.right + window.scrollX + 10;
        var maxLeft = window.scrollX + document.documentElement.clientWidth - 310;
        if (left > maxLeft) left = Math.max(window.scrollX + 8, Math.min(r.left + window.scrollX, maxLeft));
        pop.style.left = left + "px";
        pop.style.top = (r.top + window.scrollY - 8) + "px";
        nota.focus();
      }
      pop.querySelector("#popCancelar").addEventListener("click", cerrar);
      document.addEventListener("keydown", function (ev) { if (ev.key === "Escape") cerrar(); });
      document.addEventListener("click", function (ev) {
        if (pop.style.display !== "none" && !pop.contains(ev.target) && !(btnActual && btnActual.contains(ev.target))) cerrar();
      });
      pop.querySelector("#popGuardar").addEventListener("click", async function () {
        var texto = (nota.value || "").trim();
        if (!texto) { nota.style.borderColor = "#c62828"; nota.focus(); return; }
        var b = btnActual;
        if (!b) return;
        var tr = b.closest("tr");
        this.disabled = true; this.textContent = "Guardando…";
        try {
          var res = await fetch(KEYQ + "&accion=gestionar&contact=" + encodeURIComponent(b.dataset.contact), {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: "nota=" + encodeURIComponent(texto),
          });
          // Sin ok del servidor el botón NO cambia (antes quedaba "gestionada"
          // en pantalla aunque el guardado hubiera fallado).
          if (!res.ok) throw new Error("HTTP " + res.status);
          tr.style.transition = "opacity .4s"; tr.style.opacity = "0.4";
          b.dataset.estado = "gestionado"; b.textContent = "↩"; b.title = "Deshacer: volver a la cola";
          b.style.background = "#fff3e0"; b.style.color = "#7a4b00"; b.style.border = "1px solid #ffcc80";
          cerrar();
        } catch (e) {
          alert("No se pudo guardar la gestión (el caso sigue pendiente). Revisa tu conexión e inténtalo de nuevo.");
        }
        this.disabled = false; this.textContent = "Guardar ✔";
      });
      function wire(b) {
        b.addEventListener("click", async function () {
          var tr = this.closest("tr");
          if (this.dataset.estado === "gestionado") {
            this.disabled = true; this.textContent = "…";
            try {
              var resU = await fetch(KEYQ + "&accion=desgestionar&contact=" + encodeURIComponent(this.dataset.contact), { method: "POST" });
              if (!resU.ok) throw new Error("HTTP " + resU.status);
              tr.style.opacity = "1"; tr.classList.remove("filaGest");
              this.dataset.estado = ""; this.textContent = "⏳"; this.title = "Pendiente — al gestionarlo márcalo acá (pide registro y guarda nota en Zoho)";
              this.style.background = "#fffdf5"; this.style.color = "#92700c"; this.style.border = "1px dashed #d4b106";
            } catch (e) {
              this.textContent = "↩";
              alert("No se pudo deshacer la gestión. Revisa tu conexión e inténtalo de nuevo.");
            }
            this.disabled = false;
            return;
          }
          abrir(this);
        });
      }
      document.querySelectorAll(".btnGest").forEach(wire);
      var lnk = document.getElementById("lnkVerGest");
      if (lnk) lnk.addEventListener("click", function (ev) {
        ev.preventDefault();
        var filas = document.querySelectorAll("tr.filaGest");
        var ocultas = filas.length && filas[0].style.display === "none";
        filas.forEach(function (f) { f.style.display = ocultas ? "" : "none"; });
        this.textContent = ocultas ? "ocultar" : "mostrar";
      });
    })();
  </script>
</div>`
}

function renderListadoComercial(filas: FilaListado[], key: string, periodo: string, conRango: boolean): string {
  if (!filas.length) {
    // Con rango activo la sección no desaparece: se explica que no hubo actividad.
    if (conRango) {
      return `<div class="card"><h2>Listado comercial vivo <span class="pct" style="font-weight:400">— 0 casos ${periodo}</span></h2>
  <p class="sub" style="margin:0">Sin casos con actividad en el período seleccionado.</p></div>`
    }
    return ""
  }
  const filasHtml = filas
    .map(
      (f) => `<tr data-estado="${esc(f.estado)}" data-prop="${esc(f.propietario)}" data-fecha="${esc(f.fechaIso.slice(0, 10))}">
        <td>${esc(f.empresa)}<div class="sub" style="margin:0">${esc(f.contacto)}</div></td>
        <td>${f.primerContactoIso ? fmtSantiago(f.primerContactoIso) : "—"}</td>
        <td><span class="tag">${esc(f.estado)}</span></td>
        <td>${fmtSantiago(f.fechaIso)}</td>
        <td>${esc(f.estadoZoho)}</td>
        <td>${esc(f.propietario)}</td>
        <td style="max-width:260px" title="${esc(f.resumen)}">${esc(f.accionable)}${f.convId ? `<div style="margin-top:4px"><a href="?key=${encodeURIComponent(key)}&conv=${encodeURIComponent(f.convId)}">ver conversación completa →</a></div>` : ""}</td>
      </tr>`,
    )
    .join("")
  return `<div class="card"><h2>Listado comercial vivo <span class="pct" style="font-weight:400">— ${filas.length} casos (${periodo})</span></h2>
  <div style="overflow-x:auto"><table id="lcTabla">
    <thead><tr><th>Empresa / contacto</th><th>Primer contacto</th><th>Estado</th><th>Fecha último estado</th><th>Estado en Zoho (deal/lead)</th><th>Propietario</th><th>Accionable (Claude)</th></tr></thead>
    <tbody>${filasHtml}</tbody>
  </table></div>
  <div class="sub" style="margin-top:8px">El estado es el más avanzado alcanzado por el caso; su fecha es la del evento que lo definió (pago, aceptación, emisión de la formal, precio mostrado en el chat, última respuesta del cliente o creación del lead). "Estado en Zoho" muestra la etapa del deal (o el status del lead si aún no hay deal). El accionable lo escribe el análisis de Claude por conversación (pasa el mouse para ver el resumen; si aún no fue analizada, sale una sugerencia por estado). Fechas en hora de Chile. Para filtrar, usa los filtros globales de arriba (aplican a toda la página, incluida esta tabla). Con un rango de fechas activo se muestran solo los casos con actividad en el período: inicio de conversación, última respuesta del cliente, último mensaje o el evento del estado, cualquiera dentro del rango.</div>
</div>`
}

/** Evolución diaria (pedido Lalo 04-ago): serie de los últimos 30 días con
 * conversaciones, intención comercial, precios mostrados (preform), formales
 * emitidas, aceptadas y pagadas. Días en hora de Chile; las cotizaciones van
 * por su fecha en Zoho (emisión para formales, pago para aceptadas/pagadas). */
function renderEvolucionDiaria(params: {
  convs: ConvListado[]
  analysisRows: Row[]
  preformAt: Map<string, string>
  quotes: RawAceptada[]
  pais: Pais
  rango: RangoFechas | null
}): string {
  const { convs, analysisRows, preformAt, quotes, pais, rango } = params
  const testSet = testContactSet()
  const diaDe = (iso: string | null | undefined): string => {
    const t = Date.parse(String(iso || ""))
    if (!Number.isFinite(t)) return ""
    return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t))
  }
  // El gráfico sigue el filtro Desde–Hasta; sin filtro, últimos 30 días.
  // Todos los días del rango presentes (cero cuando no hubo actividad).
  const DIA_MS = 864e5
  const finMs = rango && rango.hastaMs !== Number.MAX_SAFE_INTEGER ? rango.hastaMs : Date.now()
  const inicioMs = rango && rango.desdeMs > 0 ? rango.desdeMs : finMs - 29 * DIA_MS
  // floor y no round: el rango va de las 00:00 del desde a las 23:59 del
  // hasta — round sumaba un día fantasma al inicio (31-07 en un rango 01-08).
  const nDias = Math.min(366, Math.max(1, Math.floor((finMs - inicioMs) / DIA_MS) + 1))
  const dias: string[] = []
  for (let i = nDias - 1; i >= 0; i--) {
    const d = diaDe(new Date(finMs - i * DIA_MS).toISOString())
    if (d && dias[dias.length - 1] !== d) dias.push(d)
  }
  const idx = new Map(dias.map((d, i) => [d, i]))
  const serie = () => new Array<number>(dias.length).fill(0)
  const suma = (arr: number[], iso: string | null | undefined) => {
    const i = idx.get(diaDe(iso))
    if (i !== undefined) arr[i]++
  }
  const sConv = serie(), sCom = serie(), sPreform = serie(), sFormal = serie(), sAcept = serie(), sPag = serie()

  const delPais = (tel: string) => paisDeTelefono(tel) === pais && !isTestContact(tel, testSet)
  const inicioPorContacto = new Map<string, string>()
  for (const c of convs) {
    const tel = digits(c.contact)
    if (!tel || !delPais(tel)) continue
    if (!inicioPorContacto.has(tel)) inicioPorContacto.set(tel, String(c.started_at || ""))
    suma(sConv, c.started_at)
  }
  // FOTO DIARIA DE EVENTOS (definición final de Lalo 05-ago): cada serie
  // cuenta lo que OCURRIÓ ese día — chats que partieron, precios mostrados,
  // formales emitidas, aceptaciones y pagos. NO es un embudo: las líneas
  // pueden cruzarse legítimamente (la formal de hoy puede venir de un chat
  // de ayer). Dos correcciones que SÍ se conservan del 05-ago:
  //  - intención no depende solo del análisis batch: un chat que vio precio
  //    o tiene formal ES comercial aunque su análisis aún no corra (sin esto
  //    el día en curso siempre subcontaba);
  //  - las cotizaciones de contactos de PRUEBA quedan fuera de las series.
  const comercialSet = new Set<string>()
  for (const r of analysisRows) {
    if (r.grupo === "comercial") comercialSet.add(digits(r.contact))
  }
  for (const tel of preformAt.keys()) comercialSet.add(tel)
  for (const q of quotes) {
    const tel = digits(String(q.Tel_fono_Contacto || ""))
    if (tel && !isTestContact(tel, testSet)) comercialSet.add(tel)
  }
  for (const tel of comercialSet) {
    if (!tel || !delPais(tel)) continue
    suma(sCom, inicioPorContacto.get(tel))
  }
  for (const [tel, at] of preformAt) {
    if (delPais(tel)) suma(sPreform, at)
  }
  for (const q of quotes) {
    const tel = digits(String(q.Tel_fono_Contacto || ""))
    if (tel && isTestContact(tel, testSet)) continue
    suma(sFormal, q.Created_Time)
    const pagada = Boolean(String(q.Onboarding_Link || "").trim())
    const aceptada = pagada || String(q.Estado_Cotizacion || "").toLowerCase().includes("acept")
    const fechaPago = q.Fecha_Hora_Cotizacion || q.Modified_Time || q.Created_Time
    if (aceptada) suma(sAcept, fechaPago)
    if (pagada) suma(sPag, fechaPago)
  }

  const trazas = [
    { nombre: "Conversaciones", datos: sConv, color: "#9aa0a8" },
    { nombre: "Intención comercial", datos: sCom, color: "#00aff2" },
    { nombre: "Precio mostrado (preform)", datos: sPreform, color: "#ffbb00" },
    { nombre: "Formal enviada", datos: sFormal, color: "#e67e22" },
    { nombre: "Aceptada", datos: sAcept, color: "#27ae60" },
    { nombre: "Pagada", datos: sPag, color: "#1b5e20" },
  ]
  // Agrupación según el largo del rango (pedido Lalo 04-ago): >1 semana
  // ofrece Día/Semana; ≥2 meses suma la opción Mes. La agregación corre en el
  // navegador sobre la serie diaria ya embebida.
  const btnCss = "border:1px solid #d0d5db;border-radius:6px;padding:3px 10px;margin-left:4px;cursor:pointer;font-family:inherit;font-size:12px;font-weight:700;background:#fff;color:#4e4e4e"
  const selector = dias.length > 7
    ? `<span style="float:right;font-weight:400"><button class="evoBtn" data-modo="dia" style="${btnCss}">Día</button><button class="evoBtn" data-modo="semana" style="${btnCss}">Semana</button>${dias.length >= 60 ? `<button class="evoBtn" data-modo="mes" style="${btnCss}">Mes</button>` : ""}</span>`
    : ""
  return `<div class="card"><h2>📈 Evolución <span class="pct" style="font-weight:400">— ${rango ? esc(rango.etiqueta) : "últimos 30 días"}</span>${selector}</h2>
  <div id="evoDiaria" style="height:340px"></div>
  <div class="sub" style="margin:6px 0 0">Sigue el filtro Desde–Hasta (sin filtro: últimos 30 días). FOTO DIARIA DE EVENTOS: cada serie cuenta lo que ocurrió ese día — conversaciones que partieron e intenciones identificadas (por día de inicio del chat), precios mostrados (por el día en que se mostraron), formales por emisión en Zoho, aceptadas y pagadas por su fecha de aceptación/pago. NO es un embudo: las líneas pueden cruzarse (la formal de hoy puede venir de un chat de ayer). Hora de Chile. Las semanas parten lunes; el primer y último tramo pueden venir incompletos. Clic en la leyenda para ocultar/mostrar series.</div>
  <script>
    (function () {
      var DIAS = ${JSON.stringify(dias)};
      var SERIES = ${JSON.stringify(trazas.map((t) => ({ n: t.nombre, c: t.color, y: t.datos })))};
      var MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
      var LAYOUT = {
        margin: { l: 34, r: 12, t: 10, b: 46 },
        legend: { orientation: "h", y: 1.18 },
        font: { family: "Nunito, 'Segoe UI', sans-serif", size: 12, color: "#4e4e4e" },
        xaxis: { type: "category", tickangle: -45, fixedrange: true },
        yaxis: { rangemode: "tozero", gridcolor: "#eef0f3", fixedrange: true },
        plot_bgcolor: "#ffffff", paper_bgcolor: "#ffffff", hovermode: "x unified"
      };
      var CONFIG = { displayModeBar: false, responsive: true };
      function claveDe(d, modo) {
        if (modo === "mes") return MESES[parseInt(d.slice(5, 7), 10) - 1] + " " + d.slice(2, 4);
        if (modo === "semana") {
          var t = new Date(d + "T00:00:00Z");
          t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
          var i = t.toISOString();
          return "sem " + i.slice(8, 10) + "-" + i.slice(5, 7);
        }
        return d.slice(8, 10) + "-" + d.slice(5, 7);
      }
      function pintar(modo) {
        var x = [], pos = {};
        DIAS.forEach(function (d) { var k = claveDe(d, modo); if (!(k in pos)) { pos[k] = x.length; x.push(k); } });
        var data = SERIES.map(function (s) {
          var y = x.map(function () { return 0; });
          DIAS.forEach(function (d, i) { y[pos[claveDe(d, modo)]] += s.y[i]; });
          return { x: x, y: y, name: s.n, type: "scatter", mode: "lines+markers", line: { color: s.c, width: 2 }, marker: { size: 5 } };
        });
        Plotly.react("evoDiaria", data, LAYOUT, CONFIG);
        document.querySelectorAll(".evoBtn").forEach(function (b) {
          var act = b.dataset.modo === modo;
          b.style.background = act ? "#ffbb00" : "#fff";
          b.style.color = act ? "#fff" : "#4e4e4e";
          b.style.borderColor = act ? "#ffbb00" : "#d0d5db";
        });
      }
      document.querySelectorAll(".evoBtn").forEach(function (b) {
        b.addEventListener("click", function () { pintar(this.dataset.modo); });
      });
      pintar("dia");
    })();
  </script>
</div>`
}

function page(html: string, status = 200): Response {
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } })
}

/** Página de aviso/error con branding GeoVictoria (pedido Lalo 04-ago): la
 * misma tarjeta centrada de la portada de acceso. El cuerpo llega como HTML
 * ya escapado por el llamador. */
function paginaAviso(titulo: string, cuerpoHtml: string, status = 200): Response {
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(titulo)} — Vicky</title>
<style>
  ${GV_FONT_CSS}
  body{font-family:${GV_BODY_FONT};margin:0;background:#f7f8fa;color:#4e4e4e;display:flex;align-items:center;justify-content:center;min-height:100vh}
  .card{background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:36px 32px;width:min(92vw,460px);text-align:center;box-shadow:0 8px 24px rgba(0,0,0,.06);box-sizing:border-box}
  .card img{height:34px;margin-bottom:18px}
  h1{font-family:${GV_TITLE_FONT};font-weight:700;font-size:20px;margin:0 0 10px;color:#4e4e4e}
  p{color:#646464;font-size:14px;line-height:1.5;margin:0 0 6px}
  a{color:#00aff2;text-decoration:none;font-weight:600} a:hover{text-decoration:underline}
  pre{text-align:left;background:#f7f8fa;border:1px solid #e5e7eb;border-radius:8px;padding:10px;font-size:12px;overflow-x:auto;color:#646464}
  code{background:#f0f1f3;padding:1px 5px;border-radius:4px;font-size:12.5px}
</style></head><body>
  <div class="card">
    <img src="/gv/logo-full-color.svg" alt="GeoVictoria">
    <h1>${esc(titulo)}</h1>
    ${cuerpoHtml}
  </div>
</body></html>`
  return page(html, status)
}

// ── Drill-down de KPIs (pedido Lalo 04-ago): cada número de las tarjetas es
// clickeable y abre la lista de SUS conversaciones (?lista=<bucket>), con los
// mismos filtros globales activos.
const KPI_BUCKETS: Record<string, { titulo: string; pred: (r: Row) => boolean }> = {
  total: { titulo: "Todas las conversaciones", pred: () => true },
  comercial: { titulo: "Intención comercial", pred: (r) => r.grupo === "comercial" },
  soporte: { titulo: "Soporte", pred: (r) => r.grupo === "soporte" },
  no_identificado: { titulo: "No identificado", pred: (r) => r.grupo === "no_identificado" },
  cotizacion: { titulo: "Flujo cotización", pred: (r) => r.grupo === "comercial" && r.sub_bucket === "cotizacion" },
  reunion: { titulo: "Reunión", pred: (r) => r.grupo === "comercial" && r.sub_bucket === "reunion" },
  lead: { titulo: "Lead (callback)", pred: (r) => r.grupo === "comercial" && r.sub_bucket === "lead" },
  crosselling: { titulo: "Crosselling", pred: (r) => r.grupo === "comercial" && r.sub_bucket === "crosselling" },
  solo_dudas: { titulo: "Solo dudas", pred: (r) => r.grupo === "comercial" && r.sub_bucket === "solo_dudas" },
  preform: { titulo: "Vio precio y NO avanzó", pred: (r) => r.sub_bucket === "cotizacion" && r.cotizacion_outcome === "preform_mostrado" },
  enviada: { titulo: "Cotización enviada", pred: (r) => r.sub_bucket === "cotizacion" && r.cotizacion_outcome === "cotizacion_enviada" },
  abandonado: { titulo: "Se fue ANTES del precio", pred: (r) => r.sub_bucket === "cotizacion" && r.cotizacion_outcome === "abandonado" },
}

function renderListaKpi(
  rowsBucket: Row[],
  titulo: string,
  key: string,
  volverQS: string,
  ultimoContactoPorConv: Map<string, string>,
  filaPorContacto: Map<string, FilaListado>,
): Response {
  const ultimo = (r: Row) => ultimoContactoPorConv.get(r.conversation_id) || ""
  // Más reciente primero: el detalle es una lista de trabajo, no un archivo.
  rowsBucket = [...rowsBucket].sort((a, b) => ultimo(b).localeCompare(ultimo(a)))
  const filas = rowsBucket
    .map((r) => {
      // Ficha del listado comercial (empresa, escalera, dueño, accionable con
      // respaldo determinístico); si el caso no está en ese universo (p. ej.
      // soporte), se muestra lo que aporta el análisis de la conversación.
      const d = digits(r.contact)
      const f = filaPorContacto.get(d)
      const chips = [
        r.motivo_no_cierre ? `<span class="tag" style="background:#fdecea;color:#8a1f11">motivo: ${esc(r.motivo_no_cierre.replace(/_/g, " "))}</span>` : "",
        r.es_cliente_actual ? `<span class="tag" style="background:#e8f5e9;color:#1b5e20">cliente actual</span>` : "",
      ].filter(Boolean).join(" ")
      const estadoHtml = f
        ? `<span class="tag">${esc(f.estado)}</span><div class="sub" style="margin:3px 0 0;font-size:12px">${esc(f.estadoZoho)}</div>`
        : `<span class="tag">${esc((r.cotizacion_outcome || r.sub_bucket || r.grupo || "—").replace(/_/g, " "))}</span>`
      const accionable = (f?.accionable || r.accionable || "").trim() || "—"
      const resumen = (f?.resumen || r.resumen || "").trim()
      return `<tr>
        <td>${esc(f?.empresa || "(por identificar)")}<div class="sub" style="margin:0;font-size:12px">+${esc(d)}</div></td>
        <td style="white-space:nowrap">${fmtSantiago(ultimo(r))}</td>
        <td>${estadoHtml}${chips ? `<div style="margin-top:3px">${chips}</div>` : ""}</td>
        <td>${esc(f?.propietario || "—")}</td>
        <td style="max-width:300px">${esc(accionable)}${resumen ? `<div class="sub" style="margin:3px 0 0;font-size:12px">${esc(resumen)}</div>` : ""}<div style="margin-top:4px"><a href="?key=${encodeURIComponent(key)}&conv=${esc(r.conversation_id)}">ver conversación →</a></div></td>
      </tr>`
    })
    .join("")
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(titulo)} — Vicky</title>
<style>
  ${GV_FONT_CSS}
  body{font-family:${GV_BODY_FONT};margin:0;background:#f7f8fa;color:#4e4e4e}
  .wrap{max-width:1080px;margin:0 auto;padding:24px 20px 60px}
  h1{font-family:${GV_TITLE_FONT};font-weight:700;font-size:20px;margin:0 0 4px;color:#4e4e4e} .sub{color:#6b7280;font-size:13px;margin-bottom:16px}
  .card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:18px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #eef0f2;vertical-align:top}
  th{color:#6b7280;font-weight:600;font-size:12px}
  .tag{display:inline-block;background:#eef2ff;color:#3730a3;font-size:11px;padding:2px 8px;border-radius:99px}
  a{color:#00aff2;text-decoration:none;font-weight:600} a:hover{text-decoration:underline}
</style></head><body><div class="wrap">
  <p><a href="${volverQS}">← Volver al embudo</a></p>
  <h1>${esc(titulo)}</h1>
  <div class="sub">${rowsBucket.length} conversación${rowsBucket.length === 1 ? "" : "es"} · respeta los filtros activos del embudo (país, fechas, estado, propietario)</div>
  <div class="card">${
    rowsBucket.length
      ? `<div style="overflow-x:auto"><table><thead><tr><th>Empresa / contacto</th><th>Último contacto</th><th>Estado</th><th>Ejecutivo a cargo</th><th>Accionable (Claude)</th></tr></thead><tbody>${filas}</tbody></table></div>`
      : `<p class="sub" style="margin:0">Sin conversaciones en esta categoría con los filtros actuales.</p>`
  }</div>
</div></body></html>`
  return page(html)
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
  ${GV_FONT_CSS}
  body{font-family:${GV_BODY_FONT};margin:0;background:#f7f8fa;color:#4e4e4e}
  .wrap{max-width:760px;margin:0 auto;padding:20px 16px 60px}
  a{color:#00aff2;text-decoration:none} a:hover{text-decoration:underline}
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

async function kvDel(key: string): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/vic_kv?key=eq.${encodeURIComponent(key)}`, {
    method: "DELETE",
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    cache: "no-store",
  }).catch(() => {})
}

/** Nota de gestión en el registro Zoho del contacto: primero el DEAL del
 * puntero de cotización (o la cotización si no hay deal), y como respaldo el
 * LEAD por teléfono. Best-effort: la gestión queda registrada en el dash
 * aunque Zoho falle. */
async function notaZohoGestion(contact: string, nota: string): Promise<boolean> {
  try {
    const h = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/vic_v3_quote_pointers?contact=like.*${contact.slice(-8)}&select=deal_id,quote_id&order=created_at.desc&limit=1`,
      { headers: h, cache: "no-store" },
    )
    const rows = r.ok ? ((await r.json().catch(() => [])) as Array<{ deal_id?: string | null; quote_id?: string | null }>) : []
    const token = await getZohoAccessToken()
    let parentId = String(rows[0]?.deal_id || "")
    let moduleName = "Deals"
    if (!parentId && rows[0]?.quote_id) {
      parentId = String(rows[0].quote_id)
      moduleName = QUOTE_MODULE
    }
    if (!parentId) {
      const s = await fetch(
        `${ZOHO_API_DOMAIN}/crm/v3/Leads/search?criteria=${encodeURIComponent(`(Phone:equals:+${contact})`)}&fields=id&per_page=1`,
        { headers: { Authorization: `Zoho-oauthtoken ${token}` }, cache: "no-store" },
      )
      const sd = s.ok && s.status !== 204 ? ((await s.json().catch(() => ({}))) as { data?: Array<{ id?: string }> }) : {}
      parentId = String(sd?.data?.[0]?.id || "")
      moduleName = "Leads"
    }
    if (!parentId) return false
    const res = await fetch(`${ZOHO_API_DOMAIN}/crm/v2/Notes`, {
      method: "POST",
      headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        data: [
          {
            Note_Title: "Gestión telemarketing (dashboard Vicky)",
            Note_Content: nota,
            Parent_Id: parentId,
            "$se_module": moduleName,
          },
        ],
      }),
    })
    return res.ok
  } catch {
    return false
  }
}

// Acciones de la cola (botón ✔/↩): gestionar exige un registro de texto, lo
// guarda en vic_kv (expira en 24 h) y lo deja como NOTA en el registro Zoho
// del contacto; desgestionar borra la marca al instante (deshacer).
/** Portada de acceso con la clave del equipo (sin ?key= en la URL). */
function renderLogin(error?: string): Response {
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Gestión de oportunidades — Vicky</title>
<style>
  ${GV_FONT_CSS}
  body{font-family:${GV_BODY_FONT};margin:0;background:#f7f8fa;color:#4e4e4e;display:flex;align-items:center;justify-content:center;min-height:100vh}
  .card{background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:36px 32px;width:min(92vw,380px);text-align:center;box-shadow:0 8px 24px rgba(0,0,0,.06)}
  .card img{height:34px;margin-bottom:18px}
  h1{font-family:${GV_TITLE_FONT};font-weight:700;font-size:22px;margin:0 0 6px;color:#4e4e4e}
  p.sub{color:#6b7280;font-size:13px;margin:0 0 20px}
  input[type=password]{width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid #d1d5db;border-radius:10px;font-family:${GV_BODY_FONT};font-size:15px;margin-bottom:12px;outline-color:#00aff2}
  button{width:100%;padding:12px;border:0;border-radius:10px;background:#ffbb00;color:#fff;font-family:${GV_TITLE_FONT};font-weight:700;font-size:15px;cursor:pointer}
  button:hover{filter:brightness(.96)}
  .err{color:#b91c1c;font-size:13px;margin:0 0 12px}
</style></head><body>
  <form class="card" method="POST" action="?accion=login">
    <img src="/gv/logo-full-color.svg" alt="GeoVictoria">
    <h1>Gestión de oportunidades</h1>
    <p class="sub">Ingresa la clave del equipo para ver los registros.</p>
    ${error ? `<p class="err">${esc(error)}</p>` : ""}
    <input type="password" name="clave" placeholder="Clave" autofocus autocomplete="current-password">
    <button type="submit">Entrar</button>
  </form>
</body></html>`
  return page(html, error ? 401 : 200)
}

export async function POST(req: Request): Promise<Response> {
  const { searchParams } = new URL(req.url)
  const key = (searchParams.get("key") || "").trim()
  const accionPre = (searchParams.get("accion") || "").trim()
  if (accionPre === "login") {
    const body = await req.text().catch(() => "")
    const clave = (new URLSearchParams(body).get("clave") || "").trim()
    if (!DASH_CLAVE || clave !== DASH_CLAVE) return renderLogin("Clave incorrecta. Inténtalo de nuevo.")
    return new Response(null, {
      status: 303,
      headers: {
        location: "/api/vic-funnel",
        "set-cookie": `vic_auth=${authToken()}; Path=/api/vic-funnel; HttpOnly; Secure; SameSite=Lax; Max-Age=5184000`,
      },
    })
  }
  if (!FUNNEL_KEY || key !== FUNNEL_KEY) {
    return new Response(JSON.stringify({ ok: false }), { status: 401, headers: { "content-type": "application/json" } })
  }
  const accion = accionPre
  const contact = digits(searchParams.get("contact") || "")
  if (!contact) {
    return new Response(JSON.stringify({ ok: false, error: "contact faltante" }), { status: 400, headers: { "content-type": "application/json" } })
  }
  if (accion === "gestionar") {
    const body = await req.text().catch(() => "")
    const nota = (new URLSearchParams(body).get("nota") || searchParams.get("nota") || "").trim()
    if (!nota) {
      return new Response(JSON.stringify({ ok: false, error: "nota obligatoria" }), { status: 400, headers: { "content-type": "application/json" } })
    }
    const expira = new Date(Date.now() + 24 * 3600e3).toISOString()
    await kvSet(`gestion_${contact}`, JSON.stringify({ at: new Date().toISOString(), nota: nota.slice(0, 2000) }), expira)
    const notaOk = await notaZohoGestion(contact, nota)
    return new Response(JSON.stringify({ ok: true, notaZoho: notaOk }), { headers: { "content-type": "application/json" } })
  }
  if (accion === "desgestionar") {
    await kvDel(`gestion_${contact}`)
    return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } })
  }
  return new Response(JSON.stringify({ ok: false }), { status: 400, headers: { "content-type": "application/json" } })
}

/** Detalle de los KPIs de COTIZACIONES (Cotizaciones en Zoho / Aceptadas):
 * lista de cotizaciones con estado, fechas, ejecutivo y link al chat. */
function renderListaCotizaciones(
  quotes: RawAceptada[],
  titulo: string,
  key: string,
  volverQS: string,
  convPorContacto: Map<string, string>,
): Response {
  const qs = [...quotes].sort((a, b) => String(b.Created_Time || "").localeCompare(String(a.Created_Time || "")))
  const filas = qs
    .map((q) => {
      const tel = digits(String(q.Tel_fono_Contacto || ""))
      const aceptada = String(q.Estado_Cotizacion || "").toLowerCase().includes("acept")
      const pagada = Boolean(String(q.Onboarding_Link || "").trim())
      const estado = pagada ? "Pagada" : String(q.Estado_Cotizacion || "—")
      const fechaPago = aceptada || pagada ? String(q.Fecha_Hora_Cotizacion || q.Modified_Time || "") : ""
      const owner = `${q["Owner.first_name"] || ""} ${q["Owner.last_name"] || ""}`.trim() || "—"
      const convId = tel ? convPorContacto.get(tel) || "" : ""
      return `<tr>
        <td>${esc(String(q.Numero_Cotizacion || ""))} · <b>${esc(empresaDeQuote(q))}</b>${convId ? ` <a href="?key=${encodeURIComponent(key)}&conv=${encodeURIComponent(convId)}" title="Ver conversación" style="font-weight:400">📄</a>` : ""}<div class="sub" style="margin:0;font-size:12px">${tel ? `+${esc(tel)}` : "sin teléfono"}</div></td>
        <td><span class="tag">${esc(estado)}</span></td>
        <td style="white-space:nowrap">${fmtSantiago(String(q.Created_Time || ""))}</td>
        <td style="white-space:nowrap">${fechaPago ? fmtSantiago(fechaPago) : "—"}</td>
        <td>${esc(owner)}</td>
        <td>${esc(String(q["Deal_Asociado.Stage"] || "—"))}</td>
      </tr>`
    })
    .join("")
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(titulo)} — Vicky</title>
<style>
  ${GV_FONT_CSS}
  body{font-family:${GV_BODY_FONT};margin:0;background:#f7f8fa;color:#4e4e4e}
  .wrap{max-width:1080px;margin:0 auto;padding:24px 20px 60px}
  h1{font-family:${GV_TITLE_FONT};font-weight:700;font-size:20px;margin:0 0 4px;color:#4e4e4e} .sub{color:#6b7280;font-size:13px;margin-bottom:16px}
  .card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:18px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #eef0f2;vertical-align:top}
  th{color:#6b7280;font-weight:600;font-size:12px}
  .tag{display:inline-block;background:#eef2ff;color:#3730a3;font-size:11px;padding:2px 8px;border-radius:99px}
  a{color:#00aff2;text-decoration:none;font-weight:600} a:hover{text-decoration:underline}
</style></head><body><div class="wrap">
  <p><a href="${volverQS}">← Volver</a></p>
  <h1>${esc(titulo)}</h1>
  <div class="sub">${qs.length} cotizacion${qs.length === 1 ? "" : "es"} · respeta los filtros activos (país, fechas, estado, propietario)</div>
  <div class="card">${
    qs.length
      ? `<div style="overflow-x:auto"><table><thead><tr><th>Cotización / contacto</th><th>Estado</th><th>Emisión</th><th>Aceptación/pago</th><th>Ejecutivo</th><th>Etapa deal</th></tr></thead><tbody>${filas}</tbody></table></div>`
      : `<p class="sub" style="margin:0">Sin cotizaciones con los filtros actuales.</p>`
  }</div>
</div></body></html>`
  return page(html)
}

export async function GET(req: Request): Promise<Response> {
  const { searchParams } = new URL(req.url)
  let key = (searchParams.get("key") || "").trim()

  if (!FUNNEL_KEY) {
    return paginaAviso("Falta configurar VIC_FUNNEL_KEY", "<p>Define la variable de entorno <code>VIC_FUNNEL_KEY</code> en Vercel.</p>", 503)
  }
  if (key !== FUNNEL_KEY) {
    // Acceso humano: sesión por cookie (clave GeoVictoria). El ?key= queda
    // para consumidores máquina (cron del resumen diario, links del correo).
    if (cookieDe(req, "vic_auth") === authToken()) key = FUNNEL_KEY
    else return renderLogin()
  }

  const conv = (searchParams.get("conv") || "").replace(/[^a-fA-F0-9-]/g, "").trim()
  if (conv) return renderConversation(conv, key)

  let rows: Row[]
  let origen: {
    toque0: Set<string>
    sinContactar: number
    asignadosTotal: number
    convertidos: Set<string>
    respondio: Set<string>
  } = {
    toque0: new Set(),
    sinContactar: 0,
    asignadosTotal: 0,
    convertidos: new Set(),
    respondio: new Set(),
  }
  let cierre: {
    total: number
    aceptadas: number
    autonomas: number
    asistidas: number
    sinClasificar: number
    aceptadasList: RawAceptada[]
    todasList: RawAceptada[]
    quotesList: RawAceptada[]
  } | null = null
  let ventasHtml = ""
  // Filtro por PAÍS = canal/línea de Vicky (pedido Lalo 20-jul; PE y MX
  // sumados el 04-ago): cl (default), co, pe o mx. El país de una conversación
  // viene de vic_v3_conversations.country (la línea por la que entró), con
  // respaldo por prefijo telefónico; sus cotizaciones se asocian por
  // formal_quote_id.
  const paisRaw = (searchParams.get("pais") || "cl").toLowerCase()
  const pais: Pais = (paisRaw in PAISES ? paisRaw : "cl") as Pais
  const rango = parseRango(searchParams)
  // Filtros globales de ESTADO y PROPIETARIO (pedido Lalo 03-ago): aplican a
  // TODAS las secciones. El estado/propietario de cada contacto sale de la
  // escalera del listado comercial (universo: últimos 30 días).
  const estadoRaw = (searchParams.get("estado") || "").trim()
  const estadoF = ESTADOS_LISTADO.includes(estadoRaw) ? estadoRaw : ""
  const propF = (searchParams.get("prop") || "").trim()
  // Vista: "gestion" (default, la cola de trabajo) o "analisis" (KPIs, Sankey
  // y el resto del embudo) — pestaña arriba a la derecha (pedido Lalo 04-ago).
  const vista: "gestion" | "analisis" = searchParams.get("vista") === "analisis" ? "analisis" : "gestion"
  // Drill-down de un KPI: ?lista=<bucket> abre el detalle de esas conversaciones.
  const listaParam = (searchParams.get("lista") || "").trim()
  // Query string con los filtros vigentes (para los links de los KPIs y el
  // "volver" del detalle, que deben conservar país/fechas/estado/propietario).
  const filtrosQS = (): URLSearchParams => {
    const p = new URLSearchParams({ key, pais })
    if (rango?.desdeStr) p.set("desde", rango.desdeStr)
    if (rango?.hastaStr) p.set("hasta", rango.hastaStr)
    if (estadoF) p.set("estado", estadoF)
    if (propF) p.set("prop", propF)
    if (vista === "analisis") p.set("vista", "analisis")
    return p
  }
  const hrefLista = (bucket: string) => {
    const p = filtrosQS()
    p.set("lista", bucket)
    return `?${p.toString()}`
  }
  let propietariosAll: string[] = []
  // conversación → fecha del último mensaje (columna "Último contacto" del
  // detalle de KPIs).
  let ultimoMsgPorConv = new Map<string, string>()
  // Escalera del listado comercial: también enriquece el detalle de KPIs
  // (empresa, estado, ejecutivo a cargo, accionable).
  let filasListado: FilaListado[] = []
  // Cola de gestión (vista principal) y sus insumos.
  let colaHtml = ""
  let evolucionHtml = ""
  let casosGestion: CasoGestion[] = []
  let nGestionadosCola = 0
  let gestionados = new Map<string, string>()
  let montosPorContacto = new Map<string, { uf: number | null; clp: number | null }>()
  try {
    const paisesConv = await fetchPaisesConversaciones()
    const [allRows, hard, cierreZoho, origenData, fechasConv, convsListado] = await Promise.all([
      fetchAnalysis(),
      fetchHardSignals(),
      fetchCierreZoho(paisesConv.paisPorQuote, pais, rango),
      fetchOrigenFunnel(pais).catch(() => ({ toque0: new Set<string>(), sinContactar: 0, asignadosTotal: 0, convertidos: new Set<string>(), respondio: new Set<string>(), asignados: new Set<string>(), sinContactarTels: new Set<string>() })),
      // Las fechas de inicio solo hacen falta con el filtro activo.
      rango ? fetchFechasConversaciones() : Promise.resolve(new Map<string, string>()),
      fetchConvsListado().catch(() => [] as ConvListado[]),
    ])
    origen = origenData
    cierre = cierreZoho
    ultimoMsgPorConv = new Map(
      convsListado.map((c) => [c.id, String(c.updated_at || c.last_user_at || c.started_at || "")]),
    )
    // Listado comercial vivo (best-effort: si una pata falla, la sección se
    // arma con lo que haya; jamás bota la página). Se construye ANTES que el
    // resto porque su escalera de estados alimenta los filtros globales.
    try {
      const contactosConocidos = new Set(convsListado.map((c) => digits(c.contact)))
      const hSb = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
      const [preformAt, zohoListado, gestionadosKv, punteros] = await Promise.all([
        fetchPreformAts(convsListado),
        fetchZohoListado(contactosConocidos),
        fetch(
          `${SUPABASE_URL}/rest/v1/vic_kv?key=like.gestion_%25&select=key,value&expires_at=gt.${new Date().toISOString()}&limit=1000`,
          { headers: hSb, cache: "no-store" },
        ).then((r) => (r.ok ? r.json() : [])).catch(() => []) as Promise<Array<{ key: string; value: string }>>,
        fetch(`${SUPABASE_URL}/rest/v1/vic_v3_quote_pointers?select=contact,total_uf,total_clp,quote_id&order=updated_at.desc&limit=1000`, {
          headers: hSb,
          cache: "no-store",
        }).then((r) => (r.ok ? r.json() : [])).catch(() => []) as Promise<Array<{ contact: string; total_uf: number | null; total_clp: number | null; quote_id: string | null }>>,
      ])
      gestionados = new Map(gestionadosKv.map((g) => [String(g.key).replace(/^gestion_/, ""), String(g.value || "")]))
      for (const p of punteros) {
        const d = digits(p.contact)
        if (d && !montosPorContacto.has(d)) montosPorContacto.set(d, { uf: p.total_uf, clp: p.total_clp })
      }
      // Monto/mes = fee RECURRENTE (pedido Lalo 04-ago): cuando el subform de
      // la cotización está disponible, pisa el total del puntero (que mezcla
      // el fee con compra/envío/instalación del reloj).
      try {
        const fees = await fetchFeesMensuales(
          punteros
            .filter((p) => p.quote_id)
            .map((p) => ({ contact: digits(p.contact), quoteId: String(p.quote_id) })),
        )
        for (const [c, fee] of fees) montosPorContacto.set(c, fee)
      } catch (e) {
        console.warn("[vic-funnel] fees mensuales fallaron:", e instanceof Error ? e.message : e)
      }
      filasListado = construirListadoComercial({
        quotes: cierre?.todasList || [],
        leads: zohoListado.leads,
        dealsPorId: zohoListado.dealsPorId,
        convs: convsListado,
        preformAt,
        analysisRows: allRows,
        pais,
      })
      evolucionHtml = renderEvolucionDiaria({
        convs: convsListado,
        analysisRows: allRows,
        preformAt,
        quotes: cierre?.todasList || [],
        pais,
        rango,
      })
    } catch (e) {
      console.warn("[vic-funnel] listado comercial falló:", e instanceof Error ? e.message : e)
    }
    propietariosAll = [...new Set(filasListado.map((f) => f.propietario).filter((p) => p && p !== "—"))].sort()
    // Contactos que pasan el filtro Estado/Propietario (null = sin filtro).
    const coincide = (f: FilaListado) => (!estadoF || f.estado === estadoF) && (!propF || f.propietario === propF)
    const permitidos: Set<string> | null =
      estadoF || propF
        ? new Set(filasListado.filter(coincide).map((f) => digits(f.contacto)).filter(Boolean))
        : null
    // Filtro Desde–Hasta sobre el listado (pedido Lalo 04-ago): con rango
    // activo se muestran solo los casos con ACTIVIDAD en el período — inicio
    // de conversación, última respuesta del cliente, último mensaje o el
    // evento que definió su estado actual, cualquiera dentro del rango.
    const tuvoActividad = (f: FilaListado) =>
      !rango ||
      [f.primerContactoIso, f.fechaIso, f.lastUserIso, f.updatedIso].some((iso) => iso && enRango(iso, rango))
    // (04-ago: el "Listado comercial vivo" salió de la página — la cola de
    // gestión lo reemplazó con la misma data; renderListadoComercial queda
    // disponible por si se quiere reponer.)
    const filasVisibles = filasListado.filter((f) => coincide(f) && tuvoActividad(f))
    const cola = construirCasosGestion({ filas: filasVisibles, gestionados, montos: montosPorContacto, pais })
    casosGestion = cola.casos
    nGestionadosCola = cola.nGestionados
    const qsDescarga = (() => {
      const p = new URLSearchParams({ key, pais })
      if (rango?.desdeStr) p.set("desde", rango.desdeStr)
      if (rango?.hastaStr) p.set("hasta", rango.hastaStr)
      if (estadoF) p.set("estado", estadoF)
      if (propF) p.set("prop", propF)
      return p.toString()
    })()
    colaHtml = renderColaGestion(casosGestion, nGestionadosCola, key, qsDescarga)
    // El filtro global re-corta el cierre de Zoho (por teléfono de la
    // cotización) y el funnel por origen (por teléfono del lead/toque).
    if (permitidos && cierre) {
      const enP = (q: RawAceptada) => {
        const t = digits(String(q.Tel_fono_Contacto || ""))
        return Boolean(t) && permitidos.has(t)
      }
      const aceptadasList = cierre.aceptadasList.filter(enP)
      const marca = (q: { Intervenci_n_Humana?: string | null }) => String(q.Intervenci_n_Humana || "").toLowerCase()
      const autonomas = aceptadasList.filter((q) => marca(q).includes("100%")).length
      const asistidas = aceptadasList.filter((q) => marca(q).includes("intervenci")).length
      cierre = {
        total: cierre.quotesList.filter(enP).length,
        aceptadas: aceptadasList.length,
        autonomas,
        asistidas,
        sinClasificar: aceptadasList.length - autonomas - asistidas,
        aceptadasList,
        todasList: cierre.todasList.filter(enP),
        quotesList: cierre.quotesList.filter(enP),
      }
    }
    if (permitidos) {
      const inter = (s: Set<string>) => new Set([...s].filter((x) => permitidos.has(x)))
      const asignadosF = inter(origenData.asignados)
      origen = {
        toque0: inter(origenData.toque0),
        convertidos: inter(origenData.convertidos),
        respondio: inter(origenData.respondio),
        asignadosTotal: asignadosF.size,
        sinContactar: inter(origenData.sinContactarTels).size,
      }
    }
    if (cierre?.aceptadasList?.length) {
      ventasHtml = renderVentasCerradas(await construirVentasCerradas(cierre.aceptadasList), key)
    }
    rows = allRows.filter((r) => {
      if (isTestContact(r.contact)) return false
      // Cada línea de Vicky (CL/CO/PE/MX) muestra SOLO sus conversaciones.
      const d = digits(r.contact)
      const paisRow: Pais =
        paisesConv.paisPorConv.get(r.conversation_id) ||
        paisesConv.paisPorContacto.get(d) ||
        paisDeTelefono(d) ||
        "cl"
      if (paisRow !== pais) return false
      // Filtro global Estado/Propietario: solo contactos del conjunto.
      if (permitidos && !permitidos.has(d)) return false
      // Filtro Desde–Hasta sobre el inicio de la conversación. Una conversación
      // sin fecha conocida se EXCLUYE cuando el filtro está activo: un filtro
      // de fechas no puede mostrar filas de fecha desconocida.
      return !rango || enRango(fechasConv.get(r.conversation_id), rango)
    })
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
    return paginaAviso(
      "Error consultando datos",
      `<p>Vuelve a intentarlo en unos segundos.</p><pre>${esc(String(e).slice(0, 300))}</pre>`,
      500,
    )
  }

  // Vista de detalle de un KPI: usa las MISMAS rows ya filtradas por país,
  // fechas, estado y propietario, más el predicado del bucket.
  // Detalle de los KPIs de cotizaciones (cuentan quotes, no conversaciones).
  if (listaParam === "zoho_cotizaciones" || listaParam === "zoho_aceptadas") {
    const quotes = listaParam === "zoho_aceptadas" ? cierre?.aceptadasList || [] : cierre?.quotesList || []
    const titulo = listaParam === "zoho_aceptadas" ? "Aceptadas / pagadas" : "Cotizaciones en Zoho"
    const convPorContacto = new Map<string, string>()
    for (const f of filasListado) {
      const d = digits(f.contacto)
      if (d && f.convId && !convPorContacto.has(d)) convPorContacto.set(d, f.convId)
    }
    return renderListaCotizaciones(quotes, titulo, key, `?${filtrosQS().toString()}`, convPorContacto)
  }

  if (listaParam && KPI_BUCKETS[listaParam]) {
    const b = KPI_BUCKETS[listaParam]
    // Ficha más reciente por contacto (filasListado viene ordenado por fecha
    // de último estado, descendente).
    const filaPorContacto = new Map<string, FilaListado>()
    for (const f of filasListado) {
      const d = digits(f.contacto)
      if (d && !filaPorContacto.has(d)) filaPorContacto.set(d, f)
    }
    return renderListaKpi(rows.filter(b.pred), b.titulo, key, `?${filtrosQS().toString()}`, ultimoMsgPorConv, filaPorContacto)
  }

  if (rows.length === 0) {
    if (estadoF || propF) {
      return paginaAviso(
        "Sin conversaciones para este filtro",
        `<p>No hay casos con ${[
          estadoF ? `estado <b>${esc(estadoF)}</b>` : "",
          propF ? `propietario <b>${esc(propF)}</b>` : "",
        ].filter(Boolean).join(" y ")} en el período.</p><p><a href="?key=${encodeURIComponent(key)}&pais=${pais}">← Quitar filtros</a></p>`,
      )
    }
    return paginaAviso(
      "Sin análisis todavía",
      "<p>La tabla de análisis está vacía. Corre el cron una vez: <code>/api/vic-funnel-cron?key=&lt;VIC_FUNNEL_KEY&gt;&amp;all=1</code> (puede requerir varias llamadas para el histórico).</p>",
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

  // Modo JSON (?formato=json): expone la cola de gestión y los números clave
  // para consumidores programáticos — hoy, el resumen diario por correo
  // (/api/vic-resumen-diario). Respeta todos los filtros de la URL.
  if ((searchParams.get("formato") || "") === "json") {
    const vieronPrecio = cPreform + cEnviada
    return Response.json({
      pais,
      generado: new Date().toISOString(),
      totales: {
        conversaciones: total,
        comercial,
        flujoCotizacion: cotizacion,
        colaPendiente: casosGestion.filter((c) => !c.gestionado).length,
        gestionados24h: nGestionadosCola,
      },
      cierre: cierre
        ? {
            cotizaciones: cierre.total,
            aceptadas: cierre.aceptadas,
            tasaEndToEnd: vieronPrecio ? Math.round((cierre.aceptadas / vieronPrecio) * 100) : 0,
            objetivo: pais === "cl" ? 30 : 10,
          }
        : null,
      casos: casosGestion.filter((c) => !c.gestionado),
    })
  }

  // Descarga de la cola (pedido Lalo 04-ago): ?formato=csv baja un archivo que
  // abre directo en Excel (BOM UTF-8, separador ';' — convención es-CL);
  // ?formato=impresion abre una vista limpia que lanza el diálogo de
  // imprimir/guardar como PDF. Ambas respetan los filtros activos.
  if ((searchParams.get("formato") || "") === "csv") {
    const origin = new URL(req.url).origin
    const celda = (v: string) => `"${String(v ?? "").replace(/"/g, '""')}"`
    const encabezado = [
      "Tipo de acción", "Empresa", "Teléfono", "Ejecutivo", "Primer contacto", "Estado",
      "Fecha del estado", "Último contacto", "Estado en Zoho", "Días sin contacto",
      "Urgencia", "Monto/mes", "Accionable", "Resumen", "Gestionado", "Link chat", "Link Zoho",
    ].join(";")
    const filasCsv = casosGestion.map((c) =>
      [
        c.tipoLabel, c.empresa, `+${c.contacto}`, c.propietario,
        fmtSantiago(c.primerContactoIso), c.estado, fmtSantiago(c.fechaEstadoIso),
        fmtSantiago(c.ultimoContactoIso), c.estadoZoho, String(c.diasSinContacto),
        c.urgencia, c.monto, c.accionable, c.resumen, c.gestionado ? "sí" : "no",
        c.convId ? `${origin}/api/vic-funnel?conv=${encodeURIComponent(c.convId)}` : "",
        c.zohoUrl,
      ].map(celda).join(";"),
    )
    const hoyStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago" }).format(new Date())
    return new Response(`${"\ufeff"}${encabezado}\n${filasCsv.join("\n")}`, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="gestion_vicky_${pais}_${hoyStr}.csv"`,
      },
    })
  }
  if ((searchParams.get("formato") || "") === "impresion") {
    const filtroTxt = [
      `Vicky ${PAISES[pais].nombre}`,
      rango ? `📅 ${rango.etiqueta}` : "últimos 30 días de actividad",
      estadoF ? `Estado: ${estadoF}` : "",
      propF ? `Propietario: ${propF}` : "",
      `generado ${fmtSantiago(new Date().toISOString())}`,
    ].filter(Boolean).join(" · ")
    const filasImp = casosGestion.map((c) => `<tr>
      <td>${esc(c.tipoLabel)}</td>
      <td><b>${esc(c.empresa)}</b><br>+${esc(c.contacto)}</td>
      <td>${esc(c.propietario)}</td>
      <td>${fmtSantiago(c.primerContactoIso)}</td>
      <td>${esc(c.estado)}</td>
      <td>${fmtSantiago(c.ultimoContactoIso || c.fechaEstadoIso)}</td>
      <td>${esc(c.estadoZoho)}</td>
      <td>${esc(c.urgencia)} · ${c.diasSinContacto} d</td>
      <td style="text-align:right;white-space:nowrap">${c.monto}</td>
      <td>${esc(c.accionable)}${c.resumen ? `<br><span class="mini">${esc(c.resumen)}</span>` : ""}${c.gestionado ? `<br><span class="mini">✔ gestionado en las últimas 24 h</span>` : ""}</td>
    </tr>`).join("")
    const htmlImp = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Gestión de oportunidades — Vicky</title>
<style>
  ${GV_FONT_CSS}
  @page{size:landscape;margin:10mm}
  body{font-family:${GV_BODY_FONT};margin:16px;color:#4e4e4e}
  h1{font-family:${GV_TITLE_FONT};font-weight:700;font-size:18px;margin:0 0 2px}
  .sub{color:#646464;font-size:11px;margin-bottom:10px}
  img{height:24px;vertical-align:middle;margin-right:10px}
  table{width:100%;border-collapse:collapse;font-size:10.5px}
  th,td{text-align:left;padding:4px 6px;border-bottom:1px solid #dfe2e7;vertical-align:top}
  th{color:#646464;font-size:10px;border-bottom:2px solid #c9ced4}
  tr{page-break-inside:avoid}
  .mini{color:#8a9099;font-size:9.5px}
</style></head><body>
  <h1><img src="/gv/logo-full-color.svg" alt="GeoVictoria">Gestión de oportunidades — ${casosGestion.length} casos</h1>
  <div class="sub">${esc(filtroTxt)}</div>
  <table><thead><tr><th>Tipo</th><th>Empresa / contacto</th><th>Ejecutivo</th><th>Primer contacto</th><th>Estado</th><th>Último contacto</th><th>Zoho</th><th>Urgencia</th><th>Monto/mes</th><th>Accionable</th></tr></thead>
  <tbody>${filasImp}</tbody></table>
  <script>window.addEventListener("load", function () { setTimeout(function () { window.print(); }, 300); });</script>
</body></html>`
    return page(htmlImp)
  }

  // ── Funnel por ORIGEN: outbound (leads asignados) vs inbound (llegó solo) ──
  // Etapas alineadas desde "calificado" para comparar lado a lado. Pagadas se
  // cruzan por el teléfono de la cotización; las sin teléfono van a inbound
  // (nacen de conversaciones que el cliente inició).
  const esOutbound = (c: string) => origen.toque0.has(digits(c))
  const obRespondio = [...origen.toque0].filter((c) => origen.respondio.has(c)).length
  const fOb = {
    asignados: origen.asignadosTotal || origen.toque0.size + origen.sinContactar,
    toque0: origen.toque0.size,
    respondio: obRespondio,
    calificado: n((r) => esOutbound(r.contact) && r.sub_bucket === "cotizacion"),
    precio: n((r) => esOutbound(r.contact) && (r.cotizacion_outcome === "preform_mostrado" || r.cotizacion_outcome === "cotizacion_enviada")),
    formal: n((r) => esOutbound(r.contact) && r.cotizacion_outcome === "cotizacion_enviada"),
    // Hecho duro de Zoho: leads convertidos a DEAL (se les envió cotización).
    convertido: [...origen.convertidos].filter((c) => esOutbound(c)).length,
    pagada: (cierre?.aceptadasList || []).filter((q) => esOutbound(String(q.Tel_fono_Contacto || ""))).length,
  }
  const fIn = {
    origen: n((r) => !esOutbound(r.contact)),
    calificado: n((r) => !esOutbound(r.contact) && r.sub_bucket === "cotizacion"),
    precio: n((r) => !esOutbound(r.contact) && (r.cotizacion_outcome === "preform_mostrado" || r.cotizacion_outcome === "cotizacion_enviada")),
    formal: n((r) => !esOutbound(r.contact) && r.cotizacion_outcome === "cotizacion_enviada"),
    // Leads inbound (formulario) convertidos a deal — mismo hecho duro Zoho.
    convertido: [...origen.convertidos].filter((c) => !esOutbound(c)).length,
    pagada: (cierre?.aceptadasList || []).filter((q) => !esOutbound(String(q.Tel_fono_Contacto || ""))).length,
  }
  const pct2 = (parte: number, base: number) => (base > 0 ? `${Math.round((parte / base) * 100)}%` : "—")
  const filaFunnel = (etapa: string, ob: number | null, obBase: number | null, inb: number | null, inBase: number | null) => `
    <tr>
      <td>${etapa}</td>
      <td style="text-align:right"><b>${ob === null ? "—" : ob}</b></td>
      <td style="color:#6b7280">${ob === null || obBase === null ? "" : pct2(ob, obBase)}</td>
      <td style="text-align:right"><b>${inb === null ? "—" : inb}</b></td>
      <td style="color:#6b7280">${inb === null || inBase === null ? "" : pct2(inb, inBase)}</td>
    </tr>`
  const funnelOrigenHtml = `
  <div class="card"><h2>Funnel por origen <span class="pct" style="font-weight:400">— outbound (leads asignados a Vicky) vs inbound (el cliente llegó solo) · % sobre la etapa anterior</span></h2>
    <table><thead><tr><th>Etapa</th><th style="text-align:right">Outbound</th><th></th><th style="text-align:right">Inbound</th><th></th></tr></thead><tbody>
      ${filaFunnel("Leads asignados / Conversaciones iniciadas", fOb.asignados, null, fIn.origen, null)}
      ${filaFunnel("Toque 0 entregado", fOb.toque0, fOb.asignados, null, null)}
      ${filaFunnel("Respondió", fOb.respondio, fOb.toque0, null, null)}
      ${filaFunnel("Calificado en flujo cotización", fOb.calificado, fOb.respondio, fIn.calificado, fIn.origen)}
      ${filaFunnel("Vio precio", fOb.precio, fOb.calificado, fIn.precio, fIn.calificado)}
      ${filaFunnel("Cotización formal enviada", fOb.formal, fOb.precio, fIn.formal, fIn.precio)}
      ${filaFunnel("Convertido a deal (Zoho)", fOb.convertido, fOb.formal, fIn.convertido, fIn.formal)}
      ${filaFunnel("💰 Pagada", fOb.pagada, fOb.convertido, fIn.pagada, fIn.formal)}
    </tbody></table>
    <div class="sub" style="margin-top:8px">Cierre punta a punta: outbound ${pct2(fOb.pagada, fOb.asignados)} de los leads asignados · inbound ${pct2(fIn.pagada, fIn.origen)} de las conversaciones. Las cotizaciones pagadas sin teléfono registrado se cuentan como inbound.</div>
  </div>`

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
    base: "#4e4e4e", com: "#00aff2", sop: "#00838F", noid: "#9aa0a8",
    good: "#2E7D32", best: "#1B5E20", warn: "#F9A825", bad: "#C62828", grey: "#9aa0a8",
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

  const kpiCard = (label: string, value: number | string, color: string, sub?: string, bucket?: string) =>
    `<div class="kpi">${bucket ? `<a href="${hrefLista(bucket)}" title="Ver el detalle" style="text-decoration:none">` : ""}<div class="kpi-v" style="color:${color}${bucket ? ";cursor:pointer" : ""}">${value}</div>${bucket ? "</a>" : ""}<div class="kpi-l">${label}${sub ? ` <span class="pct">${sub}</span>` : ""}</div></div>`

  // ── Flujo cotización y tasa de cierre: se computa una vez y alimenta ambas
  // vistas — el bloque completo va en Análisis; la tarjeta hero de tasa de
  // cierre es lo ÚNICO de KPIs que queda visible en Gestión (Lalo 04-ago).
  let flujoCotizHtml = ""
  let tasaCierreHtml = ""
  {
    const vieronPrecio = cPreform + cEnviada
    const pasoPreform = vieronPrecio ? `${Math.round((cEnviada / vieronPrecio) * 100)}% de los que vieron precio` : ""
    const abandonoPreform = vieronPrecio ? `${Math.round((cPreform / vieronPrecio) * 100)}% de abandono tras ver precio` : ""
    const base = `
    ${kpiCard("Vio precio y NO avanzó", cPreform, col.warn, abandonoPreform || "quedó en preform", "preform")}
    ${kpiCard("Cotización enviada", cEnviada, col.best, pasoPreform, "enviada")}
    ${kpiCard("Se fue ANTES del precio", cAbandonado, col.bad, "sin preform", "abandonado")}`
    if (!cierre) {
      flujoCotizHtml = `<div class="kpis">${base}
  </div>
  <div class="sub" style="margin:-2px 0 10px">Zoho no disponible en esta carga — recarga para ver aceptadas y cierre.</div>`
    } else {
      const tasaAcept = cierre.total ? `${Math.round((cierre.aceptadas / cierre.total) * 100)}%` : ""
      const endToEnd = vieronPrecio ? Math.round((cierre.aceptadas / vieronPrecio) * 100) : 0
      // Objetivo de cierre POR PAÍS (Lalo 28-jul): Chile 30%; Colombia, Perú y
      // México 10% — los programas nuevos maduran distinto.
      const TARGET_PCT = pais === "cl" ? 30 : 10
      const metaExacta = (TARGET_PCT / 100) * vieronPrecio
      const cumpleMeta = vieronPrecio > 0 && cierre.aceptadas >= metaExacta
      const faltanEnviadas = Math.max(0, Math.ceil(metaExacta - cierre.aceptadas))
      const faltanNuevas = Math.max(0, Math.ceil((metaExacta - cierre.aceptadas) / (1 - TARGET_PCT / 100)))
      const leyendaObjetivo = cumpleMeta
        ? "vio precio → venta · objetivo alcanzado 🎉"
        : `vio precio → venta · faltan ${faltanEnviadas} venta${faltanEnviadas === 1 ? "" : "s"} de cotizaciones ya enviadas · o ${faltanNuevas} con cotizaciones nuevas`
      const colorObjetivo = cumpleMeta ? col.best : col.warn
      const avanceMeta = Math.min(100, Math.round((endToEnd / TARGET_PCT) * 100))
      tasaCierreHtml = vieronPrecio
        ? `<div class="kpis"><div class="kpi hero">
        <div class="kpi-v"><span style="color:${colorObjetivo}">${endToEnd}%</span> <span class="hero-meta">de cierre real · objetivo ${TARGET_PCT}%</span></div>
        <div class="hero-bar"><div style="width:${avanceMeta}%;background:${colorObjetivo}"></div></div>
        <div class="kpi-l">${avanceMeta}% del camino al objetivo <span class="pct">${leyendaObjetivo}</span></div>
      </div></div>`
        : ""
      flujoCotizHtml = `<div class="kpis">${base}
    ${kpiCard("Cotizaciones en Zoho", cierre.total, col.com, undefined, "zoho_cotizaciones")}
    ${kpiCard("Aceptadas / pagadas", cierre.aceptadas, col.good, tasaAcept, "zoho_aceptadas")}
  </div>
  <div class="sub" style="margin:-2px 0 10px">Nota: los 3 primeros KPI cuentan <b>conversaciones</b>; los de Zoho cuentan <b>cotizaciones</b>. Una conversación puede generar más de una cotización (p. ej. un contacto que cotiza para 2 empresas), por eso pueden diferir levemente.</div>`
    }
  }
  const pct = (x: number) => (total ? `${Math.round((x / total) * 100)}%` : "")

  const html = `<!doctype html><html lang="es"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Embudo de conversaciones — Vicky</title>
<script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
<style>
  ${GV_FONT_CSS}
  body{font-family:${GV_BODY_FONT};margin:0;background:#f7f8fa;color:#4e4e4e}
  .wrap{max-width:1440px;margin:0 auto;padding:24px 20px 60px}
  h1{font-family:${GV_TITLE_FONT};font-weight:700;font-size:22px;margin:0 0 4px;color:#4e4e4e}
  .sub{color:#646464;font-size:13px;margin-bottom:20px}
  .kpis{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:8px}
  .kpi{background:#fff;border:1px solid #dfe2e7;border-radius:10px;padding:14px 18px;min-width:120px;flex:1}
  .kpi-v{font-family:${GV_TITLE_FONT};font-size:28px;font-weight:700} .kpi-l{font-size:12px;color:#646464;margin-top:2px}
  .kpi.hero{flex-basis:100%;text-align:center;padding:20px 18px} .kpi.hero .kpi-v{font-size:42px}
  .hero-meta{font-size:17px;font-weight:600;color:#9aa0a8}
  .hero-bar{height:9px;background:#eef0f3;border-radius:5px;max-width:440px;margin:10px auto 6px;overflow:hidden}
  .hero-bar>div{height:100%;border-radius:5px}
  .pct{color:#9aa0a8} .tag{display:inline-block;background:#e6f8fe;color:#4e4e4e;font-size:11px;padding:2px 8px;border-radius:99px}
  .card{background:#fff;border:1px solid #dfe2e7;border-radius:12px;padding:18px;margin-top:18px}
  .card h2{font-family:${GV_TITLE_FONT};font-weight:600;font-size:16px;margin:0 0 12px;color:#4e4e4e}
  #sankey{width:100%;height:480px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #eef0f3;vertical-align:top}
  th{color:#646464;font-weight:700;font-size:12px}
  td.num{text-align:right;font-weight:700;width:64px;color:#646464}
  code{background:#eef0f3;padding:1px 5px;border-radius:4px;font-size:12px}
  a{color:#00aff2;text-decoration:none;font-weight:600} a:hover{text-decoration:underline}
  .kgroup{font-family:${GV_TITLE_FONT};font-size:11px;font-weight:700;color:#646464;text-transform:uppercase;letter-spacing:.04em;margin:16px 0 6px}
  .bars{display:flex;flex-direction:column;gap:8px}
  .bar-row{display:grid;grid-template-columns:160px 1fr 40px;align-items:center;gap:10px;font-size:13px}
  .bar-track{background:#eef0f3;border-radius:6px;height:18px;overflow:hidden}
  .bar-fill{background:#ffbb00;height:100%;border-radius:6px}
  .bar-num{text-align:right;font-weight:700;color:#646464}
  .foot{color:#9aa0a8;font-size:11px;margin-top:24px;text-align:center}
  /* Celular: menos padding, tipografía contenida, tablas con scroll propio e
   * inputs de 16px (evita el zoom automático de iOS al enfocar). */
  @media (max-width:640px){
    .wrap{padding:14px 12px 44px}
    h1{font-size:18px}
    .card{padding:12px;overflow-x:auto}
    .kpi{padding:10px 12px;min-width:100px}
    .kpi-v{font-size:22px}
    .kpi.hero .kpi-v{font-size:30px}
    #sankey{height:340px}
    .bar-row{grid-template-columns:110px 1fr 36px}
    form input[type=date],form select{font-size:16px !important;padding:6px 8px !important}
    form button[type=submit]{font-size:14px !important;padding:8px 16px !important}
  }
</style></head><body><div class="wrap">
  <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
    <div style="display:flex;align-items:center;gap:16px"><img src="/gv/logo-full-color.svg" alt="GeoVictoria" style="height:30px"><h1 style="margin:0">${vista === "gestion" ? "Gestión de oportunidades" : "Análisis y KPIs"}</h1></div>
    <a href="?${(() => { const p = filtrosQS(); if (vista === "gestion") { p.set("vista", "analisis") } else { p.delete("vista") } return p.toString() })()}" style="font-size:14px;white-space:nowrap">${vista === "gestion" ? "📊 Análisis y KPIs →" : "← 📞 Gestión"}</a>
  </div>
  <div class="sub">${(Object.keys(PAISES) as Pais[]).map((k) => `<a href="?key=${encodeURIComponent(key)}&pais=${k}${vista === "analisis" ? "&vista=analisis" : ""}" style="font-weight:${pais === k ? 700 : 400}">${PAISES[k].label}</a>`).join(" | ")}</div>
  <div class="sub" style="margin-top:6px">
    <form method="GET" style="display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap">
      <input type="hidden" name="key" value="${esc(key)}">
      <input type="hidden" name="pais" value="${pais}">
      ${vista === "analisis" ? `<input type="hidden" name="vista" value="analisis">` : ""}
      <label style="font-size:12px">Desde <input type="date" name="desde" value="${rango ? rango.desdeStr : ""}" style="font-size:12px;padding:2px 4px;border:1px solid #d0d5db;border-radius:5px"></label>
      <label style="font-size:12px">Hasta <input type="date" name="hasta" value="${rango ? rango.hastaStr : ""}" style="font-size:12px;padding:2px 4px;border:1px solid #d0d5db;border-radius:5px"></label>
      <label style="font-size:12px">Estado <select name="estado" style="font-size:12px;padding:2px 4px;border:1px solid #d0d5db;border-radius:5px">
        <option value="">Todos</option>
        ${ESTADOS_LISTADO.map((e) => `<option${estadoF === e ? " selected" : ""}>${e}</option>`).join("")}
      </select></label>
      <label style="font-size:12px">Propietario <select name="prop" style="font-size:12px;padding:2px 4px;border:1px solid #d0d5db;border-radius:5px">
        <option value="">Todos</option>
        ${propietariosAll.map((p) => `<option value="${esc(p)}"${propF === p ? " selected" : ""}>${esc(p)}</option>`).join("")}
      </select></label>
      <button type="submit" style="background:#ffbb00;color:#fff;border:0;border-radius:6px;padding:3px 12px;font-size:12px;font-weight:700;cursor:pointer">Filtrar</button>
      ${rango || estadoF || propF ? `<a href="?key=${encodeURIComponent(key)}&pais=${pais}" style="font-size:12px">✕ Quitar filtros</a>` : ""}
    </form>
  </div>

  ${vista === "gestion" ? `
  ${colaHtml}
  ` : `
  ${tasaCierreHtml}
  ${evolucionHtml}
  <div class="kgroup">Por grupo · suman el total (${total})</div>
  <div class="kpis">
    ${kpiCard("Conversaciones", total, col.base, undefined, "total")}
    ${kpiCard("Intención comercial", comercial, col.com, pct(comercial), "comercial")}
    ${kpiCard("Soporte", soporte, col.sop, pct(soporte), "soporte")}
    ${kpiCard("No identificado", noId, col.noid, pct(noId), "no_identificado")}
  </div>
  <div class="kgroup">Dentro de intención comercial (${comercial})</div>
  <div class="kpis">
    ${kpiCard("Flujo cotización", cotizacion, col.com, undefined, "cotizacion")}
    ${kpiCard("Reunión", reunion, col.good, undefined, "reunion")}
    ${kpiCard("Lead (callback)", lead, col.warn, undefined, "lead")}
    ${kpiCard("Crosselling", crosselling, col.good, undefined, "crosselling")}
    ${kpiCard("Solo dudas", soloDudas, col.grey, undefined, "solo_dudas")}
  </div>
  <div class="kgroup">Flujo cotización y tasa de cierre (${cotizacion} conversaciones · cierre en vivo desde Zoho)</div>
  ${flujoCotizHtml}

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

  ${funnelOrigenHtml}
  `}

</div>
<script>
  var sankeyDiv = document.getElementById("sankey");
  if (sankeyDiv) {
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
  }
</script>
</body></html>`

  return page(html)
}
