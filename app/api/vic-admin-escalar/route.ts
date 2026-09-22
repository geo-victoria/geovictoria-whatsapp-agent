/**
 * ADMIN — escalar al implementador a mano (14-sep, caso Javiera/COTEL).
 *
 * `escalar_a_implementador` existía SOLO como tool del agente (09-sep, caso
 * Lorena Ortiz), así que cuando el que detecta la urgencia es el operador —y
 * no el cliente escribiendo— no había forma de avisarle al relator sin esperar
 * las 72 h hábiles del vigía. Este endpoint es esa puerta.
 *
 * POST {contact, motivo?, detalle}  · auth cron (header x-cron-secret o ?key=)
 *   motivo: urgencia_capacitacion | problema_plataforma | cliente_molesto |
 *           pedido_comercial | otro   (default: urgencia_capacitacion)
 * Devuelve lo mismo que la tool (relator, canales, mensajeParaProspecto) para
 * que el texto al cliente salga del MISMO lugar y no se invente otro.
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"
import { escalarAImplementador, type MotivoEscalamiento } from "@/lib/onboarding-escalamiento"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const CRON_SECRET = (process.env.CRON_SECRET || "").trim()

async function autorizado(req: Request): Promise<boolean> {
  const url = new URL(req.url)
  const auth = req.headers.get("authorization") || ""
  const entregado =
    req.headers.get("x-cron-secret") ||
    (auth.startsWith("Bearer ") ? auth.slice(7) : "") ||
    url.searchParams.get("key") ||
    ""
  if (!entregado) return false
  if (CRON_SECRET && entregado === CRON_SECRET) return true
  const kv = await getFollowupCronSecret().catch(() => "")
  return Boolean(kv) && entregado === kv
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  const body = (await req.json().catch(() => ({}))) as {
    contact?: string
    motivo?: string
    detalle?: string
  }
  const contact = String(body.contact || "").replace(/\D/g, "")
  if (!contact) return NextResponse.json({ ok: false, error: "falta contact" }, { status: 400 })
  const detalle = String(body.detalle || "").trim()
  if (!detalle) return NextResponse.json({ ok: false, error: "falta detalle" }, { status: 400 })
  const motivo = (body.motivo || "urgencia_capacitacion") as MotivoEscalamiento
  const r = await escalarAImplementador(contact, { motivo, detalle })
  return NextResponse.json({ ...r, contact, motivo })
}
