/**
 * Endpoint ADMIN: POST /api/vic-admin-cobranza-mail
 *
 * Fuerza el correo a cobranza de un pago por transferencia (el que
 * registrar_comprobante_transferencia manda solo desde el 03-ago). Para
 * rescates de pagos que llegaron antes del cambio o cuya asociación falló.
 *
 * Body: los campos de DatosCobranza (quoteId obligatorio; el resto opcional).
 *
 * Auth: header x-cron-secret == vic_kv.followup_cron_secret, o ?key=/Bearer ==
 * CRON_SECRET. Mismo modelo que el resto de endpoints admin.
 */

import { NextResponse } from "next/server"
import { enviarCorreoCobranza, type DatosCobranza } from "@/lib/correo-cobranza"
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
  let body: DatosCobranza
  try {
    body = (await req.json()) as DatosCobranza
  } catch {
    return NextResponse.json({ ok: false, error: "body JSON inválido" }, { status: 400 })
  }
  if (!body.quoteId?.trim()) {
    return NextResponse.json({ ok: false, error: "quoteId requerido" }, { status: 400 })
  }
  const result = await enviarCorreoCobranza(body)
  return NextResponse.json(result, { status: result.ok ? 200 : 502 })
}
