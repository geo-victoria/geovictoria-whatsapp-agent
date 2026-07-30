/**
 * CRON — Reconciliación CRM por hitos (Lalo 30-jul). Complementa el trigger
 * del agent-loop: el trigger da inmediatez pero corre fire-and-forget dentro
 * de la invocación serverless (se puede perder si el proceso muere), y hay
 * hitos que NO pasan por tools:
 *
 *   - preform/precio visto → detectable por pref_escalon / pref_params /
 *     pref_quote_id / formal_quote_id en vic_v3_conversations.
 *   - reunión REALIZADA → vic_v3_meetings con start_at ya pasado (la tool
 *     solo ve el agendamiento, no la realización).
 *
 * Barre las conversaciones con actividad reciente (ventana solapada con la
 * cadencia del cron para no dejar hoyos) y ejecuta la MISMA función
 * idempotente del trigger: el stage es un piso y nunca retrocede, así que
 * procesar dos veces el mismo hito no hace nada. Ocurre 100% por detrás:
 * jamás toca la conversación ni envía mensajes.
 *
 * Los hitos "aceptada" (→6) y "onboarding listo" (→7) ya los reconcilia
 * vic-deal-stage-cron cada hora — acá no se duplican.
 *
 * DETRÁS DEL FLAG VICKY_CRM_HITOS_ENABLED (el mismo del trigger): apagado
 * responde {ok:true, skipped} sin tocar nada.
 *
 * Auth: Vercel Cron manda Bearer CRON_SECRET; manual: x-cron-secret ==
 * vic_kv.followup_cron_secret o ?key=CRON_SECRET (patrón del repo).
 */

import { NextResponse } from "next/server"
import { sincronizarHitoCrm, type Hito, type DatosConversacion } from "@/lib/crm-hitos"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"

export const dynamic = "force-dynamic"
export const maxDuration = 120

const CRON_SECRET = (process.env.CRON_SECRET || "").trim()
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()

// Ventana de barrido: 2h con cron horario = cada conversación se revisa al
// menos dos veces (solape a propósito; la idempotencia absorbe el doble).
const VENTANA_MS = 2 * 60 * 60 * 1000
const MAX_CONTACTOS_POR_TICK = 100

async function authorized(req: Request): Promise<boolean> {
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim()
  if (CRON_SECRET && bearer === CRON_SECRET) return true
  const key = (new URL(req.url).searchParams.get("key") || "").trim()
  if (CRON_SECRET && key === CRON_SECRET) return true
  const xcron = (req.headers.get("x-cron-secret") || "").trim()
  if (xcron) {
    const expected = await getFollowupCronSecret().catch(() => "")
    if (expected && xcron === expected) return true
  }
  return false
}

async function supa<T>(path: string): Promise<T[]> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return []
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    cache: "no-store",
  })
  if (!res.ok) return []
  return ((await res.json().catch(() => [])) as T[]) || []
}

export async function GET(req: Request) {
  if (!(await authorized(req))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }
  if ((process.env.VICKY_CRM_HITOS_ENABLED || "").trim() !== "on") {
    return NextResponse.json({ ok: true, skipped: "VICKY_CRM_HITOS_ENABLED off" })
  }

  const desde = new Date(Date.now() - VENTANA_MS).toISOString()
  const ahora = new Date().toISOString()

  // Conversaciones recientes con señal de preform (precio visto o formal).
  const conversaciones = await supa<{
    contact: string
    pref_escalon: number | null
    pref_quote_id: string | null
    formal_quote_id: string | null
    pref_params: unknown
  }>(
    `vic_v3_conversations?updated_at=gte.${encodeURIComponent(desde)}` +
      `&select=contact,pref_escalon,pref_quote_id,formal_quote_id,pref_params` +
      `&limit=${MAX_CONTACTOS_POR_TICK}`,
  )

  // Reuniones recién REALIZADAS (agendadas cuyo inicio ya pasó, dentro de la ventana).
  const reuniones = await supa<{ contact: string; start_at: string }>(
    `vic_v3_meetings?status=eq.scheduled&start_at=gte.${encodeURIComponent(desde)}` +
      `&start_at=lte.${encodeURIComponent(ahora)}&select=contact,start_at&limit=${MAX_CONTACTOS_POR_TICK}`,
  )

  // Un hito por contacto: el MAYOR piso detectado (los pisos son acumulativos).
  // Los pref_params del preform traen datos frescos (userCount) que la
  // sincronización usa para el enriquecimiento aditivo del lead.
  const hitoPorContacto = new Map<string, { hito: Hito; datos: DatosConversacion }>()
  for (const r of reuniones) {
    if (r.contact) hitoPorContacto.set(r.contact, { hito: "reunion_realizada", datos: {} })
  }
  for (const c of conversaciones) {
    const vioPreform = Boolean(
      c.pref_escalon !== null || c.pref_quote_id || c.formal_quote_id || c.pref_params,
    )
    if (!vioPreform || !c.contact) continue
    const userCount = Number((c.pref_params as { userCount?: unknown } | null)?.userCount)
    hitoPorContacto.set(c.contact, {
      hito: "preform",
      datos: Number.isFinite(userCount) && userCount > 0 ? { empleados: Math.round(userCount) } : {},
    })
  }

  const resultados: Array<{ contact: string; hito: Hito }> = []
  for (const [contact, { hito, datos }] of hitoPorContacto) {
    await sincronizarHitoCrm(contact, hito, datos)
    resultados.push({ contact, hito })
  }

  return NextResponse.json({
    ok: true,
    ventana_desde: desde,
    conversaciones_revisadas: conversaciones.length,
    reuniones_realizadas: reuniones.length,
    sincronizados: resultados.length,
    detalle: resultados,
  })
}
