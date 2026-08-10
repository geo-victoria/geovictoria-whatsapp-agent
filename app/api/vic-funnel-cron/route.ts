/**
 * Cron de análisis del embudo. Corre cada hora (Vercel Cron) y reclasifica las
 * conversaciones V3 nuevas o modificadas desde el último análisis, poblando
 * vic_v3_conversation_analysis con Claude Sonnet. El dashboard /api/vic-funnel
 * lee esa tabla.
 *
 * Incremental: solo re-analiza una conversación si cambió (updated_at posterior
 * al analyzed_at). Excluye contactos de prueba. Procesa hasta `limit` por
 * invocación (default 25) para acotar tiempo/costo; el resto se toma en la
 * próxima corrida. Para el backfill inicial se puede llamar varias veces o con
 * ?limit mayor.
 *
 * Auth:
 *   - Vercel Cron envía `Authorization: Bearer ${CRON_SECRET}` (env CRON_SECRET).
 *   - Manual: `?key=${VIC_FUNNEL_KEY}`.
 *
 * GET /api/vic-funnel-cron[?key=...&limit=25&all=1]
 */

import {
  analyzeConversation,
  isTestContact,
  metricsContactSet,
  type TranscriptMessage,
} from "@/lib/funnel-analysis"

export const dynamic = "force-dynamic"
export const maxDuration = 120

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const CRON_SECRET = (process.env.CRON_SECRET || "").trim()
const FUNNEL_KEY = (process.env.VIC_FUNNEL_KEY || "").trim()
const ANTHROPIC_KEY = (process.env.ANTHROPIC_API_KEY || "").trim()

const HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
}

async function sb<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { ...HEADERS, ...(init.headers || {}) },
    cache: "no-store",
  })
  if (!res.ok) throw new Error(`Supabase ${res.status} en ${path}: ${(await res.text()).slice(0, 200)}`)
  const ct = res.headers.get("content-type") || ""
  return (ct.includes("application/json") ? await res.json() : null) as T
}

type ConvRow = {
  id: string
  contact: string
  updated_at: string | null
}
type AnalRow = { conversation_id: string; analyzed_at: string }

function authorized(req: Request, key: string): boolean {
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim()
  if (CRON_SECRET && bearer === CRON_SECRET) return true
  if (FUNNEL_KEY && key === FUNNEL_KEY) return true
  return false
}

export async function GET(req: Request): Promise<Response> {
  const { searchParams } = new URL(req.url)
  if (!authorized(req, (searchParams.get("key") || "").trim())) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }
  if (!ANTHROPIC_KEY) {
    return Response.json({ ok: false, error: "ANTHROPIC_API_KEY no configurada" }, { status: 503 })
  }

  const limit = Math.min(Math.max(parseInt(searchParams.get("limit") || "25", 10) || 25, 1), 200)
  const forceAll = searchParams.get("all") === "1"
  const testSet = metricsContactSet()

  // Dos consultas simples (más robusto que el embed de PostgREST): conversaciones
  // + análisis existentes, y se cruzan en JS para saber cuáles re-analizar.
  const [convs, analyzed] = await Promise.all([
    sb<ConvRow[]>(`vic_v3_conversations?select=id,contact,updated_at&order=updated_at.desc.nullslast`),
    sb<AnalRow[]>(`vic_v3_conversation_analysis?select=conversation_id,analyzed_at`),
  ])
  const analyzedAt = new Map(analyzed.map((a) => [a.conversation_id, a.analyzed_at]))

  const pending = convs
    .filter((c) => !isTestContact(c.contact, testSet))
    .filter((c) => {
      if (forceAll) return true
      const an = analyzedAt.get(c.id)
      if (!an) return true
      const upd = c.updated_at ? Date.parse(c.updated_at) : 0
      return upd > Date.parse(an)
    })

  const batch = pending.slice(0, limit)
  let ok = 0
  let failed = 0
  const errors: string[] = []

  // Concurrencia acotada para no exceder maxDuration ni rate limits.
  const CONCURRENCY = 4
  for (let i = 0; i < batch.length; i += CONCURRENCY) {
    const slice = batch.slice(i, i + CONCURRENCY)
    await Promise.all(
      slice.map(async (c) => {
        try {
          const msgs = await sb<TranscriptMessage[]>(
            `vic_v3_messages?conversation_id=eq.${c.id}&select=role,content,at&order=at.asc&limit=200`,
          )
          if (!msgs || msgs.length === 0) return
          const lastAt = (msgs[msgs.length - 1] as { at?: string }).at || null
          const analysis = await analyzeConversation(
            msgs.map((m) => ({ role: m.role, content: m.content })),
            ANTHROPIC_KEY,
          )
          await sb(`vic_v3_conversation_analysis?on_conflict=conversation_id`, {
            method: "POST",
            headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
            body: JSON.stringify({
              conversation_id: c.id,
              contact: c.contact,
              grupo: analysis.grupo,
              sub_bucket: analysis.sub_bucket,
              cotizacion_outcome: analysis.cotizacion_outcome,
              motivo_no_cierre: analysis.motivo_no_cierre,
              es_cliente_actual: analysis.es_cliente_actual,
              resumen: analysis.resumen,
              accionable: analysis.accionable,
              confianza: analysis.confianza,
              hallazgos: analysis.hallazgos,
              msg_count: msgs.length,
              analyzed_at: new Date().toISOString(),
              last_message_at: lastAt,
            }),
          })
          ok++
        } catch (e) {
          failed++
          if (errors.length < 5) errors.push(`${c.contact}: ${String(e).slice(0, 120)}`)
        }
      }),
    )
  }

  return Response.json({
    ok: true,
    analizadas: ok,
    fallidas: failed,
    pendientes_restantes: Math.max(pending.length - batch.length, 0),
    total_reales: convs.filter((c) => !isTestContact(c.contact, testSet)).length,
    errores: errors,
  })
}
