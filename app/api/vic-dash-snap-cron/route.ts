/**
 * FOTO HORARIA DEL DASH (Lalo 19-ago, "toda la data se actualice cada una
 * hora para que no demore tanto en cargar").
 *
 * Regenera las fotos precalculadas del dash (vista principal + inbound)
 * pidiéndole a vic-funnel un render en vivo con ?fresh=1 — ese render, al
 * venir con llave máquina y sin filtros, se guarda solo en vic_kv
 * (dash_snap_main / dash_snap_inbound). Las cargas humanas sin filtros se
 * sirven desde la foto al instante; el botón "⟳ Actualizar dash" fuerza vivo.
 *
 * Corre vía despachador de huérfanos (~cada 60'). Auth: Bearer/?key= ==
 * CRON_SECRET (mismo patrón del resto de crons).
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"

export const dynamic = "force-dynamic"
export const maxDuration = 120

const CRON_SECRET = (process.env.CRON_SECRET || "").trim()
const FUNNEL_KEY = (process.env.VIC_FUNNEL_KEY || "").trim()

async function authorized(req: Request): Promise<boolean> {
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim()
  const xcron = (req.headers.get("x-cron-secret") || "").trim()
  const key = (new URL(req.url).searchParams.get("key") || "").trim()
  if (CRON_SECRET && [bearer, xcron, key].includes(CRON_SECRET)) return true
  // Secreto operativo de vic_kv (mismo patrón de los endpoints admin).
  const operativo = await getFollowupCronSecret().catch(() => "")
  return Boolean(operativo) && [bearer, xcron, key].includes(operativo)
}

function baseUrl(req: Request): string {
  const actual = (process.env.VERCEL_URL || "").trim()
  if (actual) return `https://${actual}`
  return new URL(req.url).origin
}

export async function GET(req: Request): Promise<Response> {
  if (!(await authorized(req))) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  if (!FUNNEL_KEY) return NextResponse.json({ ok: false, error: "VIC_FUNNEL_KEY no configurada" }, { status: 500 })
  const base = baseUrl(req)
  const resultados: Array<{ vista: string; status: number; bytes: number; ms: number }> = []
  // Secuencial a propósito: cada render pega a Zoho/Supabase con todo; dos en
  // paralelo duplican la presión sin ganar nada (el cron no tiene apuro).
  for (const vista of ["", "inbound"]) {
    const inicio = Date.now()
    try {
      const p = new URLSearchParams({ key: FUNNEL_KEY, fresh: "1" })
      if (vista) p.set("vista", vista)
      const r = await fetch(`${base}/api/vic-funnel?${p.toString()}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(55_000),
      })
      const cuerpo = await r.text().catch(() => "")
      resultados.push({ vista: vista || "main", status: r.status, bytes: cuerpo.length, ms: Date.now() - inicio })
    } catch (e) {
      console.error(`[dash-snap] foto ${vista || "main"} falló:`, e instanceof Error ? e.message : e)
      resultados.push({ vista: vista || "main", status: 0, bytes: 0, ms: Date.now() - inicio })
    }
  }
  return NextResponse.json({ ok: true, resultados })
}
