/**
 * Reenvío MANUAL de la notificación interna de "Cotización PAGADA".
 *
 * Para pagos que quedaron sin su correo de PAGADA (el hoyo de las
 * transferencias, cerrado el 10-ago con notify-paid en el cotizador): este
 * endpoint permite dispararlo a mano para una cotización puntual — el caso
 * que lo parió es COT408 (Fernando), pagada por transferencia a las 14:49
 * del 10-ago sin que el equipo recibiera el correo.
 *
 * GET /api/vic-admin-notify-paid?quoteId=<id>
 * Auth: x-cron-secret == vic_kv.followup_cron_secret, o Bearer/?key=CRON_SECRET.
 *
 * Delega en el cotizador (notify-paid → notifyQuoteEvent), que aplica sus
 * propias reglas: destinatarios por país + Owner dinámico, filtro
 * anti-pruebas y WhatsApp interno.
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"
import { notificarPagadaAlCotizador } from "@/lib/tools/registrar-comprobante-transferencia"

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

export async function GET(req: Request): Promise<Response> {
  if (!(await authorized(req))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }
  const quoteId = (new URL(req.url).searchParams.get("quoteId") || "").trim()
  if (!/^\d{10,25}$/.test(quoteId)) {
    return NextResponse.json({ ok: false, error: "quoteId inválido" }, { status: 400 })
  }
  await notificarPagadaAlCotizador(quoteId)
  return NextResponse.json({ ok: true, quoteId, nota: "disparo delegado al cotizador; resultado en logs [quote-notify]" })
}
