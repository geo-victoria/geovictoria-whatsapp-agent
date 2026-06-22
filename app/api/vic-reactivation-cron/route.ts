/**
 * Cron de REACTIVACIÓN de leads tibios (fuera de la ventana de 24h).
 *
 * Distinto del seguimiento normal (vic-followup-cron, que corre DENTRO de 24h con
 * texto libre): este reactiva a quienes se enfriaron y reabre la conversación con
 * una PLANTILLA HSM aprobada por Meta (única vía permitida fuera de 24h). Dos
 * segmentos:
 *   - "preform": vio un estimado referencial pero NO llegó a cotización formal.
 *   - "cotizacion": recibió el link + PDF (cotización formal) y NO la aceptó/pagó.
 *
 * Salvaguardas: respeta opt-out, no toca ciclos activos, excluye cotizaciones ya
 * aceptadas/pagadas (consulta Zoho), y tope de frecuencia por conversación.
 *
 * SEGURO POR DEFECTO: si no hay nombre de plantilla configurado (REACTIVATION_
 * TEMPLATE_*), ese segmento NO envía nada. Así se puede desplegar ANTES de tener
 * las plantillas aprobadas.
 *
 * Auth: Authorization: Bearer ${CRON_SECRET} (o ?key=${CRON_SECRET}).
 */

import { NextResponse } from "next/server"
import { sendBotmakerTemplate } from "@/lib/botmaker-push-v3"
import { getZohoAccessToken } from "@/lib/zoho-token"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const CRON_SECRET = (process.env.CRON_SECRET || "").trim()

// Plantillas HSM aprobadas (nombre/ruleNameOrId en Botmaker). Vacío = segmento off.
const TPL_PREFORM = (process.env.REACTIVATION_TEMPLATE_PREFORM || "").trim()
const TPL_QUOTE = (process.env.REACTIVATION_TEMPLATE_QUOTE || "").trim()
// Parámetros de la ventana/tope (todo configurable por env).
const COLD_AFTER_H = Number(process.env.REACTIVATION_COLD_AFTER_HOURS || 48)
const MAX_AGE_D = Number(process.env.REACTIVATION_MAX_AGE_DAYS || 14)
const MAX_REACT = Number(process.env.REACTIVATION_MAX || 2)
const MIN_GAP_H = Number(process.env.REACTIVATION_MIN_GAP_HOURS || 72)
const BATCH = Number(process.env.REACTIVATION_BATCH || 25)
const QUOTE_MODULE = (process.env.ZOHO_QUOTE_MODULE || "Cotizaciones_GeoVictoria").trim()

type Row = {
  id: string
  contact: string
  formal_quote_id: string | null
  reactivation_count: number | null
  reactivation_at: string | null
  followup_closed_reason: string | null
  followup_status: string | null
}

async function supa(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
    cache: "no-store",
  })
}

function authorized(req: Request): boolean {
  if (!CRON_SECRET) return false
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim()
  if (bearer === CRON_SECRET) return true
  const key = (new URL(req.url).searchParams.get("key") || "").trim()
  return key === CRON_SECRET
}

// Devuelve el set de quoteIds que NO se deben reactivar (ya aceptadas/pagadas/
// cerradas/rechazadas). Conservador: si la consulta a Zoho falla, marca el chunk
// completo como "no reactivar" para no escribirle a un cliente que ya cerró.
async function quoteIdsNoAccionables(quoteIds: string[]): Promise<Set<string>> {
  const skip = new Set<string>()
  if (!quoteIds.length) return skip
  const apiDomain = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
  let token = ""
  try {
    token = await getZohoAccessToken()
  } catch {
    for (const id of quoteIds) skip.add(id)
    return skip
  }
  for (let i = 0; i < quoteIds.length; i += 50) {
    const chunk = quoteIds.slice(i, i + 50)
    try {
      const ids = chunk.map((id) => `'${id}'`).join(",")
      const res = await fetch(`${apiDomain}/crm/v3/coql`, {
        method: "POST",
        headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          select_query: `select id, Estado_Cotizacion from ${QUOTE_MODULE} where id in (${ids}) limit 200`,
        }),
        cache: "no-store",
      })
      if (!res.ok) {
        for (const id of chunk) skip.add(id)
        continue
      }
      const data = await res.json()
      for (const r of data?.data || []) {
        const e = String(r?.Estado_Cotizacion || "").toLowerCase()
        if (e.includes("acept") || e.includes("pagad") || e.includes("ganad") || e.includes("cerrad") || e.includes("rechaz")) {
          skip.add(String(r.id))
        }
      }
    } catch {
      for (const id of chunk) skip.add(id)
    }
  }
  return skip
}

export async function GET(req: Request): Promise<Response> {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }
  if (!TPL_PREFORM && !TPL_QUOTE) {
    return NextResponse.json({ ok: true, skipped: "sin plantillas configuradas (REACTIVATION_TEMPLATE_*)" })
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return NextResponse.json({ ok: false, error: "Supabase no configurado" }, { status: 503 })
  }

  const now = Date.now()
  const coldBefore = new Date(now - COLD_AFTER_H * 3600e3).toISOString()
  const maxAgeAfter = new Date(now - MAX_AGE_D * 86400e3).toISOString()
  const gapBefore = new Date(now - MIN_GAP_H * 3600e3).toISOString()

  // Candidatos: enfriados (last_user_at en la ventana), bajo el tope, con datos
  // para clasificar. Los filtros finos (opt-out, ciclo activo, gap) se aplican en JS.
  const res = await supa(
    `vic_v3_conversations?last_user_at=lte.${coldBefore}&last_user_at=gte.${maxAgeAfter}` +
    `&reactivation_count=lt.${MAX_REACT}` +
    `&select=id,contact,formal_quote_id,reactivation_count,reactivation_at,followup_closed_reason,followup_status` +
    `&order=last_user_at.asc&limit=400`,
  )
  const rows = (res.ok ? await res.json() : []) as Row[]
  const cand = rows.filter(
    (r) =>
      r.contact &&
      r.followup_closed_reason !== "opt_out" &&
      r.followup_status !== "activo" &&
      (!r.reactivation_at || r.reactivation_at <= gapBefore),
  )

  // Segmento "cotizacion": tiene formal_quote_id y NO está aceptada/pagada.
  let segCot: Row[] = []
  if (TPL_QUOTE) {
    const conQuote = cand.filter((r) => !!r.formal_quote_id)
    const skip = await quoteIdsNoAccionables(conQuote.map((r) => r.formal_quote_id as string))
    segCot = conQuote.filter((r) => !skip.has(String(r.formal_quote_id)))
  }

  // Segmento "preform": SIN cotización formal pero con un estimado mostrado
  // (marcador "recurrente" en un mensaje del asistente — el preform de precios).
  let segPre: Row[] = []
  if (TPL_PREFORM) {
    const sinQuote = cand.filter((r) => !r.formal_quote_id)
    if (sinQuote.length) {
      const ids = sinQuote.map((r) => r.id).join(",")
      const mr = await supa(
        `vic_v3_messages?conversation_id=in.(${ids})&role=eq.assistant&content=ilike.*recurrente*&select=conversation_id`,
      )
      const conPreform = new Set(
        (mr.ok ? ((await mr.json()) as Array<{ conversation_id: string }>) : []).map((x) => x.conversation_id),
      )
      segPre = sinQuote.filter((r) => conPreform.has(r.id))
    }
  }

  let enviados = 0
  async function enviar(list: Row[], template: string, segmento: string) {
    for (const r of list) {
      if (enviados >= BATCH) break
      const ok = await sendBotmakerTemplate(r.contact, template, {}).catch(() => false)
      if (!ok) continue
      await supa(`vic_v3_conversations?id=eq.${r.id}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          reactivation_at: new Date().toISOString(),
          reactivation_count: (r.reactivation_count || 0) + 1,
        }),
      }).catch(() => {})
      enviados++
      console.log(`[reactivation] ${segmento} → ${r.contact}`)
    }
  }

  // Prioriza cotización (lead más caliente) y luego preform.
  if (TPL_QUOTE) await enviar(segCot, TPL_QUOTE, "cotizacion")
  if (TPL_PREFORM) await enviar(segPre, TPL_PREFORM, "preform")

  return NextResponse.json({
    ok: true,
    candidatos: cand.length,
    segmento_cotizacion: segCot.length,
    segmento_preform: segPre.length,
    enviados,
  })
}
