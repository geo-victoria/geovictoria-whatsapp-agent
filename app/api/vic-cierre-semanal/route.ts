/**
 * CIERRE SEMANAL DE VICKY — el correo de los lunes temprano (Rodrigo 13-sep:
 * "manda también un mail semanal, cada lunes, con el resumen y análisis de lo
 * que pasó en la semana de lunes a domingo, y recomendaciones de mejora").
 *
 * MISMA FUENTE que el cierre diario: agrega las fotos `foto_dia_<fecha>` de
 * los 7 días (lunes→domingo). Si a un día le falta la foto (típico: el
 * domingo, porque el diario corre a las 07:30 del lunes DESPUÉS que este
 * correo), la computa llamando al propio vic-cierre-diario?json=1 — cero
 * lógica duplicada, un solo cerebro de números.
 *
 * Trae además lo que el diario no puede: comparación contra la semana
 * anterior, el pulso por día, y una sección de RECOMENDACIONES (análisis por
 * Claude sobre los números agregados + los motivos de no-cierre reales; si la
 * API falla, cae a un análisis determinista — el correo sale igual).
 *
 * GET /api/vic-cierre-semanal?key=<cron>   → HTML de la última semana completa
 *   &fecha=YYYY-MM-DD   el LUNES de otra semana
 *   &json=1             el agregado crudo
 *   &enviar=1           manda el correo (idempotente por semana; lunes 06-10 CL)
 *   &forzar=1           salta la ventana horaria (no la idempotencia)
 */

import { NextResponse } from "next/server"
import Anthropic from "@anthropic-ai/sdk"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"
import { getZohoAccessToken } from "@/lib/zoho-token"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const ZOHO_API = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
const MAIL_ANCHOR = (process.env.VIC_DASH_MAIL_ANCHOR || "Contacts/3525045000645054553").trim()
const FROM_EMAIL = (process.env.VICKY_FROM_EMAIL || "vicky@geovictoria.com").trim()
const DESTINOS = (process.env.VICKY_CIERRE_SEMANAL_TO || process.env.VICKY_CIERRE_TO || "egomez@geovictoria.com,rlewit@geovictoria.com")
  .split(",").map((s) => s.trim()).filter(Boolean)
const MODELO = (process.env.VIC_FUNNEL_MODEL || "claude-sonnet-4-5-20250929").trim()

const H = () => ({ apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" })
const esc = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
const clp = (n: number) => `$${Math.round(n).toLocaleString("es-CL")}`
const fechaCL = (d: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago", year: "numeric", month: "2-digit", day: "2-digit" }).format(d)
const horaCL = (d: Date) => Number(new Intl.DateTimeFormat("es-CL", { timeZone: "America/Santiago", hour: "2-digit", hour12: false }).format(d))
const diaSemanaCL = (d: Date) =>
  new Intl.DateTimeFormat("en-US", { timeZone: "America/Santiago", weekday: "short" }).format(d)
const corto = (f: string) =>
  new Intl.DateTimeFormat("es-CL", { timeZone: "America/Santiago", weekday: "short", day: "numeric", month: "short" }).format(new Date(`${f}T12:00:00-04:00`))
const rangoLindo = (lunes: string, domingo: string) => {
  const fd = (f: string) => new Intl.DateTimeFormat("es-CL", { timeZone: "America/Santiago", day: "numeric", month: "long" }).format(new Date(`${f}T12:00:00-04:00`))
  return `${fd(lunes)} al ${fd(domingo)}`
}

async function autorizado(req: Request): Promise<boolean> {
  const secreto = await getFollowupCronSecret().catch(() => "")
  const cron = (process.env.CRON_SECRET || "").trim()
  const url = new URL(req.url)
  const auth = req.headers.get("authorization") || ""
  const dado =
    req.headers.get("x-cron-secret") || (auth.startsWith("Bearer ") ? auth.slice(7) : "") || url.searchParams.get("key") || ""
  return Boolean(dado) && (dado === secreto || (Boolean(cron) && dado === cron))
}

const sb = async <T,>(path: string): Promise<T[]> => {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: H(), cache: "no-store" })
  return r.ok ? ((await r.json().catch(() => [])) as T[]) : []
}

/** Misma forma que la Foto del cierre diario (se lee del kv, no se re-tipa allá). */
type Foto = {
  fecha: string
  conversaciones: number
  nuevas: number
  formales: number
  medInicioFormal: number | null
  ventas: Array<{ cot: string; empresa: string; monto: number; dueno: string; reemitida?: boolean }>
  montoVentas: number
  ventasEjecutivo?: number
  montoVentasEjecutivo?: number
  ventasSinClasificar?: number
  motivos: Array<{ motivo: string; casos: Array<{ contact: string; resumen: string; accionable: string }> }>
  fallas: Array<{ contact: string; hora: string; mensajes: number }>
  traspasos: { total: number; sinContacto: number }
  generadoAt: string
}

type Semana = {
  lunes: string
  domingo: string
  dias: Array<{ fecha: string; foto: Foto | null }>
  faltantes: string[]
  conversaciones: number
  nuevas: number
  formales: number
  ventas: Foto["ventas"]
  montoVentas: number
  ventasEjecutivo: number
  montoVentasEjecutivo: number
  medFormalMin: number | null
  motivos: Array<{ motivo: string; n: number; ejemplos: string[] }>
  fallasContactos: number
  fallasMensajes: number
  traspasos: number
  traspasosSinContacto: number
}

/** El lunes (fecha CL) de la semana que contiene a `d`. */
function lunesDe(d: Date): string {
  const f = fechaCL(d)
  const dow = diaSemanaCL(d) // Mon..Sun
  const idx: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }
  const off = idx[dow] ?? 0
  return fechaCL(new Date(Date.parse(`${f}T12:00:00-04:00`) - off * 86_400_000))
}
const masDias = (f: string, n: number) => fechaCL(new Date(Date.parse(`${f}T12:00:00-04:00`) + n * 86_400_000))

async function fotoDe(fecha: string, origin: string, secreto: string, computarSiFalta: boolean): Promise<Foto | null> {
  const rows = await sb<{ value: string }>(`vic_kv?key=eq.foto_dia_${fecha}&select=value&limit=1`)
  if (rows[0]?.value) {
    try {
      return JSON.parse(rows[0].value) as Foto
    } catch { /* cae al recómputo */ }
  }
  if (!computarSiFalta) return null
  // El diario es el único cerebro de números: se le pide la foto y él mismo
  // la deja guardada en el kv para el panel.
  try {
    const r = await fetch(`${origin}/api/vic-cierre-diario?fecha=${fecha}&json=1`, {
      headers: { "x-cron-secret": secreto },
      cache: "no-store",
      signal: AbortSignal.timeout(55_000),
    })
    if (!r.ok) return null
    const j = (await r.json().catch(() => ({}))) as { foto?: Foto }
    return j.foto || null
  } catch (e) {
    console.warn("[cierre-semanal] foto", fecha, e instanceof Error ? e.message : e)
    return null
  }
}

function agregar(lunes: string, dias: Array<{ fecha: string; foto: Foto | null }>): Semana {
  const fotos = dias.map((d) => d.foto).filter((f): f is Foto => Boolean(f))
  const motivosMap = new Map<string, { n: number; ejemplos: string[] }>()
  for (const f of fotos) {
    for (const m of f.motivos || []) {
      // En la vista semanal los "otros:" (revisados ese día, conversación de
      // otro día) se excluyen: la semana ya cubre su propio universo y
      // sumarlos duplicaría contactos entre días.
      if (m.motivo.startsWith("otros:")) continue
      const cur = motivosMap.get(m.motivo) || { n: 0, ejemplos: [] }
      cur.n += m.casos.length
      for (const c of m.casos) if (cur.ejemplos.length < 3 && c.resumen) cur.ejemplos.push(c.resumen)
      motivosMap.set(m.motivo, cur)
    }
  }
  const medianas = fotos.map((f) => f.medInicioFormal).filter((n): n is number => typeof n === "number")
  const med = medianas.length ? medianas.sort((a, b) => a - b)[Math.floor(medianas.length / 2)] : null
  return {
    lunes,
    domingo: masDias(lunes, 6),
    dias,
    faltantes: dias.filter((d) => !d.foto).map((d) => d.fecha),
    conversaciones: fotos.reduce((s, f) => s + (f.conversaciones || 0), 0),
    nuevas: fotos.reduce((s, f) => s + (f.nuevas || 0), 0),
    formales: fotos.reduce((s, f) => s + (f.formales || 0), 0),
    ventas: fotos.flatMap((f) => f.ventas || []),
    montoVentas: fotos.reduce((s, f) => s + (f.montoVentas || 0), 0),
    ventasEjecutivo: fotos.reduce((s, f) => s + (f.ventasEjecutivo || 0), 0),
    montoVentasEjecutivo: fotos.reduce((s, f) => s + (f.montoVentasEjecutivo || 0), 0),
    medFormalMin: med,
    motivos: [...motivosMap.entries()].map(([motivo, v]) => ({ motivo, n: v.n, ejemplos: v.ejemplos })).sort((a, b) => b.n - a.n),
    fallasContactos: fotos.reduce((s, f) => s + (f.fallas?.length || 0), 0),
    fallasMensajes: fotos.reduce((s, f) => s + (f.fallas || []).reduce((x, y) => x + (y.mensajes || 0), 0), 0),
    traspasos: fotos.reduce((s, f) => s + (f.traspasos?.total || 0), 0),
    traspasosSinContacto: fotos.reduce((s, f) => s + (f.traspasos?.sinContacto || 0), 0),
  }
}

const ETIQUETA_MOTIVO: Record<string, string> = {
  faltaron_datos: "Faltaron datos para cotizar",
  silencio: "Silencio después del precio",
  evaluando: "Está evaluando / lo ve con otro",
  precio: "Precio",
  prefirio_humano: "Pidió hablar con una persona",
  proveedor_actual: "Tiene otro proveedor",
  hardware: "Hardware o compatibilidad",
}
const etiqueta = (k: string) => ETIQUETA_MOTIVO[k] || k

/** Deltas honestos: sin base completa de la semana anterior, se declara. */
function delta(actual: number, previo: number | null): string {
  if (previo === null) return ""
  if (previo === 0) return actual > 0 ? " (semana anterior: 0)" : " (igual que la anterior)"
  const pct = Math.round(((actual - previo) / previo) * 100)
  const flecha = pct > 0 ? "▲" : pct < 0 ? "▼" : "="
  return ` (${flecha} ${Math.abs(pct)}% vs anterior)`
}

/** Recomendaciones deterministas — el respaldo si Claude no responde. */
function recomendacionesDeterministas(s: Semana, prev: Semana | null): string[] {
  const out: string[] = []
  const cierre = s.formales ? Math.round((s.ventas.length / s.formales) * 100) : 0
  if (s.formales >= 5 && cierre < 20)
    out.push(`El cierre de la semana fue ${cierre}% de las formales (${s.ventas.length}/${s.formales}): el cuello está DESPUÉS del precio — revisar los toques post-formal y el camino de pago antes que el guion.`)
  if (prev && prev.nuevas > 0 && s.nuevas < prev.nuevas * 0.7)
    out.push(`Las conversaciones nuevas cayeron ${Math.round((1 - s.nuevas / prev.nuevas) * 100)}% contra la semana anterior (${s.nuevas} vs ${prev.nuevas}): el problema es caudal de entrada (pauta/formulario), no conversión.`)
  const top = s.motivos[0]
  if (top && top.n >= 3)
    out.push(`El motivo de no-cierre más repetido fue "${etiqueta(top.motivo)}" (${top.n} casos): diseñar el próximo toque de campaña apuntado a ESA objeción en vez del recordatorio genérico.`)
  if (s.traspasos > 0 && s.traspasosSinContacto / s.traspasos > 0.4)
    out.push(`${s.traspasosSinContacto} de ${s.traspasos} traspasos quedaron sin WhatsApp del ejecutivo el mismo día: revisar el panel de Traspasos con Victoria — ahí hay venta madura esperando una llamada.`)
  if (s.fallasContactos > 0)
    out.push(`Hubo fallas técnicas con ${s.fallasContactos} contactos en la semana: revisar el detalle en los cierres diarios y el estado del canario.`)
  if (!out.length) out.push("Semana sin señales rojas en los números: mantener el caudal de entrada y vigilar el cierre diario.")
  return out.slice(0, 5)
}

/** Análisis con Claude sobre el agregado — con degradación honesta. */
async function recomendacionesClaude(s: Semana, prev: Semana | null): Promise<string[] | null> {
  const apiKey = (process.env.ANTHROPIC_API_KEY || "").trim()
  if (!apiKey) return null
  const resumen = {
    semana: `${s.lunes} a ${s.domingo}`,
    conversaciones: s.conversaciones,
    nuevas: s.nuevas,
    formales: s.formales,
    ventas: s.ventas.length,
    montoCLP: s.montoVentas,
    cierrePctDeFormales: s.formales ? Math.round((s.ventas.length / s.formales) * 100) : 0,
    medianaMinutosPrimerMensajeAFormal: s.medFormalMin,
    ventasDetalle: s.ventas.map((v) => `${v.empresa} ${clp(v.monto)}${v.reemitida ? " (reemitida por ejecutivo)" : ""}`),
    porDia: s.dias.map((d) => ({
      fecha: d.fecha,
      convs: d.foto?.conversaciones ?? null,
      formales: d.foto?.formales ?? null,
      ventas: d.foto?.ventas?.length ?? null,
    })),
    motivosNoCierre: s.motivos.map((m) => ({ motivo: etiqueta(m.motivo), casos: m.n, ejemplos: m.ejemplos })),
    fallasTecnicas: { contactosAfectados: s.fallasContactos, mensajesDeError: s.fallasMensajes },
    traspasos: { total: s.traspasos, sinContactoDelVendedor: s.traspasosSinContacto },
    canalEjecutivoAparte: { ventas: s.ventasEjecutivo, montoCLP: s.montoVentasEjecutivo },
    semanaAnterior: prev
      ? { conversaciones: prev.conversaciones, nuevas: prev.nuevas, formales: prev.formales, ventas: prev.ventas.length, montoCLP: prev.montoVentas }
      : null,
  }
  try {
    const client = new Anthropic({ apiKey })
    const r = await client.messages.create({
      model: MODELO,
      max_tokens: 900,
      system:
        "Eres la analista comercial de Vicky, la vendedora IA por WhatsApp de GeoVictoria (control de asistencia, Chile). " +
        "Recibes el resumen numérico de una semana (lunes a domingo). Escribe entre 3 y 5 recomendaciones de mejora CONCRETAS y accionables " +
        "para Rodrigo y Lalo (los dueños del negocio), en español chileno neutro, sin saludos ni cierre. " +
        "Cada recomendación: una sola oración con el dato que la sustenta entre paréntesis. Prioriza: caudal de entrada, cuello del embudo, " +
        "el motivo de no-cierre dominante, traspasos sin gestión y fallas técnicas. No inventes datos que no estén en el JSON. " +
        'Responde SOLO un JSON: {"recomendaciones": ["...", "..."]}',
      messages: [{ role: "user", content: `Resumen de la semana:\n${JSON.stringify(resumen)}\n\nResponde SOLO el JSON.` }],
    })
    const block = r.content.find((b) => b.type === "text")
    const texto = block && block.type === "text" ? block.text : ""
    const m = texto.match(/\{[\s\S]*\}/)
    if (!m) return null
    const parsed = JSON.parse(m[0]) as { recomendaciones?: unknown }
    const recs = Array.isArray(parsed.recomendaciones)
      ? parsed.recomendaciones.map((x) => String(x || "").trim()).filter((x) => x.length > 20 && x.length < 500)
      : []
    return recs.length >= 2 ? recs.slice(0, 5) : null
  } catch (e) {
    console.warn("[cierre-semanal] claude:", e instanceof Error ? e.message : e)
    return null
  }
}

function render(s: Semana, prev: Semana | null, recomendaciones: string[], conIA: boolean): string {
  const tasa = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—")
  const kpi = (n: string, l: string) =>
    `<td style="padding:0 16px 0 0;vertical-align:top"><div style="font-size:22px;font-weight:700;color:#0e8a6d">${n}</div><div style="font-size:11px;color:#6b7683">${l}</div></td>`
  const secc = (t: string, cuerpo: string) => `<h3 style="font-size:14px;margin:22px 0 8px;color:#171d22">${t}</h3>${cuerpo}`
  const p = (t: string) => `<p style="margin:0 0 8px;font-size:13.5px;color:#39434a">${t}</p>`
  const pv = prev

  const filaDia = (d: Semana["dias"][number]) => {
    const f = d.foto
    const celda = (v: string, extra = "") => `<td style="padding:4px 8px;border-bottom:1px solid #eceeec;font-size:12.5px;${extra}">${v}</td>`
    if (!f) return `<tr>${celda(corto(d.fecha))}${celda("<i>sin foto</i>", "color:#b26a00")}${celda("—")}${celda("—")}${celda("—")}</tr>`
    return `<tr>${celda(corto(d.fecha))}${celda(String(f.conversaciones), "text-align:center")}${celda(String(f.formales), "text-align:center")}${celda(String(f.ventas.length), "text-align:center;font-weight:700")}${celda(f.montoVentas ? clp(f.montoVentas) : "—", "text-align:right")}</tr>`
  }
  const tablaDias = `<table style="width:100%;border-collapse:collapse">
    <tr><td style="padding:4px 8px;font-size:11px;color:#7d8890">día</td><td style="padding:4px 8px;font-size:11px;color:#7d8890;text-align:center">convs</td><td style="padding:4px 8px;font-size:11px;color:#7d8890;text-align:center">formales</td><td style="padding:4px 8px;font-size:11px;color:#7d8890;text-align:center">ventas</td><td style="padding:4px 8px;font-size:11px;color:#7d8890;text-align:right">cobrado</td></tr>
    ${s.dias.map(filaDia).join("")}
  </table>`

  const ventas = s.ventas.length
    ? `<table style="width:100%;border-collapse:collapse;font-size:13px">${s.ventas
        .map(
          (v) =>
            `<tr><td style="padding:5px 8px 5px 0;border-bottom:1px solid #eceeec"><b>${esc(v.empresa)}</b> <span style="color:#7d8890">${esc(v.cot)}</span>${v.reemitida ? ` <span style="color:#7d8890;font-size:11px">· reemitida por ejecutivo</span>` : ""}</td>` +
            `<td style="padding:5px 0;border-bottom:1px solid #eceeec;text-align:right">${v.monto ? clp(v.monto) : "—"}</td>` +
            `<td style="padding:5px 0 5px 12px;border-bottom:1px solid #eceeec;color:#7d8890">${esc(v.dueno)}</td></tr>`,
        )
        .join("")}</table>`
    : p("Ninguna venta de Vicky en la semana.")

  const motivos = s.motivos.length
    ? `<ul style="margin:0;padding-left:18px;font-size:13px;color:#39434a">${s.motivos
        .slice(0, 7)
        .map((m) => `<li style="margin-bottom:4px"><b>${esc(etiqueta(m.motivo))}</b> — ${m.n} ${m.n === 1 ? "caso" : "casos"}${m.ejemplos.length ? `<br><span style="color:#7d8890">Ej: ${esc(m.ejemplos[0])}</span>` : ""}</li>`)
        .join("")}</ul>`
    : p("El clasificador no marcó motivos de no-cierre en la semana.")

  const recs = `<ol style="margin:0;padding-left:20px;font-size:13.5px;color:#39434a">${recomendaciones
    .map((r) => `<li style="margin-bottom:8px">${esc(r)}</li>`)
    .join("")}</ol>`

  return `<div style="font-family:'IBM Plex Sans',Arial,sans-serif;max-width:680px;margin:0 auto;background:#fff;color:#1c2429;padding:22px 24px 30px">
  <div style="border-bottom:2px solid #0e8a6d;padding-bottom:12px;margin-bottom:16px">
    <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#7d8890">Cierre semanal de Vicky</div>
    <h1 style="margin:4px 0 0;font-size:20px">Semana del ${rangoLindo(s.lunes, s.domingo)}</h1>
    <div style="font-size:13px;color:#39434a;margin-top:4px">${s.ventas.length} ${s.ventas.length === 1 ? "venta" : "ventas"} de Vicky · ${clp(s.montoVentas)} cobrados${delta(s.montoVentas, pv ? pv.montoVentas : null)}</div>
    ${s.ventasEjecutivo ? `<div style="font-size:12px;color:#7d8890;margin-top:3px">El canal ejecutivo cerró además ${s.ventasEjecutivo} ${s.ventasEjecutivo === 1 ? "venta" : "ventas"} por ${clp(s.montoVentasEjecutivo)} — no entran en las cifras de Vicky.</div>` : ""}
    ${s.faltantes.length ? `<div style="font-size:12px;color:#b26a00;margin-top:3px">Sin foto de ${s.faltantes.map(corto).join(", ")}: esos días no suman en los totales.</div>` : ""}
  </div>
  <table style="border-collapse:collapse;margin-bottom:4px"><tr>
    ${kpi(String(s.conversaciones) + (pv ? delta(s.conversaciones, pv.conversaciones).replace(/[()]/g, "") : ""), "conversaciones")}
    ${kpi(String(s.nuevas), `nuevas${pv ? delta(s.nuevas, pv.nuevas) : ""}`)}
    ${kpi(String(s.formales), `formales${pv ? delta(s.formales, pv.formales) : ""}`)}
    ${kpi(String(s.ventas.length), `ventas${pv ? delta(s.ventas.length, pv.ventas.length) : ""}`)}
  </tr></table>
  ${p(`Cierre de la semana: <b>${tasa(s.ventas.length, s.formales)}</b> de las formales. Del primer mensaje a la formal: <b>${s.medFormalMin ?? "—"} min</b> (mediana de las medianas diarias).${pv ? ` La semana anterior: ${pv.ventas.length} ventas de ${pv.formales} formales (${tasa(pv.ventas.length, pv.formales)}).` : ""}`)}
  ${secc("El pulso por día", tablaDias)}
  ${secc("Qué vendió Vicky", ventas)}
  ${secc("Por qué no se cerró (motivos de la semana)", motivos)}
  ${secc(`Recomendaciones de la semana${conIA ? "" : " (análisis automático básico)"}`, recs)}
  ${secc("Operación", p(`${s.traspasos} traspasos al equipo (${s.traspasosSinContacto} sin WhatsApp del ejecutivo ese día). Fallas técnicas: ${s.fallasContactos ? `${s.fallasContactos} contactos afectados, ${s.fallasMensajes} mensajes de error` : "ninguna registrada"}.`))}
  <p style="margin:22px 0 0;font-size:11.5px;color:#7d8890;border-top:1px solid #e5e7e6;padding-top:10px">
  Construido sobre las mismas fotos diarias del cierre de las 07:30 — este correo y el diario no pueden contradecirse.
  ${conIA ? "Las recomendaciones las escribe Claude sobre los números de la semana; los números son deterministas." : "Claude no respondió al generar este correo: las recomendaciones salieron del análisis determinista de respaldo."}</p>
</div>`
}

async function yaEnviado(lunes: string): Promise<boolean> {
  const r = await sb<{ key: string }>(`vic_kv?key=eq.cierre_semanal_enviado_${lunes}&select=key&limit=1`)
  return r.length > 0
}

export async function GET(req: Request): Promise<NextResponse | Response> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  const url = new URL(req.url)
  const origin = url.origin
  const secreto = (await getFollowupCronSecret().catch(() => "")) || (process.env.CRON_SECRET || "").trim()

  // La semana a reportar: su LUNES. Default = la última semana COMPLETA
  // (si hoy es lunes, la que terminó ayer domingo).
  const hoy = new Date()
  const lunesActual = lunesDe(hoy)
  const fechaParam = url.searchParams.get("fecha") || ""
  const lunes = /^\d{4}-\d{2}-\d{2}$/.test(fechaParam) ? lunesDe(new Date(`${fechaParam}T12:00:00-04:00`)) : masDias(lunesActual, -7)
  const lunesPrev = masDias(lunes, -7)

  // Fotos de la semana (computa las faltantes, máx 3 por corrida) y de la
  // anterior (solo lectura del kv — es contexto, no el reporte).
  const dias: Semana["dias"] = []
  let computadas = 0
  for (let i = 0; i < 7; i++) {
    const f = masDias(lunes, i)
    const enKv = await fotoDe(f, origin, secreto, false)
    if (enKv) {
      dias.push({ fecha: f, foto: enKv })
      continue
    }
    const computada = computadas < 3 ? await fotoDe(f, origin, secreto, true) : null
    if (computada) computadas++
    dias.push({ fecha: f, foto: computada })
  }
  const diasPrev: Semana["dias"] = []
  for (let i = 0; i < 7; i++) {
    const f = masDias(lunesPrev, i)
    diasPrev.push({ fecha: f, foto: await fotoDe(f, origin, secreto, false) })
  }
  const semana = agregar(lunes, dias)
  const previaCompleta = diasPrev.filter((d) => d.foto).length >= 5
  const prev = previaCompleta ? agregar(lunesPrev, diasPrev) : null

  const deClaude = await recomendacionesClaude(semana, prev)
  const recomendaciones = deClaude || recomendacionesDeterministas(semana, prev)

  if (url.searchParams.get("json") === "1")
    return NextResponse.json({ ok: true, semana, semanaAnterior: prev, recomendaciones, conIA: Boolean(deClaude) })

  const html = render(semana, prev, recomendaciones, Boolean(deClaude))
  if (url.searchParams.get("enviar") !== "1") {
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } })
  }

  // ── Envío: los lunes temprano (06-10 CL), una vez por semana ─────────────
  const forzar = url.searchParams.get("forzar") === "1"
  const esLunes = diaSemanaCL(new Date()) === "Mon"
  const h = horaCL(new Date())
  if (!forzar && (!esLunes || h < 6 || h > 10))
    return NextResponse.json({ ok: true, enviado: false, motivo: `fuera de ventana (lunes 06-10 CL; ahora ${diaSemanaCL(new Date())} ${h}h)` })
  if (await yaEnviado(lunes)) return NextResponse.json({ ok: true, enviado: false, motivo: "ya se envió el cierre de esa semana" })

  const asunto = `Vicky · semana ${corto(lunes)} → ${corto(semana.domingo)}: ${semana.ventas.length} ${semana.ventas.length === 1 ? "venta" : "ventas"} · ${clp(semana.montoVentas)}`
  let ok = false
  try {
    const token = await getZohoAccessToken()
    const r = await fetch(`${ZOHO_API}/crm/v3/${MAIL_ANCHOR}/actions/send_mail`, {
      method: "POST",
      headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        data: [{ from: { email: FROM_EMAIL }, to: DESTINOS.map((email) => ({ email })), subject: asunto, content: html, mail_format: "html" }],
      }),
    })
    ok = r.ok
    if (!r.ok) console.error("[cierre-semanal] send_mail", r.status, (await r.text().catch(() => "")).slice(0, 300))
  } catch (e) {
    console.error("[cierre-semanal] envío:", e instanceof Error ? e.message : e)
  }
  if (ok) {
    await fetch(`${SUPABASE_URL}/rest/v1/vic_kv?on_conflict=key`, {
      method: "POST",
      headers: { ...H(), Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ key: `cierre_semanal_enviado_${lunes}`, value: new Date().toISOString(), expires_at: new Date(Date.now() + 180 * 86_400_000).toISOString() }),
    }).catch(() => {})
  }
  return NextResponse.json({ ok: true, enviado: ok, lunes, destinos: DESTINOS, asunto })
}
