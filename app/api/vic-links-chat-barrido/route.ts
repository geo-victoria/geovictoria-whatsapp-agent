/**
 * Cron: link a la conversación de Botmaker en tratos y leads de Vicky
 * (Lalo 26-sep). Ver lib/barrido-links-chat.ts.
 *
 * GET ?key=<CRON_SECRET> | x-cron-secret: <kv followup_cron_secret>
 *   &dry=1   lista qué marcaría, sin escribir
 *   &max=N   registros a marcar por pasada (default 40)
 *   &dias=N  antigüedad máxima de los registros (default 120)
 * Despachado por JOBS_HUERFANOS cada 30'.
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"
import { barrerLinksChat } from "@/lib/barrido-links-chat"

export const dynamic = "force-dynamic"
export const maxDuration = 120

const CRON_SECRET = (process.env.CRON_SECRET || "").trim()

async function authorized(req: Request): Promise<boolean> {
  const xcron = (req.headers.get("x-cron-secret") || "").trim()
  const key = (new URL(req.url).searchParams.get("key") || "").trim()
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim()
  if (CRON_SECRET && (key === CRON_SECRET || bearer === CRON_SECRET)) return true
  const expected = await getFollowupCronSecret().catch(() => "")
  return Boolean(expected) && (xcron === expected || key === expected)
}

export async function GET(req: Request): Promise<Response> {
  if (!(await authorized(req))) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  const sp = new URL(req.url).searchParams
  const dry = sp.get("dry") === "1"
  const max = Number(sp.get("max") || 40) || 40
  const dias = Number(sp.get("dias") || 120) || 120
  try {
    const r = await barrerLinksChat({ dry, max, dias })
    const resumen = r.resultados.reduce<Record<string, number>>((acc, x) => {
      acc[x.accion] = (acc[x.accion] || 0) + 1
      return acc
    }, {})
    console.log(`[links-chat] candidatos=${r.candidatos} ${JSON.stringify(resumen)} dry=${dry}`)
    return NextResponse.json({ ok: true, dry, candidatos: r.candidatos, resumen, resultados: r.resultados.slice(0, 80) })
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
