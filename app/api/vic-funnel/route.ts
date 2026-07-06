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
async function fetchCierreZoho(): Promise<{ total: number; aceptadas: number } | null> {
  try {
    const token = await getZohoAccessToken()
    const res = await fetch(`${ZOHO_API_DOMAIN}/crm/v3/coql`, {
      method: "POST",
      headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        select_query: `select id, Estado_Cotizacion from ${QUOTE_MODULE} where Created_By = ${VICKY_CREATOR_ID} limit 200`,
      }),
      cache: "no-store",
    })
    if (!res.ok) return null
    const data = (await res.json().catch(() => null)) as { data?: Array<{ Estado_Cotizacion?: string }> } | null
    const quotes = data?.data || []
    const aceptadas = quotes.filter((q) => String(q.Estado_Cotizacion || "").toLowerCase().includes("acept")).length
    return { total: quotes.length, aceptadas }
  } catch {
    return null
  }
}

// Hallazgos cualitativos curados (editables a mano — pídeme actualizarlos).
const CURATED_FINDINGS: Array<{ titulo: string; detalle: string }> = [
  {
    titulo: "Objeción al precio de compra del reloj se atacaba mal",
    detalle:
      "Cuando el cliente objetaba el reloj en venta, se descontaba el plan mensual (irrelevante al pago inicial). Resuelto: ahora Vicky pivotea a arriendo ante esa objeción.",
  },
  {
    titulo: "Vicky ofrecía la compra del reloj sin que se la pidieran",
    detalle:
      "Ante '¿cuánto vale el reloj?' daba el precio de compra (8 UF). Resuelto: ahora responde solo arriendo salvo que el cliente pida comprar.",
  },
  {
    titulo: "Dimensionamiento de relojes",
    detalle:
      "Se aceptaba 1 reloj para muchas personas con turnos (riesgo de fila). Resuelto: ahora pregunta por simultaneidad y sugiere 2.",
  },
  {
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
  let cierre: { total: number; aceptadas: number } | null = null
  try {
    const [allRows, hard, cierreZoho] = await Promise.all([fetchAnalysis(), fetchHardSignals(), fetchCierreZoho()])
    cierre = cierreZoho
    rows = allRows.filter((r) => !isTestContact(r.contact))
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
    /* 9 */ "Preform mostrado", /* 10 */ "Cotización enviada", /* 11 */ "Abandonado",
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

  const kpiCard = (label: string, value: number, color: string, sub?: string) =>
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
  <div class="sub">Clientes reales (excluye pruebas internas) · ${total} conversaciones · <span class="tag">actualizado por hora</span> · última actualización: ${lastUpdateStr}</div>

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
  <div class="kgroup">Dentro de flujo cotización (${cotizacion})</div>
  <div class="kpis">
    ${kpiCard("Preform mostrado", cPreform, col.good)}
    ${kpiCard("Cotización enviada", cEnviada, col.best)}
    ${kpiCard("Abandonado", cAbandonado, col.bad)}
  </div>

  <div class="kgroup">Tasa de cierre — en vivo (preforms: análisis · cotizaciones/aceptadas: Zoho)</div>
  ${(() => {
    const vieronPrecio = cPreform + cEnviada
    const pasoPreform = vieronPrecio ? `${Math.round((cEnviada / vieronPrecio) * 100)}%` : ""
    if (!cierre) {
      return `<div class="kpis">
    ${kpiCard("Vieron precio", vieronPrecio, col.com)}
    ${kpiCard("→ Cotización formal", cEnviada, col.best, pasoPreform)}
  </div>
  <div class="sub" style="margin:-2px 0 10px">Zoho no disponible en esta carga — recarga para ver aceptadas y cierre.</div>`
    }
    const tasaAcept = cierre.total ? `${Math.round((cierre.aceptadas / cierre.total) * 100)}%` : ""
    const endToEnd = vieronPrecio ? Math.round((cierre.aceptadas / vieronPrecio) * 100) : 0
    return `<div class="kpis">
    ${kpiCard("Vieron precio", vieronPrecio, col.com)}
    ${kpiCard("→ Cotización formal", cEnviada, col.best, pasoPreform)}
    ${kpiCard("Cotizaciones en Zoho", cierre.total, col.com)}
    ${kpiCard("Aceptadas / pagadas", cierre.aceptadas, col.good, tasaAcept)}
    ${kpiCard("Cierre end-to-end (%)", endToEnd, col.best, "vio precio → venta")}
  </div>`
  })()}

  <div class="card"><h2>Flujo del embudo</h2><div id="sankey"></div>
    <div class="sub" style="margin:8px 0 0">Flujo cotización (${cotizacion}): <b>${cPreform}</b> preform mostrado · <b>${cEnviada}</b> cotización enviada · <b>${cAbandonado}</b> abandonado.</div>
  </div>

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
          <td>${r.cotizacion_outcome === "preform_mostrado" ? "Preform" : "Abandonado"}</td>
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

  <div class="card"><h2>Hallazgos cualitativos (curados)</h2>
    <table><thead><tr><th>Hallazgo</th><th>Detalle</th></tr></thead><tbody>
      ${CURATED_FINDINGS.map((f) => `<tr><td style="width:34%"><b>${f.titulo}</b></td><td>${f.detalle}</td></tr>`).join("")}
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
