/**
 * Endpoint ADMIN: POST /api/vic-admin-descuento
 *
 * Aplica un descuento EXACTO sobre el plan de una cotización formal, usando el
 * endpoint aplicar-descuento-telefonico del cotizador con el secret del
 * servidor (nunca se expone el secret al operador).
 *
 * Nació del caso Pablo/Ayres Lubricentro (25-jul): Vicky ofreció 20% cuatro
 * veces sin que ninguna tool lo comiteara — la cotización en Zoho seguía en 0%,
 * así que el cliente habría pagado el precio de lista pese a la promesa. Este
 * endpoint permite alinear la cotización con lo YA prometido al cliente.
 *
 * El cotizador NUNCA rebaja un descuento vigente: si el pct enviado es menor o
 * igual al comiteado, responde sin cambios (candado del propio endpoint).
 *
 * Body: { "quoteId": "<id Zoho>", "pct": 20 }   // 0 < pct <= 25
 * Auth: x-cron-secret == vic_kv.followup_cron_secret (o Bearer/?key=CRON_SECRET).
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
    return NextResponse.json(
      { ok: false, error: "VICKY_COTIZADORA_SECRET no configurado" },
      { status: 503 },
    )
  }
  const body = (await req.json().catch(() => ({}))) as { quoteId?: string; pct?: number }
  const quoteId = (body.quoteId || "").trim()
  const pct = Number(body.pct)
  if (!quoteId || !Number.isFinite(pct) || pct <= 0 || pct > 25) {
    return NextResponse.json(
      { ok: false, error: "quoteId requerido y pct entre 0 y 25" },
      { status: 400 },
    )
  }

  const r = await fetch(`${COTIZADORA_API_BASE}/api/quote-acceptance/aplicar-descuento-telefonico`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-vicky-secret": VICKY_COTIZADORA_SECRET },
    body: JSON.stringify({ quoteId, pctExacto: pct }),
    cache: "no-store",
  })
  const data = await r.json().catch(() => ({}))
  return NextResponse.json({ ok: r.ok, status: r.status, quoteId, pct, data })
}
