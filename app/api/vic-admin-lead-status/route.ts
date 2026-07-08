/**
 * Endpoint ADMIN: POST /api/vic-admin-lead-status
 *
 * Actualiza el Lead_Status de un lead en Zoho usando la misma ruta que los
 * hitos automáticos de Vicky (update directo con fallback a la transición de
 * BLUEPRINT). Para rescates operativos y pruebas.
 *
 * Auth: x-cron-secret == vic_kv.followup_cron_secret, o Bearer/?key=CRON_SECRET.
 * Body: { "leadId": "<id>", "status": "3. Contactado" }
 */

import { NextResponse } from "next/server"
import { updateZohoLeadStatus } from "@/lib/zoho-leads"
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

// GET ?leadId=<id> → lista las transiciones de blueprint disponibles (debug).
export async function GET(req: Request): Promise<Response> {
  if (!(await authorized(req))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }
  const leadId = (new URL(req.url).searchParams.get("leadId") || "").trim()
  if (!leadId) return NextResponse.json({ ok: false, error: "leadId requerido" }, { status: 400 })
  const { getZohoAccessToken } = await import("@/lib/zoho-token")
  const token = await getZohoAccessToken()
  const apiDomain = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
  const res = await fetch(`${apiDomain}/crm/v2/Leads/${leadId}/actions/blueprint`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
    cache: "no-store",
  })
  const data = await res.json().catch(() => ({}))
  return NextResponse.json({ ok: res.ok, data })
}

export async function POST(req: Request): Promise<Response> {
  if (!(await authorized(req))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }
  const body = (await req.json().catch(() => ({}))) as { leadId?: string; status?: string }
  const leadId = (body.leadId || "").trim()
  const status = (body.status || "").trim()
  if (!leadId || !status) {
    return NextResponse.json({ ok: false, error: "leadId y status requeridos" }, { status: 400 })
  }
  const result = await updateZohoLeadStatus(leadId, status)
  return NextResponse.json({ ok: result.success, leadId, status, error: result.error })
}
