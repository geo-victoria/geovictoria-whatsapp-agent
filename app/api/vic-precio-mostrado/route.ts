import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * ¿Vicky le MOSTRÓ PRECIO a este teléfono antes de una fecha? (Lalo 09-sep,
 * "agrega Seguridad GSL": el caso C — Vicky dio precio en el chat, traspasó
 * y el ejecutivo cotizó y cerró — cuenta para Vicky igual que una reemisión.)
 * Lo consulta el COTIZADOR al clasificar el canal del correo de PAGADA, que no
 * tiene acceso a la base de conversaciones. Misma señal que el dash
 * (`fetchPreformAts`): mensaje de Vicky con el bloque de precio.
 *
 *   GET ?tel=569XXXXXXXX[&antes=<ISO>]   (x-cron-secret / ?key= / Bearer)
 *   → { ok: true, mostrado: boolean, at: string | null }
 *
 * Fail-closed: cualquier falla responde mostrado=false (queda la marca de la
 * emisión, como hasta ahora).
 */
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const CRON_SECRET = (process.env.CRON_SECRET || "").trim()
const SECRET_COTIZADOR = (process.env.VICKY_COTIZADORA_SECRET || "").trim()

async function autorizado(req: Request): Promise<boolean> {
  if (SECRET_COTIZADOR && (req.headers.get("x-vicky-secret") || "").trim() === SECRET_COTIZADOR) return true
  const url = new URL(req.url)
  const auth = req.headers.get("authorization") || ""
  const dado =
    (req.headers.get("x-cron-secret") || "").trim() ||
    (auth.startsWith("Bearer ") ? auth.slice(7).trim() : "") ||
    (url.searchParams.get("key") || "").trim()
  if (!dado) return false
  if (CRON_SECRET && dado === CRON_SECRET) return true
  const kv = await getFollowupCronSecret().catch(() => "")
  return Boolean(kv) && dado === kv
}

export async function GET(req: Request): Promise<Response> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  const url = new URL(req.url)
  const tel = (url.searchParams.get("tel") || "").replace(/\D/g, "").replace(/^5656/, "56")
  const antes = (url.searchParams.get("antes") || "").trim()
  if (tel.length < 9) return NextResponse.json({ ok: false, error: "tel inválido" }, { status: 400 })
  if (!SUPABASE_URL || !SUPABASE_KEY) return NextResponse.json({ ok: true, mostrado: false, at: null })
  const H = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  try {
    const convs = (await fetch(
      `${SUPABASE_URL}/rest/v1/vic_v3_conversations?contact=eq.${tel}&select=id&limit=5`,
      { headers: H, cache: "no-store" },
    ).then((r) => (r.ok ? r.json() : []))) as Array<{ id: string }>
    if (!convs.length) return NextResponse.json({ ok: true, mostrado: false, at: null })
    const ids = convs.map((c) => c.id).join(",")
    const antesMs = Date.parse(antes)
    const filtroAntes = Number.isFinite(antesMs) ? `&at=lt.${encodeURIComponent(new Date(antesMs).toISOString())}` : ""
    const rows = (await fetch(
      `${SUPABASE_URL}/rest/v1/vic_v3_messages?conversation_id=in.(${ids})&role=eq.assistant` +
        `&or=(content.ilike.*Resumen%20mensual*,content.ilike.*Total%20mensual%20con%20IVA*,content.ilike.*UF%20%2B%20IVA%20al%20mes*)` +
        `${filtroAntes}&select=at&order=at.asc&limit=1`,
      { headers: H, cache: "no-store" },
    ).then((r) => (r.ok ? r.json() : []))) as Array<{ at: string }>
    return NextResponse.json({ ok: true, mostrado: rows.length > 0, at: rows[0]?.at || null })
  } catch (e) {
    console.warn("[precio-mostrado]", tel, e instanceof Error ? e.message : e)
    return NextResponse.json({ ok: true, mostrado: false, at: null })
  }
}
