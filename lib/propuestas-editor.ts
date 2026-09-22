/**
 * "Vicky Propuestas" — agente INTERNO del dashboard para crear PROPUESTAS
 * COMERCIALES bonitas (pedido Lalo 07-ago), con la misma estructura del
 * creador de cotizaciones: se elige la empresa (un deal de la cartera del
 * vendedor), se conversa con el agente entregando la información — incluido
 * el guion/minuta de una reunión si existe — y la propuesta se genera con el
 * branding GeoVictoria en una página imprimible con link estable por deal.
 *
 * La propuesta vive como DATOS (JSON en vic_kv `propuesta_deal_<dealId>`) y
 * se renderiza al verla — así el template puede evolucionar sin regenerar
 * nada. Cada llamada a la tool REEMPLAZA el contenido completo (mismo patrón
 * "configuración completa" del editor de cotizaciones).
 */

import Anthropic from "@anthropic-ai/sdk"

import { getKvValue, setKvValue } from "@/lib/supabase-persistence-v3"
import { infoDeal, estadoCotizacion, type EstadoCotizacion } from "@/lib/cotizaciones-editor"

const DEFAULT_MODEL = "claude-sonnet-4-5-20250929"
const MAX_ITERATIONS = 4
const MAX_TOKENS = 3000

const GV_FONT_CSS = `
  @font-face{font-family:"BR Sonoma";src:url("/gv/fonts/BRSonoma-SemiBold.otf") format("opentype");font-weight:600;font-display:swap}
  @font-face{font-family:"BR Sonoma";src:url("/gv/fonts/BRSonoma-Bold.otf") format("opentype");font-weight:700;font-display:swap}
  @font-face{font-family:"Nunito";src:url("/gv/fonts/Nunito-Regular.ttf") format("truetype");font-weight:400;font-display:swap}
  @font-face{font-family:"Nunito";src:url("/gv/fonts/Nunito-SemiBold.ttf") format("truetype");font-weight:600;font-display:swap}
  @font-face{font-family:"Nunito";src:url("/gv/fonts/Nunito-Bold.ttf") format("truetype");font-weight:700;font-display:swap}`
const F_TITULO = `"BR Sonoma","Nunito",-apple-system,Segoe UI,Roboto,Arial,sans-serif`
const F_CUERPO = `"Nunito",-apple-system,Segoe UI,Roboto,Arial,sans-serif`

export type PropuestaDatos = {
  titulo: string
  subtitulo?: string
  empresa: string
  preparadaPara?: string
  resumen: string
  necesidades?: string[]
  solucion?: Array<{ titulo: string; detalle: string }>
  precios?: Array<{ item: string; detalle?: string; valor: string }>
  precioNota?: string
  diferenciales?: string[]
  proximosPasos?: string[]
  vendedor?: { nombre?: string; email?: string; telefono?: string }
}

type PropuestaGuardada = {
  datos: PropuestaDatos
  dealId: string
  actualizadaAt: string
  actualizadaPor?: string
  /** N.º de propuesta de 6 dígitos (estable por deal) y versión incremental,
   * como manda el skill gv-propuestas (portada y condiciones). */
  numero?: string
  version?: number
}

export const clavePropuesta = (dealId: string) => `propuesta_deal_${dealId}`

export async function propuestaGuardada(dealId: string): Promise<PropuestaGuardada | null> {
  try {
    const raw = await getKvValue(clavePropuesta(dealId))
    if (!raw) return null
    const p = JSON.parse(raw) as PropuestaGuardada
    return p?.datos ? p : null
  } catch {
    return null
  }
}

const esc = (s: unknown) =>
  String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

/** Render de la propuesta — DISEÑO DEL SKILL gv-propuestas (pedido Lalo
 * 07-ago: "la de la plataforma no es tan linda como la del skill"): portada
 * blanca con chevrón azul, doble barra azul/amarilla, badges azules, tabla
 * con encabezado azul y total amarillo, callout de recomendación, barra de
 * contacto y #YoTeAyudo. Imprimible como PDF con el botón (impresión del
 * navegador; la portada es blanca, así que los márgenes de impresión no la
 * rompen). */
export function renderPropuestaHtml(p: PropuestaGuardada): string {
  const d = p.datos
  const fecha = new Date(p.actualizadaAt || Date.now()).toLocaleDateString("es-CL", {
    timeZone: "America/Santiago",
    day: "numeric",
    month: "long",
    year: "numeric",
  })
  const v = d.vendedor || {}
  const lista = (items: string[] | undefined) =>
    items?.length ? `<ul class="ul">${items.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""
  let nSeccion = 0
  const seccion = (titulo: string, cuerpo: string, lead = "") => {
    if (!cuerpo) return ""
    nSeccion++
    return `<section class="blockSec">
      <h2 class="sec"><span class="num">${nSeccion}</span>${esc(titulo)}</h2>
      ${lead ? `<p class="sec-lead">${esc(lead)}</p>` : ""}
      ${cuerpo}
    </section>`
  }
  // Solución en tarjetas (2 por fila, bordes superiores alternando azul/amarillo).
  const solucionHtml = d.solucion?.length
    ? (() => {
        const cards = d.solucion.map(
          (s, i) =>
            `<div class="card ${i % 2 === 0 ? "top-b" : "top-y"}"><div class="cap">${esc(s.titulo)}</div><p>${esc(s.detalle)}</p></div>`,
        )
        const filasC: string[] = []
        for (let i = 0; i < cards.length; i += 2) filasC.push(`<div class="cards">${cards.slice(i, i + 2).join("")}</div>`)
        return filasC.join("")
      })()
    : ""
  const preciosHtml = d.precios?.length
    ? `<table class="gv"><thead><tr><th>Ítem</th><th>Detalle</th><th class="num">Valor</th></tr></thead>
       <tbody>${d.precios.map((r) => `<tr><td class="svc">${esc(r.item)}</td><td>${esc(r.detalle || "")}</td><td class="num u">${esc(r.valor)}</td></tr>`).join("")}</tbody></table>
       ${d.precioNota ? `<p class="note">${esc(d.precioNota)}</p>` : ""}`
    : ""
  const docmeta = p.numero
    ? `${/^COT/i.test(p.numero) ? `Cotización N.º ${esc(p.numero)}` : `Propuesta N.º ${esc(p.numero)}`} · <span class="v">v${p.version || 1}</span>`
    : ""
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Propuesta GeoVictoria — ${esc(d.empresa)}</title>
<style>
  ${GV_FONT_CSS}
  :root{--blue:#00aff2;--yellow:#ffbb00;--gray:#646464;--gray6:#4e4e4e;--blue50:#e6f8fe;--yellow50:#fffaeb;--g50:#f7f8fa;--g100:#eef0f3;--g200:#dfe2e7}
  *{box-sizing:border-box}
  body{font-family:${F_CUERPO};margin:0;background:#e9ebee;color:var(--gray6);font-size:14px;line-height:1.55}
  .hoja{max-width:880px;margin:0 auto;background:#fff;box-shadow:0 2px 18px rgba(0,0,0,.08)}
  /* ── Portada (skill gv-propuestas: blanca, chevrón azul, doble barra) ── */
  .cover{position:relative;min-height:920px;overflow:hidden;background:#fff}
  .cover .bluechev{position:absolute;right:-40px;top:-50px;width:420px;height:320px}
  .cover .inner{position:absolute;left:64px;right:64px;top:70px}
  .cover .logo{width:190px;display:block}
  .cover .overline{margin-top:110px;color:var(--blue);font-weight:800;letter-spacing:3px;font-size:14px;text-transform:uppercase}
  .cover h1{font-family:${F_TITULO};font-weight:700;color:var(--gray6);font-size:40px;line-height:1.1;margin:14px 0 0;letter-spacing:-.5px;max-width:600px}
  .cover .sub{color:var(--gray);font-size:17px;margin-top:14px;max-width:560px}
  .prepared{position:absolute;left:64px;right:64px;bottom:170px;display:flex;align-items:center;gap:30px}
  .prepared .plabel{font-weight:700;text-transform:uppercase;letter-spacing:2px;color:#9aa0a8;font-size:11px}
  .prepared .clientbox{border-left:3px solid var(--yellow);padding-left:20px}
  .prepared .client{font-family:${F_TITULO};font-weight:700;font-size:24px;color:var(--gray6)}
  .prepared .date{margin-top:7px;color:var(--gray);font-size:13.5px}
  .prepared .docmeta{margin-top:5px;color:var(--gray6);font-size:12.5px;font-weight:800;letter-spacing:.3px}
  .prepared .docmeta .v{color:var(--blue)}
  .barwrap{position:absolute;left:0;right:0;bottom:66px}
  .bar-blue{height:8px;background:var(--blue)}
  .bar-yellow{height:20px;background:var(--yellow)}
  .cover .contact{position:absolute;left:64px;right:64px;bottom:24px;display:flex;justify-content:space-between;align-items:center;color:var(--gray);font-size:12.5px;gap:12px;flex-wrap:wrap}
  .yta{font-weight:800;font-size:15px}
  .yta .y{color:var(--gray)}.yta .t{color:var(--blue)}.yta .a{color:var(--yellow)}
  /* ── Cuerpo ── */
  main{padding:48px 64px 40px}
  .blockSec{margin:0 0 36px}
  h2.sec{display:flex;align-items:center;gap:14px;font-family:${F_TITULO};font-weight:700;color:var(--blue);font-size:22px;margin:0 0 8px}
  h2.sec .num{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:50%;background:var(--blue);color:#fff;font-family:${F_CUERPO};font-weight:800;font-size:16px;flex:none}
  .sec-lead{color:var(--gray);font-size:14px;margin:0 0 14px}
  p{margin:0 0 10px}
  .ul{margin:0;padding-left:22px}
  .ul li{margin:5px 0;color:var(--gray)}
  .ul li::marker{color:var(--blue)}
  .callout{background:var(--yellow50);border-left:4px solid var(--yellow);padding:14px 18px;border-radius:0 8px 8px 0;color:var(--gray6);margin:12px 0}
  .cards{display:flex;gap:14px;margin:12px 0}
  .card{flex:1;border:1px solid var(--g200);border-radius:10px;padding:16px;background:#fff}
  .card .cap{font-weight:800;color:var(--blue);font-size:15px;margin:0 0 6px}
  .card p{margin:0;font-size:13px;color:var(--gray)}
  .card.top-y{border-top:3px solid var(--yellow)}
  .card.top-b{border-top:3px solid var(--blue)}
  table.gv{width:100%;border-collapse:collapse;font-size:13.5px;margin:8px 0 4px}
  table.gv thead th{background:var(--blue);color:#fff;font-weight:700;text-align:left;padding:10px 12px;font-size:12.5px}
  table.gv thead th.num{text-align:right}
  table.gv tbody td{padding:10px 12px;border-bottom:1px solid var(--g200);vertical-align:middle}
  table.gv tbody tr:nth-child(even){background:var(--g50)}
  table.gv td.svc{font-weight:700;color:var(--gray6)}
  table.gv td.num{text-align:right;white-space:nowrap}
  table.gv td.u{color:var(--blue);font-weight:800}
  .note{font-size:11.5px;color:#9aa0a8;margin:6px 0 0;line-height:1.45}
  .contactbar{margin:44px 64px 0;background:var(--blue);color:#fff;border-radius:12px;padding:20px 24px;display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap}
  .contactbar .who{font-family:${F_TITULO};font-weight:700;font-size:17px}
  .contactbar .det{font-size:13px;opacity:.95;margin-top:4px}
  .contactbar .yta{font-size:16px}
  .contactbar .yta .y{color:#fff}.contactbar .yta .t{color:#fff}.contactbar .yta .a{color:var(--yellow)}
  .piefin{height:36px}
  .btnPrint{position:fixed;top:14px;right:14px;background:var(--yellow);color:#fff;border:0;border-radius:10px;padding:10px 16px;font-family:${F_TITULO};font-weight:700;font-size:13px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.15);z-index:9}
  @media (max-width:700px){.cover .inner,.prepared,.cover .contact{left:24px;right:24px}main{padding:32px 24px}.contactbar{margin:32px 24px 0}.cards{flex-direction:column}.cover h1{font-size:30px}}
  @media print{
    .btnPrint{display:none}
    body{background:#fff}
    .hoja{max-width:none;box-shadow:none}
    .cover{min-height:96vh;page-break-after:always}
    *{-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .blockSec{page-break-inside:avoid}
    .contactbar{page-break-inside:avoid}
  }
</style></head><body>
<button class="btnPrint" onclick="window.print()">🖨️ Guardar como PDF</button>
<div class="hoja">
  <div class="cover">
    <svg class="bluechev" viewBox="0 0 120 90" xmlns="http://www.w3.org/2000/svg"><path d="M20 0 L70 0 L120 55 L120 90 L70 40 L20 90 L20 55 L55 20 Z" fill="#00aff2" opacity="0.9"/></svg>
    <div class="inner">
      <img class="logo" src="/gv/logo-full-color.svg" alt="GeoVictoria" onerror="this.style.display='none'">
      <div class="overline">Propuesta comercial</div>
      <h1>${esc(d.titulo || `Propuesta para ${d.empresa}`)}</h1>
      ${d.subtitulo ? `<div class="sub">${esc(d.subtitulo)}</div>` : ""}
    </div>
    <div class="prepared">
      <div><div class="plabel">Preparado para</div></div>
      <div class="clientbox">
        <div class="client">${esc(d.empresa)}</div>
        ${d.preparadaPara ? `<div class="date">${esc(d.preparadaPara)}</div>` : ""}
        <div class="date">Santiago de Chile · ${esc(fecha)}</div>
        ${docmeta ? `<div class="docmeta">${docmeta}</div>` : ""}
      </div>
    </div>
    <div class="barwrap"><div class="bar-blue"></div><div class="bar-yellow"></div></div>
    <div class="contact">
      <div>${esc([v.nombre, "GeoVictoria", v.email, v.telefono].filter(Boolean).join(" · "))}</div>
      <div class="yta"><span class="y">#Yo</span><span class="t">Te</span><span class="a">Ayudo</span></div>
    </div>
  </div>
  <main>
    ${seccion("Resumen y recomendación", d.resumen ? `<div class="callout">${esc(d.resumen)}</div>` : "")}
    ${seccion("Lo que nos contaron", lista(d.necesidades), d.necesidades?.length ? "Las necesidades que levantamos con tu equipo." : "")}
    ${seccion("Nuestra propuesta", solucionHtml)}
    ${seccion("Inversión", preciosHtml)}
    ${seccion("Por qué GeoVictoria", lista(d.diferenciales))}
    ${seccion("Próximos pasos", lista(d.proximosPasos))}
  </main>
  ${
    v.nombre || v.email || v.telefono
      ? `<div class="contactbar"><div><div class="who">${esc(v.nombre || "Tu ejecutivo GeoVictoria")}</div><div class="det">${esc([v.email, v.telefono].filter(Boolean).join(" · "))}</div></div><div class="yta"><span class="y">#Yo</span><span class="t">Te</span><span class="a">Ayudo</span></div></div>`
      : `<div class="contactbar"><div class="who">GeoVictoria</div><div class="yta"><span class="y">#Yo</span><span class="t">Te</span><span class="a">Ayudo</span></div></div>`
  }
  <div class="piefin"></div>
</div>
</body></html>`
}

const generarPropuestaSchema = {
  name: "generar_propuesta",
  description:
    "Genera (o REEMPLAZA por completo) la propuesta comercial de esta empresa con el branding GeoVictoria. Pasa SIEMPRE el contenido COMPLETO final — cada llamada pisa la versión anterior. Redacta tú los textos: claros, concretos, partiendo del dolor del cliente (no de GeoVictoria), sin jerga y sin la palabra prohibida de saludo. Si el vendedor pegó un guion o minuta de reunión, saca de ahí las necesidades ('Lo que nos contaron') y personaliza el resumen y la solución. Los precios solo si el vendedor los entregó — no los inventes.",
  input_schema: {
    type: "object" as const,
    properties: {
      titulo: { type: "string" as const, description: "Título de la portada (ej. 'Control de asistencia para Transportes VIIG')." },
      subtitulo: { type: "string" as const, description: "Bajada de una línea para la portada (opcional)." },
      empresa: { type: "string" as const },
      preparadaPara: { type: "string" as const, description: "Nombre de la persona que la recibirá." },
      resumen: { type: "string" as const, description: "Párrafo ejecutivo: el problema del cliente y qué proponemos. 3-5 frases." },
      necesidades: { type: "array" as const, items: { type: "string" as const }, description: "Necesidades/dolores levantados (de la reunión o de lo que cuente el vendedor)." },
      solucion: {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: { titulo: { type: "string" as const }, detalle: { type: "string" as const } },
          required: ["titulo", "detalle"],
        },
        description: "Bloques de la solución (módulos, marcaje, implementación, soporte…).",
      },
      precios: {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: {
            item: { type: "string" as const },
            detalle: { type: "string" as const },
            valor: { type: "string" as const, description: "Texto tal cual se mostrará (ej. 'UF 1,42/mes + IVA')." },
          },
          required: ["item", "valor"],
        },
      },
      precioNota: { type: "string" as const, description: "Nota bajo la tabla de precios (condiciones, vigencia, UF)." },
      diferenciales: { type: "array" as const, items: { type: "string" as const } },
      proximosPasos: { type: "array" as const, items: { type: "string" as const } },
    },
    required: ["titulo", "empresa", "resumen"],
  },
}

export type EventoPropuesta = { tool: string; ok: boolean; resumen: string }

export type ChatPropuestaResultado = {
  reply: string
  eventos: EventoPropuesta[]
  /** URL relativa de la propuesta cuando fue (re)generada en este turno. */
  propuestaUrl?: string
}

export async function chatVickyPropuestas(params: {
  dealId: string
  historial: Array<{ role: "user" | "assistant"; content: string }>
  mensaje: string
  /** Identidad de la sesión (login del dashboard): firma la propuesta. */
  quien?: string
}): Promise<ChatPropuestaResultado> {
  const { dealId, historial, mensaje, quien } = params
  const apiKey = (process.env.ANTHROPIC_API_KEY || "").trim()
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY no configurada")
  const info = await infoDeal(dealId)
  if (!info) throw new Error("No se pudo leer la oportunidad en Zoho.")
  const previa = await propuestaGuardada(dealId)
  // ÚLTIMA COTIZACIÓN presentada al cliente (pedido Lalo 07-ago): la
  // propuesta se basa en ella — mismo número, mismos ítems y valores.
  const cot: EstadoCotizacion | null = info.telefono
    ? await estadoCotizacion(info.telefono).catch(() => null)
    : null
  const bloqueCot = cot
    ? [
        `COTIZACIÓN VIGENTE del cliente — ${cot.numero || cot.puntero.quoteId} (la última presentada):`,
        ...cot.items.map(
          (i) =>
            `- ${i.nombre}${i.cantidad > 1 ? ` × ${i.cantidad}` : ""} · ${i.recurrente ? "mensual" : "pago único"} · UF ${i.subtotalUF} neto`,
        ),
        `Total con IVA: ${cot.puntero.totalUf ? `UF ${cot.puntero.totalUf}` : "?"}${cot.puntero.totalClp ? ` (~$${Math.round(cot.puntero.totalClp).toLocaleString("es-CL")})` : ""}${cot.descuentoPct ? ` · incluye ${cot.descuentoPct}% dcto. recurrente` : ""}`,
        `REGLA DURA: la sección Inversión se basa EN ESTA cotización — mismos ítems y mismos valores (puedes mejorar la redacción del detalle, jamás los montos). El N.º de la propuesta será el de esta cotización automáticamente. Si el vendedor quiere OTROS precios, dile que primero edite la cotización en el editor de cotizaciones y luego regenere la propuesta.`,
      ].join("\n")
    : `El cliente NO tiene cotización formal registrada: incluye precios solo si el vendedor los entrega textualmente.`

  const system = [
    `Eres "Vicky Propuestas", herramienta interna de GeoVictoria con la que un VENDEDOR arma una propuesta comercial con branding oficial para una empresa de su cartera. Hablas con el vendedor (no con el cliente): tono directo de colega, español de Chile. Jamás uses la palabra prohibida de saludo informal chileno de dos letras y media para dirigirte a nadie.`,
    ``,
    `EMPRESA / OPORTUNIDAD (deal Zoho ${info.dealId}):`,
    `- Deal: ${info.nombre || "(sin nombre)"} · etapa: ${info.stage || "?"} · dueño: ${info.ownerNombre || "?"}`,
    `- Cuenta: ${info.accountNombre || "(sin cuenta)"} · Contacto: ${info.contactoNombre || "?"}${info.email ? ` · ${info.email}` : ""}`,
    previa ? `- Ya EXISTE una propuesta (${previa.datos.titulo}); las ediciones la reemplazan completa.` : `- Aún no hay propuesta para este deal.`,
    ``,
    bloqueCot,
    ``,
    `CÓMO TRABAJAS:`,
    `1. EL VENDEDOR MANDA. Pídele solo lo que falte para una buena propuesta: qué se le ofrece, dotación/precios si quiere incluirlos, y si tiene el GUION O MINUTA de la reunión que lo pegue en el chat — de ahí sacas las necesidades reales y personalizas todo. Con lo mínimo listo, genera de inmediato; los detalles se pulen en iteraciones.`,
    `2. La propuesta parte del DOLOR del cliente, no de GeoVictoria. Textos concretos, cortos, sin superlativos vacíos. Los precios SOLO si el vendedor los dio — nunca los inventes.`,
    `3. Cada generar_propuesta REEMPLAZA la versión anterior completa: incluye siempre todo el contenido vigente, no solo lo que cambió. El link de la propuesta es estable — al regenerar, el mismo link muestra la versión nueva.`,
    `4. Después de generar, resume en 2-3 líneas qué contiene y recuerda que con el botón de la página se guarda como PDF.`,
  ].join("\n")

  const client = new Anthropic({ apiKey })
  const model = (process.env.ANTHROPIC_COTED_MODEL || process.env.ANTHROPIC_SALES_AGENT_MODEL_V3 || DEFAULT_MODEL).trim()
  const messages: Anthropic.Messages.MessageParam[] = [
    ...historial
      .filter((m) => (m.role === "user" || m.role === "assistant") && String(m.content || "").trim())
      .slice(-30)
      .map((m) => ({ role: m.role, content: String(m.content).slice(0, 30000) })),
    { role: "user" as const, content: mensaje },
  ]

  const eventos: EventoPropuesta[] = []
  let propuestaUrl: string | undefined
  let reply = ""
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const res = await client.messages.create({
      model,
      max_tokens: MAX_TOKENS,
      system,
      messages,
      tools: [generarPropuestaSchema] as unknown as Anthropic.Messages.Tool[],
    })
    const textos = res.content.filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    if (textos.length) reply = textos.map((b) => b.text).join("\n").trim()
    const toolUses = res.content.filter((b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use")
    if (!toolUses.length || res.stop_reason !== "tool_use") break
    messages.push({ role: "assistant", content: res.content })
    const results: Anthropic.Messages.ToolResultBlockParam[] = []
    for (const tu of toolUses) {
      let output: unknown
      try {
        const datos = tu.input as PropuestaDatos
        if (!datos?.empresa) datos.empresa = info.accountNombre || info.nombre
        datos.vendedor = {
          nombre: info.ownerNombre || quien || undefined,
          email: undefined,
          telefono: undefined,
          ...(datos.vendedor || {}),
        }
        // FIDELIDAD A LA COTIZACIÓN (pedido Lalo 07-ago): con cotización
        // vigente, la Inversión son SUS ítems y valores — si el modelo no los
        // pasó (o pasó otros por error), se reconstruyen desde la cotización.
        if (cot?.items?.length) {
          datos.precios = cot.items.map((it) => ({
            item: it.nombre,
            detalle: [it.cantidad > 1 ? `${it.cantidad} unidades` : "", it.recurrente ? "cargo mensual" : "pago único"]
              .filter(Boolean)
              .join(" · "),
            valor: `UF ${it.subtotalUF.toLocaleString("es-CL", { maximumFractionDigits: 2 })}${it.recurrente ? "/mes" : ""} + IVA`,
          }))
          if (!datos.precioNota) {
            const totalTxt = [
              cot.puntero.totalUf ? `UF ${cot.puntero.totalUf.toLocaleString("es-CL", { maximumFractionDigits: 2 })}` : "",
              cot.puntero.totalClp ? `(~$${Math.round(cot.puntero.totalClp).toLocaleString("es-CL")})` : "",
            ].filter(Boolean).join(" ")
            datos.precioNota =
              `Valores netos según cotización ${cot.numero || ""}`.trim() +
              `${cot.descuentoPct ? `, incluyen ${cot.descuentoPct}% de descuento recurrente` : ""}.` +
              (totalTxt ? ` Total con IVA: ${totalTxt}.` : "")
          }
        }
        const guardada: PropuestaGuardada = {
          datos,
          dealId,
          actualizadaAt: new Date().toISOString(),
          actualizadaPor: quien || undefined,
          // El N.º de la propuesta ES el de la última cotización presentada
          // (pedido Lalo 07-ago); sin cotización, un N.º estable de 6 dígitos.
          // La versión sube con cada regeneración.
          numero: cot?.numero || previa?.numero || String((Number(dealId.slice(-9)) % 900000) + 100000),
          version: (previa?.version || 0) + 1,
        }
        await setKvValue(clavePropuesta(dealId), JSON.stringify(guardada))
        propuestaUrl = `?prop_ver=${encodeURIComponent(dealId)}`
        output = { ok: true, propuestaUrl, detalle: "Propuesta guardada. El link estable ya muestra esta versión." }
        eventos.push({ tool: tu.name, ok: true, resumen: `Propuesta ${previa ? "actualizada" : "creada"}: ${datos.titulo}` })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        output = { ok: false, error: msg.slice(0, 300) }
        eventos.push({ tool: tu.name, ok: false, resumen: `Error: ${msg.slice(0, 160)}` })
      }
      results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(output).slice(0, 4000) })
    }
    messages.push({ role: "user", content: results })
  }
  return { reply: reply || "No tengo respuesta — intenta de nuevo.", eventos, propuestaUrl }
}
