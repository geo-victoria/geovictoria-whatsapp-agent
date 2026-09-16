/**
 * Endpoint ADMIN: POST /api/vic-admin-adjuntar-imp
 *
 * Sube un archivo (base64) como adjunto de una NOTA de una Implementación
 * (fallback: adjunto directo de la IMP). Nació el 16-sep para dejar en la
 * IMP la planilla de ingreso oficial (PLANTILLA_INGRESO del wizard) armada
 * a mano desde lo levantado por chat, cuando el cliente no cerró el wizard
 * y `adjuntarPlanillasImplementacion` solo pudo generar la de usuarios.
 *
 * Body: { impId, nombreArchivo, contenidoBase64, notaId?, tituloNota?, contenidoNota? }
 *  - Con notaId: adjunta a esa nota.
 *  - Sin notaId y con tituloNota: crea una nota nueva en la IMP y adjunta ahí.
 *  - Sin ninguno: adjunta directo a la IMP.
 * Auth: header x-cron-secret == vic_kv.followup_cron_secret, o ?key=/Bearer == CRON_SECRET.
 */
import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"
import { getZohoAccessToken } from "@/lib/zoho-token"
import { subirAdjuntoNota } from "@/lib/implementacion-planillas"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const CRON_SECRET = (process.env.CRON_SECRET || "").trim()
const API = () => (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").replace(/\/$/, "")

async function authorized(req: Request): Promise<boolean> {
  const xcron = (req.headers.get("x-cron-secret") || "").trim()
  if (xcron) {
    const expected = await getFollowupCronSecret().catch(() => "")
    if (expected && xcron === expected) return true
  }
  if (CRON_SECRET) {
    const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim()
    if (bearer === CRON_SECRET) return true
    const key = (new URL(req.url).searchParams.get("key") || "").trim()
    if (key === CRON_SECRET) return true
  }
  return false
}

export async function POST(req: Request): Promise<Response> {
  if (!(await authorized(req))) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  let body: { impId?: string; notaId?: string; nombreArchivo?: string; contenidoBase64?: string; tituloNota?: string; contenidoNota?: string } = {}
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: "body inválido" }, { status: 400 })
  }
  const impId = String(body.impId || "").trim()
  const nombre = String(body.nombreArchivo || "").trim()
  const b64 = String(body.contenidoBase64 || "").trim()
  if (!/^\d{15,20}$/.test(impId) || !nombre || !b64) {
    return NextResponse.json({ ok: false, error: "faltan impId, nombreArchivo o contenidoBase64" }, { status: 400 })
  }
  const buf = Buffer.from(b64, "base64")
  if (!buf.length || buf.length > 15 * 1024 * 1024) {
    return NextResponse.json({ ok: false, error: "archivo vacío o mayor a 15 MB" }, { status: 400 })
  }
  const token = await getZohoAccessToken()
  let notaId = String(body.notaId || "").trim()
  if (!notaId && body.tituloNota) {
    const r = await fetch(`${API()}/crm/v3/Implementaciones/${impId}/Notes`, {
      method: "POST",
      headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ data: [{ Note_Title: String(body.tituloNota).slice(0, 120), Note_Content: String(body.contenidoNota || "").slice(0, 60000) }] }),
      cache: "no-store",
    })
    const j = (await r.json().catch(() => ({}))) as { data?: Array<{ details?: { id?: string } }> }
    notaId = String(j?.data?.[0]?.details?.id || "")
    if (!notaId) return NextResponse.json({ ok: false, error: "no se pudo crear la nota", status: r.status }, { status: 502 })
  }
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
  let ok: boolean
  if (notaId) {
    ok = await subirAdjuntoNota(token, notaId, impId, ab, nombre)
  } else {
    const form = new FormData()
    form.append("file", new Blob([ab]), nombre)
    const r = await fetch(`${API()}/crm/v3/Implementaciones/${impId}/Attachments`, { method: "POST", headers: { Authorization: `Zoho-oauthtoken ${token}` }, body: form, cache: "no-store" })
    ok = r.ok
  }
  return NextResponse.json({ ok, impId, notaId: notaId || null, nombreArchivo: nombre, bytes: buf.length }, { status: ok ? 200 : 502 })
}
