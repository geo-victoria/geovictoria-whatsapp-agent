/**
 * Registro MANUAL de un comprobante por el MISMO camino del chat (24-sep, caso
 * B-ram COT1660: el comprobante llegó por WhatsApp y la tool lo descartó como
 * "recibo de tarjeta de Mercado Pago" cuando era una transferencia desde una
 * billetera MP a nuestra cuenta).
 *
 * POST /api/vic-admin-registrar-comprobante
 *   { contact, pais?: "cl"|"pe"|"co"|"mx", input: { montoDetectado, medio?, bancoOrigen?,
 *     fechaDetectada?, detalle?, numeroCotizacion? }, enviar?: boolean }
 * Auth: x-cron-secret == vic_kv.followup_cron_secret, o Bearer/?key=CRON_SECRET.
 *
 * Corre `registrarComprobanteTransferencia` tal cual (Pagada, adjunto, marca
 * comprobante_ok_, correo de PAGADA, avance del deal, alta por chat). Con
 * enviar=true además le manda al cliente el `mensajeParaProspecto` de la tool
 * y lo deja en el historial.
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret, appendAssistantV3 } from "@/lib/supabase-persistence-v3"
import { registrarComprobanteTransferencia } from "@/lib/tools/registrar-comprobante-transferencia"
import { sendBotmakerMessage } from "@/lib/botmaker-push-v3"

export const dynamic = "force-dynamic"
export const maxDuration = 120

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

type Body = {
  contact?: string
  pais?: "cl" | "pe" | "co" | "mx"
  enviar?: boolean
  input?: Parameters<typeof registrarComprobanteTransferencia>[1]
}

export async function POST(req: Request): Promise<Response> {
  if (!(await authorized(req))) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  const body = (await req.json().catch(() => ({}))) as Body
  const contact = String(body.contact || "").replace(/\D/g, "")
  if (!/^\d{10,15}$/.test(contact)) return NextResponse.json({ ok: false, error: "contact inválido" }, { status: 400 })
  if (!body.input || !(Number(body.input.montoDetectado) > 0)) {
    return NextResponse.json({ ok: false, error: "input.montoDetectado requerido" }, { status: 400 })
  }
  const pais = body.pais || "cl"
  const r = await registrarComprobanteTransferencia(contact, body.input, pais)
  let enviado = false
  if (body.enviar && r.mensajeParaProspecto) {
    enviado = await sendBotmakerMessage(contact, r.mensajeParaProspecto, undefined, { transaccional: true }).catch(() => false)
    if (enviado) await appendAssistantV3(contact, r.mensajeParaProspecto, pais).catch(() => {})
  }
  return NextResponse.json({ ok: r.ok, contact, pais, resultado: r, enviado })
}
