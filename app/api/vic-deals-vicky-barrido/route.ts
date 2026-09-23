/**
 * Cron: barrido de DEALS a nombre de Vicky (Lalo 23-sep, "dale con el
 * barrido, ok con 2, 3 y 4"). Ver lib/barrido-deals-vicky.ts.
 *
 * GET ?key=<CRON_SECRET> | x-cron-secret: <kv followup_cron_secret>
 *   &dry=1           lista qué haría, sin tocar Zoho ni candados
 *   &max=N           máximo de deals a procesar por pasada (default 10)
 *   &horas=N         edad mínima del deal en horas (default 24)
 *   &horasAceptada=N horas de una aceptada sin pago antes de la tómbola (default 48)
 * Despachado por JOBS_HUERFANOS cada 60'. Apagar sin deploy: vic_kv
 * `barrido_deals_vicky` = "off".
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"
import { barrerDealsVicky } from "@/lib/barrido-deals-vicky"

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
  const horasAceptada = Number(sp.get("horasAceptada") || 0) || undefined
  const t0 = Date.now()
  try {
    const r = await barrerDealsVicky({ dry, max, minHoras, horasAceptada })
    const resumen = r.resultados.reduce<Record<string, number>>((acc, x) => {
      acc[x.accion] = (acc[x.accion] || 0) + 1
      return acc
    }, {})
    console.log(`[barrido-deals] revisados=${r.revisados} ${JSON.stringify(resumen)} dry=${dry} ${Date.now() - t0}ms`)
    const acciones = r.resultados.filter((x) => !["sin_accion", "omitido"].includes(x.accion))
    if (!dry && acciones.length) {
      try {
        const { avisarEquipoInterno } = await import("@/lib/alerta-interna")
        await avisarEquipoInterno(
          `🧹 Barrido de deals a nombre de Vicky: ${acciones.length} acción(es).\n` +
            acciones.map((x) => `• ${x.deal} (${x.pais}) — ${x.accion}: ${x.detalle}`).join("\n"),
        )
      } catch {
        /* best-effort */
      }
    }
    return NextResponse.json({ ok: true, dry, revisados: r.revisados, resumen, resultados: r.resultados, ms: Date.now() - t0 })
  } catch (e) {
    console.error("[barrido-deals] falló:", e instanceof Error ? e.message : e)
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
