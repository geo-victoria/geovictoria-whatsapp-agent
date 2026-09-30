/**
 * LECTOR ADMIN de Zoho Analytics, SOLO LECTURA (30-sep). Proxy GET a la API
 * v2 de Analytics con el token propio (lib/zoho-analytics).
 *
 *   GET ?key=<cron>&ruta=/workspaces/<wid>/views/<vid>
 *   GET ?key=<cron>&ruta=/workspaces/<wid>/views/<vid>/data&config={"responseFormat":"json"}
 *
 * `config` se manda como el parámetro CONFIG de la API. Solo GET: no existe
 * forma de escribir en Analytics desde acá.
 */
import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"
import { analyticsGet } from "@/lib/zoho-analytics"

export const dynamic = "force-dynamic"
export const maxDuration = 120

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const secreto = await getFollowupCronSecret().catch(() => "")
  const cron = (process.env.CRON_SECRET || "").trim()
  const dado = req.headers.get("x-cron-secret") || url.searchParams.get("key") || ""
  if (!dado || (dado !== secreto && dado !== cron)) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  const ruta = (url.searchParams.get("ruta") || "").trim()
  if (!ruta.startsWith("/") || ruta.includes("..")) return NextResponse.json({ ok: false, error: "ruta debe empezar con /" }, { status: 400 })
  const config = url.searchParams.get("config")
  const sep = ruta.includes("?") ? "&" : "?"
  const r = await analyticsGet(config ? `${ruta}${sep}CONFIG=${encodeURIComponent(config)}` : ruta)
  return NextResponse.json({ ok: r.status >= 200 && r.status < 300, status: r.status, ruta, json: r.json, texto: r.texto?.slice(0, 200_000) })
}
