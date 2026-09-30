/**
 * ACCESS token corto de ZohoFiles para el COTIZADOR (30-sep): el refresh vive
 * SOLO en el agente (vic_kv, ver vic-admin-zoho-canje); el cotizador pide acá
 * un access token (~1 h) cuando necesita subir un archivo a /crm/v3/files
 * (PDF adjunto del correo). Auth: x-vicky-secret (el secreto compartido con el
 * cotizador) o el secreto cron. Sin token de archivos configurado → 404 y el
 * llamador sigue por su camino de siempre.
 */
import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"
import { getZohoFilesToken, filesTokenConfigurado } from "@/lib/zoho-files-token"

export const dynamic = "force-dynamic"
export const maxDuration = 15

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const vicky = (process.env.VICKY_COTIZADORA_SECRET || "").trim()
  const cron = await getFollowupCronSecret().catch(() => "")
  const dado = req.headers.get("x-vicky-secret") || req.headers.get("x-cron-secret") || url.searchParams.get("key") || ""
  const autorizado = Boolean(dado) && ((vicky && dado === vicky) || (cron && dado === cron) || (process.env.CRON_SECRET && dado === process.env.CRON_SECRET))
  if (!autorizado) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  if (!(await filesTokenConfigurado())) return NextResponse.json({ ok: false, error: "sin token de archivos configurado" }, { status: 404 })
  const token = await getZohoFilesToken()
  if (!token) return NextResponse.json({ ok: false, error: "no se pudo acuñar el access token" }, { status: 502 })
  return NextResponse.json({ ok: true, access_token: token, expires_in: 3000, api_domain: (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim() })
}
