/**
 * ADMIN — leer/escribir una clave de vic_kv (24-ago, primera necesidad real:
 * cambiar el dueño de ventas autónomas `owner_venta_autonoma` sin deploy y
 * sin acceso directo a Supabase). Auth de cron; mismo nivel de poder que el
 * resto de los endpoints vic-admin-*.
 *
 * GET  ?key=<clave>            → { key, value }
 * POST { key, value }          → upsert (value "" = limpiar)
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret, getKvValue, setKvValue } from "@/lib/supabase-persistence-v3"

export const dynamic = "force-dynamic"
export const maxDuration = 15

async function autorizado(req: Request): Promise<boolean> {
  const secreto = await getFollowupCronSecret()
  const url = new URL(req.url)
  const auth = req.headers.get("authorization") || ""
  const entregado =
    req.headers.get("x-cron-secret") || (auth.startsWith("Bearer ") ? auth.slice(7) : "") || url.searchParams.get("key") || ""
  return Boolean(secreto) && entregado === secreto
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  const clave = (new URL(req.url).searchParams.get("k") || "").trim()
  if (!clave) return NextResponse.json({ ok: false, error: "falta ?k=" }, { status: 400 })
  const value = await getKvValue(clave).catch(() => null)
  return NextResponse.json({ ok: true, key: clave, value: value ?? "" })
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  const body = (await req.json().catch(() => ({}))) as { key?: string; value?: string }
  const clave = String(body.key || "").trim()
  if (!clave) return NextResponse.json({ ok: false, error: "falta key" }, { status: 400 })
  await setKvValue(clave, String(body.value ?? ""))
  console.log(`[admin-kv] ${clave} actualizado (${String(body.value ?? "").slice(0, 60)})`)
  return NextResponse.json({ ok: true, key: clave })
}
