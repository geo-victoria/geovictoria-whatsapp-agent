/**
 * WEBHOOK DE SAMU → espejo en Supabase + relay al Zoho Flow (Lalo 25-ago,
 * "¿podemos hacer un espejo de samu en supabase?").
 *
 * Samu.ai empuja cada reunión/llamada analizada a UNA URL de webhook. Hoy esa
 * URL apunta a un Zoho Flow; este endpoint se pone EN MEDIO sin romper nada:
 *
 *   Samu → vic-samu-webhook → (1) guarda el evento crudo en vic_samu_eventos
 *                           → (2) reenvía el MISMO payload al Zoho Flow
 *                                (kv `samu_forward_url`, best-effort)
 *
 * Con el espejo en Supabase la data de Samu (llamadas SDR con teléfono,
 * reuniones del roster con score/tareas/deal) queda cruzable con los
 * contactos de Vicky: señal "el vendedor llamó/se reunió" para el candado
 * v3 y el SLA, paneles del dash, y compromisos pendientes en la Cartera.
 *
 * Auth: header `x-samu-secret` == vic_kv `samu_webhook_secret` (Samu permite
 * headers personalizados en su config de webhook). Sin match → 401 y no se
 * guarda ni reenvía nada.
 *
 * Siempre 200 tras autenticar: un fallo nuestro de persistencia o del relay
 * no debe hacer que Samu reintente en tormenta ni marque la integración
 * caída. Lo no-reenviado queda marcado (reenviado_zoho=false) y se puede
 * re-despachar a mano.
 *
 * CONFIGURACIÓN EN SAMU (dashboard → API y desarrollo → Webhooks):
 *   URL:    https://<agente>/api/vic-samu-webhook
 *   Header: x-samu-secret: <vic_kv samu_webhook_secret>
 */

import { NextResponse } from "next/server"
import { getKvValue, getFollowupCronSecret } from "@/lib/supabase-persistence-v3"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()

function hSb(): Record<string, string> {
  return { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" }
}

/** id de la reunión, donde sea que Samu lo haya puesto (payload aún sin
 * contrato conocido — se descubre con los primeros eventos reales). */
function extraerMeetingId(p: unknown): string {
  if (!p || typeof p !== "object") return ""
  const o = p as Record<string, unknown>
  for (const k of ["meetingId", "meeting_id", "id", "_id"]) {
    const v = o[k]
    if (typeof v === "string" && v.trim()) return v.trim()
  }
  const anidado = o.meeting || o.data || o.event
  if (anidado && typeof anidado === "object") {
    const a = anidado as Record<string, unknown>
    for (const k of ["meetingId", "meeting_id", "id", "_id"]) {
      const v = a[k]
      if (typeof v === "string" && v.trim()) return v.trim()
    }
  }
  return ""
}

export async function POST(req: Request): Promise<Response> {
  const secreto = (req.headers.get("x-samu-secret") || "").trim()
  const esperado = ((await getKvValue("samu_webhook_secret").catch(() => "")) || "").trim()
  if (!esperado || secreto !== esperado) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }

  const crudo = await req.text().catch(() => "")
  let payload: unknown = null
  try {
    payload = JSON.parse(crudo)
  } catch {
    payload = { _raw: crudo.slice(0, 100000) }
  }
  const meetingId = extraerMeetingId(payload)

  // 1. Espejo durable (primero: si el relay falla, el evento ya está).
  let guardado = false
  let filaId: number | null = null
  try {
    const ins = await fetch(`${SUPABASE_URL}/rest/v1/vic_samu_eventos`, {
      method: "POST",
      headers: { ...hSb(), Prefer: "return=representation" },
      body: JSON.stringify([{ meeting_id: meetingId || null, payload }]),
      cache: "no-store",
    })
    if (ins.ok) {
      guardado = true
      const filas = ((await ins.json().catch(() => [])) as Array<{ id?: number }>) || []
      filaId = filas[0]?.id ?? null
    }
  } catch (e) {
    console.error("[samu-webhook] persistencia falló:", e instanceof Error ? e.message : e)
  }

  // 2. Relay al Zoho Flow que ya consumía este webhook (no romper lo que hay).
  let reenviado = false
  try {
    const destino = ((await getKvValue("samu_forward_url").catch(() => "")) || "").trim()
    if (destino) {
      const r = await fetch(destino, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: crudo || JSON.stringify(payload),
        cache: "no-store",
        signal: AbortSignal.timeout(15000),
      })
      reenviado = r.ok
      if (!r.ok) console.warn(`[samu-webhook] relay a Zoho Flow devolvió ${r.status}`)
    }
  } catch (e) {
    console.warn("[samu-webhook] relay a Zoho Flow falló:", e instanceof Error ? e.message : e)
  }
  if (guardado && reenviado && filaId !== null) {
    await fetch(`${SUPABASE_URL}/rest/v1/vic_samu_eventos?id=eq.${filaId}`, {
      method: "PATCH",
      headers: { ...hSb(), Prefer: "return=minimal" },
      body: JSON.stringify({ reenviado_zoho: true }),
      cache: "no-store",
    }).catch(() => undefined)
  }

  console.log(`[samu-webhook] evento meeting=${meetingId || "?"} guardado=${guardado} relay=${reenviado}`)
  return NextResponse.json({ ok: true, guardado, reenviado })
}

/** Inspección admin: últimos eventos recibidos (auth cron). */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const key = (url.searchParams.get("key") || req.headers.get("x-cron-secret") || "").trim()
  const cronEnv = (process.env.CRON_SECRET || "").trim()
  const cronKv = ((await getFollowupCronSecret().catch(() => "")) || "").trim()
  if (!key || (key !== cronEnv && key !== cronKv)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 5) || 5, 1), 25)
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/vic_samu_eventos?select=id,recibido_at,meeting_id,reenviado_zoho&order=recibido_at.desc&limit=${limit}`,
    { headers: hSb(), cache: "no-store" },
  ).catch(() => null)
  const filas = r?.ok ? await r.json().catch(() => []) : []
  return NextResponse.json({ ok: true, eventos: filas })
}
