/**
 * Endpoint ADMIN: POST /api/vic-admin-onboarding-link
 *
 * Genera (o reutiliza) el link de auto-onboarding de una cotización vía el
 * cotizador y, opcionalmente, se lo manda al cliente por WhatsApp como Vicky
 * dejándolo en el historial. Para rescates manuales: el caso que lo motivó
 * (Grupo Dog Delivery, 03-ago) fue un comprobante enviado desde un número
 * distinto al de la cotización — el registro automático no lo asoció y el
 * cliente quedó sin su acceso.
 *
 * Body: { quoteId: string, contact?: string, send?: boolean, text?: string }
 *  - Sin send: devuelve el link.
 *  - Con send + contact: manda el mensaje CL estándar (o `text`, con {link}
 *    como placeholder) por Botmaker. Requiere ventana de 24h abierta.
 *
 * Auth: header x-cron-secret == vic_kv.followup_cron_secret, o ?key=/Bearer ==
 * CRON_SECRET. Mismo modelo que el resto de endpoints admin.
 */

import { NextResponse } from "next/server"
import { obtenerLinkOnboarding } from "@/lib/tools/registrar-comprobante-transferencia"
import { sendBotmakerMessage } from "@/lib/botmaker-push-v3"
import { appendAssistantV3, getFollowupCronSecret } from "@/lib/supabase-persistence-v3"

export const dynamic = "force-dynamic"
export const maxDuration = 30

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
  let body: { quoteId?: string; contact?: string; send?: boolean; text?: string } = {}
  try {
    body = (await req.json()) as typeof body
  } catch {
    return NextResponse.json({ ok: false, error: "body JSON inválido" }, { status: 400 })
  }
  const quoteId = (body.quoteId || "").trim()
  if (!quoteId) {
    return NextResponse.json({ ok: false, error: "quoteId requerido" }, { status: 400 })
  }
  const link = await obtenerLinkOnboarding(quoteId)
  if (!link) {
    return NextResponse.json(
      { ok: false, error: "el cotizador no devolvió link de onboarding" },
      { status: 502 },
    )
  }
  const contact = (body.contact || "").trim().replace(/\D/g, "")
  if (body.send && contact) {
    const texto = (body.text || "").trim()
      ? (body.text || "").replace("{link}", link)
      : `Ya quedó habilitada la configuración de tu cuenta — no tienes que esperar la verificación 🙌\n\n` +
        `Aquí tienes tu acceso: en unos 15 minutos dejas configurada tu empresa y cargados a tus trabajadores.\n${link}\n\n` +
        `Cualquier duda mientras lo llenas, me escribes por acá y lo vemos juntos 😊`
    const enviado = await sendBotmakerMessage(contact, texto).catch(() => false)
    if (enviado) await appendAssistantV3(contact, texto).catch(() => {})
    return NextResponse.json({ ok: enviado, link, sent: enviado, contact })
  }
  return NextResponse.json({ ok: true, link })
}
