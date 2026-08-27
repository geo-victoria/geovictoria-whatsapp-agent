/**
 * Endpoint ADMIN: ola de CORREO de una campaña de re-encantamiento.
 *
 * POST /api/vic-admin-campana-correo  (auth cron: ?key= o x-cron-secret)
 * Body: { campana: "dcto10_2026-08-26", dryRun?: boolean, max?: number }
 *
 * Cascada del doc v21: el correo va SOLO a quienes recibieron el toque de
 * WhatsApp y NO respondieron. Antes de enviar se aplica el FILTRO ESTÁNDAR
 * (lib/campana-filtro.ts): 48 horas hábiles sin actividad del cliente ni
 * gestión de un ejecutivo, sin clientes facturando — el caso Hofmann no se
 * repite por ningún canal.
 *
 * Cada correo se ancla a SU cotización en Zoho (queda en los Emails del
 * registro) y estampa evento `enviado_correo` en vic_campanas — de ahí lo
 * lee la sub-fila ✉️ Correo del panel. Idempotente: quien ya tiene
 * enviado_correo no se repite. `max` acota el lote por invocación.
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"
import { filtrarPadronCampana } from "@/lib/campana-filtro"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const CRON_SECRET = (process.env.CRON_SECRET || "").trim()
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const ZOHO_API = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
const QUOTE_MODULE = (process.env.ZOHO_QUOTE_MODULE || "Cotizaciones_GeoVictoria").trim()
const FROM_EMAIL = (process.env.VICKY_FROM_EMAIL || "vicky@geovictoria.com").trim()
const WA_VICKY = "https://wa.me/56967308227?text=Quiero%20el%20descuento"

const H_SB = () => ({ apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` })

async function autorizado(req: Request): Promise<boolean> {
  const key = (new URL(req.url).searchParams.get("key") || "").trim()
  if (CRON_SECRET && key === CRON_SECRET) return true
  const x = (req.headers.get("x-cron-secret") || "").trim()
  const esperado = await getFollowupCronSecret().catch(() => "")
  return Boolean(esperado) && (x === esperado || key === esperado)
}

function esc(s: string): string {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function htmlCorreo(empresa: string, lineaPersonal?: string): string {
  const intro = lineaPersonal
    ? esc(lineaPersonal)
    : `Ayer te escribí por WhatsApp: conseguí un <b>10% de descuento adicional</b> sobre el plan mensual de tu cotización${empresa ? ` para <b>${esc(empresa)}</b>` : ""}, y sigue disponible.`
  return `<!doctype html><html><body style="margin:0;background:#f4f6f8;font-family:'Segoe UI',Arial,sans-serif;color:#2d3748">
<div style="max-width:560px;margin:0 auto;padding:26px 18px">
  <div style="background:#fff;border-radius:14px;padding:28px 26px;box-shadow:0 1px 4px rgba(0,0,0,.06)">
    <p style="margin:0 0 6px;font-size:22px;font-weight:700;color:#0087C8">Tu 10% extra sigue esperando 👀</p>
    <p style="margin:0 0 14px;font-size:15px">Hola! Soy <b>Vicky</b>, de GeoVictoria 👋</p>
    <p style="margin:0 0 14px;font-size:14.5px;line-height:1.6">${intro}</p>
    <p style="margin:0 0 20px;font-size:14.5px;line-height:1.6">Tienes un <b>10% de descuento adicional</b> sobre el plan mensual, por los primeros 6 meses. Me respondes por WhatsApp y te dejo la cotización actualizada al instante, con pago en línea y tu cuenta activa el mismo día.</p>
    <p style="text-align:center;margin:24px 0"><a href="${WA_VICKY}" style="background:#25D366;color:#fff;text-decoration:none;font-weight:700;padding:13px 28px;border-radius:10px;display:inline-block;font-size:15px">Quiero mi descuento 💬</a></p>
    <p style="margin:0;font-size:13px;color:#718096;line-height:1.6">Si ya no lo necesitas o prefieres que no te escribamos más por esta cotización, respóndeme este correo y lo dejo hasta aquí.</p>
    <p style="margin:18px 0 0;font-size:13.5px">Un abrazo,<br><b>Vicky</b> · GeoVictoria</p>
  </div>
  <p style="text-align:center;font-size:11px;color:#a0aec0;margin:14px 0 0">GeoVictoria · Control de asistencia sin fricción</p>
</div>
</body></html>`
}

/** Versión "escrita a mano" (Lalo 27-ago): cero look de marketing — párrafos
 * simples, tipografía por defecto, links planos. Como un correo persona a
 * persona de Vicky. */
function htmlPersonal(empresa: string, lineaPersonal?: string): string {
  const intro = lineaPersonal
    ? esc(lineaPersonal)
    : `Ayer te escribí por WhatsApp por tu cotización${empresa ? ` de ${esc(empresa)}` : ""} y no quise dejarlo pasar.`
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;line-height:1.65;max-width:600px">
<p>Hola! Soy Vicky, de GeoVictoria.</p>
<p>${intro}</p>
<p>Te guardé un 10% adicional sobre el plan mensual, por los primeros 6 meses. Si te interesa lo activo al tiro: <a href="${WA_VICKY}">me escribes por WhatsApp</a> o me respondes este correo con un "sí", y te dejo la cotización actualizada con el pago en línea listo.</p>
<p>Y si ya no lo necesitan, me dices y no te molesto más con esto.</p>
<p>Un abrazo,<br>Vicky<br>GeoVictoria</p>
</div>`
}

export async function POST(req: Request): Promise<Response> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  const body = (await req.json().catch(() => ({}))) as { campana?: string; dryRun?: boolean; max?: number }
  const campana = (body.campana || "").trim()
  if (!campana) return NextResponse.json({ ok: false, error: "falta campana" }, { status: 400 })
  const dryRun = body.dryRun === true
  const max = Math.min(Math.max(Number(body.max) || 25, 1), 60)

  // Modo PRUEBA: manda UN correo de muestra al email indicado (para ver cómo
  // lo recibe el cliente), anclado al contacto interno — sin eventos ni kv.
  const testTo = ((body as { testTo?: string }).testTo || "").trim()
  if (testTo && /@/.test(testTo)) {
    const { getZohoAccessToken } = await import("@/lib/zoho-token")
    const token = await getZohoAccessToken()
    const anchor = (process.env.VIC_DASH_MAIL_ANCHOR || "Contacts/3525045000645054553").trim()
    const lineaEjemplo =
      "Cuando hablamos quedó dando vueltas cómo sumar a los subcontratados de Temple Norte: se puede, marcan igual que el resto y el plan se ajusta solo."
    const estilo = ((body as { estilo?: string }).estilo || "marketing").trim()
    const contenido =
      estilo === "personal"
        ? htmlPersonal("Temple Norte Selección y Chancado Spa", lineaEjemplo)
        : htmlCorreo("Temple Norte Selección y Chancado Spa", lineaEjemplo)
    const asunto =
      estilo === "personal"
        ? "[PRUEBA · estilo personal] Te guardé un 10% en tu cotización"
        : "[PRUEBA · estilo marketing] Tu 10% extra sigue esperando 👀"
    const rs = await fetch(`${ZOHO_API}/crm/v3/${anchor}/actions/send_mail`, {
      method: "POST",
      headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        data: [{
          from: { email: FROM_EMAIL },
          to: [{ email: testTo }],
          subject: asunto,
          content: contenido,
          mail_format: "html",
        }],
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    })
    return NextResponse.json({ ok: rs.ok, test: true, estilo, to: testTo, status: rs.status })
  }

  // 1. Pendientes de la cascada: enviados (WhatsApp) sin respuesta y sin
  // correo ya enviado.
  const rEv = await fetch(
    `${SUPABASE_URL}/rest/v1/vic_campanas?campana=eq.${encodeURIComponent(campana)}&select=contact,evento&limit=20000`,
    { headers: H_SB(), cache: "no-store" },
  )
  const eventos = ((await rEv.json().catch(() => [])) as Array<{ contact: string; evento: string }>) || []
  const enviados = new Set<string>()
  const respondieron = new Set<string>()
  const conCorreo = new Set<string>()
  for (const e of eventos) {
    const tel = e.contact.replace(/\D/g, "")
    if (e.evento === "enviado") enviados.add(tel)
    if (e.evento === "respuesta") respondieron.add(tel)
    if (e.evento === "enviado_correo") conCorreo.add(tel)
  }
  const pendientes = [...enviados].filter((t) => !respondieron.has(t) && !conCorreo.has(t))

  // 2. Filtro estándar (caso Hofmann: gestión activa queda fuera por TODO canal).
  const { aptos, excluidos } = await filtrarPadronCampana(pendientes)

  // 3. Email y empresa desde la cotización de cada kv de campaña.
  const rKv = await fetch(
    `${SUPABASE_URL}/rest/v1/vic_kv?key=like.campana_dcto_*&select=key,value&limit=1000`,
    { headers: H_SB(), cache: "no-store" },
  )
  const kvs = ((await rKv.json().catch(() => [])) as Array<{ key: string; value: string }>) || []
  const quoteDe = new Map<string, string>()
  for (const f of kvs) {
    try {
      const st = JSON.parse(f.value) as { campana?: string; quoteId?: string }
      if (st.campana === campana && st.quoteId) quoteDe.set(f.key.replace("campana_dcto_", ""), st.quoteId)
    } catch { /* kv corrupto */ }
  }

  const { getZohoAccessToken } = await import("@/lib/zoho-token")
  const token = await getZohoAccessToken()
  const HZ = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }

  const resultados: Array<{ contact: string; estado: string; email?: string; empresa?: string }> = []
  let enviadosAhora = 0
  for (const tel of aptos) {
    if (enviadosAhora >= max) { resultados.push({ contact: tel, estado: "queda_para_proximo_lote" }); continue }
    const quoteId = quoteDe.get(tel)
    if (!quoteId) { resultados.push({ contact: tel, estado: "sin_quote_en_kv" }); continue }
    const rq = await fetch(`${ZOHO_API}/crm/v3/${QUOTE_MODULE}/${quoteId}?fields=Email_Contacto,Cuenta_Asociada,Estado_Cotizacion,Owner`, { headers: HZ, cache: "no-store" })
    const fila = rq.ok && rq.status !== 204
      ? (((await rq.json().catch(() => null)) as { data?: Array<{ Email_Contacto?: string; Estado_Cotizacion?: string; Cuenta_Asociada?: { name?: string } | null; Owner?: { email?: string } | null }> } | null)?.data || [])[0]
      : undefined
    // Si el cliente RESPONDE el correo, la respuesta va al EJECUTIVO dueño de
    // la cotización (Lalo 27-ago); dueño robot → vicky@ (no hay humano aún).
    const ownerMail = String(fila?.Owner?.email || "").toLowerCase()
    const replyTo = ownerMail && !/vicky@|info@geovictoria/.test(ownerMail) ? ownerMail : FROM_EMAIL
    const email = (fila?.Email_Contacto || "").trim()
    const empresa = (fila?.Cuenta_Asociada?.name || "").trim()
    if (String(fila?.Estado_Cotizacion || "") === "Pagada") { resultados.push({ contact: tel, estado: "ya_pagada" }); continue }
    if (!email || !/@/.test(email)) { resultados.push({ contact: tel, estado: "sin_email", empresa }); continue }
    // TEST A/B (Lalo 27-ago): mitad estilo MARKETING (tarjeta + boton), mitad
    // estilo PERSONAL (texto plano escrito a mano). Asignacion determinista
    // por paridad del ultimo digito del telefono — reproducible y ciega al
    // contenido. La variante queda registrada en el evento para medir cual
    // convierte mejor (respuestas y pagos atribuidos al toque correo).
    const variante = Number(tel.slice(-1)) % 2 === 0 ? "marketing" : "personal"
    const asunto = variante === "personal"
      ? "Te guardé un 10% en tu cotización"
      : "Tu 10% extra sigue esperando 👀"
    const contenido = variante === "personal" ? htmlPersonal(empresa) : htmlCorreo(empresa)
    if (dryRun) { resultados.push({ contact: tel, estado: `dry_run_enviaria_${variante}`, email, empresa }); enviadosAhora++; continue }
    const rs = await fetch(`${ZOHO_API}/crm/v3/${QUOTE_MODULE}/${quoteId}/actions/send_mail`, {
      method: "POST",
      headers: HZ,
      body: JSON.stringify({
        data: [{
          from: { email: FROM_EMAIL },
          to: [{ email }],
          reply_to: { email: replyTo },
          subject: asunto,
          content: contenido,
          mail_format: "html",
        }],
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    })
    if (!rs.ok) {
      const cuerpo = await rs.text().catch(() => "")
      resultados.push({ contact: tel, estado: `fallo_${rs.status}:${cuerpo.slice(0, 120)}`, email, empresa })
      continue
    }
    await fetch(`${SUPABASE_URL}/rest/v1/vic_campanas`, {
      method: "POST",
      headers: { ...H_SB(), "Content-Type": "application/json" },
      body: JSON.stringify({ contact: tel, campana, evento: "enviado_correo", respuesta: variante, at: new Date().toISOString() }),
      cache: "no-store",
    }).catch(() => {})
    resultados.push({ contact: tel, estado: `enviado_${variante}`, email, empresa })
    enviadosAhora++
    await new Promise((r) => setTimeout(r, 400))
  }

  return NextResponse.json({
    ok: true,
    campana,
    dryRun,
    universo: { enviadosWhatsApp: enviados.size, respondieron: respondieron.size, correoYaEnviado: conCorreo.size, pendientes: pendientes.length },
    filtro: { aptos: aptos.length, excluidos },
    resultados,
  })
}
