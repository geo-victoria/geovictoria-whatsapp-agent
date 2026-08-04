/**
 * Endpoint ADMIN: POST /api/vic-admin-mail-cotizacion
 *
 * Envía (o re-envía) por correo una cotización EXISTENTE vía Zoho send_mail
 * sobre el registro, con el token del agente. Para rescates: el caso que lo
 * motivó (Globe Air Fuel CO, 04-ago) — la formal se emitió bien pero el flujo
 * CO v1 no enviaba correo, y Vicky le había prometido el correo al cliente.
 *
 * Body: { quoteId, to, toName?, cc?: string[], replyTo?, subject, html,
 *         module? (default Cotizaciones_GeoVictoria) }
 *
 * Auth: header x-cron-secret == vic_kv.followup_cron_secret, o ?key=/Bearer ==
 * CRON_SECRET. Mismo modelo que el resto de endpoints admin.
 */

import { NextResponse } from "next/server"
import { getZohoAccessToken } from "@/lib/zoho-token"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"

export const dynamic = "force-dynamic"
export const maxDuration = 30

const CRON_SECRET = (process.env.CRON_SECRET || "").trim()

async function authorized(req: Request): Promise<boolean> {
  const xcron = (req.headers.get("x-cron-secret") || "").trim()
  if (xcron) {
    const expected = await getFollowupCronSecret().catch(() => "")
    if (expected && xcron === expected) return true
  }
  if (CRON_SECRET) {
    const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim()
    if (bearer === CRON_SECRET) return true
    const key = (new URL(req.url).searchParams.get("key") || "").trim()
    if (key === CRON_SECRET) return true
  }
  return false
}

export async function POST(req: Request): Promise<Response> {
  if (!(await authorized(req))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }
  const body = (await req.json().catch(() => ({}))) as {
    quoteId?: string
    module?: string
    to?: string
    toName?: string
    cc?: string[]
    replyTo?: string
    subject?: string
    html?: string
  }
  if (!body.quoteId || !body.to || !body.subject || !body.html) {
    return NextResponse.json(
      { ok: false, error: "Faltan campos: quoteId, to, subject, html" },
      { status: 400 },
    )
  }
  const modulo = (body.module || "Cotizaciones_GeoVictoria").trim()
  const accessToken = await getZohoAccessToken()
  const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
  const payload: Record<string, unknown> = {
    from: { email: "vicky@geovictoria.com" },
    to: [{ user_name: body.toName || body.to, email: body.to }],
    subject: body.subject,
    content: body.html,
    mail_format: "html",
  }
  if (body.replyTo) payload.reply_to = { email: body.replyTo }
  const cc = (body.cc || []).map((e) => String(e || "").trim()).filter(Boolean)
  if (cc.length) payload.cc = cc.map((email) => ({ email }))

  const res = await fetch(
    `${api}/crm/v3/${encodeURIComponent(modulo)}/${encodeURIComponent(body.quoteId)}/actions/send_mail`,
    {
      method: "POST",
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}`, "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ data: [payload] }),
    },
  )
  const texto = await res.text().catch(() => "")
  if (!res.ok) {
    return NextResponse.json({ ok: false, error: `send_mail ${res.status}: ${texto.slice(0, 300)}` }, { status: 502 })
  }
  return NextResponse.json({ ok: true, detalle: texto.slice(0, 300) })
}
