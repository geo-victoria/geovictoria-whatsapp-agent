import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"
import { precioMostradoPorVicky } from "@/lib/atribucion-venta"

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
  // La consulta vive en lib/atribucion-venta: la comparten este endpoint (que
  // usa el COTIZADOR para clasificar el canal del correo de PAGADA) y el gate
  // del alta por chat. Dos copias de la misma señal se habrían separado sin
  // que nadie lo notara — que es justo el defecto del 13-sep.
  const r = await precioMostradoPorVicky(tel, antes)
  return NextResponse.json({ ok: true, mostrado: r.mostrado, at: r.at })
}
