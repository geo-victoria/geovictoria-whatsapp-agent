/**
 * Endpoint ADMIN: pone un TAG de Botmaker en una o varias conversaciones.
 *
 * Nace de la campaña de reactivación (Lalo 03-sep): "etiquetar las
 * conversaciones con tags, no con variables, para poder filtrarlas en
 * Botmaker". El token de Botmaker vive en el env del agente, así que sin este
 * endpoint habría que pegárselo a alguien o hacerlo a mano chat por chat.
 *
 *   POST ?key=<cron>  { "tag": "reactivacion_sep2026",
 *                       "contacts": ["56942712678", ...] }
 *
 * Responde el detalle por contacto: el tag es best-effort y un fallo aislado
 * (chat inexistente, línea que no calza) no debe abortar el lote.
 */

import { NextResponse } from "next/server"
import { tagearChat } from "@/lib/botmaker-tags"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"

export const dynamic = "force-dynamic"
export const maxDuration = 60

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

export async function POST(req: Request): Promise<Response> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  const body = (await req.json().catch(() => null)) as { tag?: string; contacts?: string[] } | null
  const tag = String(body?.tag || "").trim()
  const contacts = Array.isArray(body?.contacts) ? body!.contacts : []
  if (!tag || contacts.length === 0) {
    return NextResponse.json({ ok: false, error: "faltan tag y contacts" }, { status: 400 })
  }
  const detalle: Array<{ contact: string; ok: boolean }> = []
  for (const c of contacts.slice(0, 200)) {
    detalle.push({ contact: String(c), ok: await tagearChat(String(c), tag) })
  }
  const ok = detalle.filter((d) => d.ok).length
  return NextResponse.json({ ok: true, tag, total: detalle.length, tagueados: ok, fallas: detalle.length - ok, detalle })
}
