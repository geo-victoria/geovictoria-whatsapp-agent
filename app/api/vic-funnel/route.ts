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

export const dynamic = "force-dynamic"

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const FUNNEL_KEY = (process.env.VIC_FUNNEL_KEY || "").trim()

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
  contact: string
  grupo: string
  sub_bucket: string | null
  cotizacion_outcome: string | null
  es_cliente_actual: boolean
  resumen: string | null
  hallazgos: Array<{ tipo: string; detalle: string }> | null
  analyzed_at: string | null
}

async function fetchAnalysis(): Promise<Row[]> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/vic_v3_conversation_analysis?select=contact,grupo,sub_bucket,cotizacion_outcome,es_cliente_actual,resumen,hallazgos,analyzed_at`,
    {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      cache: "no-store",
    },
  )
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return (await res.json()) as Row[]
}

function page(html: string, status = 200): Response {
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } })
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

  let rows: Row[]
  try {
    rows = (await fetchAnalysis()).filter((r) => !isTestContact(r.contact))
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
  const callback = n((r) => r.grupo === "comercial" && r.sub_bucket === "callback")
  const reunion = n((r) => r.grupo === "comercial" && r.sub_bucket === "reunion")
  const cotizacion = n((r) => r.grupo === "comercial" && r.sub_bucket === "cotizacion")

  const cEnviada = n((r) => r.sub_bucket === "cotizacion" && r.cotizacion_outcome === "enviada")
  const cFuga = n((r) => r.sub_bucket === "cotizacion" && r.cotizacion_outcome === "fuga")
  const cRechazo = n((r) => r.sub_bucket === "cotizacion" && r.cotizacion_outcome === "rechazo_explicito")
  const cSinPreform = n((r) => r.sub_bucket === "cotizacion" && r.cotizacion_outcome === "sin_preform")

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
  const labels = [
    "Conversaciones", "Intención comercial", "Soporte", "No identificado",
    "Crosselling", "Callback (lead)", "Reunión agendada", "Cotización",
    "Cotización enviada", "Fuga", "Rechazo explícito", "No alcanzó preform",
  ]
  const col = {
    base: "#2F5496", com: "#1565C0", sop: "#00838F", noid: "#9E9E9E",
    good: "#2E7D32", best: "#1B5E20", warn: "#F9A825", bad: "#C62828", grey: "#9E9E9E",
  }
  const nodeColor = [
    col.base, col.com, col.sop, col.noid,
    col.good, col.warn, col.good, col.com,
    col.best, col.warn, col.bad, col.grey,
  ]
  const mk = (s: number, t: number, v: number) => ({ s, t, v })
  const links = [
    mk(0, 1, comercial), mk(0, 2, soporte), mk(0, 3, noId),
    mk(1, 4, crosselling), mk(1, 5, callback), mk(1, 6, reunion), mk(1, 7, cotizacion),
    mk(7, 8, cEnviada), mk(7, 9, cFuga), mk(7, 10, cRechazo), mk(7, 11, cSinPreform),
  ].filter((l) => l.v > 0)

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
  .kgroup{font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;margin:16px 0 6px}
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
    ${kpiCard("Cotización", cotizacion, col.com)}
    ${kpiCard("Reunión", reunion, col.good)}
    ${kpiCard("Callback (lead)", callback, col.warn)}
    ${kpiCard("Crosselling", crosselling, col.good)}
  </div>
  <div class="kgroup">Resultado de las cotizaciones (${cotizacion})</div>
  <div class="kpis">
    ${kpiCard("Enviada / aceptada", cEnviada, col.best)}
    ${kpiCard("Fuga", cFuga, col.warn)}
    ${kpiCard("Rechazo explícito", cRechazo, col.bad)}
    ${kpiCard("No alcanzó preform", cSinPreform, col.grey)}
  </div>

  <div class="card"><h2>Flujo del embudo</h2><div id="sankey"></div>
    <div class="sub" style="margin:8px 0 0">Cotización: <b>${cEnviada}</b> enviada/aceptada · <b>${cFuga}</b> fuga · <b>${cRechazo}</b> rechazo explícito · <b>${cSinPreform}</b> no alcanzó preform.</div>
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
    node: { label: labels, color: nodeColor, pad: 18, thickness: 18, line: { color: "#fff", width: 1 } },
    link: { source: L.map(function(x){return x.s}), target: L.map(function(x){return x.t}),
      value: L.map(function(x){return x.v}), color: "rgba(47,84,150,0.16)" }
  }];
  Plotly.newPlot("sankey", data, { font: { size: 12 }, margin: { l: 0, r: 0, t: 8, b: 8 } }, { responsive: true, displayModeBar: false });
</script>
</body></html>`

  return page(html)
}
