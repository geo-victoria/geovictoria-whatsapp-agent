/**
 * ENDPOINT — Vicky dentro de la cotización online (31-ago, pedido de Lalo).
 *
 * La página de aceptación (repo cotizador) llama acá con el token firmado de
 * su URL. No hay secreto compartido: el token se valida preguntándole al
 * propio cotizador por su endpoint de sesión, que ya verifica la firma.
 *
 * POST { token, mensaje, historial? } → { ok, reply }
 *
 * CORS abierto porque la página vive en otro dominio (cotizacion.geovictoria
 * .com). Lo que protege no es el origen sino el token: sin token válido no
 * hay respuesta, y el token solo lo tiene quien recibió la cotización.
 */

import { NextResponse } from "next/server"
import { contextoDesdeToken, chatEnCotizacion } from "@/lib/cotizacion-chat"

export const dynamic = "force-dynamic"
export const maxDuration = 45

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
}

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, { status: 204, headers: CORS })
}

export async function POST(req: Request): Promise<NextResponse> {
  const body = (await req.json().catch(() => ({}))) as {
    token?: string
    mensaje?: string
    historial?: Array<{ role?: string; content?: string }>
  }
  const token = String(body.token || "").trim()
  const mensaje = String(body.mensaje || "").trim()
  if (!token || !mensaje) {
    return NextResponse.json({ ok: false, error: "falta token o mensaje" }, { status: 400, headers: CORS })
  }

  const ctx = await contextoDesdeToken(token)
  if (!ctx?.quoteId) {
    return NextResponse.json({ ok: false, error: "cotización no disponible" }, { status: 401, headers: CORS })
  }

  const historial = (body.historial || [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && String(m.content || "").trim())
    .map((m) => ({ role: m.role as "user" | "assistant", content: String(m.content) }))

  const r = await chatEnCotizacion(ctx, mensaje, historial)
  if (r.error) {
    console.warn(`[cotizacion-chat] ${ctx.quoteId}: ${r.error}`)
    return NextResponse.json(
      { ok: false, error: "no disponible por ahora" },
      { status: 503, headers: CORS },
    )
  }
  console.log(`[cotizacion-chat] ${ctx.quoteId} (${ctx.empresa || "-"}): respondido`)
  return NextResponse.json({ ok: true, reply: r.reply }, { headers: CORS })
}
