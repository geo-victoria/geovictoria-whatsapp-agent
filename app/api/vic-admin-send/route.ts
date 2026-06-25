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
  let body: { contact?: string; text?: string } = {}
  try {
    body = (await req.json()) as { contact?: string; text?: string }
  } catch {
    return NextResponse.json({ ok: false, error: "body JSON inválido" }, { status: 400 })
  }
  const contact = (body.contact || "").trim()
  const text = (body.text || "").trim()
  if (!contact || !text) {
    return NextResponse.json({ ok: false, error: "contact y text requeridos" }, { status: 400 })
  }
  const ok = await sendBotmakerMessage(contact, text).catch(() => false)
  if (ok) {
    await appendAssistantV3(contact, text).catch(() => {})
  }
  return NextResponse.json({ ok, contact })
}
