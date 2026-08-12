/**
 * Endpoint POST /api/vic-callback-cron — HOY ES SOLO EL LATIDO DE 2 MINUTOS.
 *
 * Historia: este cron nació (14-jul) como el despachador de llamadas de voz de
 * Dapta (callbacks agendados + consentimiento + flujos por país). Dapta murió
 * el 24-jul y quedó definitivamente fuera por decisión de Lalo (08-ago: las
 * ventas SUBIERON sin la llamada robótica). La demolición de la biblia
 * (12-ago, Fase 1) extirpó toda la maquinaria de voz.
 *
 * Lo que queda es lo único vivo que este cron aportaba: es el job MÁS
 * FRECUENTE del scheduler (pg_cron cada 2 min), así que dispara el despachador
 * de huérfanos — el latido real de loop, PTV, outbound y mudos (barrido
 * acelerado, Lalo 10-ago). El endpoint conserva su nombre porque el scheduler
 * externo apunta acá; renombrarlo exige tocar pg_cron.
 */
import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

export async function POST(req: Request): Promise<Response> {
  const provided = (req.headers.get("x-cron-secret") || "").trim()
  const expected = await getFollowupCronSecret().catch(() => "")
  if (!expected || provided !== expected) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }

  const { despacharHuerfanos } = await import("@/lib/despachador-huerfanos")
  const despachados = await despacharHuerfanos().catch(() => undefined)

  return NextResponse.json({
    ok: true,
    latido: true,
    despachados: despachados ?? "error",
    voz: "eliminada (demolición biblia 12-ago — Dapta fuera)",
  })
}
