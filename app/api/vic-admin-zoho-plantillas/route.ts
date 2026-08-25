/**
 * Endpoint ADMIN de solo lectura: plantillas de CORREO de Zoho CRM.
 *
 * Existe para la simulación del alta (25-ago): la plataforma manda las
 * credenciales con una plantilla de correo del módulo Implementaciones, y
 * para clonarla fiel hay que poder LEERLA — el token de Zoho vive en el env
 * de Vercel, no en las sesiones de trabajo.
 *
 *   GET ?key=<cron>&module=Implementaciones          → lista (id, nombre, asunto)
 *   GET ?key=<cron>&id=<templateId>                  → detalle con contenido HTML
 *
 * Solo lectura de settings/email_templates — nada más pasa por aquí.
 */

import { NextResponse } from "next/server"
import { getZohoAccessToken } from "@/lib/zoho-token"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"

export const dynamic = "force-dynamic"
export const maxDuration = 30

const ZOHO_API_DOMAIN = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
const CRON_SECRET = (process.env.CRON_SECRET || "").trim()

async function autorizado(req: Request): Promise<boolean> {
  const url = new URL(req.url)
  const entregado =
    req.headers.get("x-cron-secret") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") ||
    url.searchParams.get("key") ||
    ""
  if (!entregado) return false
  const kv = await getFollowupCronSecret().catch(() => "")
  return entregado === CRON_SECRET || (Boolean(kv) && entregado === kv)
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  const sp = new URL(req.url).searchParams
  const token = await getZohoAccessToken()
  const id = (sp.get("id") || "").trim()
  const modulo = (sp.get("module") || "Implementaciones").trim()
  const page = Math.max(1, Number(sp.get("page") || 1) || 1)
  const path = id
    ? `/crm/v3/settings/email_templates/${encodeURIComponent(id)}`
    : `/crm/v3/settings/email_templates?module=${encodeURIComponent(modulo)}&page=${page}&per_page=200`
  const r = await fetch(`${ZOHO_API_DOMAIN}${path}`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
    cache: "no-store",
  })
  const cuerpo = await r.text().catch(() => "")
  let data: unknown = null
  try {
    data = JSON.parse(cuerpo)
  } catch {
    return NextResponse.json({ ok: false, status: r.status, crudo: cuerpo.slice(0, 400) })
  }
  if (id) return NextResponse.json({ ok: r.ok, status: r.status, data })
  const lista = ((data as { email_templates?: Array<Record<string, unknown>> })?.email_templates || []).map((t) => ({
    id: String(t.id || ""),
    name: String(t.name || ""),
    subject: String(t.subject || ""),
    modified_time: String(t.modified_time || ""),
  }))
  return NextResponse.json({ ok: r.ok, status: r.status, n: lista.length, plantillas: lista })
}
