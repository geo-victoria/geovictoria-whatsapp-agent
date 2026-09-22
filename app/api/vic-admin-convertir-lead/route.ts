/**
 * Endpoint ADMIN: POST /api/vic-admin-convertir-lead
 *
 * Convierte un LEAD apuntando a una CUENTA y CONTACTO existentes (sin crear
 * deal nuevo): lo marca Converted y lo saca de la cola "cliente para
 * contactar" del SDR. Para remediar leads huérfanos del flujo SDR que
 * coexisten con un deal de Vicky (caso Globe Air Fuel / Juan 04-ago).
 *
 * Body: { leadId, accountId?, contactId?, dealData? }
 *   Sin dealData: convierte solo a account/contact (no crea deal).
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
    leadId?: string
    accountId?: string
    contactId?: string
  }
  if (!body.leadId || (!body.accountId && !body.contactId)) {
    return NextResponse.json({ ok: false, error: "Faltan campos: leadId + (accountId o contactId)" }, { status: 400 })
  }
  const token = await getZohoAccessToken()
  const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
  const payload: Record<string, unknown> = {
    overwrite: false,
    notify_lead_owner: false,
    notify_new_entity_owner: false,
  }
  if (body.accountId) payload.Accounts = { id: body.accountId }
  if (body.contactId) payload.Contacts = { id: body.contactId }
  const res = await fetch(`${api}/crm/v3/Leads/${encodeURIComponent(body.leadId)}/actions/convert`, {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({ data: [payload] }),
  })
  const texto = await res.text().catch(() => "")
  return NextResponse.json({ ok: res.ok, status: res.status, detalle: texto.slice(0, 400) }, { status: res.ok ? 200 : 502 })
}
