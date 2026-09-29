/**
 * Endpoint ADMIN: POST /api/vic-admin-asignar-chat
 *
 * Asigna en Botmaker la conversación de uno o varios contactos al agente
 * (ejecutivo) dueño del registro, con la MISMA función que usa el ptv-cron
 * (`asignarConversacionAlDueno`: flujo por id, guardas de no-asignables,
 * verificación de que el agentId cambió). Nació el 29-sep para la orden de
 * Lalo "todas las conversaciones de deals de Mónica asígnalas a Mónica en
 * Botmaker" — hasta entonces no había puerta admin y la única forma era el
 * cron. Body: { contact?: string, contacts?: string[], ownerEmail: string,
 * dry?: boolean }. Auth: x-cron-secret (kv followup) o ?key=/Bearer CRON_SECRET.
 *
 * OJO (regla 07-sep): un chat asignado a un agente en Botmaker deja a Vicky
 * MUDA en ese chat. Es una decisión de quien llama, no del endpoint.
 */
import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"

export const dynamic = "force-dynamic"
export const maxDuration = 300

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
  if (!(await authorized(req))) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  const body = (await req.json().catch(() => ({}))) as {
    contact?: string
    contacts?: string[]
    ownerEmail?: string
    dry?: boolean
  }
  const ownerEmail = String(body.ownerEmail || "").trim().toLowerCase()
  const contacts = Array.from(
    new Set(
      ([] as string[])
        .concat(body.contacts || [], body.contact ? [body.contact] : [])
        .map((c) => String(c || "").replace(/\D/g, ""))
        .filter((c) => c.length >= 10),
    ),
  )
  if (!ownerEmail || contacts.length === 0) {
    return NextResponse.json({ ok: false, error: "ownerEmail y contact(s) requeridos" }, { status: 400 })
  }
  if (contacts.length > 60) {
    return NextResponse.json({ ok: false, error: "máximo 60 contactos por llamada" }, { status: 400 })
  }
  const { asignarConversacionAlDueno, leerChat, chatRefDeContacto } = await import("@/lib/botmaker-agentes")
  const t0 = Date.now()
  const resultados: Array<Record<string, unknown>> = []
  for (const contact of contacts) {
    if (Date.now() - t0 > 270_000) {
      resultados.push({ contact, ok: false, motivo: "presupuesto_agotado" })
      continue
    }
    if (body.dry) {
      const ref = chatRefDeContacto(contact)
      const chat = ref ? await leerChat(ref).catch(() => null) : null
      resultados.push({
        contact,
        ok: Boolean(chat),
        dry: true,
        chatRef: ref,
        agenteActual: (chat as { agentId?: string } | null)?.agentId || null,
      })
      continue
    }
    const r = await asignarConversacionAlDueno(contact, ownerEmail).catch((e) => ({
      ok: false,
      motivo: `excepcion: ${String((e as Error)?.message || e)}`,
    }))
    resultados.push({ contact, ...(r as Record<string, unknown>) })
  }
  const ok = resultados.filter((r) => r.ok).length
  return NextResponse.json({ ok: true, ownerEmail, total: contacts.length, asignados: ok, resultados })
}
