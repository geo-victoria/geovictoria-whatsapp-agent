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

  // __ping__ es el chequeo de disponibilidad de la página (decide si mostrar
  // la burbuja). Hasta hoy pasaba por el MODELO y se PERSISTÍA: cada carga de
  // página gastaba una llamada y dejaba conversaciones basura ("__pong__",
  // JSON inventado) en vic_widget_chat. El token ya se validó arriba — eso es
  // todo lo que el ping necesita saber.
  if (mensaje === "__ping__") {
    return NextResponse.json({ ok: true, reply: "" }, { headers: CORS })
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
  console.log(
    `[cotizacion-chat] ${ctx.quoteId} (${ctx.empresa || "-"}): respondido${r.descuentoAplicado ? " + DESCUENTO APLICADO" : ""}`,
  )
  // PERSISTENCIA (Lalo 31-ago, "necesito que esas conversaciones persistan"):
  // hasta hoy estos chats vivían solo en los logs de Vercel (3 días). Cada
  // turno guarda pregunta y respuesta en vic_widget_chat, best-effort — un
  // fallo acá jamás le quita la respuesta al cliente.
  guardarTurnoWidget(
    ctx.quoteId,
    ctx.empresa || "",
    mensaje,
    (r.reply || "") + (r.descuentoAplicado ? "\n[descuento aplicado desde el widget]" : ""),
  ).catch(() => {})
  // descuentoAplicado le avisa a la página que los totales que muestra
  // quedaron viejos: el widget recarga para que el cliente vea el precio nuevo.
  return NextResponse.json(
    { ok: true, reply: r.reply, descuentoAplicado: r.descuentoAplicado === true },
    { headers: CORS },
  )
}

const SUPA_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "")
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || ""

async function guardarTurnoWidget(quoteId: string, empresa: string, pregunta: string, respuesta: string): Promise<void> {
  if (!SUPA_URL || !SUPA_KEY) return
  const filas = [
    { quote_id: quoteId, empresa: empresa.slice(0, 200), role: "user", content: pregunta.slice(0, 4000) },
    { quote_id: quoteId, empresa: empresa.slice(0, 200), role: "assistant", content: respuesta.slice(0, 4000) },
  ]
  await fetch(`${SUPA_URL}/rest/v1/vic_widget_chat`, {
    method: "POST",
    headers: {
      apikey: SUPA_KEY,
      Authorization: `Bearer ${SUPA_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(filas),
    cache: "no-store",
  }).catch(() => undefined)
}
