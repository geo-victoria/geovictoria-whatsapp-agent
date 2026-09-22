/**
 * Endpoint ADMIN: POST /api/vic-admin-regenerate-pdf
 *
 * Passthrough a la cotizadora para regenerar el PDF de una cotización cuyo
 * detalle fue editado directamente en Zoho (el PDF es un artefacto congelado;
 * la página de aceptación siempre muestra lo vivo). NO envía correos.
 *
 * Body: { "quoteId": "<id Zoho>" }
 * Auth: x-cron-secret == vic_kv.followup_cron_secret, o Bearer/?key=CRON_SECRET.
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const CRON_SECRET = (process.env.CRON_SECRET || "").trim()
const COTIZADORA_API_BASE = (
  process.env.COTIZADORA_API_BASE || "https://cotizacion.geovictoria.com"
).trim()
const VICKY_COTIZADORA_SECRET = (process.env.VICKY_COTIZADORA_SECRET || "").trim()

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
  if (!VICKY_COTIZADORA_SECRET) {
    return NextResponse.json({ ok: false, error: "VICKY_COTIZADORA_SECRET no configurada" }, { status: 503 })
  }
  const body = (await req.json().catch(() => ({}))) as { quoteId?: string }
  const quoteId = (body.quoteId || "").trim()
  if (!quoteId) return NextResponse.json({ ok: false, error: "quoteId requerido" }, { status: 400 })

  const res = await fetch(`${COTIZADORA_API_BASE}/api/quote-acceptance/regenerate-pdf`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-vicky-secret": VICKY_COTIZADORA_SECRET,
    },
    body: JSON.stringify({ quoteId }),
    cache: "no-store",
  })
  const data = await res.json().catch(() => ({}))
  return NextResponse.json(data, { status: res.status })
}
