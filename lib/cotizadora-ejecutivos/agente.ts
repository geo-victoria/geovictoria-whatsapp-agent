/**
 * AGENTE "COTIZADORA DE EJECUTIVOS" — el chat del editor con el catálogo
 * comercial completo (la calculadora de Nacho).
 *
 * SEPARADO de Vicky vendedora por orden de Lalo (principio 0, 10-ago):
 * prompt, tools y MOTOR propios. Este archivo es la capa de conversación e
 * infraestructura; los precios viven en motor.ts (determinista) y la emisión
 * viaja por la tubería existente de create-from-vicky vía emitir.ts.
 *
 * Principios en código:
 *   - El agente captura CONFIGURACIÓN; jamás un precio (salvo overrides
 *     explícitos que el motor valida).
 *   - Emitir se NIEGA mientras validarPropuesta devuelva pendientes.
 *   - No existe ninguna tool de envío al cliente: entregar es botón humano.
 *   - Ancla obligatoria: la cotización nace amarrada al deal del contexto,
 *     su cuenta, su contacto y su dueño.
 */

import Anthropic from "@anthropic-ai/sdk"
import { cotizarPropuesta, validarPropuesta, type ConfigPropuesta } from "./motor.ts"
import { payloadDesdePropuesta } from "./emitir.ts"
import { ADDONS, EQUIPOS, ACCESORIOS, OTROS_SERVICIOS, TRAMOS_ASISTENCIA } from "./catalogo.ts"
import { infoDeal } from "@/lib/cotizaciones-editor"
import { getUFActualSafe } from "@/lib/tools/generar-link-cotizadora"
import { formatearRut } from "@/lib/rut"
import { setQuotePointer } from "@/lib/supabase-persistence-v3"

const DEFAULT_MODEL = "claude-sonnet-4-5-20250929"
const MAX_ITERATIONS = 6
const MAX_TOKENS = 1600
const COTIZADORA_API_BASE = process.env.COTIZADORA_API_BASE || "https://cotizacion.geovictoria.com"
const VICKY_COTIZADORA_SECRET = process.env.VICKY_COTIZADORA_SECRET || ""

// ── Schema de configuración (compartido por las dos tools) ────────────────
const CONFIG_PROPS = {
  usuarios: { type: "integer", minimum: 1, maximum: 8000, description: "Dotación total (1-8000)." },
  descuentoAsistenciaPct: { type: "number", minimum: 0, maximum: 25, description: "Descuento % línea asistencia (tope 25)." },
  addons: {
    type: "array",
    items: {
      type: "object",
      properties: {
        id: { type: "string", enum: Object.keys(ADDONS) },
        usuarios: { type: "integer", minimum: 1 },
        descuentoPct: { type: "number", minimum: 0, maximum: 25 },
      },
      required: ["id"],
    },
  },
  otrosServicios: {
    type: "array",
    items: {
      type: "object",
      properties: {
        id: { type: "string", enum: Object.keys(OTROS_SERVICIOS) },
        usuarios: { type: "integer", minimum: 1 },
        descuentoPct: { type: "number", minimum: 0, maximum: 25 },
      },
      required: ["id"],
    },
  },
  equipos: {
    type: "array",
    items: {
      type: "object",
      properties: {
        id: { type: "string", enum: EQUIPOS.map((e) => e.id) },
        modalidad: { type: "string", enum: ["venta", "arriendo"] },
        cantidad: { type: "integer", minimum: 1 },
        descuentoPct: { type: "number", minimum: 0, maximum: 25 },
        precioUF: { type: "number", description: "Override de precio unitario UF (libre; bajo lista×0,75 queda advertencia)." },
      },
      required: ["id", "modalidad", "cantidad"],
    },
  },
  accesorios: {
    type: "array",
    items: {
      type: "object",
      properties: {
        id: { type: "string", enum: ACCESORIOS.map((e) => e.id) },
        modalidad: { type: "string", enum: ["venta", "arriendo"] },
        cantidad: { type: "integer", minimum: 1 },
        descuentoPct: { type: "number", minimum: 0, maximum: 25 },
        precioUF: { type: "number" },
      },
      required: ["id", "modalidad", "cantidad"],
    },
  },
  serviciosAsociados: {
    type: "array",
    items: {
      type: "object",
      properties: {
        id: { type: "string", enum: ["envio", "instalacion", "homologacion"] },
        zona: { type: "string", enum: ["rm", "region"], description: "SOLO la instalación con técnico la necesita (cambia la tarifa). Para envío/homologación se omite." },
        modalidad: { type: "string", enum: ["venta", "arriendo"] },
        cantidad: { type: "integer", minimum: 1 },
        precioUF: { type: "number", description: "Override UF. En envío es LIBRE (≥0, lo define el ejecutivo); en instalación se valida contra el mínimo de tabla." },
      },
      required: ["id", "modalidad"],
    },
  },
  envioExcluido: { type: "boolean", description: "true = el envío queda EXPLÍCITAMENTE fuera (el cliente retira / lo asume)." },
  instalacionPorCliente: { type: "boolean", description: "true = instala el cliente (declarado)." },
  promoAsistenciaAddon: { type: "string", enum: Object.keys(ADDONS), description: "Promo 1 UF: add-on incluido (solo 1-10 usuarios, nunca banco)." },
  promoSf2aUnidades: { type: "integer", minimum: 1, description: "Unidades SF2A a precio promo 0,30 (se capa por tramo)." },
  kitQrCantidad: { type: "integer", minimum: 1 },
  bundleIn01: {
    type: "object",
    properties: { modalidad: { type: "string", enum: ["venta", "arriendo"] }, cantidad: { type: "integer", minimum: 1 } },
    required: ["modalidad", "cantidad"],
  },
  firmante: { type: "string", description: "Ejecutivo que firma la propuesta (nombre)." },
} as const

const previsualizarSchema = {
  name: "previsualizar_propuesta",
  description:
    "Calcula la propuesta con el motor determinista del catálogo comercial y devuelve líneas, totales (mensual y pago único, UF netos), advertencias y la LISTA DE PENDIENTES que impedirían emitir. Úsala cada vez que el vendedor cambie algo, para mostrarle el resumen actualizado. No crea nada.",
  input_schema: { type: "object" as const, properties: CONFIG_PROPS, required: ["usuarios"] },
}

const emitirSchema = {
  name: "emitir_propuesta",
  description:
    "Emite la cotización FORMAL con la configuración dada: la valida (si hay pendientes, NO emite y te los devuelve para que los resuelvas con el vendedor), calcula con el motor, y la crea amarrada al deal del contexto (misma cuenta, contacto y dueño) con PDF y link de aceptación. Pasa la configuración COMPLETA. rutEmpresa solo si la ficha del deal no lo trae o el vendedor lo corrige.",
  input_schema: {
    type: "object" as const,
    properties: {
      ...CONFIG_PROPS,
      rutEmpresa: { type: "string", description: "RUT de la empresa (si la ficha no trae o se corrige)." },
      empresa: { type: "string", description: "Razón social (default: la cuenta del deal)." },
    },
    required: ["usuarios", "firmante"],
  },
}

function catalogoResumen(): string {
  const tramos = TRAMOS_ASISTENCIA.map((t) => `${t.min}-${t.max === 8000 ? "8000" : t.max}: ${t.uf}${t.tipo === "fijo" ? " UF fijo" : "/u"}`).join(" · ")
  const addons = Object.entries(ADDONS).map(([k, v]) => `${k}=${v.nombre} ${v.uf}/u`).join(" · ")
  const equipos = EQUIPOS.map((e) => `${e.id} (${e.nombre}) V${e.venta}/A${e.arriendo}`).join(" · ")
  const otros = Object.entries(OTROS_SERVICIOS).map(([k, v]) => `${k}=${v.nombre} (mín ${v.minUsuarios}u)`).join(" · ")
  return [
    `CATÁLOGO COMERCIAL (UF netos; el motor calcula, tú NUNCA inventas precios):`,
    `- Asistencia por tramo: ${tramos}`,
    `- Add-ons (por usuario/mes): ${addons}`,
    `- Otros servicios: ${otros} (tramos propios en el motor)`,
    `- Equipos (Venta/Arriendo UF): ${equipos}`,
    `- Accesorios: ${ACCESORIOS.map((a) => a.id).join(", ")} (precios en el motor)`,
    `- Servicios asociados (SIEMPRE pago único): envío (referencia V 0,7 / A 0,5, pero el COSTO LO DEFINE EL EJECUTIVO libre desde 0 y NO se pregunta lugar/comuna de envío) · instalación con técnico (V: RM 2 / reg 5 · A: RM 1 / reg 4, no baja de tabla — esta SÍ necesita zona) · homologación 0,3. ENVÍO = AUTO-INSTALACIÓN: con envío cotizado la instalación queda resuelta (instala el cliente), no preguntes quién instala.`,
    `- Promos (solo si el motor las declara elegibles): Asistencia+Addon = 1 UF (1-10 usuarios, NUNCA banco) · SF2A arriendo 0,30 capado por tramo · Kit QR 1,8 UF/mes · Bundle IN01 4G/LAN 27 V / 3,4 A`,
  ].join("\n")
}

export type EventoEjec = { tool: string; ok: boolean; resumen: string }
export type ChatEjecResultado = {
  reply: string
  eventos: EventoEjec[]
  creado?: { quoteId: string; contact: string }
}

export async function postCreateFromVicky(body: unknown): Promise<{ ok: boolean; [k: string]: unknown }> {
  for (let intento = 0; intento < 2; intento++) {
    try {
      const r = await fetch(`${COTIZADORA_API_BASE}/api/quote-acceptance/create-from-vicky`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(VICKY_COTIZADORA_SECRET ? { "x-vicky-secret": VICKY_COTIZADORA_SECRET } : {}),
        },
        body: JSON.stringify(body),
        cache: "no-store",
      })
      const data = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string }
      if (r.ok && data.ok) return data as { ok: true }
      if (intento === 0) continue
      return { ok: false, error: data.error || `HTTP ${r.status}` }
    } catch (e) {
      if (intento === 0) continue
      return { ok: false, error: e instanceof Error ? e.message : "error de red" }
    }
  }
  return { ok: false, error: "sin respuesta" }
}

export async function chatCotizadoraEjecutivos(params: {
  dealId: string
  historial: Array<{ role: "user" | "assistant"; content: string }>
  mensaje: string
}): Promise<ChatEjecResultado> {
  const { dealId, historial, mensaje } = params
  const apiKey = (process.env.ANTHROPIC_API_KEY || "").trim()
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY no configurada")
  const info = await infoDeal(dealId)
  if (!info) throw new Error("No se pudo leer la oportunidad en Zoho.")

  const system = [
    `Eres la "Cotizadora de Ejecutivos" de GeoVictoria: un VENDEDOR arma contigo una propuesta con el CATÁLOGO COMERCIAL COMPLETO (1 a 8.000 trabajadores). Hablas con el vendedor, no con el cliente: directo, colega, español de Chile.`,
    ``,
    `OPORTUNIDAD ANCLA (deal Zoho ${info.dealId}):`,
    `- Deal: ${info.nombre || "(sin nombre)"} · etapa: ${info.stage || "?"} · dueño: ${info.ownerNombre || "?"}`,
    `- Cuenta: ${info.accountNombre || "(sin cuenta)"}${info.rut ? ` · RUT ficha: ${info.rut}` : " · RUT: no está en la ficha"}`,
    `- Contacto: ${info.contactoNombre || "(sin contacto)"}${info.telefono ? ` · +${info.telefono}` : " · SIN teléfono"}${info.email ? ` · ${info.email}` : " · sin email"}`,
    ``,
    catalogoResumen(),
    ``,
    `CÓMO TRABAJAS:`,
    `1. EL VENDEDOR MANDA. Traduce lo que pida a configuración y llama previsualizar_propuesta para mostrarle el resumen (líneas + total mensual + pago único + advertencias). Cambia algo → previsualiza de nuevo.`,
    `2. Los PRECIOS los pone el motor, jamás tú: descuentos sobre 25% se recortan solos, overrides bajo mínimos se ajustan o quedan con advertencia — muestra las advertencias tal cual.`,
    `3. Para emitir llama emitir_propuesta. Si devuelve PENDIENTES (envío/instalación sin resolver, modalidad faltante, firmante, etc.), pregúntalos TODOS JUNTOS en un mensaje corto y reintenta. La cotización nace amarrada a ESTE deal con su dueño.`,
    `3b. ENVÍO (reglas Anderson): el costo lo dicta el ejecutivo (precioUF libre, puede ser 0) y JAMÁS preguntes comuna/lugar de envío. Envío cotizado ⇒ auto-instalación resuelta: no preguntes quién instala. Solo si piden instalación CON TÉCNICO pregunta RM o región (cambia la tarifa).`,
    `4. Tras emitir: número/total/links en 2-3 líneas. NADA se envía al cliente desde este chat — el envío es con los botones del editor (WhatsApp del ejecutivo, Vicky o correo); dilo si el vendedor te pide "mándasela".`,
    ``,
    `LÍMITES: catálogo comercial Chile en UF. No inventes RUT ni datos. Si piden algo fuera del catálogo (producto inexistente, descuento imposible), dilo sin rodeos.`,
  ].join("\n")

  const client = new Anthropic({ apiKey })
  const model = (process.env.ANTHROPIC_COTEJEC_MODEL || process.env.ANTHROPIC_COTED_MODEL || DEFAULT_MODEL).trim()
  const messages: Anthropic.Messages.MessageParam[] = [
    ...historial
      .filter((m) => (m.role === "user" || m.role === "assistant") && String(m.content || "").trim())
      .slice(-30)
      .map((m) => ({ role: m.role, content: String(m.content).slice(0, 6000) })),
    { role: "user" as const, content: mensaje },
  ]

  const eventos: EventoEjec[] = []
  let creado: ChatEjecResultado["creado"]
  let reply = ""

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const res = await client.messages.create({
      model,
      max_tokens: MAX_TOKENS,
      system,
      messages,
      tools: [previsualizarSchema, emitirSchema] as unknown as Anthropic.Messages.Tool[],
    })
    const textos = res.content.filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    if (textos.length) reply = textos.map((b) => b.text).join("\n").trim()
    const toolUses = res.content.filter((b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use")
    if (!toolUses.length || res.stop_reason !== "tool_use") break
    messages.push({ role: "assistant", content: res.content })
    const results: Anthropic.Messages.ToolResultBlockParam[] = []

    for (const tu of toolUses) {
      let output: unknown
      const input = tu.input as ConfigPropuesta & { rutEmpresa?: string; empresa?: string }

      if (tu.name === "previsualizar_propuesta") {
        const r = cotizarPropuesta(input)
        const pendientes = validarPropuesta(input)
        output = {
          lineas: r.lineas.map((l) => ({ nombre: l.nombre, detalle: l.detalle, subtotalUF: l.subtotalUF, recurrencia: l.recurrencia })),
          totalMensualUF: r.totalMensualUF,
          totalPagoUnicoUF: r.totalPagoUnicoUF,
          advertencias: r.advertencias,
          pendientesParaEmitir: pendientes,
        }
        eventos.push({ tool: tu.name, ok: true, resumen: `Previsualización · mensual UF ${r.totalMensualUF} · único UF ${r.totalPagoUnicoUF}${pendientes.length ? ` · ${pendientes.length} pendiente(s)` : ""}` })
      } else if (tu.name === "emitir_propuesta") {
        const pendientes = validarPropuesta(input)
        if (pendientes.length) {
          output = { ok: false, pendientes }
          eventos.push({ tool: tu.name, ok: false, resumen: `Emisión bloqueada: ${pendientes.length} pendiente(s)` })
        } else {
          const r = cotizarPropuesta(input)
          const ufActual = await getUFActualSafe()
          if (!(ufActual > 0)) {
            output = { ok: false, error: "No se pudo obtener la UF del día — reintenta en un minuto." }
            eventos.push({ tool: tu.name, ok: false, resumen: "Sin UF del día" })
          } else {
            const cotizacion = payloadDesdePropuesta(r, ufActual)
            const rut = (input.rutEmpresa || info.rut || "").trim()
            const resp = await postCreateFromVicky({
              // Principio 4: la emisión ejecutiva NO envía el correo al
              // cliente — entregar es botón humano desde el editor.
              sinCorreoCliente: true,
              cliente: {
                empresa: (input.empresa || info.accountNombre || info.nombre || "").trim(),
                contacto: (info.contactoNombre || "Contacto").trim(),
                contactoEmail: info.email || undefined,
                contactoTelefono: info.telefono || "",
                rutEmpresa: rut ? formatearRut(rut) : "",
                userCount: input.usuarios,
                sectorEmpresa: "",
              },
              existing: {
                accountId: info.accountId || undefined,
                contactId: info.contactId || undefined,
                dealId: info.dealId,
                ownerId: info.ownerId || undefined,
              },
              cotizacion,
            })
            output = resp
            if (resp.ok) {
              const quoteId = String(resp.quoteId || "")
              eventos.push({ tool: tu.name, ok: true, resumen: `Cotización emitida · total UF ${cotizacion.totalUF} (~$${cotizacion.totalCLP.toLocaleString("es-CL")}) · catálogo comercial` })
              if (info.telefono && quoteId) {
                await setQuotePointer(info.telefono, {
                  quoteId,
                  dealId: String(resp.dealId || info.dealId),
                  acceptanceUrl: String(resp.acceptanceUrl || ""),
                  pdfUrl: String(resp.pdfUrl || ""),
                  totalClp: cotizacion.totalCLP,
                  totalUf: cotizacion.totalUF,
                  rut: rut || undefined,
                  empresa: (input.empresa || info.accountNombre || undefined) as string | undefined,
                }).catch(() => {})
                creado = { quoteId, contact: info.telefono }
              }
            } else {
              eventos.push({ tool: tu.name, ok: false, resumen: `No se pudo emitir: ${String(resp.error || "").slice(0, 160)}` })
            }
          }
        }
      } else {
        output = { ok: false, error: `tool desconocida: ${tu.name}` }
      }
      results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(output).slice(0, 8000) })
    }
    messages.push({ role: "user", content: results })
  }

  return { reply: reply || "Listo.", eventos, creado }
}
