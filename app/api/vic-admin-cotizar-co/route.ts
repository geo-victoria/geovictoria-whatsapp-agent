/**
 * Endpoint ADMIN: POST /api/vic-admin-cotizar-co
 *
 * Ejecuta la tool REAL generar_link_cotizadora de Colombia para un contacto y,
 * opcionalmente, le envía el mensaje con el link verdadero por WhatsApp como
 * Vicky (dejándolo en el historial). Para rescates manuales: el caso que lo
 * motivó (VMW Ingeniería, 04-ago) fue una ALUCINACIÓN — el modelo le mandó al
 * cliente un link de checkout fabricado sin llamar la tool, y el cliente quedó
 * con un link muerto y sin cotización real.
 *
 * Body: { contact, empresa, contacto, nit, email, userCount,
 *         reloj?, puntosInstalacion?, send?: boolean, text?: string }
 *  - Sin send: crea la cotización y devuelve acceptanceUrl.
 *  - Con send: además manda `text` (con {link} como placeholder) o el
 *    mensajeParaProspecto de la tool. Requiere ventana de 24h abierta.
 *
 * Auth: header x-cron-secret == vic_kv.followup_cron_secret, o ?key=/Bearer ==
 * CRON_SECRET. Mismo modelo que el resto de endpoints admin.
 */

import { NextResponse } from "next/server"
import { buildDispatchCO } from "@/lib/paises/co/tools"
import { PERFIL_CO } from "@/lib/paises/co"
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
  const body = (await req.json().catch(() => ({}))) as {
    contact?: string
    empresa?: string
    contacto?: string
    nit?: string
    email?: string
    userCount?: number
    reloj?: { modalidad?: "arriendo" | "venta"; cantidad?: number }
    puntosInstalacion?: Array<{ ubicacion?: string; autoInstalada?: boolean }>
    send?: boolean
    text?: string
  }
  const contact = (body.contact || "").replace(/\D/g, "")
  if (!contact || !body.empresa || !body.contacto || !body.nit || !body.email || !body.userCount) {
    return NextResponse.json(
      { ok: false, error: "Faltan campos: contact, empresa, contacto, nit, email, userCount" },
      { status: 400 },
    )
  }

  const dispatch = buildDispatchCO(contact)
  const result = (await dispatch("generar_link_cotizadora", {
    empresa: body.empresa,
    contacto: body.contacto,
    nit: body.nit,
    email: body.email,
    userCount: body.userCount,
    ...(body.reloj ? { reloj: body.reloj } : {}),
    ...(body.puntosInstalacion ? { puntosInstalacion: body.puntosInstalacion } : {}),
  })) as {
    ok?: boolean
    error?: string
    quoteId?: string
    acceptanceUrl?: string
    mensajeParaProspecto?: string
  }

  if (!result?.ok || !result.acceptanceUrl) {
    return NextResponse.json({ ok: false, error: result?.error || "tool falló" }, { status: 502 })
  }

  let enviado = false
  if (body.send === true) {
    const texto = (body.text || "").includes("{link}")
      ? (body.text || "").split("{link}").join(result.acceptanceUrl)
      : result.mensajeParaProspecto || `Aquí tienes tu cotización formal: ${result.acceptanceUrl}`
    enviado = await sendBotmakerMessage(contact, texto, PERFIL_CO.canal.channelId).catch(() => false)
    if (enviado) {
      await appendAssistantV3(contact, texto).catch(() => {})
    }
  }

  return NextResponse.json({
    ok: true,
    quoteId: result.quoteId || "",
    acceptanceUrl: result.acceptanceUrl,
    enviado,
  })
}
