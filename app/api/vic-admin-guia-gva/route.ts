/**
 * Prueba de la guía de GV Avanzado (02-oct): responde una pregunta con el
 * manual, igual que la tool guia_gv_avanzado del chat. Solo lectura.
 * GET ?key=<cron>&q=<pregunta>[&pais=cl|pe|co|mx]
 */
import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"
import { consultarGuiaGva } from "@/lib/guia-gva"

export const dynamic = "force-dynamic"
export const maxDuration = 60

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const secreto = await getFollowupCronSecret()
  const dado = req.headers.get("x-cron-secret") || url.searchParams.get("key") || ""
  if (!secreto || dado !== secreto) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  const q = url.searchParams.get("q") || ""
  const pais = url.searchParams.get("pais") || "cl"
  return NextResponse.json(await consultarGuiaGva(q, { pais }))
}
