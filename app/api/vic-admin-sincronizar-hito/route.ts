/**
 * Endpoint ADMIN: POST /api/vic-admin-sincronizar-hito
 *
 * Re-ejecuta la sincronización de hitos CRM para un contacto — el MISMO
 * pipeline de producción (enriquecimiento aditivo, status por blueprint,
 * conversión con deal en el piso del hito, tómbola al nacer, candados,
 * nota de transcripción). Para backfills: el caso que lo motivó (04-ago)
 * fueron los 14 leads de callbacks forzados a Eddyluz cuyo status y
 * conversión quedaron atrás por los bugs corregidos hoy.
 *
 * Body: { contact: string, hito?: Hito (default "intencion"),
 *         datos?: { nombre?, empresa?, email?, rut?, empleados? } }
 *
 * Auth: header x-cron-secret == vic_kv.followup_cron_secret, o ?key=/Bearer ==
 * CRON_SECRET. Mismo modelo que el resto de endpoints admin.
 */

import { NextResponse } from "next/server"
import { sincronizarHitoCrm, type Hito, type DatosConversacion } from "@/lib/crm-hitos"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const CRON_SECRET = (process.env.CRON_SECRET || "").trim()

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

const HITOS_VALIDOS = new Set(["intencion", "reunion_realizada", "discovery", "preform", "aceptada", "onboarding_listo"])

export async function POST(req: Request): Promise<Response> {
  if (!(await authorized(req))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }
  const body = (await req.json().catch(() => ({}))) as {
    contact?: string
    hito?: string
    datos?: DatosConversacion
  }
  const contact = (body.contact || "").replace(/\D/g, "")
  if (!contact) {
    return NextResponse.json({ ok: false, error: "Falta contact" }, { status: 400 })
  }
  const hito = (body.hito || "intencion").trim()
  if (!HITOS_VALIDOS.has(hito)) {
    return NextResponse.json({ ok: false, error: `hito inválido: ${hito}` }, { status: 400 })
  }
  await sincronizarHitoCrm(contact, hito as Hito, body.datos || {})
  return NextResponse.json({ ok: true, contact, hito })
}
