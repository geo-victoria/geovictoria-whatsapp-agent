/**
 * Endpoint ADMIN: POST /api/vic-admin-zoho-unblock
 *
 * Desbloquea una dirección rebotada en Zoho CRM vía la API v8 unblock_email
 * (el bloqueo es por DIRECCIÓN pero la API opera sobre un registro que la
 * contenga en un campo Email). Caso que lo motivó (04-ago): pdiaz@ quedó en
 * la lista de rebotes por un envío antiguo a "pdíaz@" (tilde) que Microsoft
 * rechazó — desde mayo Zoho se negaba a enviarle TODO correo del CRM.
 *
 * Body: { module: string, recordId: string, fields?: string[] }
 *   fields default: ["Email"]. Solo rebotes temporales; máx 5 desbloqueos.
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
    module?: string
    recordId?: string
    fields?: string[]
  }
  if (!body.module || !body.recordId) {
    return NextResponse.json({ ok: false, error: "Faltan campos: module, recordId" }, { status: 400 })
  }
  const accessToken = await getZohoAccessToken()
  const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
  const res = await fetch(
    `${api}/crm/v8/${encodeURIComponent(body.module)}/${encodeURIComponent(body.recordId)}/actions/unblock_email`,
    {
      method: "POST",
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}`, "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ unblock_fields: body.fields && body.fields.length ? body.fields : ["Email"] }),
    },
  )
  const texto = await res.text().catch(() => "")
  return NextResponse.json(
    { ok: res.ok, status: res.status, detalle: texto.slice(0, 500) },
    { status: res.ok ? 200 : 502 },
  )
}
