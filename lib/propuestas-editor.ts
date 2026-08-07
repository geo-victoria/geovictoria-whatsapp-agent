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
import { infoDeal, type InfoDeal } from "@/lib/cotizaciones-editor"

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

/** Render de la propuesta con el branding GV — página imprimible (el botón
 * "Guardar como PDF" usa la impresión del navegador). */
export function renderPropuestaHtml(p: PropuestaGuardada): string {
  const d = p.datos
  const fecha = new Date(p.actualizadaAt || Date.now()).toLocaleDateString("es-CL", {
    timeZone: "America/Santiago",
    day: "numeric",
    month: "long",
    year: "numeric",
  })
  const lista = (items: string[] | undefined) =>
    items?.length ? `<ul>${items.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""
  let nSeccion = 0
  const seccion = (titulo: string, cuerpo: string) => {
    if (!cuerpo) return ""
    nSeccion++
    return `<section>
      <h2><span class="badge">${nSeccion}</span>${esc(titulo)}</h2>
      ${cuerpo}
    </section>`
  }
  const solucionHtml = d.solucion?.length
    ? d.solucion.map((s) => `<div class="bloque"><h3>${esc(s.titulo)}</h3><p>${esc(s.detalle)}</p></div>`).join("")
    : ""
  const preciosHtml = d.precios?.length
    ? `<table><thead><tr><th>Ítem</th><th>Detalle</th><th style="text-align:right">Valor</th></tr></thead>
       <tbody>${d.precios.map((r) => `<tr><td><b>${esc(r.item)}</b></td><td>${esc(r.detalle || "")}</td><td style="text-align:right;white-space:nowrap">${esc(r.valor)}</td></tr>`).join("")}</tbody></table>
       ${d.precioNota ? `<p class="nota">${esc(d.precioNota)}</p>` : ""}`
    : ""
  const v = d.vendedor || {}
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Propuesta GeoVictoria — ${esc(d.empresa)}</title>
<style>
  ${GV_FONT_CSS}
  *{box-sizing:border-box}
  body{font-family:${F_CUERPO};margin:0;background:#f7f8fa;color:#4e4e4e}
  .hoja{max-width:860px;margin:0 auto;background:#fff;padding:0 0 40px}
  .portada{background:#ffbb00;padding:56px 56px 40px;color:#fff}
  .portada img{height:34px;margin-bottom:34px}
  .portada .tipo{font-size:13px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;opacity:.85}
  .portada h1{font-family:${F_TITULO};font-weight:700;font-size:34px;margin:6px 0 4px;line-height:1.15}
  .portada .para{font-size:16px;font-weight:600}
  .portada .fecha{font-size:13px;margin-top:18px;opacity:.9}
  main{padding:36px 56px}
  section{margin:0 0 30px}
  h2{font-family:${F_TITULO};font-weight:700;font-size:19px;color:#4e4e4e;margin:0 0 12px;display:flex;align-items:center;gap:10px}
  .badge{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;background:#ffbb00;color:#fff;font-size:14px;flex:none}
  h3{font-family:${F_TITULO};font-weight:600;font-size:14.5px;margin:0 0 4px;color:#4e4e4e}
  p{font-size:14px;line-height:1.65;margin:0 0 10px}
  ul{margin:0;padding-left:20px}
  li{font-size:14px;line-height:1.7}
  .bloque{border-left:3px solid #00aff2;padding:2px 0 2px 14px;margin:0 0 14px}
  table{width:100%;border-collapse:collapse;font-size:13.5px}
  th,td{text-align:left;padding:9px 10px;border-bottom:1px solid #eef0f2;vertical-align:top}
  th{color:#6b7280;font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
  .nota{font-size:12px;color:#6b7280;margin-top:8px}
  .cierre{margin:38px 56px 0;background:#f7f8fa;border-radius:14px;padding:22px 26px;display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;align-items:center}
  .cierre .quien{font-size:13.5px;line-height:1.6}
  .cierre .marca{font-family:${F_TITULO};font-weight:700;font-size:15px}
  .marca .a{color:#646464}.marca .b{color:#00aff2}.marca .c{color:#ffbb00}
  .btnPrint{position:fixed;top:14px;right:14px;background:#ffbb00;color:#fff;border:0;border-radius:10px;padding:10px 16px;font-family:${F_TITULO};font-weight:700;font-size:13px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.15)}
  @media print{.btnPrint{display:none}body{background:#fff}.hoja{max-width:none}.portada{-webkit-print-color-adjust:exact;print-color-adjust:exact}.badge{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style></head><body>
<button class="btnPrint" onclick="window.print()">🖨️ Guardar como PDF</button>
<div class="hoja">
  <div class="portada">
    <img src="/gv/logo-full-white.svg" alt="GeoVictoria" onerror="this.style.display='none'">
    <div class="tipo">Propuesta comercial</div>
    <h1>${esc(d.titulo || `Propuesta para ${d.empresa}`)}</h1>
    <div class="para">${esc(d.empresa)}${d.preparadaPara ? ` · Preparada para ${esc(d.preparadaPara)}` : ""}</div>
    <div class="fecha">${esc(fecha)}</div>
  </div>
  <main>
    ${seccion("Resumen", d.resumen ? `<p>${esc(d.resumen)}</p>` : "")}
    ${seccion("Lo que nos contaron", lista(d.necesidades))}
    ${seccion("Nuestra propuesta", solucionHtml)}
    ${seccion("Inversión", preciosHtml)}
    ${seccion("Por qué GeoVictoria", lista(d.diferenciales))}
    ${seccion("Próximos pasos", lista(d.proximosPasos))}
  </main>
  <div class="cierre">
    <div class="quien">${v.nombre ? `<b>${esc(v.nombre)}</b><br>` : ""}${v.email ? `✉️ ${esc(v.email)}<br>` : ""}${v.telefono ? `📱 ${esc(v.telefono)}` : ""}</div>
    <div class="marca"><span class="a">#Yo</span><span class="b">Te</span><span class="c">Ayudo</span></div>
  </div>
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

  const system = [
    `Eres "Vicky Propuestas", herramienta interna de GeoVictoria con la que un VENDEDOR arma una propuesta comercial con branding oficial para una empresa de su cartera. Hablas con el vendedor (no con el cliente): tono directo de colega, español de Chile. Jamás uses la palabra prohibida de saludo informal chileno de dos letras y media para dirigirte a nadie.`,
    ``,
    `EMPRESA / OPORTUNIDAD (deal Zoho ${info.dealId}):`,
    `- Deal: ${info.nombre || "(sin nombre)"} · etapa: ${info.stage || "?"} · dueño: ${info.ownerNombre || "?"}`,
    `- Cuenta: ${info.accountNombre || "(sin cuenta)"} · Contacto: ${info.contactoNombre || "?"}${info.email ? ` · ${info.email}` : ""}`,
    previa ? `- Ya EXISTE una propuesta (${previa.datos.titulo}); las ediciones la reemplazan completa.` : `- Aún no hay propuesta para este deal.`,
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
        const guardada: PropuestaGuardada = {
          datos,
          dealId,
          actualizadaAt: new Date().toISOString(),
          actualizadaPor: quien || undefined,
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
