/**
 * Cron: barrido de leads a nombre de Vicky (Lalo 09-sep, "nada queda a nombre
 * de Vicky mucho tiempo"). Ver lib/barrido-leads-vicky.ts.
 *
 * GET ?key=<CRON_SECRET> | x-cron-secret: <kv followup_cron_secret>
 *   &dry=1      lista qué haría, sin tocar Zoho ni candados
 *   &max=N      máximo de leads a procesar por pasada (default 10)
 *   &horas=N    edad mínima en horas (default 24)
 * Despachado por JOBS_HUERFANOS cada 60'. Apagar sin deploy: vic_kv
 * `barrido_leads_vicky` = "off".
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"
import { barrerLeadsVicky } from "@/lib/barrido-leads-vicky"

export const dynamic = "force-dynamic"
export const maxDuration = 120

const CRON_SECRET = (process.env.CRON_SECRET || "").trim()

async function authorized(req: Request): Promise<boolean> {
  const xcron = (req.headers.get("x-cron-secret") || "").trim()
  if (xcron) {
    const expected = await getFollowupCronSecret().catch(() => "")
    if (expected && xcron === expected) return true
  }
  const key = (new URL(req.url).searchParams.get("key") || "").trim()
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim()
  if (CRON_SECRET && (key === CRON_SECRET || bearer === CRON_SECRET)) return true
  if (key) {
    const expected = await getFollowupCronSecret().catch(() => "")
    if (expected && key === expected) return true
  }
  return false
}

export async function GET(req: Request): Promise<Response> {
  if (!(await authorized(req))) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  const sp = new URL(req.url).searchParams
  const dry = sp.get("dry") === "1"
  const max = Number(sp.get("max") || 10) || 10
  const minHoras = Number(sp.get("horas") || 0) || undefined
  const t0 = Date.now()
  try {
    const r = await barrerLeadsVicky({ dry, max, minHoras })
    const resumen = r.resultados.reduce<Record<string, number>>((acc, x) => {
      acc[x.accion] = (acc[x.accion] || 0) + 1
      return acc
    }, {})
    console.log(`[barrido-leads] revisados=${r.revisados} ${JSON.stringify(resumen)} dry=${dry} ${Date.now() - t0}ms`)
    return NextResponse.json({ ok: true, dry, revisados: r.revisados, resumen, resultados: r.resultados, ms: Date.now() - t0 })
  } catch (e) {
    console.error("[barrido-leads] falló:", e instanceof Error ? e.message : e)
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
