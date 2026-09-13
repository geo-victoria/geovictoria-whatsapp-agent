import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"
import { verificarYPersistirEntregas } from "@/lib/entrega-plantilla"

export const runtime = "nodejs"
export const maxDuration = 180

/**
 * CRON: ¿salieron de verdad los toques de la campaña? (13-sep)
 *
 * Cierra el bucle del ciclo de reactivación: el runner anota "enviado" con el
 * 202 de Botmaker ("encargo aceptado"), y esto verifica después contra el
 * historial de Botmaker si la plantilla realmente se despachó, y PERSISTE el
 * veredicto para que el reporte del lunes lo lea gratis.
 *
 * Corre solo (JOBS_HUERFANOS) y es idempotente: lo ya verificado no se vuelve
 * a leer. `?dias=` mueve la ventana (default 3).
 */
export async function GET(req: Request): Promise<Response> {
  const sp = new URL(req.url).searchParams
  const key = (sp.get("key") || req.headers.get("x-cron-secret") || "").trim()
  const secreto = (process.env.FOLLOWUP_CRON_SECRET || "").trim() || (await getFollowupCronSecret().catch(() => "")) || ""
  if (!key || !secreto || key !== secreto) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  const dias = Math.min(Math.max(Number(sp.get("dias")) || 3, 1), 14)
  const r = await verificarYPersistirEntregas(dias)
  return NextResponse.json({ ok: !r.error, ...r, detalle: r.detalle.slice(0, 40) })
}
