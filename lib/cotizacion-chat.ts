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
import { consultarSiguienteDescuento } from "./tools/consultar-siguiente-descuento"
import { aplicarSiguienteDescuento } from "./tools/aplicar-siguiente-descuento"

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
  "  lo ÚNICO que puedes ejecutar desde acá es el descuento con tus tools (si las tienes en este",
  "  turno); todo lo demás no, y nadie se entera de lo que prometiste. Lo que SÍ puedes ofrecer es",
  "  que siga por WhatsApp contigo, que es el mismo chat, o hablar con su ejecutivo.",
  "· No inventes requisitos ni procesos internos (pantallazos, aprobaciones, formularios). Si algo",
  "  no está en la cotización, di simplemente que no está incluido.",
  "· Si alguien dice que le prometieron algo que no aparece, no lo niegues ni lo confirmes como un",
  "  hecho: dile que en su cotización no aparece y que su ejecutivo lo puede revisar con él.",
  "· Si no sabes algo, dilo. Es mejor que quede una duda a que quede una promesa falsa.",
  "· DESCUENTOS: acá rigen las MISMAS reglas y topes que tienes en WhatsApp — es UNA sola escalera",
  "  compartida: el descuento vigente de arriba puede venir de esta página o del chat de WhatsApp,",
  "  y el servidor es el único que lleva la cuenta. Por eso JAMÁS negocies de memoria: si el",
  "  cliente objeta el precio de forma EXPLÍCITA ('muy caro', 'fuera de presupuesto', pide rebaja),",
  "  usa consultar_descuento y ofrécele copiando el mensajeParaProspecto tal cual; si ACEPTA esa",
  "  oferta, recién ahí aplicar_descuento. NUNCA ofrezcas descuento de forma proactiva, NUNCA",
  "  enuncies porcentajes ni totales que no vengan de una tool, y si la tool dice topeAlcanzado",
  "  ese es el último escalón: no hay más rebaja, ni acá ni por WhatsApp ni con el ejecutivo.",
  "  Si en este turno NO tienes esas tools (cotización pagada o de otro país), no negocies nada:",
  "  di el descuento que aparece arriba y deriva a su ejecutivo.",
  "",
  "PRECIOS A FUTURO — NUNCA los calcules ni los estimes:",
  "El único precio que conoces es el de la cotización de arriba, para la cantidad que dice.",
  "Si te preguntan cuánto pagarían con otra dotación, con más relojes o con otro plan, NO respondas",
  "con un número, ni siquiera aproximado o 'a modo de referencia': no tienes la tabla de precios acá.",
  "Explica cómo funciona el cobro y deriva a su ejecutivo para el valor exacto.",
  "",
  "CÓMO FUNCIONA EL COBRO DESPUÉS DEL PRIMER MES (regla de Chile, dictada por Eduardo Gómez):",
  "· Se factura por USUARIO ACTIVO en el mes, al valor de la tabla que ya viene en su cotización.",
  "· Esa tabla no cambia: es la misma que él aceptó.",
  "· Si un mes tiene más o menos gente activa, NO hay que cotizar de nuevo ni avisar a nadie —",
  "  el ajuste se refleja solo en la factura de fin de período.",
  "Eso es todo el modelo. No le agregues plazos de aviso, mínimos, prorrateos ni trámites, y no le",
  "digas que tiene que coordinar el cambio con su ejecutivo: no tiene que hacer nada.",
  "Puedes explicar el mecanismo las veces que haga falta, pero NO calcules cuánto pagaría con otra",
  "dotación: el valor por usuario depende del tramo y el tramo puede cambiar. Para un número",
  "exacto, su ejecutivo se lo confirma."
].join("\n")

/**
 * TOOLS DE DESCUENTO DEL WIDGET (01-sep, orden de Lalo: "dale las mismas
 * atribuciones de descuentos de Vicky WhatsApp pero que ninguna pueda dar más
 * descuento del permitido y sepa el descuento vigente que dio la otra Vicky").
 *
 * Son los MISMOS endpoints del cotizador que usan las tools de WhatsApp
 * (consultar/aplicar-siguiente-descuento): el estado de la escalera y el tope
 * de cliente viven en el SERVIDOR, por cotización — así las dos Vickys
 * comparten el descuento vigente sin sincronizar nada, y ninguna puede pasar
 * el tope aunque el modelo lo pida. Diferencias deliberadas con WhatsApp:
 * el quote_id NO lo pasa el modelo (se inyecta el de la sesión del token —
 * el widget jamás puede tocar otra cotización) y el pct_ofrecido se acota a
 * TOPE_CLIENTE_PCT antes de salir.
 */
const TOPE_CLIENTE_PCT = 20

const TOOLS_DESCUENTO_WIDGET: Anthropic.Tool[] = [
  {
    name: "consultar_descuento",
    description:
      "Consulta (solo lectura) qué descuento puedes ofrecer y devuelve el precio recalculado. Úsala SOLO cuando el cliente objeta el precio de forma explícita ('muy caro', 'fuera de presupuesto', pide rebaja) o insiste en más descuento. NUNCA la uses de forma proactiva. No recibe porcentaje: el servidor decide el escalón según lo ya negociado en cualquier canal (WhatsApp o este chat). Comunica al cliente SOLO el contenido de mensajeParaProspecto. Si topeAlcanzado=true, es el último escalón: no ofrezcas más rebaja.",
    input_schema: { type: "object" as const, properties: {} },
  },
  {
    name: "aplicar_descuento",
    description:
      "Aplica a la cotización el descuento que el cliente ACEPTÓ tras ofrecérselo con consultar_descuento, y regenera el documento. Úsala SOLO después de que el cliente acepte una oferta que vino de consultar_descuento en esta misma conversación — nunca antes de consultar, nunca sin aceptación explícita. Pasa pct_ofrecido = el porcentaje EXACTO que consultar_descuento te devolvió y que le comunicaste. Comunica al cliente SOLO el contenido de mensajeParaProspecto.",
    input_schema: {
      type: "object" as const,
      properties: {
        pct_ofrecido: {
          type: "number" as const,
          description:
            "Porcentaje exacto sobre el plan mensual que le ofreciste al cliente y que vino de consultar_descuento (ej. 10). No lo inventes.",
          minimum: 0,
          maximum: 40,
        },
      },
    },
  },
]

async function ejecutarToolWidget(
  quoteId: string,
  nombre: string,
  input: Record<string, unknown>,
): Promise<{ resultado: unknown; aplicado: boolean }> {
  if (nombre === "consultar_descuento") {
    const r = await consultarSiguienteDescuento({ quote_id: quoteId })
    return { resultado: r, aplicado: false }
  }
  if (nombre === "aplicar_descuento") {
    const pctNum = Number(input?.pct_ofrecido)
    const pct =
      Number.isFinite(pctNum) && pctNum > 0 ? Math.min(TOPE_CLIENTE_PCT, pctNum) : undefined
    const r = await aplicarSiguienteDescuento({ quote_id: quoteId, pct_ofrecido: pct })
    return { resultado: r, aplicado: r.ok === true }
  }
  return { resultado: { ok: false, error: `tool desconocida: ${nombre}` }, aplicado: false }
}

export type RespuestaChat = { reply: string; error?: string; descuentoAplicado?: boolean }

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

  // Las tools de descuento solo existen para cotizaciones CL sin pagar: la
  // escalera es un mecanismo chileno y sobre una Pagada no hay nada que
  // negociar. Sin tools, el prompt manda al modelo a no negociar.
  const negociable = (ctx.pais || "cl") === "cl" && ctx.necesitaPago === true && Boolean(ctx.quoteId)
  const tools = negociable ? TOOLS_DESCUENTO_WIDGET : undefined

  const mensajes: Anthropic.MessageParam[] = [
    ...historialLocal
      .filter((m) => String(m.content || "").trim())
      .slice(-12)
      .map((m) => ({ role: m.role, content: String(m.content).slice(0, 4000) })),
    { role: "user" as const, content: mensaje.slice(0, 4000) },
  ]

  try {
    let descuentoAplicado = false
    // Hasta 4 vueltas de tools por turno (consultar → aplicar y margen); la
    // última llamada se hace sin tools para forzar el cierre en texto.
    for (let vuelta = 0; vuelta < 5; vuelta++) {
      const res = await client.messages.create({
        model,
        max_tokens: 900,
        system,
        messages: mensajes,
        ...(tools && vuelta < 4 ? { tools } : {}),
      })

      const usosTool = res.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      )
      if (usosTool.length === 0 || res.stop_reason !== "tool_use") {
        const reply = res.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim()
        return {
          reply: reply || "Disculpa, no alcancé a procesar eso. ¿Me lo repites?",
          descuentoAplicado: descuentoAplicado || undefined,
        }
      }

      mensajes.push({ role: "assistant", content: res.content })
      const resultados: Anthropic.ToolResultBlockParam[] = []
      for (const uso of usosTool) {
        const { resultado, aplicado } = await ejecutarToolWidget(
          ctx.quoteId,
          uso.name,
          (uso.input || {}) as Record<string, unknown>,
        )
        if (aplicado) descuentoAplicado = true
        console.log(
          `[cotizacion-chat] ${ctx.quoteId}: tool ${uso.name} → ${JSON.stringify(resultado).slice(0, 300)}`,
        )
        resultados.push({
          type: "tool_result",
          tool_use_id: uso.id,
          content: JSON.stringify(resultado).slice(0, 4000),
        })
      }
      mensajes.push({ role: "user", content: resultados })
    }
    return { reply: "", error: "el turno no cerró en texto tras las vueltas de tools" }
  } catch (e) {
    return { reply: "", error: e instanceof Error ? e.message : "excepción del modelo" }
  }
}
