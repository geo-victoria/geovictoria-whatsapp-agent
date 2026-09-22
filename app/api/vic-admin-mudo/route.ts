/**
 * ADMIN — mudo temporal de un contacto (04-sep, pedido de Lalo).
 *
 * Deja la línea de Vicky como BUZÓN: lo que el contacto mande se sigue
 * recibiendo, transcribiendo (voz) y describiendo (capturas, PDF) y queda en
 * el historial, pero Vicky no contesta. Sirve para reenviarle material y que
 * yo lo lea, sin que ella intente venderle a quien se lo manda.
 *
 *   GET  ?key=<cron>&contact=<fono>              → ¿está en mudo? ¿hasta cuándo?
 *   POST {contact, horas?}                        → enmudece (default 2 h, tope 12)
 *   POST {contact, off:true}                      → le devuelve la voz ahora
 *
 * El vencimiento vive DENTRO del valor, así que un mudo olvidado se apaga
 * solo. Tope de 12 horas por construcción.
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"
import { contactoEnMudo, enmudecer, desenmudecer, MUDO_MAX_HORAS } from "@/lib/mudo-contacto"

export const dynamic = "force-dynamic"
export const maxDuration = 15

async function autorizado(req: Request): Promise<boolean> {
  const url = new URL(req.url)
  const dado =
    req.headers.get("x-cron-secret") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim() ||
    url.searchParams.get("key") ||
    ""
  if (!dado) return false
  const kv = await getFollowupCronSecret().catch(() => "")
  return dado === (process.env.CRON_SECRET || "").trim() || (Boolean(kv) && dado === kv)
}

export async function GET(req: Request): Promise<Response> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  const contact = (new URL(req.url).searchParams.get("contact") || "").replace(/\D/g, "")
  if (!contact) return NextResponse.json({ ok: false, error: "falta contact" }, { status: 400 })
  return NextResponse.json({ ok: true, contact, enMudo: await contactoEnMudo(contact) })
}

export async function POST(req: Request): Promise<Response> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  const body = (await req.json().catch(() => ({}))) as { contact?: string; horas?: number; off?: boolean }
  const contact = String(body.contact || "").replace(/\D/g, "")
  if (!contact) return NextResponse.json({ ok: false, error: "falta contact" }, { status: 400 })
  if (body.off) {
    await desenmudecer(contact)
    return NextResponse.json({ ok: true, contact, enMudo: false, detalle: "Vicky vuelve a responder" })
  }
  const hasta = await enmudecer(contact, body.horas ?? 2)
  return NextResponse.json({ ok: true, contact, enMudo: true, hasta, topeHoras: MUDO_MAX_HORAS })
}
