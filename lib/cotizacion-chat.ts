/**
 * VICKY DENTRO DE LA COTIZACIÓN ONLINE (31-ago, pedido de Lalo).
 *
 * EL PROBLEMA: el cliente abre su cotización, le queda una duda —"¿el reloj va
 * incluido?", "¿por qué sale este monto inicial?", "¿puedo pagar en dos
 * partes?"— y no tiene a quién preguntarle ahí mismo. Cierra la página y la
 * duda se convierte en silencio. En el saneamiento de agosto vimos cotizaciones
 * abiertas cinco y ocho veces sin que nadie completara el pago.
 *
 * LA IDEA: es la MISMA Vicky, no una nueva. Entra sabiendo qué cotizó el
 * cliente, cuánto, en qué estado está y qué conversaron por WhatsApp — nada de
 * preguntar todo otra vez. Y rige con los MISMOS topes que tiene en WhatsApp
 * (decisión de Lalo 31-ago: "puede cambiar lo mismo que ya puede por WhatsApp,
 * y pedir descuento con los mismos topes").
 *
 * FASE 1 (esta): entiende y responde. Todavía no modifica la cotización — esa
 * es la fase 2, con las tools del agente y su recálculo determinista.
 *
 * IDENTIDAD: el token firmado de la URL de aceptación. No se valida a mano ni
 * se comparte el secreto: se le pregunta al propio cotizador por su endpoint
 * de sesión, que ya verifica la firma y devuelve la cotización. Si el token no
 * sirve, no hay chat.
 */

import Anthropic from "@anthropic-ai/sdk"
import { fetchHistoryV3 } from "./supabase-persistence-v3"

const COTIZADOR_BASE = (process.env.VICKY_COTIZADOR_BASE || "https://cotizacion.geovictoria.com").trim()
const DEFAULT_MODEL = "claude-sonnet-4-5-20250929"

export type ContextoCotizacion = {
  quoteId: string
  numero?: string
  empresa?: string
  estado?: string
  pais?: string
  telefono?: string
  totalMensualClp?: number
  pagoInicialClp?: number
  vigencia?: string
  items: Array<{ nombre: string; cantidad?: number; subtotalClp?: number; recurrente?: boolean }>
}

/** Pregunta al cotizador si el token es válido y trae la cotización. */
export async function contextoDesdeToken(token: string): Promise<ContextoCotizacion | null> {
  if (!token) return null
  try {
    const r = await fetch(
      `${COTIZADOR_BASE}/api/quote-acceptance/session?token=${encodeURIComponent(token)}`,
      { cache: "no-store" },
    )
    if (!r.ok) return null
    const d = (await r.json().catch(() => null)) as Record<string, unknown> | null
    if (!d || d.success === false) return null
    const q = (d.quote || d.data || d) as Record<string, unknown>
    const items = Array.isArray(q.items) ? (q.items as Array<Record<string, unknown>>) : []
    return {
      quoteId: String(q.quoteId || q.id || ""),
      numero: q.numeroCotizacion ? String(q.numeroCotizacion) : undefined,
      empresa: q.empresa ? String(q.empresa) : undefined,
      estado: q.estado ? String(q.estado) : q.status ? String(q.status) : undefined,
      pais: q.pais ? String(q.pais) : "cl",
      telefono: String(q.telefono || q.telefonoContacto || q.phone || "").replace(/\D/g, ""),
      totalMensualClp: Number(q.totalMensualClp || q.totalRecurrenteClp || 0) || undefined,
      pagoInicialClp: Number(q.pagoInicialClp || q.oneShotClp || 0) || undefined,
      vigencia: q.vigencia ? String(q.vigencia) : undefined,
      items: items.map((i) => ({
        nombre: String(i.nombre || i.Nombre_Item || i.name || ""),
        cantidad: Number(i.cantidad || i.Cantidad || 0) || undefined,
        subtotalClp: Number(i.subtotalClp || i.Subtotal_CLP || 0) || undefined,
        recurrente: Boolean(i.recurrente ?? i.Es_Recurrente),
      })).filter((i) => i.nombre),
    }
  } catch {
    return null
  }
}

function clp(n?: number): string {
  return typeof n === "number" && n > 0 ? `$${Math.round(n).toLocaleString("es-CL")}` : "—"
}

function bloqueCotizacion(c: ContextoCotizacion): string {
  const lineas = c.items
    .slice(0, 25)
    .map((i) => `  · ${i.nombre}${i.cantidad && i.cantidad > 1 ? ` x${i.cantidad}` : ""} — ${clp(i.subtotalClp)}${i.recurrente ? "/mes" : " (pago único)"}`)
    .join("\n")
  return [
    `LA COTIZACIÓN QUE EL CLIENTE ESTÁ MIRANDO AHORA:`,
    c.numero ? `Número: ${c.numero}` : "",
    c.empresa ? `Empresa: ${c.empresa}` : "",
    c.estado ? `Estado: ${c.estado}` : "",
    lineas ? `Detalle:\n${lineas}` : "",
    `Mensualidad: ${clp(c.totalMensualClp)} · Pago inicial: ${clp(c.pagoInicialClp)}`,
    c.vigencia ? `Vigencia: ${c.vigencia}` : "",
  ].filter(Boolean).join("\n")
}

const ESTILO = [
  "Eres Vicky, de GeoVictoria. El cliente está mirando su cotización en línea y te escribe desde ahí mismo.",
  "",
  "CÓMO HABLAS: 2 o 3 oraciones, una idea por mensaje, tuteo chileno neutro sin jerga. Nunca empieces con 'Oye'.",
  "Usa su nombre si lo sabes, o entra directo al tema.",
  "",
  "LO QUE YA SABES: tienes el detalle exacto de su cotización y la conversación que tuvieron por WhatsApp.",
  "No le preguntes cosas que ya te dijo ni le pidas datos que ya están en la cotización.",
  "",
  "TU TRABAJO ACÁ: resolver la duda que lo tiene detenido y acompañarlo hasta el pago.",
  "Responde con los números REALES de su cotización, nunca aproximados ni inventados.",
  "",
  "LÍMITES DUROS:",
  "· Jamás inventes precios, descuentos, plazos ni condiciones que no estén en la cotización.",
  "· Si te piden un descuento, no lo ofrezcas por tu cuenta: dile que lo revisas y que le confirmas.",
  "· Si te piden cambiar la cotización, dile que lo puedes ajustar y que se lo dejas listo — todavía",
  "  no tienes la herramienta para hacerlo acá, así que ofrécele seguir por WhatsApp, que es el mismo chat.",
  "· Si no sabes algo, dilo. No adivines condiciones comerciales.",
].join("\n")

export type RespuestaChat = { reply: string; error?: string }

export async function chatEnCotizacion(
  ctx: ContextoCotizacion,
  mensaje: string,
  historialLocal: Array<{ role: "user" | "assistant"; content: string }> = [],
): Promise<RespuestaChat> {
  const apiKey = (process.env.ANTHROPIC_API_KEY || "").trim()
  if (!apiKey) return { reply: "", error: "sin credenciales del modelo" }

  // El historial de WhatsApp es el contexto de la negociación: sin él, Vicky
  // le preguntaría de nuevo lo que el cliente ya respondió.
  let wa: Array<{ role: string; content: string }> = []
  if (ctx.telefono) {
    wa = (await fetchHistoryV3(ctx.telefono, 30).catch(() => [])) as Array<{ role: string; content: string }>
  }
  const resumenWa = wa
    .filter((m) => (m.role === "user" || m.role === "assistant") && String(m.content || "").trim())
    .slice(-20)
    .map((m) => `${m.role === "user" ? "Cliente" : "Vicky"}: ${String(m.content).replace(/\s+/g, " ").slice(0, 300)}`)
    .join("\n")

  const system = [
    ESTILO,
    "",
    bloqueCotizacion(ctx),
    resumenWa ? `\nLO QUE CONVERSARON POR WHATSAPP (lo más reciente al final):\n${resumenWa}` : "",
  ].join("\n")

  const client = new Anthropic({ apiKey })
  const model = (process.env.ANTHROPIC_COTCHAT_MODEL || DEFAULT_MODEL).trim()
  try {
    const res = await client.messages.create({
      model,
      max_tokens: 700,
      system,
      messages: [
        ...historialLocal
          .filter((m) => String(m.content || "").trim())
          .slice(-12)
          .map((m) => ({ role: m.role, content: String(m.content).slice(0, 4000) })),
        { role: "user" as const, content: mensaje.slice(0, 4000) },
      ],
    })
    const reply = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim()
    return { reply: reply || "Disculpa, no alcancé a procesar eso. ¿Me lo repites?" }
  } catch (e) {
    return { reply: "", error: e instanceof Error ? e.message : "excepción del modelo" }
  }
}
