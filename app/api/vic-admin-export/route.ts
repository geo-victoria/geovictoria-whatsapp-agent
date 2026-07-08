/**
 * Endpoint ADMIN: POST /api/vic-admin-export
 *
 * Exporta conversaciones completas (mensajes con timestamp y rol) para análisis
 * offline (ej. Excel de ganadas vs fugadas). Body: { "contacts": ["569...", ...] }.
 * Devuelve JSON { conversations: [{contact, startedAt, messages:[{at, role, content}]}] }.
 *
 * Auth: x-cron-secret == vic_kv.followup_cron_secret, o Bearer/?key=CRON_SECRET.
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
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

function supa(path: string): Promise<Response> {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    cache: "no-store",
  })
}

export async function POST(req: Request): Promise<Response> {
  if (!(await authorized(req))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }
  const body = (await req.json().catch(() => ({}))) as { contacts?: string[] }
  const contacts = (body.contacts || []).map((c) => c.replace(/\D/g, "")).filter(Boolean).slice(0, 60)
  if (!contacts.length) {
    return NextResponse.json({ ok: false, error: "contacts requerido" }, { status: 400 })
  }
  const inList = contacts.map((c) => `"${c}"`).join(",")
  const convRes = await supa(
    `vic_v3_conversations?contact=in.(${inList})&select=id,contact,started_at`,
  )
  const convs = (convRes.ok ? await convRes.json() : []) as Array<{
    id: string
    contact: string
    started_at: string
  }>
  const out = []
  for (const c of convs) {
    const msgRes = await supa(
      `vic_v3_messages?conversation_id=eq.${c.id}&select=at,role,content&order=at.asc&limit=500`,
    )
    const messages = (msgRes.ok ? await msgRes.json() : []) as Array<{
      at: string
      role: string
      content: string
    }>
    out.push({ contact: c.contact, startedAt: c.started_at, messages })
  }
  return NextResponse.json({ ok: true, conversations: out })
}
