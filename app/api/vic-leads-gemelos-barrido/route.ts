/**
 * Cron: leads gemelos (Lalo 01-oct, "dale con el punto 2"). Tratos creados por
 * Vicky (agente o cotizador) con dueño humano → se cierran los leads abiertos
 * del mismo teléfono y se avisa a su dueño. Ver lib/leads-gemelos.ts.
 *
 * GET ?key=<CRON_SECRET> | x-cron-secret: <kv followup_cron_secret>
 *   &dry=1      lista qué haría, sin tocar Zoho ni candados
 *   &horas=N    ventana de creación de los tratos (default 72)
 *   &max=N      tratos a revisar por pasada (default 40)
 *   &deal=<id>&fono=<fono>  procesa un solo trato
 * Despachado por JOBS_HUERFANOS cada 60'. Apagar sin deploy: vic_kv
 * `leads_gemelos` = "off".
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret, getKvValue } from "@/lib/supabase-persistence-v3"
import { barrerLeadsGemelos, cerrarLeadsGemelos } from "@/lib/leads-gemelos"

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
  const t0 = Date.now()
  try {
    const deal = (sp.get("deal") || "").trim()
    const fono = (sp.get("fono") || "").trim()
    if (deal && fono) {
      const r = await cerrarLeadsGemelos({ fono, dealId: deal, dry })
      return NextResponse.json({ ok: true, dry, ...r, ms: Date.now() - t0 })
    }
    const apagado = ((await getKvValue("leads_gemelos").catch(() => null)) || "").trim().toLowerCase() === "off"
    if (apagado && !dry) return NextResponse.json({ ok: true, apagado: true })
    const r = await barrerLeadsGemelos({
      dry,
      horas: Number(sp.get("horas") || 0) || undefined,
      max: Number(sp.get("max") || 0) || undefined,
    })
    console.log(`[leads-gemelos] revisados=${r.revisados} conGemelos=${r.conGemelos} dry=${dry} ${Date.now() - t0}ms`)
    return NextResponse.json({ ok: true, dry, ...r, ms: Date.now() - t0 })
  } catch (e) {
    console.error("[leads-gemelos] falló:", e instanceof Error ? e.message : e)
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
