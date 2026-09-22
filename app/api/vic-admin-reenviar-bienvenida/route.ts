/**
 * Endpoint ADMIN: reenvía la bienvenida post-pago de cotizaciones cuyo envío
 * original falló (push_fallo sin rastro — caso barrido 27-ago: 6 pagos de la
 * semana del canal ejecutivo quedaron sin bienvenida ni link de onboarding
 * porque la ventana de 24 h no existía y aún no había fallback de plantilla).
 *
 *   POST ?key=<cron>  body {"quoteIds": ["...", ...]}
 *
 * Reusa cerrarYTraspasarPostPago tal cual: el candado kv `traspaso_postpago_`
 * hace el reenvío idempotente (si el original SÍ salió, esto responde
 * "ya_enviado" y no molesta al cliente), y la rama nueva de respaldo manda la
 * plantilla vicky_bienvenida_pago_cl cuando el texto libre no puede entrar.
 * Pausa entre envíos para no gatillar el pacing de Meta en plantilla nueva.
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"
import { cerrarYTraspasarPostPago, type ResultadoTraspaso } from "@/lib/traspaso-postpago"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const CRON_SECRET = (process.env.CRON_SECRET || "").trim()

export async function POST(req: Request): Promise<Response> {
  const key = (new URL(req.url).searchParams.get("key") || "").trim()
  const kv = await getFollowupCronSecret().catch(() => "")
  if (!key || (key !== CRON_SECRET && key !== kv)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }
  const body = (await req.json().catch(() => ({}))) as { quoteIds?: unknown }
  const ids = Array.isArray(body.quoteIds)
    ? body.quoteIds.map((x) => String(x).trim()).filter((x) => /^\d{10,25}$/.test(x)).slice(0, 20)
    : []
  if (!ids.length) return NextResponse.json({ ok: false, error: "faltan quoteIds" }, { status: 400 })

  const resultados: Array<ResultadoTraspaso & { quoteId: string }> = []
  for (const quoteId of ids) {
    const r = await cerrarYTraspasarPostPago(quoteId)
    resultados.push({ ...r, quoteId })
    if (ids.length > 1) await new Promise((res) => setTimeout(res, 2000))
  }
  return NextResponse.json({ ok: true, n: resultados.length, resultados })
}
