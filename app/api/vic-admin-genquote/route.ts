/**
 * Endpoint ADMIN: POST /api/vic-admin-genquote
 *
 * Ejecuta generar_link_cotizadora con los datos que se le pasen en el body, para
 * generar manualmente una cotización (pdfUrl + acceptanceUrl) cuando el flujo
 * automático de Vicky falló. Devuelve el resultado crudo de la tool (incluido el
 * error real del cotizador si falla, en vez del mensaje genérico).
 *
 * Auth: header x-cron-secret == vic_kv.followup_cron_secret, o ?key=/Bearer ==
 * CRON_SECRET. Mismo modelo que el resto de crons V3.
 */

import { NextResponse } from "next/server"
import { generarLinkCotizadora } from "@/lib/tools/generar-link-cotizadora"
import { buildDispatchCO } from "@/lib/paises/co/tools"
import { buildDispatchMX } from "@/lib/paises/mx/tools"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const CRON_SECRET = (process.env.CRON_SECRET || "").trim()

async function authorized(req: Request): Promise<boolean> {
  const xcron = (req.headers.get("x-cron-secret") || "").trim()
  if (xcron) {
    const expected = await getFollowupCronSecret().catch(() => "")
    if (expected && xcron === expected) return true
  }
  if (CRON_SECRET) {
    const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim()
    if (bearer === CRON_SECRET) return true
    const key = (new URL(req.url).searchParams.get("key") || "").trim()
    if (key === CRON_SECRET) return true
  }
  return false
}

export async function POST(req: Request): Promise<Response> {
  if (!(await authorized(req))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }
  let body: Record<string, unknown> = {}
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ ok: false, error: "body JSON inválido" }, { status: 400 })
  }
  try {
    // pais=co: genera por el flujo COLOMBIANO (create-from-vicky-co, precios
    // COP, NIT). `_contact` es el teléfono del cliente (lo usa el dispatch CO
    // para los caminos de lead). Agregado 21-jul para la llamada de
    // validación de voz CO (cotización de prueba de Alejandro).
    if (String(body.pais || "") === "co") {
      const contact = String(body._contact || "")
      const dispatchCO = buildDispatchCO(contact)
      const result = await dispatchCO("generar_link_cotizadora", body)
      return NextResponse.json(result as Record<string, unknown>)
    }
    if (String(body.pais || "") === "mx") {
      const contact = String(body._contact || "")
      const dispatchMX = buildDispatchMX(contact)
      const result = await dispatchMX("generar_link_cotizadora", body)
      return NextResponse.json(result as Record<string, unknown>)
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await generarLinkCotizadora(body as any)
    return NextResponse.json(result)
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `Excepción: ${String((e as Error)?.message || e)}` },
      { status: 500 },
    )
  }
}
