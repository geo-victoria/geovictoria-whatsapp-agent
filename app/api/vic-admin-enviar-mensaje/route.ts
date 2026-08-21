/**
 * ADMIN — enviar UN mensaje puntual como Vicky (21-ago, caso COT789
 * Ciberlabs: la emisión salió sin el link en el chat y hubo que remediar a
 * mano). Envía el texto por Botmaker al contacto y lo APPENDEA al historial
 * v3 — así el modelo sabe que ya se entregó y los guardrails reconocen el
 * link como "conocido" en los turnos siguientes.
 *
 * POST {contact, texto} con auth de cron (x-cron-secret / Bearer / ?key=).
 * Herramienta de operación puntual: no la usa ningún flujo automático.
 */

import { NextResponse } from "next/server"
import { sendBotmakerMessage } from "@/lib/botmaker-push-v3"
import { appendAssistantV3, getFollowupCronSecret } from "@/lib/supabase-persistence-v3"

export const dynamic = "force-dynamic"
export const maxDuration = 30

export async function POST(req: Request): Promise<NextResponse> {
  const secreto = await getFollowupCronSecret()
  const url = new URL(req.url)
  const auth = req.headers.get("authorization") || ""
  const entregado =
    req.headers.get("x-cron-secret") || (auth.startsWith("Bearer ") ? auth.slice(7) : "") || url.searchParams.get("key") || ""
  if (!secreto || entregado !== secreto) {
    return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  }
  const body = (await req.json().catch(() => ({}))) as { contact?: string; texto?: string }
  const contact = String(body.contact || "").replace(/\D/g, "")
  const texto = String(body.texto || "").trim()
  if (!/^\d{9,15}$/.test(contact) || !texto) {
    return NextResponse.json({ ok: false, error: "contact (dígitos) y texto son obligatorios" }, { status: 400 })
  }
  const enviado = await sendBotmakerMessage(contact, texto).catch(() => false)
  if (!enviado) {
    return NextResponse.json({ ok: false, error: "Botmaker no aceptó el envío (¿ventana 24h cerrada?)" }, { status: 502 })
  }
  await appendAssistantV3(contact, texto).catch(() => {})
  console.log(`[admin-enviar-mensaje] mensaje manual enviado a ${contact} (${texto.length} chars)`)
  return NextResponse.json({ ok: true, contact })
}
