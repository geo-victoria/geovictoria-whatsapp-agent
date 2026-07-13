/**
 * Endpoint ADMIN: POST /api/vic-admin-send
 *
 * Envía un mensaje de texto libre a un contacto de WhatsApp vía el push de
 * Botmaker (sendBotmakerMessage). Para rescates manuales: entregar un link/
 * cotización cuando el flujo automático no lo hizo. Requiere ventana de 24h
 * abierta (último mensaje del cliente < 24h), como cualquier texto libre.
 *
 * También deja el mensaje en el historial (appendAssistantV3) para que Vicky
 * tenga el contexto si el cliente responde.
 *
 * Auth: header x-cron-secret == vic_kv.followup_cron_secret, o ?key=/Bearer ==
 * CRON_SECRET. Body: { "contact": "<fono>", "text": "<mensaje>" }.
 */

import { NextResponse } from "next/server"
import { sendBotmakerMessage, sendBotmakerTemplate } from "@/lib/botmaker-push-v3"
import { appendAssistantV3, getFollowupCronSecret } from "@/lib/supabase-persistence-v3"

export const dynamic = "force-dynamic"
export const maxDuration = 30

const CRON_SECRET = (process.env.CRON_SECRET || "").trim()

// Envío por la Cloud API de Meta directo (línea WHATSAPP_PHONE_NUMBER_ID), para
// la línea registrada directamente en Meta (distinta de la de Botmaker que usa
// el agente conversacional). Mismo requisito de ventana de 24h para texto libre.
async function sendCloudApi(
  to: string,
  text: string,
): Promise<{ ok: boolean; status?: number; response?: unknown; error?: string }> {
  const accessToken = (process.env.WHATSAPP_ACCESS_TOKEN || "").trim()
  const phoneNumberId = (process.env.WHATSAPP_PHONE_NUMBER_ID || "").trim()
  if (!accessToken || !phoneNumberId) {
    return { ok: false, error: "WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID no configurados" }
  }
  const res = await fetch(`https://graph.facebook.com/v22.0/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text } }),
    cache: "no-store",
  })
  const response = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, response }
}

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
  let body: {
    contact?: string
    text?: string
    via?: string
    template?: string
    params?: Record<string, string>
    /** Línea por la que sale (channelId o número, ej. "573181070737"). Default: línea CL. */
    channel?: string
  } = {}
  try {
    body = (await req.json()) as typeof body
  } catch {
    return NextResponse.json({ ok: false, error: "body JSON inválido" }, { status: 400 })
  }
  const contact = (body.contact || "").trim()
  const text = (body.text || "").trim()

  // Modo PLANTILLA (HSM vía Botmaker): body = { via:"template", contact, template, params }.
  // Para pruebas de plantillas aprobadas y rescates proactivos fuera de 24h.
  if ((body.via || "").toLowerCase() === "template") {
    const template = (body.template || "").trim()
    if (!contact || !template) {
      return NextResponse.json({ ok: false, error: "contact y template requeridos" }, { status: 400 })
    }
    const channel = (body.channel || "").trim() || undefined
    const ok = await sendBotmakerTemplate(contact, template, body.params || {}, channel).catch(() => false)
    return NextResponse.json(
      { ok, via: "template", contact, template, channel: channel || "default(CL)" },
      { status: ok ? 200 : 502 },
    )
  }
  // via=cloud → línea de Meta directa (Cloud API). Por defecto, Botmaker (agente).
  const via = (body.via || new URL(req.url).searchParams.get("via") || "botmaker").trim().toLowerCase()
  if (!contact || !text) {
    return NextResponse.json({ ok: false, error: "contact y text requeridos" }, { status: 400 })
  }
  if (via === "cloud" || via === "meta") {
    const result = await sendCloudApi(contact.replace(/\D/g, ""), text)
    return NextResponse.json({ via: "cloud", contact, ...result }, { status: result.ok ? 200 : 502 })
  }
  const ok = await sendBotmakerMessage(contact, text).catch(() => false)
  if (ok) {
    await appendAssistantV3(contact, text).catch(() => {})
  }
  return NextResponse.json({ ok, via: "botmaker", contact })
}
