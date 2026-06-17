/**
 * Dashboard de embudo (Sankey) de las conversaciones de Vicky V3.
 *
 * GET /api/vic-funnel?key=<VIC_FUNNEL_KEY>[&days=N]
 *
 * Sirve una página HTML en vivo (Sankey con Plotly + KPIs + hallazgos) para
 * compartir con el equipo comercial. La data sale de la vista
 * `vic_v3_conversation_signals` (Supabase), que encapsula las heurísticas del
 * embudo. Se excluyen los contactos de prueba (env VIC_FUNNEL_TEST_CONTACTS).
 *
 * "Se actualiza diariamente" = la página consulta en vivo, así que cada vez que
 * se abre muestra la data actual. No requiere cron.
 */

export const dynamic = "force-dynamic"

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const FUNNEL_KEY = (process.env.VIC_FUNNEL_KEY || "").trim()

// Números internos de prueba a excluir (configurable sin redeploy).
const DEFAULT_TEST_CONTACTS = [
  "56944668823", // Eduardo
  "56978385048", // Rodrigo
  "56962288575", // Kerim
  "56982945030", // Andrea
  "56966850332", // C. Fuentes
]
function testContacts(): Set<string> {
  const raw = (process.env.VIC_FUNNEL_TEST_CONTACTS || "").trim()
  const list = raw ? raw.split(",").map((s) => s.replace(/\D/g, "").trim()).filter(Boolean) : DEFAULT_TEST_CONTACTS
  return new Set(list)
}

// Hallazgos curados (sección editable a mano — pídeme actualizarlos cuando
// quieras). Se muestran junto a los auto-detectados.
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
  started_at: string
  intencion: boolean
  inicio_cotizar: boolean
  preform: boolean
  cotizacion: boolean
  reunion: boolean
  lead: boolean
  f_venta_proactiva: boolean
  f_objecion_no_cierre: boolean
  f_fuera_catalogo: boolean
  f_pidio_humano: boolean
  f_audio: boolean
}

async function fetchSignals(days: number | null): Promise<Row[]> {
  let url = `${SUPABASE_URL}/rest/v1/vic_v3_conversation_signals?select=*`
  if (days && days > 0) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
    url += `&started_at=gte.${since}`
  }
  const res = await fetch(url, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    cache: "no-store",
  })
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return (await res.json()) as Row[]
}

function page(html: string, status = 200): Response {
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } })
}

export async function GET(req: Request): Promise<Response> {
  const { searchParams } = new URL(req.url)
  const key = (searchParams.get("key") || "").trim()
  const daysRaw = parseInt(searchParams.get("days") || "", 10)
  const days = Number.isFinite(daysRaw) && daysRaw > 0 ? daysRaw : null

  if (!FUNNEL_KEY) {
    return page("<h1>Falta configurar VIC_FUNNEL_KEY</h1><p>Define la variable de entorno VIC_FUNNEL_KEY en Vercel para proteger este dashboard.</p>", 503)
  }
  if (key !== FUNNEL_KEY) {
    return page("<h1>No autorizado</h1><p>Falta o es incorrecto el parámetro <code>?key=</code>.</p>", 401)
  }

  let rows: Row[]
  try {
    rows = await fetchSignals(days)
  } catch (e) {
    return page(`<h1>Error consultando datos</h1><pre>${String(e).slice(0, 300)}</pre>`, 500)
  }

  const test = testContacts()
  const reales = rows.filter((r) => !test.has((r.contact || "").replace(/\D/g, "")))

  const n = (pred: (r: Row) => boolean) => reales.filter(pred).length
  const total = reales.length
  const intencion = n((r) => r.intencion)
  const sinIntencion = total - intencion
  const inicio = n((r) => r.intencion && r.inicio_cotizar)
  const preform2 = (r: Row) => r.preform || r.cotizacion
  const reunion = n((r) => r.intencion && !r.inicio_cotizar && r.reunion)
  const lead = n((r) => r.intencion && !r.inicio_cotizar && !r.reunion && r.lead)
  const soloConsulta = n((r) => r.intencion && !r.inicio_cotizar && !r.reunion && !r.lead)
  const nPreform = n((r) => r.intencion && r.inicio_cotizar && preform2(r))
  const inicioSinPreform = n((r) => r.intencion && r.inicio_cotizar && !preform2(r))
  const cotizacion = n((r) => r.intencion && r.inicio_cotizar && preform2(r) && r.cotizacion)
  const preformSinCotiz = n((r) => r.intencion && r.inicio_cotizar && preform2(r) && !r.cotizacion)

  // Totales brutos (no exclusivos) para el strip de KPIs.
  const kpi = {
    total,
    intencion,
    inicio: n((r) => r.inicio_cotizar),
    preform: n((r) => r.preform || r.cotizacion),
    cotizacion: n((r) => r.cotizacion),
    reunion: n((r) => r.reunion),
    lead: n((r) => r.lead),
  }

  const auto = {
    venta_proactiva: n((r) => r.f_venta_proactiva),
    objecion_no_cierre: n((r) => r.f_objecion_no_cierre),
    fuera_catalogo: n((r) => r.f_fuera_catalogo),
    pidio_humano: n((r) => r.f_pidio_humano),
    audio: n((r) => r.f_audio),
  }

  // Nodos del Sankey
  const labels = [
    "Conversaciones", "Con intención", "Sin intención", "Inició cotización",
    "Reunión agendada", "Lead / callback", "Solo consulta", "Preform enviada",
    "Cotización enviada", "Abandonó (sin preform)", "No avanzó a cotización",
  ]
  const C = { base: "#2F5496", good: "#2E7D32", warn: "#9E9E9E", best: "#1B5E20" }
  const nodeColor = [C.base, C.base, C.warn, C.base, C.good, "#F9A825", C.warn, C.good, C.best, C.warn, C.warn]
  const link = (s: number, t: number, v: number) => ({ s, t, v })
  const links = [
    link(0, 1, intencion), link(0, 2, sinIntencion),
    link(1, 3, inicio), link(1, 4, reunion), link(1, 5, lead), link(1, 6, soloConsulta),
    link(3, 7, nPreform), link(3, 9, inicioSinPreform),
    link(7, 8, cotizacion), link(7, 10, preformSinCotiz),
  ].filter((l) => l.v > 0)

  const rango = days ? `últimos ${days} días` : "todo el histórico"
  const fechas = reales.length
    ? `${reales.map((r) => r.started_at).sort()[0]?.slice(0, 10)} → ${reales.map((r) => r.started_at).sort().slice(-1)[0]?.slice(0, 10)}`
    : "—"

  const kpiCard = (label: string, value: number, color: string) =>
    `<div class="kpi"><div class="kpi-v" style="color:${color}">${value}</div><div class="kpi-l">${label}</div></div>`

  const findingRow = (t: string, c: number, d: string) =>
    `<tr><td>${t}</td><td class="num">${c}</td><td>${d}</td></tr>`

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
  .card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:18px;margin-top:18px}
  .card h2{font-size:16px;margin:0 0 12px}
  #sankey{width:100%;height:460px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #eef0f2;vertical-align:top}
  th{color:#6b7280;font-weight:600;font-size:12px}
  td.num{text-align:right;font-weight:700;width:64px;color:#9A6700}
  .foot{color:#9ca3af;font-size:11px;margin-top:24px;text-align:center}
  .tag{display:inline-block;background:#eef2ff;color:#3730a3;font-size:11px;padding:2px 8px;border-radius:99px}
</style></head><body><div class="wrap">
  <h1>Embudo de conversaciones — Vicky V3</h1>
  <div class="sub">Clientes reales (excluye pruebas internas) · ${rango} · ${fechas} · <span class="tag">en vivo</span></div>

  <div class="kpis">
    ${kpiCard("Conversaciones", kpi.total, C.base)}
    ${kpiCard("Con intención", kpi.intencion, C.base)}
    ${kpiCard("Inició cotización", kpi.inicio, "#1565C0")}
    ${kpiCard("Preform enviada", kpi.preform, C.good)}
    ${kpiCard("Cotización enviada", kpi.cotizacion, C.best)}
    ${kpiCard("Reunión agendada", kpi.reunion, C.good)}
    ${kpiCard("Lead / callback", kpi.lead, "#F9A825")}
  </div>

  <div class="card"><h2>Flujo del embudo</h2><div id="sankey"></div></div>

  <div class="card"><h2>Hallazgos auto-detectados</h2>
    <table><thead><tr><th>Patrón</th><th class="num">N°</th><th>Qué significa</th></tr></thead><tbody>
      ${findingRow("Ofreció venta sin que la pidieran", auto.venta_proactiva, "Vicky mencionó compra/venta del reloj y el cliente nunca lo pidió.")}
      ${findingRow("Objetó precio y no cerró", auto.objecion_no_cierre, "El cliente puso objeción de precio/descuento y no terminó en cotización.")}
      ${findingRow("Pidió algo fuera de catálogo", auto.fuera_catalogo, "Pidió algo que Vicky no tiene (ej. marcaje por tarjeta) y derivó.")}
      ${findingRow("Pidió hablar con un humano", auto.pidio_humano, "El cliente pidió ejecutivo/persona en vez del bot.")}
      ${findingRow("Conversaciones con audio", auto.audio, "Incluyeron notas de voz (se transcriben con ElevenLabs).")}
    </tbody></table>
  </div>

  <div class="card"><h2>Hallazgos cualitativos (curados)</h2>
    <table><thead><tr><th>Hallazgo</th><th>Detalle</th></tr></thead><tbody>
      ${CURATED_FINDINGS.map((f) => `<tr><td style="width:34%"><b>${f.titulo}</b></td><td>${f.detalle}</td></tr>`).join("")}
    </tbody></table>
  </div>

  <div class="foot">Generado en vivo desde Supabase · Vicky V3 · GeoVictoria</div>
</div>
<script>
  var labels = ${JSON.stringify(labels)};
  var nodeColor = ${JSON.stringify(nodeColor)};
  var L = ${JSON.stringify(links)};
  var data = [{
    type: "sankey", orientation: "h",
    node: { label: labels, color: nodeColor, pad: 18, thickness: 18,
      line: { color: "#fff", width: 1 } },
    link: { source: L.map(function(x){return x.s}), target: L.map(function(x){return x.t}),
      value: L.map(function(x){return x.v}), color: "rgba(47,84,150,0.18)" }
  }];
  Plotly.newPlot("sankey", data, { font: { size: 12 }, margin: { l: 0, r: 0, t: 8, b: 8 } }, { responsive: true, displayModeBar: false });
</script>
</body></html>`

  return page(html)
}
