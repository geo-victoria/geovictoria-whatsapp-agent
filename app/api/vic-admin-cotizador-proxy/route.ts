/**
 * Endpoint ADMIN: GET /api/vic-admin-cotizador-proxy?ruta=/api/...
 *
 * Puente de SOLO LECTURA hacia el cotizador. Existe porque los endpoints de
 * diagnóstico de ese repo se autentican con `VICKY_COTIZADORA_SECRET`, que
 * vive en el env del agente y no se puede leer desde fuera (es `sensitive` en
 * Vercel). Sin esto, cada consulta de diagnóstico exige un deploy allá.
 *
 * GET únicamente, host fijo y ruta acotada a /api/: no muta nada por sí mismo.
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const CRON_SECRET = (process.env.CRON_SECRET || "").trim()
const COTIZADOR = (process.env.COTIZADORA_API_BASE || "https://cotizacion.geovictoria.com").trim()
const SECRET = (process.env.VICKY_COTIZADORA_SECRET || "").trim()

export async function GET(req: Request): Promise<Response> {
  const sp = new URL(req.url).searchParams
  const key = (sp.get("key") || "").trim()
  const kv = await getFollowupCronSecret().catch(() => "")
  if (!key || (key !== CRON_SECRET && key !== kv)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }
  const ruta = (sp.get("ruta") || "").trim()
  if (!/^\/api\/[A-Za-z0-9/_?&=%.:+-]*$/.test(ruta)) {
    return NextResponse.json({ ok: false, error: "ruta inválida" }, { status: 400 })
  }
  const r = await fetch(`${COTIZADOR}${ruta}`, {
    headers: { "x-vicky-secret": SECRET, Accept: "application/json" },
    cache: "no-store",
  })
  const cuerpo = await r.text().catch(() => "")
  return new NextResponse(cuerpo, {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "x-upstream-status": String(r.status) },
  })
}
