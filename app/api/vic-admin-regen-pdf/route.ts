/**
 * Endpoint ADMIN: POST /api/vic-admin-regen-pdf
 *
 * Proxy a la cotizadora /api/quote-acceptance/regenerate-pdf (que exige
 * x-vicky-secret, no legible desde fuera). Regenera el PDF de una cotización
 * desde su estado actual en Zoho (útil cuando se editaron ítems/descuentos en
 * Zoho y el PDF quedó desactualizado). Devuelve el link_pdf nuevo.
 *
 * Auth: header x-cron-secret == vic_kv.followup_cron_secret, o ?key=/Bearer ==
 * CRON_SECRET. Body: { "quoteId": "<id>" } o { "token": "<token de aceptación>" }.
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const COTIZADORA_API_BASE = (process.env.COTIZADORA_API_BASE || "https://cotizacion.geovictoria.com").trim()
const VICKY_COTIZADORA_SECRET = (process.env.VICKY_COTIZADORA_SECRET || "").trim()
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
  let body: { quoteId?: string; token?: string } = {}
  try {
    body = (await req.json()) as { quoteId?: string; token?: string }
  } catch {
    return NextResponse.json({ ok: false, error: "body JSON inválido" }, { status: 400 })
  }
  const quoteId = (body.quoteId || "").trim()
  const token = (body.token || "").trim()
  if (!quoteId && !token) {
    return NextResponse.json({ ok: false, error: "quoteId o token requerido" }, { status: 400 })
  }
  try {
    const r = await fetch(`${COTIZADORA_API_BASE}/api/quote-acceptance/regenerate-pdf`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(VICKY_COTIZADORA_SECRET ? { "x-vicky-secret": VICKY_COTIZADORA_SECRET } : {}),
      },
      body: JSON.stringify(quoteId ? { quoteId } : { token }),
      cache: "no-store",
    })
    const data = await r.json().catch(() => null)
    return NextResponse.json({ ok: r.ok, status: r.status, data })
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `Excepción: ${String((e as Error)?.message || e)}` },
      { status: 500 },
    )
  }
}
