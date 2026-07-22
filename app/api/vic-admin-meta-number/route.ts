/**
 * Endpoint ADMIN: GET /api/vic-admin-meta-number?id=<phoneNumberId>
 *
 * Diagnóstico de un número de WhatsApp vía la Graph API de Meta con el
 * WHATSAPP_ACCESS_TOKEN del servidor: estado de conexión, verificación de
 * nombre, calidad, throughput y plataforma. Creado 22-jul para diagnosticar
 * la línea MX (+52 1 56 5977 8486, id 1205318145997953) que no recibe
 * mensajes entrantes (un solo check en el remitente = Meta no los acepta).
 *
 * Solo lectura. Si el token no alcanza el WABA del número, la Graph API
 * responde el error de permisos — que también es diagnóstico útil.
 *
 * Auth: x-cron-secret == vic_kv.followup_cron_secret (mismo esquema admin).
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"

export const dynamic = "force-dynamic"
export const maxDuration = 30

export async function GET(req: Request): Promise<Response> {
  const xcron = (req.headers.get("x-cron-secret") || "").trim()
  const expected = await getFollowupCronSecret().catch(() => "")
  if (!expected || xcron !== expected) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }
  const token = (process.env.WHATSAPP_ACCESS_TOKEN || "").trim()
  if (!token) {
    return NextResponse.json({ ok: false, error: "WHATSAPP_ACCESS_TOKEN no configurado" }, { status: 503 })
  }
  const url = new URL(req.url)
  const id = (url.searchParams.get("id") || "").replace(/\D/g, "")
  if (!id) return NextResponse.json({ ok: false, error: "id (phoneNumberId) requerido" }, { status: 400 })

  const fields = [
    "display_phone_number",
    "verified_name",
    "code_verification_status",
    "quality_rating",
    "platform_type",
    "throughput",
    "status",
    "name_status",
    "account_mode",
  ].join(",")
  const r = await fetch(`https://graph.facebook.com/v22.0/${id}?fields=${fields}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  })
  const data = await r.json().catch(() => ({}))
  return NextResponse.json({ ok: r.ok, status: r.status, data })
}
