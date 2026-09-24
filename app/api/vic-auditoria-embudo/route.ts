/**
 * AUDITORÍA DEL EMBUDO DE CAMPAÑAS (David García 24-sep, orden de Lalo: "una
 * tarea que revise si estos 4 puntos se han cumplido y mande el correo con el
 * status… en cuáles sí ocurrió y en cuáles falló").
 *
 * Toma los deals que CREÓ Vicky en la ventana [desde, hasta) y revisa por cada uno:
 *   1. el lead convertido quedó en "4. Calificado";
 *   2. el deal pasó por "1. Trato Creado" (primera etapa del historial);
 *   3. valores: moneda del país, "Mensual fijo", N° de empleados y — si tiene
 *      cotización — Valor fijo del trato > 0;
 *   4. existe un lead convertido que apunta al deal.
 * Solo lectura sobre Zoho. GET ?key=<cron>&desde=<ISO>&hasta=<ISO>[&enviar=1][&to=a,b][&json=1]
 */
import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"
import { getZohoAccessToken } from "@/lib/zoho-token"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const ZOHO_API = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
const QUOTE_MODULE = (process.env.ZOHO_QUOTE_MODULE || "Cotizaciones_GeoVictoria").trim()
const MAIL_ANCHOR = (process.env.VIC_DASH_MAIL_ANCHOR || "Contacts/3525045000645054553").trim()
const FROM_EMAIL = (process.env.VICKY_FROM_EMAIL || "vicky@geovictoria.com").trim()
const VICKY_ID = "3525045000484500876"
const MONEDA: Record<string, string> = { Chile: "CLP", "Perú": "SOL", Colombia: "COP", "México": "MXN" }
const esPrueba = (n: string) => /\bprueba\b|\btest\b|e2e/i.test(n)
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

async function autorizado(req: Request): Promise<boolean> {
  const secreto = await getFollowupCronSecret().catch(() => "")
  const cron = (process.env.CRON_SECRET || "").trim()
  const url = new URL(req.url)
  const auth = req.headers.get("authorization") || ""
  const dado = req.headers.get("x-cron-secret") || (auth.startsWith("Bearer ") ? auth.slice(7) : "") || url.searchParams.get("key") || ""
  return Boolean(dado) && (dado === secreto || (Boolean(cron) && dado === cron))
}

type Deal = {
  id: string
  Deal_Name?: string
  Stage?: string
  Territorio?: string
  Monda_del_trato?: string
  Tipo_de_Cobro?: string
  Valor_fijo_del_trato_Global?: number | null
  N_Empleados_que_marcan?: number | null
  Description?: string | null
  Owner?: { name?: string }
  Created_Time?: string
}

type Fila = {
  deal: Deal
  prueba: boolean
  p1: { ok: boolean; detalle: string }
  p2: { ok: boolean; detalle: string }
  p3: { ok: boolean; detalle: string }
  p4: { ok: boolean; detalle: string }
}

export async function GET(req: Request): Promise<Response> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  const url = new URL(req.url)
  const hasta = new Date(url.searchParams.get("hasta") || Date.now())
  const desde = new Date(url.searchParams.get("desde") || hasta.getTime() - 24 * 3600 * 1000)
  const token = await getZohoAccessToken()
  const H = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }
  const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "+00:00")

  // Deals creados por Vicky en la ventana.
  const deals: Deal[] = []
  for (let off = 0; off < 1000; off += 200) {
    const q =
      `select id, Deal_Name, Stage, Territorio, Monda_del_trato, Tipo_de_Cobro, Valor_fijo_del_trato_Global, ` +
      `N_Empleados_que_marcan, Description, Owner, Created_Time from Deals ` +
      `where ((Created_By = ${VICKY_ID} and Created_Time >= '${iso(desde)}') and Created_Time < '${iso(hasta)}') ` +
      `order by Created_Time asc limit 200 offset ${off}`
    const r = await fetch(`${ZOHO_API}/crm/v8/coql`, { method: "POST", headers: H, cache: "no-store", body: JSON.stringify({ select_query: q }) })
    if (r.status === 204) break
    const j = (await r.json().catch(() => ({}))) as { data?: Deal[]; info?: { more_records?: boolean }; message?: string }
    if (!r.ok) return NextResponse.json({ ok: false, error: `COQL deals: ${r.status} ${j.message || ""}` }, { status: 502 })
    deals.push(...(j.data || []))
    if (!j.info?.more_records) break
  }

  const revisar = async (d: Deal): Promise<Fila> => {
    const nombre = String(d.Deal_Name || "")
    // 1 y 4: lead convertido que apunta al deal.
    let lead: { id?: string; Lead_Status?: string } | null = null
    try {
      const r = await fetch(
        `${ZOHO_API}/crm/v8/Leads/search?criteria=${encodeURIComponent(`(Converted_Deal:equals:${d.id})`)}&converted=true&fields=Lead_Status`,
        { headers: H, cache: "no-store" },
      )
      if (r.status === 200) lead = (((await r.json()) as { data?: Array<{ id?: string; Lead_Status?: string }> }).data || [])[0] || null
    } catch { /* sin lead */ }
    const marcaSinLead = /Nació SIN lead convertido/i.test(String(d.Description || ""))
    const p4 = lead
      ? { ok: true, detalle: "lead convertido" }
      : { ok: false, detalle: marcaSinLead ? "sin lead (marcado en la descripción)" : "sin lead convertido" }
    const p1 = lead
      ? /^\s*4\./.test(String(lead.Lead_Status || ""))
        ? { ok: true, detalle: String(lead.Lead_Status) }
        : { ok: false, detalle: `lead en "${lead.Lead_Status || "?"}"` }
      : { ok: false, detalle: "no aplica: no hay lead" }
    // 2: historial de etapas.
    let etapas: string[] = []
    try {
      const r = await fetch(`${ZOHO_API}/crm/v8/Deals/${d.id}/Stage_History?fields=Stage,Last_Modified_Time`, { headers: H, cache: "no-store" })
      if (r.status === 200) {
        const filas = (((await r.json()) as { data?: Array<{ Stage?: string; Last_Modified_Time?: string }> }).data || [])
        etapas = filas
          .sort((a, b) => String(a.Last_Modified_Time).localeCompare(String(b.Last_Modified_Time)))
          .map((x) => String(x.Stage || ""))
      }
    } catch { /* sin historial */ }
    const p2 = /^1\./.test(etapas[0] || "")
      ? { ok: true, detalle: etapas.join(" → ") }
      : { ok: false, detalle: etapas.length ? `nació en "${etapas[0]}"` : "sin historial de etapas" }
    // 3: valores.
    let tieneCotizacion = false
    try {
      const r = await fetch(`${ZOHO_API}/crm/v8/coql`, {
        method: "POST",
        headers: H,
        cache: "no-store",
        body: JSON.stringify({ select_query: `select id from ${QUOTE_MODULE} where Deal_Asociado = '${d.id}' limit 1` }),
      })
      if (r.status === 200) tieneCotizacion = ((((await r.json()) as { data?: unknown[] }).data) || []).length > 0
    } catch { /* sin cotización */ }
    const faltas: string[] = []
    const monedaEsperada = MONEDA[String(d.Territorio || "")] || ""
    if (monedaEsperada && d.Monda_del_trato !== monedaEsperada) faltas.push(`moneda ${d.Monda_del_trato || "vacía"} (esperada ${monedaEsperada})`)
    if (!monedaEsperada) faltas.push(`territorio "${d.Territorio || "vacío"}"`)
    if (d.Tipo_de_Cobro !== "Mensual fijo") faltas.push(`tipo de cobro "${d.Tipo_de_Cobro || "vacío"}"`)
    if (!(Number(d.N_Empleados_que_marcan) > 0)) faltas.push("sin N° de empleados")
    if (tieneCotizacion && !(Number(d.Valor_fijo_del_trato_Global) > 0)) faltas.push("con cotización y sin valor fijo")
    const p3 = faltas.length
      ? { ok: false, detalle: faltas.join(" · ") }
      : { ok: true, detalle: `${d.Monda_del_trato} ${tieneCotizacion ? Number(d.Valor_fijo_del_trato_Global).toLocaleString("es-CL") : "(sin cotización)"} · N=${d.N_Empleados_que_marcan}` }
    return { deal: d, prueba: esPrueba(nombre), p1, p2, p3, p4 }
  }

  const filas: Fila[] = []
  for (let i = 0; i < deals.length; i += 4) {
    filas.push(...(await Promise.all(deals.slice(i, i + 4).map(revisar))))
  }
  const reales = filas.filter((f) => !f.prueba)
  const cuenta = (k: "p1" | "p2" | "p3" | "p4") => ({ ok: reales.filter((f) => f[k].ok).length, total: reales.length })
  const resumen = { p1: cuenta("p1"), p2: cuenta("p2"), p3: cuenta("p3"), p4: cuenta("p4") }

  if (url.searchParams.get("json") === "1" || url.searchParams.get("enviar") !== "1") {
    if (url.searchParams.get("json") === "1") {
      return NextResponse.json({ ok: true, desde: desde.toISOString(), hasta: hasta.toISOString(), deals: filas.length, pruebas: filas.length - reales.length, resumen, filas: filas.map((f) => ({ deal: f.deal.Deal_Name, id: f.deal.id, territorio: f.deal.Territorio, prueba: f.prueba, p1: f.p1, p2: f.p2, p3: f.p3, p4: f.p4 })) })
    }
  }

  const fechaCL = (d: Date) => d.toLocaleString("es-CL", { timeZone: "America/Santiago", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
  const pill = (x: { ok: boolean; detalle: string }) =>
    `<td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:12px;color:${x.ok ? "#16794a" : "#b42318"}">${x.ok ? "✅" : "❌"} ${esc(x.detalle)}</td>`
  const linea = (t: string, x: { ok: number; total: number }) =>
    `<li><b>${t}:</b> ${x.ok} de ${x.total}${x.total && x.ok < x.total ? ` — <span style="color:#b42318">${x.total - x.ok} con falla</span>` : ""}</li>`
  const html =
    `<div style="font-family:Arial,sans-serif;color:#1d2433;max-width:980px">` +
    `<h2 style="margin:0 0 4px">Auditoría del embudo de campañas (los 4 puntos de David)</h2>` +
    `<p style="margin:0 0 12px;color:#555">Deals creados por Vicky entre ${esc(fechaCL(desde))} y ${esc(fechaCL(hasta))} (hora de Chile): ` +
    `<b>${reales.length}</b> reales${filas.length - reales.length ? ` (+${filas.length - reales.length} de prueba, fuera del conteo)` : ""}.</p>` +
    `<ul style="margin:0 0 16px;padding-left:18px">` +
    linea("1. Lead en 4. Calificado antes de convertir", resumen.p1) +
    linea("2. Deal nace en 1. Trato Creado y avanza", resumen.p2) +
    linea("3. Valores completos (moneda, Mensual fijo, empleados, valor fijo)", resumen.p3) +
    linea("4. Deal nace de un lead convertido", resumen.p4) +
    `</ul>` +
    (reales.length
      ? `<div style="overflow-x:auto"><table style="border-collapse:collapse;width:100%"><thead><tr style="background:#f4f6fa;text-align:left;font-size:12px">` +
        `<th style="padding:6px 8px">Deal</th><th style="padding:6px 8px">País</th><th style="padding:6px 8px">1. Lead calificado</th>` +
        `<th style="padding:6px 8px">2. Etapas</th><th style="padding:6px 8px">3. Valores</th><th style="padding:6px 8px">4. Lead previo</th></tr></thead><tbody>` +
        reales
          .map(
            (f) =>
              `<tr><td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:12px"><a href="https://crm.zoho.com/crm/org685875245/tab/Potentials/${f.deal.id}">${esc(f.deal.Deal_Name)}</a><br><span style="color:#888">${esc(f.deal.Owner?.name || "")} · ${esc(f.deal.Stage || "")}</span></td>` +
              `<td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:12px">${esc(f.deal.Territorio || "")}</td>` +
              pill(f.p1) + pill(f.p2) + pill(f.p3) + pill(f.p4) + `</tr>`,
          )
          .join("") +
        `</tbody></table></div>`
      : `<p>No hubo deals nuevos de Vicky en la ventana.</p>`) +
    `<p style="margin-top:16px;color:#888;font-size:11px">Punto 3: el valor fijo solo se exige a deals con cotización (los que nacen sin cotización no tienen precio). Fuente: Zoho CRM, solo lectura.</p></div>`

  if (url.searchParams.get("enviar") !== "1") {
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } })
  }
  const to = (url.searchParams.get("to") || "egomez@geovictoria.com").split(",").map((s) => s.trim()).filter(Boolean)
  // Copia a Dave (David García, marketing) por defecto — Lalo 24-sep. `cc=-` la apaga.
  const ccParam = url.searchParams.get("cc") ?? "dgarciat@geovictoria.com"
  const cc = ccParam === "-" ? [] : ccParam.split(",").map((s) => s.trim()).filter(Boolean)
  const fallas = (["p1", "p2", "p3", "p4"] as const).reduce((a, k) => a + (resumen[k].total - resumen[k].ok), 0)
  const asunto = `Vicky · auditoría embudo de campañas: ${reales.length} deals, ${fallas ? `${fallas} fallas` : "sin fallas"}`
  const r = await fetch(`${ZOHO_API}/crm/v3/${MAIL_ANCHOR}/actions/send_mail`, {
    method: "POST",
    headers: H,
    cache: "no-store",
    body: JSON.stringify({ data: [{ from: { email: FROM_EMAIL }, to: to.map((email) => ({ email })), ...(cc.length ? { cc: cc.map((email) => ({ email })) } : {}), subject: asunto, content: html, mail_format: "html" }] }),
  })
  const detalle = r.ok ? "" : (await r.text().catch(() => "")).slice(0, 300)
  return NextResponse.json({ ok: r.ok, enviado: r.ok, to, cc, asunto, resumen, detalle })
}
