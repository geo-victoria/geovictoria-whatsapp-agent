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

import { getKvValue, getQuotePointers, setQuotePointer, type QuotePointer } from "@/lib/supabase-persistence-v3"
import { getZohoAccessToken } from "@/lib/zoho-token"
import {
  actualizarCotizacion,
  actualizarCotizacionSchema,
  type ActualizarCotizacionInput,
} from "@/lib/tools/actualizar-cotizacion"
import { enviarCotizacionWhatsapp } from "@/lib/tools/enviar-cotizacion-whatsapp"
import { definirDescuentoEjecutivo } from "@/lib/tools/definir-descuento-ejecutivo"
import { generarLinkCotizadora } from "@/lib/tools/generar-link-cotizadora"
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
  /** Vigencia del descuento del plan: null = política por defecto (6 meses), 0 = indefinido. */
  descuentoMeses: number | null
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
  const base =
    (quoteId ? punteros.find((p) => p.quoteId === quoteId) : undefined) ??
    punteros[0] ??
    (await punteroPorSufijo(contact))
  if (!base) return null
  const puntero: QuotePointer = { ...base }

  let numero = ""
  let estadoZoho = ""
  let descuentoPct = 0
  let items: ItemCotizacion[] = []
  // Vigencia del descuento de ESTA cotización (Lalo 10-ago). Vive en vic_kv
  // porque el cotizador no tiene credenciales de este Supabase; acá se lee
  // directo. null = política por defecto.
  const mesesCrudo = await getKvValue(`descuento_meses_${puntero.quoteId}`).catch(() => "")
  const descuentoMeses = mesesCrudo === "" || mesesCrudo === null ? null : Number(mesesCrudo)
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
        PDF_URL?: string
        URL_Aceptacion_Web?: string
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
      // Los LINKS de Zoho mandan sobre el puntero: el PDF se regenera en
      // segundo plano tras cada edición y el puntero queda apuntando a la
      // versión vieja (caso UF 41.000, 07-ago: el panel mostraba el v4).
      const pdfZoho = String(rec.PDF_URL || "")
      const accZoho = String(rec.URL_Aceptacion_Web || "")
      if ((pdfZoho && pdfZoho !== puntero.pdfUrl) || (accZoho && accZoho !== puntero.acceptanceUrl)) {
        if (pdfZoho) puntero.pdfUrl = pdfZoho
        if (accZoho) puntero.acceptanceUrl = accZoho
        await refrescarPuntero(contact, puntero.quoteId, {
          pdfUrl: pdfZoho || undefined,
          acceptanceUrl: accZoho || undefined,
        })
      }
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
  return {
    puntero,
    numero,
    estadoZoho,
    descuentoPct,
    descuentoMeses: Number.isFinite(descuentoMeses as number) ? (descuentoMeses as number) : null,
    items,
  }
}

/**
 * Envío directo al cliente (botón del panel, sin pasar por el chat): PDF
 * vigente por el WhatsApp de Vicky + mensaje corto con su voz.
 */
export async function enviarCotizacionAlClienteDirecto(
  contact: string,
  quoteId?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const estado = await estadoCotizacion(contact, quoteId)
  if (!estado) return { ok: false, error: "Este contacto no tiene cotización formal registrada." }
  const envio = await enviarCotizacionWhatsapp({ quote_id: estado.puntero.quoteId, _contact: contact })
  if (!envio.ok) return { ok: false, error: envio.error }
  await sendBotmakerMessage(
    contact,
    "Te comparto la cotización actualizada en PDF 📄 El link de aceptación es el mismo de siempre — ahí ya aparece todo al día para revisarla y aceptarla. Cualquier duda, aquí estoy.",
  ).catch(() => {})
  return { ok: true }
}

// ── MODO CREACIÓN (pedido Lalo 07-ago): cotización nueva sobre un deal ──────

export type InfoDeal = {
  dealId: string
  nombre: string
  stage: string
  ownerId: string
  ownerNombre: string
  accountId: string
  accountNombre: string
  contactId: string
  contactoNombre: string
  /** Teléfono del contacto en dígitos (con 56 normalizado); "" si no hay. */
  telefono: string
  email: string
  rut: string
}

/** Ficha del deal elegido + su cuenta y contacto (teléfono/email/RUT), para
 * sembrar la creación sin duplicar registros. */
export async function infoDeal(dealId: string): Promise<InfoDeal | null> {
  try {
    const token = await getZohoAccessToken()
    const h = { Authorization: `Zoho-oauthtoken ${token}` }
    const r = await fetch(`${ZOHO_API_DOMAIN}/crm/v3/Deals/${dealId}`, { headers: h, cache: "no-store" })
    const rec = ((await r.json().catch(() => null)) as { data?: Array<Record<string, unknown>> } | null)?.data?.[0]
    if (!rec) return null
    const look = (v: unknown): { id: string; name: string } => {
      const o = (v || {}) as { id?: string; name?: string }
      return { id: String(o.id || ""), name: String(o.name || "") }
    }
    const cuenta = look(rec.Account_Name)
    const contacto = look(rec.Contact_Name)
    const owner = look(rec.Owner)
    let telefono = ""
    let email = ""
    if (contacto.id) {
      const rc = await fetch(`${ZOHO_API_DOMAIN}/crm/v3/Contacts/${contacto.id}?fields=Phone,Mobile,Email`, {
        headers: h,
        cache: "no-store",
      })
      const c = ((await rc.json().catch(() => null)) as {
        data?: Array<{ Phone?: string; Mobile?: string; Email?: string }>
      } | null)?.data?.[0]
      telefono = String(c?.Mobile || c?.Phone || "").replace(/\D/g, "")
      if (telefono.length === 9 && telefono.startsWith("9")) telefono = `56${telefono}`
      email = String(c?.Email || "")
    }
    // RUT de la cuenta: el nombre exacto del campo varía entre layouts — se
    // toma la primera clave que parezca RUT con valor string no vacío.
    let rut = ""
    if (cuenta.id) {
      const ra = await fetch(`${ZOHO_API_DOMAIN}/crm/v3/Accounts/${cuenta.id}`, { headers: h, cache: "no-store" })
      const a = ((await ra.json().catch(() => null)) as { data?: Array<Record<string, unknown>> } | null)?.data?.[0]
      if (a) {
        for (const k of Object.keys(a)) {
          if (/rut/i.test(k) && typeof a[k] === "string" && String(a[k]).trim()) {
            rut = String(a[k]).trim()
            break
          }
        }
      }
    }
    return {
      dealId,
      nombre: String(rec.Deal_Name || ""),
      stage: String(rec.Stage || ""),
      ownerId: owner.id,
      ownerNombre: owner.name,
      accountId: cuenta.id,
      accountNombre: cuenta.name,
      contactId: contacto.id,
      contactoNombre: contacto.name,
      telefono,
      email,
      rut,
    }
  } catch {
    return null
  }
}

const crearCotizacionSchema = {
  name: "crear_cotizacion",
  description:
    "Emite la cotización formal NUEVA amarrada a la oportunidad (deal) del contexto: reusa su cuenta y su contacto en Zoho (cero duplicados), el dueño queda el del deal, se genera el PDF y el link de aceptación, y si el contacto tiene correo se le envía automáticamente. Pasa la configuración COMPLETA. Llámala apenas tengas los datos mínimos: RUT válido, dotación (1-8000) y módulos (asistencia siempre); hardware y puntos de instalación solo si el vendedor quiere reloj.",
  input_schema: {
    type: "object" as const,
    properties: {
      empresa: { type: "string" as const, description: "Razón social. Omítela para usar el nombre de la cuenta del deal." },
      contacto: { type: "string" as const, description: "Nombre de la persona de contacto. Omítelo para usar el del deal." },
      contactoEmail: { type: "string" as const, description: "Email del contacto. Omítelo para usar el de la ficha." },
      rutEmpresa: { type: "string" as const, description: "RUT de la empresa (con dígito verificador). Omítelo solo si la ficha ya trae RUT." },
      userCount: { type: "integer" as const, minimum: 1, maximum: 8000, description: "Dotación (1-8000, tramos del catálogo comercial)." },
      modulos: { type: "array" as const, items: { type: "string" as const }, minItems: 1, description: "IDs de módulos. Siempre incluir 'asistencia'." },
      hardware: {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: {
            id: { type: "string" as const },
            cantidad: { type: "integer" as const, minimum: 1 },
            modalidad: { type: "string" as const, enum: ["arriendo", "venta"] },
          },
          required: ["id"],
        },
      },
      puntosInstalacion: {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: {
            ubicacion: { type: "string" as const },
            autoInstalada: { type: "boolean" as const },
          },
          required: ["ubicacion"],
        },
        description: "Obligatorio si hay hardware: un punto por lugar físico. Basta 'RM' o 'Región' como ubicación (como la calculadora comercial) — NO exijas comuna; si el vendedor da la comuna, mejor (afina la tarifa de instalación).",
      },
      direccionEmpresa: { type: "string" as const },
      comunaEmpresa: { type: "string" as const },
      regionEmpresa: { type: "string" as const },
    },
    required: ["userCount", "modulos"],
  },
}

export type ChatCrearResultado = {
  reply: string
  eventos: EventoCoted[]
  creado?: { quoteId: string; contact: string }
}

/** Un turno del chat de CREACIÓN de cotización sobre un deal elegido. */
export async function chatVickyCotizacionesCrear(params: {
  dealId: string
  historial: Array<{ role: "user" | "assistant"; content: string }>
  mensaje: string
}): Promise<ChatCrearResultado> {
  const { dealId, historial, mensaje } = params
  const apiKey = (process.env.ANTHROPIC_API_KEY || "").trim()
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY no configurada")
  const info = await infoDeal(dealId)
  if (!info) throw new Error("No se pudo leer la oportunidad en Zoho.")

  const system = [
    `Eres "Vicky Cotizaciones" en modo CREACIÓN: un VENDEDOR de GeoVictoria va a emitir una cotización formal nueva sobre una oportunidad ya existente en Zoho. Hablas con el vendedor, no con el cliente: tono directo de colega, español de Chile.`,
    ``,
    `OPORTUNIDAD ELEGIDA (deal Zoho ${info.dealId}):`,
    `- Deal: ${info.nombre || "(sin nombre)"} · etapa: ${info.stage || "?"} · dueño: ${info.ownerNombre || "?"}`,
    `- Cuenta: ${info.accountNombre || "(sin cuenta)"}${info.rut ? ` · RUT ficha: ${info.rut}` : " · RUT: no está en la ficha"}`,
    `- Contacto: ${info.contactoNombre || "(sin contacto)"}${info.telefono ? ` · +${info.telefono}` : " · SIN teléfono"}${info.email ? ` · ${info.email}` : " · sin email"}`,
    ``,
    catalogoParaModelo(),
    ``,
    `CÓMO TRABAJAS:`,
    `1. EL VENDEDOR MANDA. Reúne SOLO lo mínimo que falte para emitir: RUT válido (si la ficha no trae), dotación (1-8000) y módulos (asistencia es la base; agrega otros solo si los pide); reloj y puntos de instalación solo si quiere hardware. Para la zona de un punto BASTA "RM" o "Región" (no exijas comuna ni dirección — si el vendedor la da, afina la tarifa). Pide todo lo que falte JUNTO, en un solo mensaje corto.`,
    `2. Con los datos listos llama crear_cotizacion de inmediato — sin confirmaciones extra. La cotización nace amarrada a ESTE deal, su cuenta y su contacto (cero duplicados) y con el dueño del deal.`,
    `3. Tras crear, informa número interno/total/links en 2-3 líneas y avisa que se abrirá el editor de esa cotización para ajustes o envío. Si falló, muestra el error textual y reintenta una vez si fue un error genérico.`,
    ``,
    `LÍMITES: solo línea Chile (UF), 1-8000 trabajadores (sobre 50 rigen los tramos del catálogo comercial; algunos módulos como vacaciones aún no tienen precio sobre 50 — la tool avisa con advertencias), precios del catálogo (los ajustes finos se hacen después en el editor). No inventes RUT ni datos: lo que falte se pregunta.`,
  ].join("\n")

  const client = new Anthropic({ apiKey })
  const model = (process.env.ANTHROPIC_COTED_MODEL || process.env.ANTHROPIC_SALES_AGENT_MODEL_V3 || DEFAULT_MODEL).trim()
  const messages: Anthropic.Messages.MessageParam[] = [
    ...historial
      .filter((m) => (m.role === "user" || m.role === "assistant") && String(m.content || "").trim())
      .slice(-30)
      .map((m) => ({ role: m.role, content: String(m.content).slice(0, 6000) })),
    { role: "user" as const, content: mensaje },
  ]

  const eventos: EventoCoted[] = []
  let creado: ChatCrearResultado["creado"]
  let reply = ""
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const res = await client.messages.create({
      model,
      max_tokens: MAX_TOKENS,
      system,
      messages,
      tools: [crearCotizacionSchema] as unknown as Anthropic.Messages.Tool[],
    })
    const textos = res.content.filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    if (textos.length) reply = textos.map((b) => b.text).join("\n").trim()
    const toolUses = res.content.filter((b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use")
    if (!toolUses.length || res.stop_reason !== "tool_use") break
    messages.push({ role: "assistant", content: res.content })
    const results: Anthropic.Messages.ToolResultBlockParam[] = []
    for (const tu of toolUses) {
      let output: unknown
      try {
        const input = tu.input as {
          empresa?: string
          contacto?: string
          contactoEmail?: string
          rutEmpresa?: string
          userCount: number
          modulos: string[]
          hardware?: Array<{ id: string; cantidad?: number; modalidad?: "arriendo" | "venta" }>
          puntosInstalacion?: Array<{ ubicacion: string; autoInstalada?: boolean }>
          direccionEmpresa?: string
          comunaEmpresa?: string
          regionEmpresa?: string
        }
        const r = await generarLinkCotizadora({
          empresa: (input.empresa || info.accountNombre || info.nombre || "").trim(),
          contacto: (input.contacto || info.contactoNombre || "Contacto").trim(),
          contactoEmail: (input.contactoEmail || info.email || "").trim() || undefined,
          contactoTelefono: info.telefono,
          rutEmpresa: (input.rutEmpresa || info.rut || "").trim(),
          direccionEmpresa: input.direccionEmpresa,
          comunaEmpresa: input.comunaEmpresa,
          regionEmpresa: input.regionEmpresa,
          userCount: input.userCount,
          // Canal ejecutivo: el editor cotiza el rango completo de la
          // calculadora de Nacho (Lalo 10-ago) — Vicky chat sigue en 50.
          _maxUsuariosOverride: 8000,
          _zonaGenericaOk: true,
          sectorEmpresa: "",
          modulos: input.modulos,
          hardware: input.hardware,
          puntosInstalacion: (input.puntosInstalacion || []).map((p) => ({
            ubicacion: p.ubicacion,
            autoInstalada: p.autoInstalada === true,
          })),
          // Amarre a la oportunidad elegida: mismo deal, cuenta y contacto.
          _draftDealId: info.dealId,
          _draftAccountId: info.accountId || undefined,
          _draftContactId: info.contactId || undefined,
          _ownerOverrideId: info.ownerId || undefined,
        })
        output = r
        if (r.ok) {
          eventos.push({
            tool: tu.name,
            ok: true,
            resumen: `Cotización creada · total UF ${r.totalUF} (~$${r.totalCLP.toLocaleString("es-CL")}) · asociada al deal`,
          })
          if (info.telefono) {
            await setQuotePointer(info.telefono, {
              quoteId: r.quoteId,
              dealId: r.dealId || info.dealId,
              acceptanceUrl: r.acceptanceUrl,
              pdfUrl: r.pdfUrl,
              totalClp: r.totalCLP,
              totalUf: r.totalUF,
              rut: (tu.input as { rutEmpresa?: string }).rutEmpresa || info.rut || undefined,
              empresa: (tu.input as { empresa?: string }).empresa || info.accountNombre || undefined,
            }).catch(() => {})
            creado = { quoteId: r.quoteId, contact: info.telefono }
          }
        } else {
          eventos.push({ tool: tu.name, ok: false, resumen: `No se pudo crear: ${r.error.slice(0, 160)}` })
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        output = { ok: false, error: msg.slice(0, 300) }
        eventos.push({ tool: tu.name, ok: false, resumen: `Error: ${msg.slice(0, 160)}` })
      }
      if ((output as { ok?: boolean } | null)?.ok === false) {
        console.warn(`[coted-crear] ${tu.name} falló para deal ${dealId}:`, JSON.stringify({ input: tu.input, output }).slice(0, 1500))
      }
      results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(output).slice(0, 8000) })
    }
    messages.push({ role: "user", content: results })
  }
  return { reply: reply || "No tengo respuesta — intenta de nuevo.", eventos, creado }
}

// ── MODO PREFORM (pedido Lalo 07-ago): formal directa desde la conversación ──
// El contacto vio un precio referencial en el chat pero NO tiene cotización
// formal. El editor abre YA con ese contexto (transcripción + lead de Zoho)
// para que el vendedor ajuste lo que quiera y emita la formal de inmediato.

async function transcripcionPreform(contact: string): Promise<string> {
  try {
    const conv = await fetch(
      `${SUPABASE_URL}/rest/v1/vic_v3_conversations?contact=eq.${encodeURIComponent(contact)}&select=id&order=started_at.desc&limit=1`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, cache: "no-store" },
    ).then((r) => (r.ok ? r.json() : [])) as Array<{ id: string }>
    if (!conv[0]?.id) return ""
    const msgs = (await fetch(
      `${SUPABASE_URL}/rest/v1/vic_v3_messages?conversation_id=eq.${conv[0].id}&select=role,content&order=at.desc&limit=30`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, cache: "no-store" },
    ).then((r) => (r.ok ? r.json() : []))) as Array<{ role: string; content: string }>
    return msgs
      .reverse()
      .map((m) => `${m.role === "user" ? "Cliente" : "Vicky"}: ${String(m.content || "").slice(0, 320)}`)
      .join("\n")
  } catch {
    return ""
  }
}

async function leadPorFono(contact: string): Promise<{ nombre: string; empresa: string; email: string } | null> {
  try {
    const token = await getZohoAccessToken()
    const r = await fetch(
      `${ZOHO_API_DOMAIN}/crm/v3/Leads/search?phone=${encodeURIComponent(contact)}&converted=both&per_page=1&fields=Full_Name,Company,Email`,
      { headers: { Authorization: `Zoho-oauthtoken ${token}` }, cache: "no-store" },
    )
    if (!r.ok || r.status === 204) return null
    const l = ((await r.json().catch(() => ({}))) as { data?: Array<{ Full_Name?: string; Company?: string; Email?: string }> }).data?.[0]
    if (!l) return null
    return { nombre: String(l.Full_Name || "").trim(), empresa: String(l.Company || "").trim(), email: String(l.Email || "").trim() }
  } catch {
    return null
  }
}

export async function chatVickyCotizacionesPreform(params: {
  contact: string
  historial: Array<{ role: "user" | "assistant"; content: string }>
  mensaje: string
}): Promise<ChatCrearResultado> {
  const { contact, historial, mensaje } = params
  const apiKey = (process.env.ANTHROPIC_API_KEY || "").trim()
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY no configurada")
  const [transcripcion, lead] = await Promise.all([transcripcionPreform(contact), leadPorFono(contact)])
  if (!transcripcion) throw new Error("Este contacto no tiene conversación registrada con Vicky.")

  const system = [
    `Eres "Vicky Cotizaciones" en modo PREFORM: el cliente conversó con Vicky por WhatsApp y vio un precio referencial, pero AÚN NO tiene cotización formal. Un VENDEDOR va a emitirla ahora contigo. Hablas con el vendedor, no con el cliente: tono directo de colega, español de Chile.`,
    ``,
    `DATOS DEL CLIENTE (+${contact}):`,
    `- Nombre: ${lead?.nombre || "(ver transcripción)"} · Empresa: ${lead?.empresa || "(ver transcripción)"} · Email: ${lead?.email || "(no registrado)"}`,
    ``,
    `TRANSCRIPCIÓN DE LA CONVERSACIÓN CON VICKY (la fuente de la configuración — dotación, módulos, reloj, comuna, y datos que el cliente ya entregó):`,
    transcripcion.slice(0, 7000),
    ``,
    catalogoParaModelo(),
    ``,
    `CÓMO TRABAJAS:`,
    `1. PARTE TÚ: en tu primer mensaje resume la configuración que reconstruiste de la transcripción (dotación, marcaje, puntos/comuna, precio referencial mostrado) y di exactamente qué falta para emitir (típicamente RUT y/o email). No re-preguntes lo que la transcripción ya responde.`,
    `2. EL VENDEDOR MANDA: puede cambiar cualquier cosa de la configuración antes de emitir. Pide lo que falte JUNTO, en un solo mensaje corto.`,
    `3. Con los datos completos llama crear_cotizacion de inmediato — sin confirmaciones extra. La emisión adopta el lead vivo del teléfono (cero duplicados) y sigue las reglas vigentes de asignación.`,
    `4. Tras crear, informa número/total/links en 2-3 líneas y avisa que se abrirá el editor para ajustes o envío. Si falló, muestra el error textual y reintenta una vez si fue genérico.`,
    ``,
    `LÍMITES: solo línea Chile (UF), 1-8000 trabajadores (sobre 50, tramos del catálogo comercial), precios del catálogo (ajustes finos después en el editor). El RUT se pasa TAL CUAL a la tool — tú no lo validas.`,
  ].join("\n")

  const client = new Anthropic({ apiKey })
  const model = (process.env.ANTHROPIC_COTED_MODEL || process.env.ANTHROPIC_SALES_AGENT_MODEL_V3 || DEFAULT_MODEL).trim()
  const messages: Anthropic.Messages.MessageParam[] = [
    ...historial
      .filter((m) => (m.role === "user" || m.role === "assistant") && String(m.content || "").trim())
      .slice(-30)
      .map((m) => ({ role: m.role, content: String(m.content).slice(0, 6000) })),
    { role: "user" as const, content: mensaje },
  ]

  const eventos: EventoCoted[] = []
  let creado: ChatCrearResultado["creado"]
  let reply = ""
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const res = await client.messages.create({
      model,
      max_tokens: MAX_TOKENS,
      system,
      messages,
      tools: [crearCotizacionSchema] as unknown as Anthropic.Messages.Tool[],
    })
    const textos = res.content.filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    if (textos.length) reply = textos.map((b) => b.text).join("\n").trim()
    const toolUses = res.content.filter((b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use")
    if (!toolUses.length || res.stop_reason !== "tool_use") break
    messages.push({ role: "assistant", content: res.content })
    const results: Anthropic.Messages.ToolResultBlockParam[] = []
    for (const tu of toolUses) {
      let output: unknown
      try {
        const input = tu.input as {
          empresa?: string
          contacto?: string
          contactoEmail?: string
          rutEmpresa?: string
          userCount: number
          modulos: string[]
          hardware?: Array<{ id: string; cantidad?: number; modalidad?: "arriendo" | "venta" }>
          puntosInstalacion?: Array<{ ubicacion: string; autoInstalada?: boolean }>
          direccionEmpresa?: string
          comunaEmpresa?: string
          regionEmpresa?: string
        }
        const r = await generarLinkCotizadora({
          empresa: (input.empresa || lead?.empresa || "").trim(),
          contacto: (input.contacto || lead?.nombre || "Contacto").trim(),
          contactoEmail: (input.contactoEmail || lead?.email || "").trim() || undefined,
          contactoTelefono: contact,
          rutEmpresa: (input.rutEmpresa || "").trim(),
          direccionEmpresa: input.direccionEmpresa,
          comunaEmpresa: input.comunaEmpresa,
          regionEmpresa: input.regionEmpresa,
          userCount: input.userCount,
          // Canal ejecutivo: el editor cotiza el rango completo de la
          // calculadora de Nacho (Lalo 10-ago) — Vicky chat sigue en 50.
          _maxUsuariosOverride: 8000,
          _zonaGenericaOk: true,
          sectorEmpresa: "",
          modulos: input.modulos,
          hardware: input.hardware,
          puntosInstalacion: (input.puntosInstalacion || []).map((p) => ({
            ubicacion: p.ubicacion,
            autoInstalada: p.autoInstalada === true,
          })),
        })
        output = r
        if (r.ok) {
          eventos.push({
            tool: tu.name,
            ok: true,
            resumen: `Cotización formal emitida · total UF ${r.totalUF} (~$${r.totalCLP.toLocaleString("es-CL")})`,
          })
          creado = { quoteId: r.quoteId, contact }
        } else {
          eventos.push({ tool: tu.name, ok: false, resumen: `No se pudo emitir: ${r.error.slice(0, 160)}` })
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
  return { reply: reply || "No tengo respuesta — intenta de nuevo.", eventos, creado }
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
    `Estado en Zoho: ${e.estadoZoho || "desconocido"}${
      e.descuentoPct
        ? ` · descuento recurrente comiteado: ${e.descuentoPct}% · vigencia: ${
            e.descuentoMeses === 0
              ? "INDEFINIDA (sin vencimiento)"
              : `${e.descuentoMeses ?? 6} meses${e.descuentoMeses === null ? " (por defecto)" : ""}`
          }`
        : ""
    }`,
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
      items_extra: {
        type: "array" as const,
        description:
          "Líneas MANUALES fuera del catálogo/tarifa que pida el vendedor (ej. 'instalación por 2 UF', un cargo especial, un ajuste a favor del cliente con monto negativo). monto_uf es NETO unitario en UF; recurrente true = mensual, omitido/false = pago único. Para REEMPLAZAR un cobro de tarifa por uno manual (ej. instalación a precio especial), anula el de tarifa (autoInstalada true en el punto) y agrega acá la línea manual. En ediciones posteriores estas líneas deben volver a pasarse (la configuración es completa).",
        items: {
          type: "object" as const,
          properties: {
            nombre: { type: "string" as const, description: "Nombre visible de la línea (ej. 'Instalación de reloj')." },
            monto_uf: { type: "number" as const, description: "Monto NETO unitario en UF (negativo = ajuste a favor).", minimum: -100, maximum: 500 },
            cantidad: { type: "integer" as const, minimum: 1, maximum: 100 },
            recurrente: { type: "boolean" as const, description: "true = cargo mensual; omitido/false = pago único." },
          },
          required: ["nombre", "monto_uf"],
        },
      },
      precios_override: {
        type: "array" as const,
        description:
          "Cambia el PRECIO UNITARIO de ítems del catálogo cuando el vendedor lo pida (ej. 'sube el arriendo del reloj a 0.43 UF' → {id:'senseface_2a', precio_unit_uf:0.43}). El subtotal del ítem pasa a ser precio × cantidad. id = código del ítem tal como aparece en el contexto (senseface_2a, asistencia, …); modalidad solo si el mismo id existe en más de una (arriendo/venta). En ediciones posteriores los overrides vigentes deben volver a pasarse.",
        items: {
          type: "object" as const,
          properties: {
            id: { type: "string" as const, description: "Código del ítem del catálogo a repreciar." },
            precio_unit_uf: { type: "number" as const, description: "Nuevo precio unitario NETO en UF.", minimum: 0, maximum: 500 },
            modalidad: { type: "string" as const, description: "Opcional: arriendo/venta/por usuario/fijo, si hay ambigüedad." },
          },
          required: ["id", "precio_unit_uf"],
        },
      },
    },
  },
}

const aplicarDescuentoSchema = {
  name: "aplicar_descuento",
  description:
    "Fija el DESCUENTO de la cotización EXACTAMENTE como lo pide el vendedor: el porcentaje que él diga sobre el plan mensual (se puede SUBIR, BAJAR o dejar en 0 para quitarlo) y la VIGENCIA en meses que él defina (1, 3, 6, los que quiera, o indefinido). Acá no hay escalera de escalones: lo que pide el vendedor es lo que se aplica, acotado solo por el tope interno (40%). Pasa pct y/o meses — lo que no pases, no se toca. El descuento y su vigencia sobreviven a ediciones de configuración posteriores. Informa SIEMPRE al vendedor el % y la vigencia que quedaron.",
  input_schema: {
    type: "object" as const,
    properties: {
      pct: {
        type: "number" as const,
        description:
          "Porcentaje EXACTO de descuento sobre el plan mensual que pidió el vendedor (ej. 10). 0 quita el descuento. Omítelo si el vendedor solo quiere cambiar la vigencia.",
        minimum: 0,
        maximum: 40,
      },
      meses: {
        type: "number" as const,
        description:
          "Meses de vigencia del descuento sobre el plan mensual: 1..24 los meses que pida el vendedor, o 0 para dejarlo INDEFINIDO (sin vencimiento). Omítelo si el vendedor no habló de plazo — se conserva la vigencia actual (por defecto 6 meses).",
        minimum: 0,
        maximum: 24,
      },
    },
  },
}

const confirmarVersionSchema = {
  name: "confirmar_version",
  description:
    "Genera LA versión definitiva del PDF con todos los cambios aplicados en esta sesión (una sola versión, no una por cambio) y actualiza el link en todos lados (Zoho, panel, WhatsApp). Úsala cuando el vendedor confirme que NO hay más cambios que hacer — pregúntale SIEMPRE '¿algo más que modificar?' después de aplicar cambios, y solo con su confirmación llama esta tool. Si responde que ya estaba al día, no había cambios pendientes.",
  input_schema: { type: "object" as const, properties: {} },
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
          "Mensaje corto que acompaña el PDF, escrito con la voz de Vicky hacia el cliente: tuteo chileno neutro, cálido y directo, sin interjecciones de apertura para dirigirse al cliente (regla de estilo de Eduardo). Menciona que la cotización quedó actualizada y que el link de aceptación es el mismo.",
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
    `Eres "Vicky Cotizaciones", la herramienta interna de GeoVictoria con la que un VENDEDOR edita la cotización formal de un cliente. Hablas con el vendedor, NO con el cliente: tono directo, profesional y breve, de colega a colega (español de Chile, sin jerga y sin interjecciones de apertura para dirigirte a nadie — regla de estilo de Eduardo).`,
    ``,
    `CONTEXTO — cotización vigente del contacto +${contact}:`,
    resumenEstadoParaModelo(estado),
    ``,
    catalogoParaModelo(),
    ``,
    `CÓMO TRABAJAS:`,
    `0. EL VENDEDOR MANDA — obedécele (orden de Lalo 07-ago). Si pide agregar, quitar o CAMBIAR cualquier cosa (ítems, montos, precios unitarios, cargos fuera de tarifa), se hace en el acto: precios_override cambia el precio de un ítem del catálogo (ej. "sube el arriendo del reloj a 0.43 UF" → {id:"senseface_2a", precio_unit_uf:0.43}); items_extra agrega líneas manuales con el monto que él diga (ej. "instalación por 2 UF" → punto con autoInstalada true para anular la tarifa + línea manual "Instalación de reloj" por 2 UF pago único). PROHIBIDO responder "no es posible", "los precios son fijos" o derivar a Zoho para un cambio de precio. A lo más UNA pregunta aclaratoria y solo si es imprescindible (ej. ¿mensual o pago único?); si el contexto lo sugiere, asume lo razonable y decláralo en tu resumen.`,
    `1. El vendedor te pide cambios (dotación, agregar/quitar reloj, módulos, puntos de instalación). Aplícalos DE INMEDIATO con actualizar_cotizacion — sin pedir confirmación extra al vendedor (él ya es la confirmación). Pasa SIEMPRE la configuración COMPLETA final: parte de los ítems actuales del contexto y aplica el cambio pedido encima — incluidos los overrides de precio y las líneas manuales vigentes (códigos ajuste_* o precios distintos al catálogo en el contexto: vuelve a pasarlos en precios_override/items_extra o se pierden). AGREGAR o QUITAR cualquier ítem (módulos, relojes, instalación) SIEMPRE es posible por esta vía — jamás digas que "no hay soporte" para modificar un ítem ni derives a Zoho por eso. Si la cotizadora devuelve un error genérico, REINTENTA una vez con la misma configuración; si persiste, muestra al vendedor el error textual y sugiere reintentar en unos minutos (a Zoho manual solo si la cotización está Aceptada).`,
    `2. Reconstrucción de la configuración: los ítems con código de módulo (asistencia, vacaciones, …) van en "modulos"; los ítems con código de hardware van en "hardware" (respeta su modalidad arriendo/venta y cantidad actuales salvo que el vendedor pida cambiarlas); la dotación (userCount) es la Cantidad del ítem asistencia — si su modalidad es "Fijo" es el plan fijo (1-10): usa la dotación que te diga el vendedor o, si no la menciona y no la puedes deducir, pregúntasela. Los ítems de envío/instalación NO se pasan: se derivan de "puntosInstalacion" (uno por punto físico; si la cotización tiene reloj y no conoces la comuna del punto, pregúntala al vendedor antes de actualizar).`,
    `3. INSTALACIÓN DEL RELOJ — sentido EXACTO, no lo inviertas (error real del 07-ago): "el cliente lo instala él mismo / lo va a instalar el cliente / auto-instalación / sin visita técnica" → autoInstalada: true → NO se cobra instalación (el envío SÍ se cobra igual, el equipo se despacha de todas formas). "lo instala GeoVictoria / que vayan a instalarlo / con instalación" → autoInstalada: false → la instalación se cobra según zona. Después de CUALQUIER cambio de instalación o hardware, llama ver_cotizacion y verifica en los ítems que la línea de instalación quedó o desapareció según corresponde ANTES de responderle al vendedor; si quedó mal, corrige de inmediato con otra actualización.`,
    `4. Después de cada actualización exitosa, resume al vendedor en 2-3 líneas qué quedó (dotación, ítems, total nuevo en UF y pesos aprox) y PREGUNTA SIEMPRE: "¿algo más que modificar?". Las ediciones NO generan versión de PDF — cuando el vendedor confirme que no hay más cambios, llama confirmar_version: ahí se genera LA versión definitiva (una sola por sesión de cambios) y el link queda actualizado en todos lados. El link de aceptación NO cambia nunca. NO envíes al cliente sin haber confirmado la versión primero.`,
    `4. Descuentos — ACÁ MANDA EL VENDEDOR, NO LA ESCALERA (Lalo 10-ago): usa aplicar_descuento con pct = el porcentaje EXACTO que pidió (10 es 10, no 20) y meses = la vigencia que defina. Se puede SUBIR, BAJAR o dejar en 0 para quitarlo; la vigencia puede ser 1, 3, 6 o los meses que él diga, y 0 significa INDEFINIDO (sin vencimiento). Si solo pide el %, no pases meses (se conserva la vigencia actual, por defecto 6 meses); si solo pide cambiar el plazo, pasa meses y omite pct. Único límite: el tope interno de 40%. Confirma siempre al vendedor cómo quedó (% y vigencia). El descuento y su vigencia sobreviven a ediciones de configuración posteriores. La escalera de escalones 10→20 es de cara al CLIENTE (la usa Vicky en el chat), no acá.`,
    `5. Valor de la UF: por defecto los totales en pesos usan la UF del día automáticamente. Si el vendedor pide fijar otro valor ("usa la UF a $39.500"), pásalo en valor_uf de actualizar_cotizacion y menciona en tu resumen qué valor de UF se usó. OJO: una edición posterior sin valor_uf recalcula con la UF del día — si el vendedor quiere mantener el valor fijado, vuelve a pasarlo en cada edición.`,
    `6. Enviar al cliente: SOLO cuando el vendedor dé el OK explícito, usa enviar_cotizacion_al_cliente. Antes de eso, el cliente no se entera de nada. Si el vendedor quiere verificar cómo quedó antes de enviar, indícale el botón "Vista previa del PDF" del panel (abre el PDF con los últimos cambios sin enviarle nada al cliente).`,
    ``,
    `LÍMITES (sé transparente con el vendedor):`,
    `- Descuentos: cualquier % entre 0 y 40 y cualquier vigencia (incluida indefinida). Sobre 40% sí requiere gestión del ejecutivo directamente en Zoho.`,
    `- Cotizaciones Aceptadas/pagadas: no se pueden editar (la tool lo rechazará); los ajustes post-aceptación los coordina el ejecutivo.`,
    `- Solo cotizaciones de la línea Chile (catálogo en UF). Máximo 50 trabajadores.`,
    `- No inventes precios ni totales: todo número sale de las tools o del contexto.`,
  ].join("\n")

  const client = new Anthropic({ apiKey })
  const model = (process.env.ANTHROPIC_COTED_MODEL || process.env.ANTHROPIC_SALES_AGENT_MODEL_V3 || DEFAULT_MODEL).trim()

  const tools = [
    verCotizacionSchema,
    actualizarSchemaEditor,
    confirmarVersionSchema,
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
        } else if (tu.name === "confirmar_version") {
          const { regenerarPdfFresco } = await import("@/lib/enviar-cotizacion-wa")
          const url = await regenerarPdfFresco(estado.puntero.quoteId)
          if (url) {
            eventos.push({ tool: tu.name, ok: true, resumen: "Versión definitiva del PDF generada y propagada 📄" })
            output = { ok: true, pdfUrl: url, detalle: "Versión nueva generada con todos los cambios; el link quedó actualizado en todos lados (Zoho, panel, WhatsApp)." }
          } else {
            eventos.push({ tool: tu.name, ok: true, resumen: "Sin cambios pendientes — el PDF vigente ya era la última versión" })
            output = { ok: true, detalle: "No había cambios sin versionar: el PDF vigente ya es la versión confirmada." }
          }
        } else if (tu.name === "actualizar_cotizacion") {
          const input = tu.input as ActualizarCotizacionInput & {
            valor_uf?: number
            items_extra?: Array<{ nombre: string; monto_uf: number; cantidad?: number; recurrente?: boolean }>
            precios_override?: Array<{ id: string; precio_unit_uf: number; modalidad?: string }>
          }
          // El editor está fijado a UNA cotización: el quote_id que proponga el
          // modelo se IGNORA (bug 07-ago: pasó el NÚMERO "COT403" en vez del id
          // interno de Zoho y la cotizadora no encontraba el registro).
          const qid = estado.puntero.quoteId
          const r = await actualizarCotizacion({
            ...input,
            quote_id: qid,
            // Flujo confirmar-una-vez (Lalo 07-ago): las ediciones del chat
            // NO generan versión/PDF — eso lo hace confirmar_version cuando
            // el vendedor dice que no hay más cambios.
            _regenerarPdf: false,
            _zonaGenericaOk: true,
            ufValor: typeof input.valor_uf === "number" && input.valor_uf > 0 ? input.valor_uf : undefined,
            itemsExtra: Array.isArray(input.items_extra)
              ? input.items_extra.map((e) => ({
                  nombre: String(e?.nombre || ""),
                  montoUF: Number(e?.monto_uf),
                  cantidad: e?.cantidad,
                  recurrente: e?.recurrente,
                }))
              : undefined,
            preciosOverride: Array.isArray(input.precios_override)
              ? input.precios_override.map((o) => ({
                  id: String(o?.id || ""),
                  precioUnitUF: Number(o?.precio_unit_uf),
                  modalidad: o?.modalidad,
                }))
              : undefined,
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
          // Canal INTERNO (Lalo 10-ago): sin escalera. El % y la vigencia son
          // los que pide el vendedor — puede bajar el descuento y puede dejar
          // la vigencia en los meses que quiera o indefinida.
          const input = tu.input as { pct?: number; meses?: number }
          const r = await definirDescuentoEjecutivo({
            quote_id: estado.puntero.quoteId,
            pct: typeof input?.pct === "number" ? input.pct : undefined,
            ...(typeof input?.meses === "number" ? { meses: input.meses } : {}),
          })
          output = r
          if (r.ok) {
            eventos.push({
              tool: tu.name,
              ok: true,
              resumen: `Descuento: ${r.pct}% sobre el plan mensual · ${r.indefinido ? "sin vencimiento" : `${r.meses} ${r.meses === 1 ? "mes" : "meses"}`} · PDF v${r.version}`,
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
