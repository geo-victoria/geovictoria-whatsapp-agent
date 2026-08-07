/**
 * "Vicky Cotizaciones" — agente INTERNO del dashboard de gestión para editar
 * cotizaciones formales conversando (pedido Lalo 06-ago).
 *
 * El vendedor abre la cotización desde la cola de gestión, describe el cambio
 * ("súbela a 25 trabajadores", "agrégale un segundo reloj en arriendo") y el
 * agente lo aplica EN EL ACTO con la misma tool `actualizar_cotizacion` que usa
 * Vicky con los clientes: mismo builder de ítems, mismos precios, cero drift.
 * El PDF se regenera y el link de aceptación NO cambia. Recién cuando el
 * vendedor da el OK explícito, el agente le manda al cliente el PDF nuevo por
 * el WhatsApp de Vicky con un mensaje corto.
 *
 * El interlocutor es el VENDEDOR (no el cliente): tono directo de herramienta
 * interna. Todo lo que ve el CLIENTE (el mensaje del envío) mantiene la voz de
 * Vicky: tuteo chileno neutro, jamás "Oye".
 */

import Anthropic from "@anthropic-ai/sdk"

import { getQuotePointers, setQuotePointer, type QuotePointer } from "@/lib/supabase-persistence-v3"
import { getZohoAccessToken } from "@/lib/zoho-token"
import {
  actualizarCotizacion,
  actualizarCotizacionSchema,
  type ActualizarCotizacionInput,
} from "@/lib/tools/actualizar-cotizacion"
import { enviarCotizacionWhatsapp } from "@/lib/tools/enviar-cotizacion-whatsapp"
import { aplicarSiguienteDescuento } from "@/lib/tools/aplicar-siguiente-descuento"
import { sendBotmakerMessage } from "@/lib/botmaker-push-v3"
import {
  getModulosDisponiblesParaVicky,
  getHardwareDisponiblesParaVicky,
} from "@/lib/catalogo"

const ZOHO_API_DOMAIN = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
const QUOTE_MODULE = (process.env.ZOHO_QUOTE_MODULE || "Cotizaciones_GeoVictoria").trim()
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
// Mismo default que el agente de ventas (agent-loop): Sonnet probado en
// producción para tool use con la cotizadora. Override propio por env.
const DEFAULT_MODEL = "claude-sonnet-4-5-20250929"
const MAX_ITERATIONS = 6
const MAX_TOKENS = 1200

// ── Estado vivo de la cotización (puntero + detalle de Zoho) ────────────────

export type ItemCotizacion = {
  codigo: string
  nombre: string
  cantidad: number
  modalidad: string
  recurrente: boolean
  subtotalUF: number
  subtotalCLP: number
}

export type EstadoCotizacion = {
  puntero: QuotePointer
  numero: string
  estadoZoho: string
  descuentoPct: number
  items: ItemCotizacion[]
}

/**
 * Estado actual de la cotización del contacto: puntero durable (links,
 * totales, empresa) + detalle de ítems desde Zoho (best-effort — si Zoho no
 * responde, se devuelve el puntero con items vacíos). Con `quoteId` se elige
 * ESA cotización entre los punteros del contacto (multi-RUT / búsqueda por
 * número); sin él, la más reciente.
 */
export async function estadoCotizacion(contact: string, quoteId?: string): Promise<EstadoCotizacion | null> {
  const punteros = await getQuotePointers(contact).catch(() => [])
  const puntero =
    (quoteId ? punteros.find((p) => p.quoteId === quoteId) : undefined) ??
    punteros[0] ??
    (await punteroPorSufijo(contact))
  if (!puntero) return null

  let numero = ""
  let estadoZoho = ""
  let descuentoPct = 0
  let items: ItemCotizacion[] = []
  try {
    const token = await getZohoAccessToken()
    const r = await fetch(`${ZOHO_API_DOMAIN}/crm/v3/${QUOTE_MODULE}/${puntero.quoteId}`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      cache: "no-store",
    })
    const body = (await r.json().catch(() => null)) as {
      data?: Array<{
        Numero_Cotizacion?: string
        Estado_Cotizacion?: string
        Descuento_Recurrente_Pct?: number
        Detalle_Items_Cotizacion?: Array<{
          Codigo_Item?: string
          Nombre_Item?: string
          Descripcion?: string
          Cantidad?: number
          Modalidad?: string
          Es_Recurrente?: boolean
          Subtotal_UF?: number
          Subtotal_CLP?: number
        }>
      }>
    } | null
    const rec = body?.data?.[0]
    if (rec) {
      numero = String(rec.Numero_Cotizacion || "")
      estadoZoho = String(rec.Estado_Cotizacion || "")
      descuentoPct = Number(rec.Descuento_Recurrente_Pct ?? 0) || 0
      items = (rec.Detalle_Items_Cotizacion || []).map((it) => ({
        codigo: String(it.Codigo_Item || ""),
        nombre: String(it.Nombre_Item || it.Descripcion || it.Codigo_Item || "ítem"),
        cantidad: Number(it.Cantidad) || 1,
        modalidad: String(it.Modalidad || ""),
        recurrente: Boolean(it.Es_Recurrente),
        subtotalUF: Number(it.Subtotal_UF) || 0,
        subtotalCLP: Number(it.Subtotal_CLP) || 0,
      }))
    }
  } catch {
    // best-effort: el puntero solo ya sirve para conversar
  }
  return { puntero, numero, estadoZoho, descuentoPct, items }
}

export type CotizacionEncontrada = {
  quoteId: string
  /** Teléfono (solo dígitos) del contacto de la cotización. */
  contact: string
  numero: string
  empresa: string
  /** true si existe puntero de Vicky para esta cotización exacta (editable acá). */
  conPuntero: boolean
}

/**
 * Busca una cotización por su NÚMERO (ej. "COT400", "cot 400" o "400") en
 * Zoho y resuelve el contacto para abrirla en el editor. Prefiere el contact
 * del puntero de Vicky (formato canónico) cuando existe.
 */
export async function buscarCotizacionPorNumero(numeroRaw: string): Promise<CotizacionEncontrada | null> {
  const limpio = (numeroRaw || "").toUpperCase().replace(/\s+/g, "").replace(/[^A-Z0-9-]/g, "").slice(0, 20)
  if (!limpio) return null
  const candidatos = [...new Set([limpio, /^\d+$/.test(limpio) ? `COT${limpio}` : ""])].filter(Boolean)

  const token = await getZohoAccessToken()
  const enLista = candidatos.map((c) => `'${c}'`).join(",")
  const r = await fetch(`${ZOHO_API_DOMAIN}/crm/v3/coql`, {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      select_query: `select id, Numero_Cotizacion, Tel_fono_Contacto, Cuenta_Asociada.Account_Name from ${QUOTE_MODULE} where Numero_Cotizacion in (${enLista}) limit 1`,
    }),
    cache: "no-store",
  })
  const rows = r.ok
    ? (((await r.json().catch(() => null)) as { data?: Array<Record<string, string>> } | null)?.data ?? [])
    : []
  const row = rows[0]
  if (!row?.id) return null

  const quoteId = String(row.id)
  let contact = String(row.Tel_fono_Contacto || "").replace(/\D/g, "")
  let conPuntero = false
  // El puntero de Vicky manda sobre el teléfono de Zoho (formato canónico del
  // chat) y confirma que la cotización es editable desde acá.
  if (SUPABASE_URL && SUPABASE_KEY) {
    try {
      const pr = await fetch(
        `${SUPABASE_URL}/rest/v1/vic_v3_quote_pointers?quote_id=eq.${encodeURIComponent(quoteId)}&select=contact&limit=1`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, cache: "no-store" },
      )
      const prows = pr.ok ? ((await pr.json().catch(() => [])) as Array<{ contact: string }>) : []
      if (prows[0]?.contact) {
        contact = String(prows[0].contact).replace(/\D/g, "")
        conPuntero = true
      }
    } catch {}
  }
  if (!contact) return null
  return {
    quoteId,
    contact,
    numero: String(row.Numero_Cotizacion || limpio),
    empresa: String(row["Cuenta_Asociada.Account_Name"] || ""),
    conPuntero,
  }
}

/** Fallback para punteros con formato de contacto histórico (+56…, espacios):
 * match por los últimos 8 dígitos, igual que el resto del dashboard. */
async function punteroPorSufijo(contact: string): Promise<QuotePointer | null> {
  const sufijo = contact.replace(/\D/g, "").slice(-8)
  if (sufijo.length < 8 || !SUPABASE_URL || !SUPABASE_KEY) return null
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/vic_v3_quote_pointers?contact=like.*${sufijo}` +
        `&select=quote_id,deal_id,acceptance_url,pdf_url,total_clp,total_uf,updated_at,rut,empresa&order=updated_at.desc&limit=1`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, cache: "no-store" },
    )
    const rows = r.ok
      ? ((await r.json().catch(() => [])) as Array<{
          quote_id: string | null
          deal_id: string | null
          acceptance_url: string | null
          pdf_url: string | null
          total_clp: number | null
          total_uf: number | null
          updated_at: string | null
          rut: string | null
          empresa: string | null
        }>)
      : []
    const row = rows[0]
    if (!row?.quote_id) return null
    return {
      quoteId: row.quote_id,
      dealId: row.deal_id || "",
      acceptanceUrl: row.acceptance_url || "",
      pdfUrl: row.pdf_url || "",
      totalClp: row.total_clp,
      totalUf: row.total_uf,
      updatedAt: row.updated_at || "",
      rut: row.rut || "",
      empresa: row.empresa || "",
    }
  } catch {
    return null
  }
}

function resumenEstadoParaModelo(e: EstadoCotizacion): string {
  const items = e.items.length
    ? e.items
        .map(
          (i) =>
            `- ${i.codigo || "?"} (${i.nombre}) · cantidad ${i.cantidad}` +
            `${i.modalidad ? ` · modalidad ${i.modalidad}` : ""} · ${i.recurrente ? "recurrente/mes" : "pago único"}` +
            ` · subtotal UF ${i.subtotalUF}`,
        )
        .join("\n")
    : "(detalle de ítems no disponible — usa ver_cotizacion o pregunta al vendedor)"
  return [
    `Cotización ${e.numero || e.puntero.quoteId} de ${e.puntero.empresa || "empresa sin nombre"}${e.puntero.rut ? ` (RUT ${e.puntero.rut})` : ""} — quote_id interno Zoho: ${e.puntero.quoteId} (las tools operan siempre sobre esta cotización)`,
    `Estado en Zoho: ${e.estadoZoho || "desconocido"}${e.descuentoPct ? ` · descuento recurrente comiteado: ${e.descuentoPct}%` : ""}`,
    `Total con IVA: ${e.puntero.totalUf ? `UF ${e.puntero.totalUf}` : ""}${e.puntero.totalClp ? ` (~$${Math.round(e.puntero.totalClp).toLocaleString("es-CL")})` : ""}`,
    `Ítems actuales:`,
    items,
  ].join("\n")
}

function catalogoParaModelo(): string {
  const modulos = getModulosDisponiblesParaVicky()
    .map((m) => {
      const tiers = m.tiers
        .map((t) => `${t.minUsuarios}-${t.maxUsuarios}: ${t.modalidad === "fijo" ? `UF ${t.precioUF} fijo` : `UF ${t.precioUF}/usuario`}`)
        .join(" · ")
      return `- ${m.id} (${m.nombre}): ${tiers}`
    })
    .join("\n")
  const hardware = getHardwareDisponiblesParaVicky()
    .map(
      (h) =>
        `- ${h.id} (${h.displayName}): arriendo UF ${h.arriendoUF}/mes` +
        `${h.ventaUF ? ` · venta UF ${h.ventaUF}` : ""}`,
    )
    .join("\n")
  return `MÓDULOS disponibles (id → precio neto/mes):\n${modulos}\n\nHARDWARE disponible (id → precio neto):\n${hardware}`
}

// ── Tools del agente ────────────────────────────────────────────────────────

const verCotizacionSchema = {
  name: "ver_cotizacion",
  description:
    "Trae el estado ACTUAL de la cotización del contacto desde Zoho: número, estado, ítems (código, cantidad, modalidad, recurrente/único, subtotales UF) y links. Úsala si necesitas refrescar el detalle después de un cambio o si el resumen del contexto no basta.",
  input_schema: { type: "object" as const, properties: {} },
}

// Versión del schema de actualizar_cotizacion SOLO para el editor interno:
// agrega valor_uf (override del valor de la UF para los totales), que el
// schema de Vicky con clientes jamás expone.
const actualizarSchemaEditor = {
  ...actualizarCotizacionSchema,
  input_schema: {
    ...actualizarCotizacionSchema.input_schema,
    properties: {
      ...actualizarCotizacionSchema.input_schema.properties,
      valor_uf: {
        type: "number" as const,
        description:
          "OPCIONAL — valor en PESOS de 1 UF a usar para calcular el total en CLP (ej. 39500). Pásalo SOLO si el vendedor pide fijar un valor de UF distinto al del día; si no lo pasas, se usa la UF vigente automáticamente.",
        minimum: 20000,
        maximum: 80000,
      },
    },
  },
}

const aplicarDescuentoSchema = {
  name: "aplicar_descuento",
  description:
    "Aplica o avanza el DESCUENTO de la cotización con la escalera oficial de la cotizadora: escalones de 10% y 20% sobre el plan mensual, TOPE 20% (la instalación y el envío no tienen descuento). Pasa pct_objetivo = el % que pidió el vendedor: el servidor comitea el escalón que garantiza AL MENOS ese nivel, acotado al tope. El PDF se regenera (misma numeración, versión nueva) y el link de aceptación sigue vigente. El resultado trae el % REAL comiteado (ultimoEscalon.pct): informa SIEMPRE ese número al vendedor, y si difiere de lo pedido (ej. pidió 15% y quedó 20%, o pidió 30% y el tope es 20%) díselo sin vueltas. No sirve para REBAJAR un descuento ya comiteado (la escalera solo sube).",
  input_schema: {
    type: "object" as const,
    properties: {
      pct_objetivo: {
        type: "number" as const,
        description:
          "Porcentaje de descuento sobre el plan mensual que pidió el vendedor (ej. 20). Omítelo para avanzar simplemente al siguiente escalón.",
        minimum: 0,
        maximum: 40,
      },
    },
  },
}

const enviarAlClienteSchema = {
  name: "enviar_cotizacion_al_cliente",
  description:
    "Envía al CLIENTE, por el WhatsApp de Vicky, el PDF actualizado de la cotización más un mensaje corto tuyo. Úsala ÚNICAMENTE cuando el vendedor dé el OK explícito de enviar (\"mándasela\", \"envíala\", \"dale, que le llegue\"). NUNCA la llames por iniciativa propia ni junto con la edición en el mismo turno sin ese OK.",
  input_schema: {
    type: "object" as const,
    properties: {
      mensaje_para_cliente: {
        type: "string" as const,
        description:
          "Mensaje corto que acompaña el PDF, escrito con la voz de Vicky hacia el cliente: tuteo chileno neutro, cálido y directo, SIN la palabra 'Oye'. Menciona que la cotización quedó actualizada y que el link de aceptación es el mismo.",
        minLength: 10,
        maxLength: 600,
      },
    },
    required: ["mensaje_para_cliente"],
  },
}

/** Refresco del puntero tras una tool que regenera PDF/links/totales — mismo
 * merge que hace el agent-loop (setQuotePointer es upsert completo: sin el
 * merge, los campos no pasados se pisan con null). */
async function refrescarPuntero(
  contact: string,
  quoteId: string,
  cambios: { acceptanceUrl?: string; pdfUrl?: string; totalClp?: number; totalUf?: number },
): Promise<void> {
  const prevs = await getQuotePointers(contact).catch(() => [])
  const prev = prevs.find((p) => p.quoteId === quoteId) || null
  await setQuotePointer(contact, {
    quoteId,
    dealId: prev?.dealId || undefined,
    acceptanceUrl: cambios.acceptanceUrl || prev?.acceptanceUrl || undefined,
    pdfUrl: cambios.pdfUrl || prev?.pdfUrl || undefined,
    totalClp: cambios.totalClp ?? prev?.totalClp ?? undefined,
    totalUf: cambios.totalUf ?? prev?.totalUf ?? undefined,
    rut: prev?.rut || undefined,
    empresa: prev?.empresa || undefined,
  }).catch(() => {})
}

export type EventoCoted = { tool: string; ok: boolean; resumen: string }

export type ChatCotedResultado = {
  reply: string
  eventos: EventoCoted[]
  enviadoAlCliente: boolean
}

/**
 * Un turno del chat interno de edición de cotizaciones: corre el loop de tool
 * use y devuelve la respuesta para el vendedor + los eventos de tools (para
 * pintarlos como chips en el chat del dashboard).
 */
export async function chatVickyCotizaciones(params: {
  contact: string
  historial: Array<{ role: "user" | "assistant"; content: string }>
  mensaje: string
  /** Cotización específica a editar (búsqueda por número). Default: la más reciente. */
  quoteId?: string
}): Promise<ChatCotedResultado> {
  const { contact, historial, mensaje, quoteId } = params
  const apiKey = (process.env.ANTHROPIC_API_KEY || "").trim()
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY no configurada")

  const estado = await estadoCotizacion(contact, quoteId)
  if (!estado) throw new Error("Este contacto no tiene cotización formal registrada.")

  const system = [
    `Eres "Vicky Cotizaciones", la herramienta interna de GeoVictoria con la que un VENDEDOR edita la cotización formal de un cliente. Hablas con el vendedor, NO con el cliente: tono directo, profesional y breve, de colega a colega (español de Chile, sin jerga). Nunca uses la palabra "Oye" para dirigirte a nadie.`,
    ``,
    `CONTEXTO — cotización vigente del contacto +${contact}:`,
    resumenEstadoParaModelo(estado),
    ``,
    catalogoParaModelo(),
    ``,
    `CÓMO TRABAJAS:`,
    `1. El vendedor te pide cambios (dotación, agregar/quitar reloj, módulos, puntos de instalación). Aplícalos DE INMEDIATO con actualizar_cotizacion — sin pedir confirmación extra al vendedor (él ya es la confirmación). Pasa SIEMPRE la configuración COMPLETA final: parte de los ítems actuales del contexto y aplica el cambio pedido encima. AGREGAR o QUITAR cualquier ítem (módulos, relojes, instalación) SIEMPRE es posible por esta vía — jamás digas que "no hay soporte" para modificar un ítem ni derives a Zoho por eso. Si la cotizadora devuelve un error genérico, REINTENTA una vez con la misma configuración; si persiste, muestra al vendedor el error textual y sugiere reintentar en unos minutos (a Zoho manual solo si la cotización está Aceptada).`,
    `2. Reconstrucción de la configuración: los ítems con código de módulo (asistencia, vacaciones, …) van en "modulos"; los ítems con código de hardware van en "hardware" (respeta su modalidad arriendo/venta y cantidad actuales salvo que el vendedor pida cambiarlas); la dotación (userCount) es la Cantidad del ítem asistencia — si su modalidad es "Fijo" es el plan fijo (1-10): usa la dotación que te diga el vendedor o, si no la menciona y no la puedes deducir, pregúntasela. Los ítems de envío/instalación NO se pasan: se derivan de "puntosInstalacion" (uno por punto físico; si la cotización tiene reloj y no conoces la comuna del punto, pregúntala al vendedor antes de actualizar).`,
    `3. INSTALACIÓN DEL RELOJ — sentido EXACTO, no lo inviertas (error real del 07-ago): "el cliente lo instala él mismo / lo va a instalar el cliente / auto-instalación / sin visita técnica" → autoInstalada: true → NO se cobra instalación (el envío SÍ se cobra igual, el equipo se despacha de todas formas). "lo instala GeoVictoria / que vayan a instalarlo / con instalación" → autoInstalada: false → la instalación se cobra según zona. Después de CUALQUIER cambio de instalación o hardware, llama ver_cotizacion y verifica en los ítems que la línea de instalación quedó o desapareció según corresponde ANTES de responderle al vendedor; si quedó mal, corrige de inmediato con otra actualización.`,
    `4. Después de cada actualización exitosa, resume al vendedor en 2-3 líneas qué quedó: dotación, ítems y total nuevo (UF y pesos aprox). El link de aceptación NO cambia y el PDF se regenera solo.`,
    `4. Descuentos (el vendedor SÍ puede pedirlos): usa aplicar_descuento con pct_objetivo = el % que pidió. La escalera oficial comitea escalones de 10% y 20% sobre el plan mensual, TOPE 20% (instalación y envío no tienen descuento); el servidor aplica el escalón que garantiza al menos lo pedido, acotado al tope. Informa SIEMPRE el % real comiteado y, si difiere de lo pedido, dilo sin vueltas. El descuento comiteado sobrevive a ediciones de configuración posteriores y la escalera no baja descuentos ya comiteados.`,
    `5. Valor de la UF: por defecto los totales en pesos usan la UF del día automáticamente. Si el vendedor pide fijar otro valor ("usa la UF a $39.500"), pásalo en valor_uf de actualizar_cotizacion y menciona en tu resumen qué valor de UF se usó. OJO: una edición posterior sin valor_uf recalcula con la UF del día — si el vendedor quiere mantener el valor fijado, vuelve a pasarlo en cada edición.`,
    `6. Enviar al cliente: SOLO cuando el vendedor dé el OK explícito, usa enviar_cotizacion_al_cliente. Antes de eso, el cliente no se entera de nada.`,
    ``,
    `LÍMITES (sé transparente con el vendedor):`,
    `- Descuentos: solo por la escalera oficial (tope 20% sobre el plan mensual). Un % fuera de escalera o sobre el tope requiere gestión del ejecutivo en Zoho.`,
    `- Cotizaciones Aceptadas/pagadas: no se pueden editar (la tool lo rechazará); los ajustes post-aceptación los coordina el ejecutivo.`,
    `- Solo cotizaciones de la línea Chile (catálogo en UF). Máximo 50 trabajadores.`,
    `- No inventes precios ni totales: todo número sale de las tools o del contexto.`,
  ].join("\n")

  const client = new Anthropic({ apiKey })
  const model = (process.env.ANTHROPIC_COTED_MODEL || process.env.ANTHROPIC_SALES_AGENT_MODEL_V3 || DEFAULT_MODEL).trim()

  const tools = [
    verCotizacionSchema,
    actualizarSchemaEditor,
    aplicarDescuentoSchema,
    enviarAlClienteSchema,
  ] as unknown as Anthropic.Messages.Tool[]

  const messages: Anthropic.Messages.MessageParam[] = [
    ...historial
      .filter((m) => (m.role === "user" || m.role === "assistant") && String(m.content || "").trim())
      .slice(-30)
      .map((m) => ({ role: m.role, content: String(m.content).slice(0, 6000) })),
    { role: "user" as const, content: mensaje },
  ]

  const eventos: EventoCoted[] = []
  let enviadoAlCliente = false
  let reply = ""

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const res = await client.messages.create({
      model,
      max_tokens: MAX_TOKENS,
      system,
      messages,
      tools,
    })

    const textos = res.content.filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    if (textos.length) reply = textos.map((b) => b.text).join("\n").trim()

    const toolUses = res.content.filter(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
    )
    if (!toolUses.length || res.stop_reason !== "tool_use") break

    messages.push({ role: "assistant", content: res.content })
    const results: Anthropic.Messages.ToolResultBlockParam[] = []
    for (const tu of toolUses) {
      let output: unknown
      try {
        if (tu.name === "ver_cotizacion") {
          const e = await estadoCotizacion(contact, estado.puntero.quoteId)
          output = e
            ? { ok: true, resumen: resumenEstadoParaModelo(e), pdfUrl: e.puntero.pdfUrl, acceptanceUrl: e.puntero.acceptanceUrl }
            : { ok: false, error: "Sin cotización registrada para este contacto." }
          eventos.push({ tool: tu.name, ok: !!e, resumen: "Estado de la cotización consultado en Zoho" })
        } else if (tu.name === "actualizar_cotizacion") {
          const input = tu.input as ActualizarCotizacionInput & { valor_uf?: number }
          // El editor está fijado a UNA cotización: el quote_id que proponga el
          // modelo se IGNORA (bug 07-ago: pasó el NÚMERO "COT403" en vez del id
          // interno de Zoho y la cotizadora no encontraba el registro).
          const qid = estado.puntero.quoteId
          const r = await actualizarCotizacion({
            ...input,
            quote_id: qid,
            ufValor: typeof input.valor_uf === "number" && input.valor_uf > 0 ? input.valor_uf : undefined,
          })
          output = r
          eventos.push({
            tool: tu.name,
            ok: r.ok,
            resumen: r.ok
              ? `Cotización actualizada (v${r.version}) · total UF ${r.totalUF} (~$${r.totalCLP.toLocaleString("es-CL")})`
              : `No se pudo actualizar: ${r.error.slice(0, 160)}`,
          })
          if (r.ok) await refrescarPuntero(contact, qid, { acceptanceUrl: r.acceptanceUrl, totalClp: r.totalCLP, totalUf: r.totalUF })
        } else if (tu.name === "aplicar_descuento") {
          const input = tu.input as { pct_objetivo?: number }
          const r = await aplicarSiguienteDescuento({
            quote_id: estado.puntero.quoteId,
            pct_ofrecido: typeof input?.pct_objetivo === "number" && input.pct_objetivo > 0 ? input.pct_objetivo : undefined,
          })
          output = r
          if (r.ok) {
            eventos.push({
              tool: tu.name,
              ok: true,
              resumen: `Descuento comiteado: ${r.ultimoEscalon.pct}% sobre el plan mensual${r.topeAlcanzado ? " (tope alcanzado)" : ""} · PDF v${r.version}`,
            })
            await refrescarPuntero(contact, estado.puntero.quoteId, { acceptanceUrl: r.acceptanceUrl, pdfUrl: r.linkPdf })
          } else {
            eventos.push({ tool: tu.name, ok: false, resumen: `No se pudo aplicar el descuento: ${r.error.slice(0, 160)}` })
          }
        } else if (tu.name === "enviar_cotizacion_al_cliente") {
          const input = tu.input as { mensaje_para_cliente: string }
          // Se envía la cotización EN EDICIÓN, no la más reciente del contacto.
          const envio = await enviarCotizacionWhatsapp({ quote_id: estado.puntero.quoteId, _contact: contact })
          if (envio.ok) {
            const texto = String(input.mensaje_para_cliente || "").trim()
            if (texto) await sendBotmakerMessage(contact, texto)
            enviadoAlCliente = true
            output = { ok: true, detalle: "PDF y mensaje enviados al cliente por WhatsApp." }
            eventos.push({ tool: tu.name, ok: true, resumen: "Cotización enviada al cliente por WhatsApp 📤" })
          } else {
            output = envio
            eventos.push({ tool: tu.name, ok: false, resumen: `Envío falló: ${envio.error.slice(0, 160)}` })
          }
        } else {
          output = { ok: false, error: `Tool desconocida: ${tu.name}` }
        }
        // Diagnóstico: los fallos de tools quedan en los logs con su input
        // (el chat solo muestra el error corto — caso instalación 07-ago).
        if ((output as { ok?: boolean } | null)?.ok === false) {
          console.warn(`[coted] ${tu.name} falló para ${contact}:`, JSON.stringify({ input: tu.input, output }).slice(0, 1500))
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        output = { ok: false, error: msg.slice(0, 300) }
        eventos.push({ tool: tu.name, ok: false, resumen: `Error: ${msg.slice(0, 160)}` })
      }
      results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(output).slice(0, 8000) })
    }
    messages.push({ role: "user", content: results })
  }

  return { reply: reply || "No tengo respuesta — intenta de nuevo.", eventos, enviadoAlCliente }
}
