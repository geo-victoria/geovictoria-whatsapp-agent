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
  descuentoTexto?: string
  descuentoPct?: number
  ejecutivo?: string
  ejecutivoFono?: string
  necesitaPago?: boolean
  pdfUrl?: string
  items: Array<{
    nombre: string
    cantidad?: number
    subtotalClp?: number
    recurrente?: boolean
    modalidad?: string
  }>
}

/** Pregunta al cotizador si el token es válido y trae la cotización.
 *
 * La forma la dicta el endpoint de sesión y NO es plana: los datos del
 * encabezado van en `quote`, pero los ítems, los totales y el descuento
 * cuelgan de la raíz. Mapearlo mal no rompe nada visible — simplemente deja
 * a Vicky sin datos, y entonces alucina: en la primera prueba respondió
 * "tu cotización incluye 5 planes con reportes en tiempo real", nada de lo
 * cual estaba en la cotización. Por eso cada campo se lee del lugar exacto y
 * el llamador exige al menos un ítem antes de dejarla hablar. */
export async function contextoDesdeToken(token: string): Promise<ContextoCotizacion | null> {
  if (!token) return null
  try {
    const r = await fetch(
      `${COTIZADOR_BASE}/api/quote-acceptance/session?token=${encodeURIComponent(token)}`,
      { cache: "no-store" },
    )
    if (!r.ok) return null
    const d = (await r.json().catch(() => null)) as Record<string, unknown> | null
    if (!d || d.success !== true) return null
    const q = (d.quote || {}) as Record<string, unknown>
    const totals = (d.totals || {}) as Record<string, unknown>
    const desc = (d.descuento || {}) as Record<string, unknown>
    const support = (d.support || {}) as Record<string, unknown>
    const items = Array.isArray(d.items) ? (d.items as Array<Record<string, unknown>>) : []

    const recurrentes = items.filter((i) => String(i.modalidad || "").toLowerCase() !== "cobro único")
    const mensual =
      Number(totals.totalConIvaClp || totals.totalClp || 0) ||
      recurrentes.reduce((a, i) => a + (Number(i.subtotalClp) || 0), 0)

    return {
      quoteId: String(q.id || ""),
      numero: q.name ? String(q.name) : undefined,
      empresa: q.name ? String(q.name).replace(/^Cotización\s+/i, "").replace(/\s+-\s+\d{4}-\d{2}-\d{2}$/, "") : undefined,
      estado: q.status ? String(q.status) : undefined,
      pais: d.pais ? String(d.pais) : "cl",
      telefono: String(q.contactPhone || q.billingPhone || "").replace(/\D/g, ""),
      totalMensualClp: mensual || undefined,
      pagoInicialClp: Number(q.pagoInicialClp || 0) || undefined,
      vigencia: q.expiresAt ? String(q.expiresAt).slice(0, 10) : undefined,
      descuentoTexto: desc.texto ? String(desc.texto) : undefined,
      descuentoPct: await descuentoRealPct(String(q.id || "")),
      ejecutivo: support.executiveName ? String(support.executiveName) : undefined,
      ejecutivoFono: support.executivePhone ? String(support.executivePhone) : undefined,
      necesitaPago: q.needsPayment === true,
      pdfUrl: q.pdfUrl ? String(q.pdfUrl) : undefined,
      items: items
        .map((i) => ({
          nombre: String(i.nombre || ""),
          cantidad: Number(i.cantidad) || undefined,
          subtotalClp: Number(i.subtotalClp) || undefined,
          recurrente: String(i.modalidad || "").toLowerCase() !== "cobro único",
          modalidad: i.modalidad ? String(i.modalidad) : undefined,
        }))
        .filter((i) => i.nombre),
    }
  } catch {
    return null
  }
}

/** PORCENTAJE REAL DEL DESCUENTO (31-ago, hallazgo de la prueba adversarial).
 *
 * El endpoint de sesión entrega el TEXTO del descuento ("aplica durante los
 * primeros 6 meses") pero no el porcentaje. Sin ese número, ante un cliente
 * que pregunta "¿me haces un 40%?" el modelo llenó el hueco con la cifra de
 * la pregunta y respondió que su descuento ERA del 40% — cuando la campaña le
 * había dado 10%. Un compromiso comercial inventado, y de los que suenan
 * informados. El dato vive en Zoho: se lee de ahí. */
async function descuentoRealPct(quoteId: string): Promise<number | undefined> {
  if (!quoteId) return undefined
  try {
    const { getZohoAccessToken } = await import("./zoho-token")
    const token = await getZohoAccessToken()
    const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
    const r = await fetch(
      `${api}/crm/v3/Cotizaciones_GeoVictoria/${quoteId}?fields=Descuento_Recurrente_Pct`,
      { headers: { Authorization: `Zoho-oauthtoken ${token}` }, cache: "no-store" },
    )
    if (r.status !== 200) return undefined
    const pct = Number(
      ((await r.json().catch(() => ({}))) as { data?: Array<{ Descuento_Recurrente_Pct?: number }> })
        .data?.[0]?.Descuento_Recurrente_Pct,
    )
    return Number.isFinite(pct) && pct > 0 ? pct : undefined
  } catch {
    return undefined
  }
}

function clp(n?: number): string {
  return typeof n === "number" && n > 0 ? `$${Math.round(n).toLocaleString("es-CL")}` : "—"
}

function bloqueCotizacion(c: ContextoCotizacion): string {
  const lineas = c.items
    .slice(0, 25)
    .map((i) => {
      const cant = i.cantidad && i.cantidad > 1 ? ` — ${i.cantidad} ${i.modalidad === "Por usuario" ? "usuarios" : "unidades"}` : ""
      return `  · ${i.nombre}${cant}: ${clp(i.subtotalClp)}${i.recurrente ? " al mes" : " (pago único)"}`
    })
    .join("\n")
  return [
    `LA COTIZACIÓN QUE EL CLIENTE ESTÁ MIRANDO AHORA:`,
    c.empresa ? `Empresa: ${c.empresa}` : "",
    c.estado ? `Estado: ${c.estado}` : "",
    lineas ? `Detalle:\n${lineas}` : "",
    `Mensualidad con IVA: ${clp(c.totalMensualClp)}`,
    c.pagoInicialClp ? `Pago inicial: ${clp(c.pagoInicialClp)}` : "",
    c.descuentoPct
      ? `Descuento aplicado: ${c.descuentoPct}%${c.descuentoTexto ? ` — ${c.descuentoTexto}` : ""}`
      : "Descuento aplicado: NINGUNO. Esta cotización no tiene descuento vigente.",
    c.vigencia ? `Vigente hasta: ${c.vigencia}` : "",
    c.ejecutivo
      ? `Ejecutivo a cargo: ${c.ejecutivo}${c.ejecutivoFono ? ` (+${c.ejecutivoFono})` : ""}`
      : "",
    c.necesitaPago
      ? `Formas de pago disponibles: las que muestra esta misma página (tarjeta o transferencia). No hay otras.`
      : `Esta cotización ya está pagada.`,
    ``,
    `ESTE ES EL DETALLE COMPLETO. La cotización no incluye nada que no esté en esta lista:`,
    `si te preguntan por algo que no aparece acá, di que no está incluido y ofrece agregarlo.`,
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
  "LÍMITES DUROS — todos salieron de pruebas reales donde te equivocaste:",
  "· Jamás inventes precios, descuentos, plazos, formas de pago ni condiciones que no estén arriba.",
  "· NUNCA confirmes ni repitas un porcentaje, monto o plazo que el cliente proponga como si fuera",
  "  el suyo. Si te pregunta '¿me haces un 40%?', esa cifra es de él, no de su cotización. El único",
  "  descuento que existe es el que aparece arriba; si dice NINGUNO, no tiene descuento y punto.",
  "· Las ÚNICAS formas de pago son las de esta página. No existen cuotas, cheques, órdenes de compra",
  "  ni pagos coordinados aparte: si te los piden, di que no están disponibles y ofrece que lo vea su",
  "  ejecutivo.",
  "· NO PROMETAS ACCIONES QUE NO PUEDES HACER. No digas que vas a consultar con tu jefe, que le",
  "  confirmas en unos minutos, que le preparas un documento ni que le agregas algo a la cuenta:",
  "  desde acá no puedes hacer nada de eso y nadie se entera de lo que prometiste. Lo que SÍ puedes",
  "  ofrecer es que siga por WhatsApp contigo, que es el mismo chat, o hablar con su ejecutivo.",
  "· No inventes requisitos ni procesos internos (pantallazos, aprobaciones, formularios). Si algo",
  "  no está en la cotización, di simplemente que no está incluido.",
  "· Si alguien dice que le prometieron algo que no aparece, no lo niegues ni lo confirmes como un",
  "  hecho: dile que en su cotización no aparece y que su ejecutivo lo puede revisar con él.",
  "· Si no sabes algo, dilo. Es mejor que quede una duda a que quede una promesa falsa.",
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
