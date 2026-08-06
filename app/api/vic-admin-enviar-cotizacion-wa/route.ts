/**
 * Endpoint ADMIN: POST /api/vic-admin-enviar-cotizacion-wa
 *
 * Botón "Enviar por WhatsApp" de la cotización en Zoho (Deluge, Lalo 06-ago):
 * Vicky le envía al cliente el PDF como ARCHIVO + el link de la aceptación
 * online. Cubre AMBOS lados de la ventana de 24h de Meta:
 *
 *  - Ventana ABIERTA  → sale de inmediato (texto con link + PDF adjunto).
 *  - Ventana CERRADA  → sale la plantilla aprobada `vicky_loop_pago`; cuando
 *    el cliente responda, el webhook detecta el pendiente y el paquete
 *    completo sale solo (lib/enviar-cotizacion-wa).
 *
 * Body: { "quoteId": "<id Zoho>" }
 * Auth: x-cron-secret == vic_kv.followup_cron_secret, o ?key=/Bearer CRON_SECRET.
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"
import {
  datosDeCotizacion,
  enviarPaqueteCotizacion,
  programarEnvioConPlantilla,
} from "@/lib/enviar-cotizacion-wa"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const CRON_SECRET = (process.env.CRON_SECRET || "").trim()
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()

async function authorized(req: Request): Promise<boolean> {
  const url = new URL(req.url)
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim()
  const key = (url.searchParams.get("key") || "").trim()
  if (CRON_SECRET && (bearer === CRON_SECRET || key === CRON_SECRET)) return true
  const xcron = (req.headers.get("x-cron-secret") || "").trim()
  if (xcron || key) {
    const expected = await getFollowupCronSecret().catch(() => "")
    if (expected && (xcron === expected || key === expected)) return true
  }
  return false
}

/** Ventana de 24h de Meta: abierta si el cliente escribió hace < 23h (margen). */
async function ventanaAbierta(fono: string): Promise<boolean> {
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/vic_v3_conversations?contact=eq.${encodeURIComponent(fono)}&select=last_user_at&limit=1`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, cache: "no-store" },
    )
    const rows = (await r.json().catch(() => [])) as Array<{ last_user_at: string | null }>
    const at = rows?.[0]?.last_user_at
    if (!at) return false
    return Date.now() - Date.parse(at) < 23 * 3600_000
  } catch {
    return false
  }
}

export async function POST(req: Request): Promise<Response> {
  if (!(await authorized(req))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }
  const body = (await req.json().catch(() => ({}))) as { quoteId?: string }
  const quoteId = (body.quoteId || "").trim()
  if (!quoteId) {
    return NextResponse.json({ ok: false, error: "Falta quoteId" }, { status: 400 })
  }

  const datos = await datosDeCotizacion(quoteId)
  if (!datos) {
    return NextResponse.json({ ok: false, error: "Cotización no encontrada en Zoho" }, { status: 404 })
  }
  if (!datos.telefono) {
    return NextResponse.json({ ok: false, error: "La cotización no tiene teléfono de contacto" }, { status: 400 })
  }
  if (!datos.acceptanceUrl) {
    return NextResponse.json({ ok: false, error: "La cotización no tiene URL de aceptación" }, { status: 400 })
  }

  if (await ventanaAbierta(datos.telefono)) {
    const r = await enviarPaqueteCotizacion(datos, quoteId)
    if (!r.ok) {
      return NextResponse.json(
        { ok: false, error: "Botmaker rechazó el envío directo. Reintenta o consulta el estado de la conversación." },
        { status: 502 },
      )
    }
    return NextResponse.json({ via: "directo", ...r })
  }

  // Ventana cerrada: plantilla de re-apertura + pendiente para el webhook.
  const okTpl = await programarEnvioConPlantilla(datos, quoteId)
  if (!okTpl) {
    return NextResponse.json(
      { ok: false, error: "No se pudo enviar la plantilla (Botmaker la rechazó). Reintenta en unos minutos." },
      { status: 502 },
    )
  }
  return NextResponse.json({
    ok: true,
    via: "plantilla",
    detalle:
      "Ventana de 24h cerrada: se envió la plantilla de contacto. Apenas el cliente responda, el PDF y el link salen automáticamente.",
  })
}
