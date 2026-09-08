/**
 * ADMIN — proxy de SOLO LECTURA a la API de Zoho (08-sep): GET ?path=/crm/v3/...
 * Devuelve JSON tal cual o el binario (archivos: /crm/v3/files?id=...). Auth cron.
 * Sirve para inspeccionar registros y bajar adjuntos sin exponer el token.
 */
import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"
import { getZohoAccessToken } from "@/lib/zoho-token"

export const dynamic = "force-dynamic"
export const maxDuration = 60

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const secreto = await getFollowupCronSecret()
  const dado = req.headers.get("x-cron-secret") || url.searchParams.get("key") || ""
  if (!secreto || dado !== secreto) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  const path = (url.searchParams.get("path") || "").trim()
  if (!path.startsWith("/crm/")) return NextResponse.json({ ok: false, error: "path debe empezar con /crm/" }, { status: 400 })
  const token = await getZohoAccessToken()
  const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
  const r = await fetch(`${api}${path}`, { headers: { Authorization: `Zoho-oauthtoken ${token}` }, cache: "no-store" })
  const ct = r.headers.get("content-type") || "application/octet-stream"
  const buf = await r.arrayBuffer()
  const h: Record<string, string> = { "content-type": ct, "x-zoho-status": String(r.status) }
  const cd = r.headers.get("content-disposition")
  if (cd) h["content-disposition"] = cd
  return new Response(buf, { status: r.status === 204 ? 200 : r.status, headers: h })
}
