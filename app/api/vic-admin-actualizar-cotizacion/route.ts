/**
 * Endpoint ADMIN: POST /api/vic-admin-actualizar-cotizacion
 *
 * Ejecuta la tool REAL actualizar_cotizacion (CL) con una configuración
 * explícita y, opcionalmente, envía el mensajeParaProspecto al cliente por
 * WhatsApp como Vicky (persistido en historial). Para actualizaciones
 * pedidas por los ejecutivos fuera de la conversación (caso COT355/Frederic,
 * 04-ago: Eddyluz pidió agregar un reloj en arriendo con instalación).
 * El correo con el PDF v2 lo envía el propio endpoint del cotizador.
 *
 * Body: { contact?, send?, quote_id, userCount, modulos, hardware?,
 *         puntosInstalacion?, resumen_cambio }
 *
 * Auth: header x-cron-secret == vic_kv.followup_cron_secret, o ?key=/Bearer ==
 * CRON_SECRET. Mismo modelo que el resto de endpoints admin.
 */

import { NextResponse } from "next/server"
import { actualizarCotizacion, type ActualizarCotizacionInput } from "@/lib/tools/actualizar-cotizacion"
import { sendBotmakerMessage } from "@/lib/botmaker-push-v3"
import { appendAssistantV3, getFollowupCronSecret } from "@/lib/supabase-persistence-v3"

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

export async function POST(req: Request): Promise<Response> {
  if (!(await authorized(req))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }
  const body = (await req.json().catch(() => ({}))) as Partial<ActualizarCotizacionInput> & {
    contact?: string
    send?: boolean
    anualizar?: boolean
  }
  // Canal admin de la ANUALIDAD (01-sep): con anualizar=true la cotización se
  // convierte a pago anual con la misma tool determinista de Vicky.
  if (body.anualizar === true && body.quote_id) {
    const { anualizarCotizacion } = await import("@/lib/tools/anualizar-cotizacion")
    const r = await anualizarCotizacion({
      quote_id: body.quote_id,
      _sinCorreoCliente: (body as { _sinCorreoCliente?: boolean })._sinCorreoCliente === true,
    })
    if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: 502 })
    return NextResponse.json({
      ok: true,
      version: r.version,
      acceptanceUrl: r.acceptanceUrl,
      totalCLP: r.totalConIvaCLP,
      mensaje: r.mensajeParaProspecto,
    })
  }
  if (!body.quote_id || !body.userCount || !body.modulos?.length || !body.resumen_cambio) {
    return NextResponse.json(
      { ok: false, error: "Faltan campos: quote_id, userCount, modulos, resumen_cambio" },
      { status: 400 },
    )
  }
  const result = await actualizarCotizacion({
    quote_id: body.quote_id,
    userCount: body.userCount,
    modulos: body.modulos,
    hardware: body.hardware,
    puntosInstalacion: body.puntosInstalacion,
    resumen_cambio: body.resumen_cambio,
    // Edición RICA del canal admin (réplica COT453, 11-ago): líneas manuales,
    // overrides de precio y UF fijada viajan tal cual al motor del editor.
    itemsExtra: body.itemsExtra,
    preciosOverride: body.preciosOverride,
    ufValor: body.ufValor,
    _regenerarPdf: body._regenerarPdf,
    _sinCorreoCliente: body._sinCorreoCliente,
    // Canal interno de ejecutivos: "RM"/"Región" a secas vale como zona.
    _zonaGenericaOk: true,
  })
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 502 })
  }
  let enviado = false
  const contact = (body.contact || "").replace(/\D/g, "")
  if (body.send === true && contact) {
    enviado = await sendBotmakerMessage(contact, result.mensajeParaProspecto).catch(() => false)
    if (enviado) await appendAssistantV3(contact, result.mensajeParaProspecto).catch(() => {})
  }
  return NextResponse.json({
    ok: true,
    version: result.version,
    totalUF: result.totalUF,
    totalCLP: result.totalCLP,
    acceptanceUrl: result.acceptanceUrl,
    enviado,
    mensaje: result.mensajeParaProspecto,
  })
}
