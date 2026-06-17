/**
 * Análisis semántico (LLM) de las conversaciones V3 para el dashboard de embudo.
 *
 * Clasifica cada conversación en la taxonomía comercial definida con el equipo:
 *
 *   Nivel 1 (grupo):
 *     - comercial         → intención comercial (cotizar/comprar/reunión/callback/cross-sell)
 *     - soporte           → consulta operativa/funcional de la plataforma o
 *                           problema de un cliente existente (lo que Vicky
 *                           derivaría al agente de soporte)
 *     - no_identificado   → sin intención identificable (saludo suelto, spam,
 *                           número equivocado, prueba, mensaje ambiguo)
 *
 *   Nivel 2 (sub_bucket, solo si grupo=comercial) — el MÁS avanzado alcanzado:
 *     - cotizacion  → entró al flujo de cotización (se pidió/mostró precio o se
 *                     generó cotización)
 *     - reunion     → se coordinó/pidió una reunión con un ejecutivo comercial
 *     - callback    → pidió que un ejecutivo lo contacte/llame de vuelta (lead)
 *     - crosselling → cliente ACTUAL de GeoVictoria consultando por OTRO producto
 *
 *   Nivel 3 (cotizacion_outcome, solo si sub_bucket=cotizacion):
 *     - enviada           → se mostró preform/estimación o se envió cotización
 *                           formal y el cliente NO la rechazó
 *     - fuga              → se mostró preform/cotización pero el cliente dejó de
 *                           responder / no avanzó, sin rechazo explícito
 *     - rechazo_explicito → el cliente rechazó explícitamente (no le interesa,
 *                           se cae por precio, eligió otra solución)
 *     - sin_preform       → entró a cotizar pero abandonó antes de ver un precio
 *
 * El cron /api/vic-funnel-cron usa estas funciones; el dashboard /api/vic-funnel
 * lee la tabla vic_v3_conversation_analysis que esto puebla.
 */

import Anthropic from "@anthropic-ai/sdk"

export const ANALYSIS_MODEL =
  (process.env.VIC_FUNNEL_MODEL || "claude-sonnet-4-5-20250929").trim()

// Números internos de prueba a excluir del embudo (configurable sin redeploy
// vía VIC_FUNNEL_TEST_CONTACTS, coma-separados). Compartido por cron + dashboard.
const DEFAULT_TEST_CONTACTS = [
  "56944668823", // Eduardo
  "56978385048", // Rodrigo
  "56962288575", // Kerim
  "56982945030", // Andrea
  "56966850332", // C. Fuentes
]
export function testContactSet(): Set<string> {
  const raw = (process.env.VIC_FUNNEL_TEST_CONTACTS || "").trim()
  const list = raw
    ? raw.split(",").map((s) => s.replace(/\D/g, "").trim()).filter(Boolean)
    : DEFAULT_TEST_CONTACTS
  return new Set(list)
}
export function isTestContact(contact: string, set = testContactSet()): boolean {
  return set.has((contact || "").replace(/\D/g, ""))
}

export type Hallazgo = { tipo: string; detalle: string }

export type ConversationAnalysis = {
  grupo: "comercial" | "soporte" | "no_identificado"
  sub_bucket: "crosselling" | "callback" | "reunion" | "cotizacion" | null
  cotizacion_outcome: "enviada" | "fuga" | "rechazo_explicito" | "sin_preform" | null
  es_cliente_actual: boolean
  resumen: string
  confianza: "alta" | "media" | "baja"
  hallazgos: Hallazgo[]
}

export type TranscriptMessage = { role: "user" | "assistant"; content: string }

const SYSTEM_PROMPT = `Eres analista comercial de GeoVictoria (control de asistencia B2B en Chile). Vicky es la vendedora-bot por WhatsApp. Recibes el transcript de UNA conversación y la clasificas en una taxonomía. Respondes SOLO un objeto JSON válido, sin texto adicional, sin markdown, sin \`\`\`.

Clasifica así:

1) "grupo" (obligatorio), uno de:
   - "comercial": el prospecto muestra intención comercial (quiere cotizar, comprar, conocer precios, contratar, agendar reunión, que lo llamen, o es un cliente actual preguntando por OTRO producto).
   - "soporte": la conversación es una consulta operativa o funcional sobre USAR la plataforma (configurar, generar reportes, errores, "no me funciona", feriados) o un problema de un cliente existente. Es el caso donde Vicky consultaría al agente de soporte.
   - "no_identificado": no se identifica intención (solo un saludo sin desarrollo, spam, número equivocado, mensaje de prueba, o ambiguo sin avanzar).

2) "sub_bucket" (solo si grupo="comercial"; null en otro caso). Elige el estado MÁS avanzado alcanzado, en este orden de prioridad:
   - "cotizacion": entró al flujo de cotización (Vicky pidió datos para cotizar, mostró un precio/estimación, negoció descuento, o envió una cotización formal).
   - "reunion": se coordinó o el prospecto pidió una reunión con un ejecutivo comercial.
   - "callback": el prospecto pidió que un ejecutivo lo contacte o lo llame de vuelta (lead), sin llegar a cotizar.
   - "crosselling": es un cliente ACTUAL de GeoVictoria que consulta por un producto o módulo ADICIONAL (venta cruzada / upsell).

3) "cotizacion_outcome" (solo si sub_bucket="cotizacion"; null en otro caso):
   - "enviada": se mostró el preform/estimación o se envió la cotización formal y el cliente NO la rechazó (aceptó, mostró interés, o quedó evaluando con buena disposición).
   - "fuga": se mostró preform/cotización pero el cliente dejó de responder o no avanzó, SIN rechazo explícito (silencio, "lo voy a pensar" y nada más).
   - "rechazo_explicito": el cliente rechazó explícitamente (dijo que no le interesa, lo encontró caro y se cayó, eligió otra solución, "no gracias").
   - "sin_preform": entró a cotizar pero abandonó ANTES de que Vicky mostrara un precio/estimación.

4) "es_cliente_actual" (boolean): true si el prospecto da señales de ser ya cliente de GeoVictoria (menciona que ya lo usa, que tiene el sistema, problema operativo de su cuenta, etc.).

5) "resumen" (string, máx 140 caracteres): una línea en español chileno (tuteo, nunca voseo) describiendo qué pasó.

6) "confianza": "alta" | "media" | "baja" según qué tan clara es la clasificación.

7) "hallazgos": arreglo (puede ser vacío) de observaciones accionables para mejorar a Vicky o el proceso de venta. Cada una { "tipo": "<etiqueta_corta_snake_case>", "detalle": "<1 frase>" }. Detecta por ejemplo: objecion_precio_mal_manejada, ofrecio_venta_no_pedida, pidio_fuera_de_catalogo, pidio_humano, dimensionamiento_dudoso, demora_respuesta, confusion_producto, oportunidad_perdida. Solo incluye hallazgos REALES y relevantes de esta conversación.

Devuelve EXACTAMENTE este shape:
{"grupo":"...","sub_bucket":null,"cotizacion_outcome":null,"es_cliente_actual":false,"resumen":"...","confianza":"...","hallazgos":[]}`

function buildTranscript(messages: TranscriptMessage[]): string {
  return messages
    .map((m) => `${m.role === "user" ? "CLIENTE" : "VICKY"}: ${m.content}`)
    .join("\n")
    .slice(0, 12000)
}

function coerce(raw: unknown): ConversationAnalysis {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  const grupo = ["comercial", "soporte", "no_identificado"].includes(String(o.grupo))
    ? (o.grupo as ConversationAnalysis["grupo"])
    : "no_identificado"
  let sub = ["crosselling", "callback", "reunion", "cotizacion"].includes(String(o.sub_bucket))
    ? (o.sub_bucket as ConversationAnalysis["sub_bucket"])
    : null
  if (grupo !== "comercial") sub = null
  let outcome =
    ["enviada", "fuga", "rechazo_explicito", "sin_preform"].includes(String(o.cotizacion_outcome))
      ? (o.cotizacion_outcome as ConversationAnalysis["cotizacion_outcome"])
      : null
  if (sub !== "cotizacion") outcome = null
  const hallazgos = Array.isArray(o.hallazgos)
    ? (o.hallazgos as unknown[])
        .map((h) => {
          const hh = (h && typeof h === "object" ? h : {}) as Record<string, unknown>
          return { tipo: String(hh.tipo || "").slice(0, 60), detalle: String(hh.detalle || "").slice(0, 240) }
        })
        .filter((h) => h.tipo && h.detalle)
        .slice(0, 8)
    : []
  return {
    grupo,
    sub_bucket: sub,
    cotizacion_outcome: outcome,
    es_cliente_actual: Boolean(o.es_cliente_actual),
    resumen: String(o.resumen || "").slice(0, 200),
    confianza: ["alta", "media", "baja"].includes(String(o.confianza))
      ? (o.confianza as ConversationAnalysis["confianza"])
      : "media",
    hallazgos,
  }
}

function extractJson(text: string): unknown {
  const trimmed = text.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.indexOf("{")
    const end = trimmed.lastIndexOf("}")
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1))
    }
    throw new Error("Sin JSON en la respuesta del modelo")
  }
}

/** Clasifica una conversación. Lanza si la API falla. */
export async function analyzeConversation(
  messages: TranscriptMessage[],
  apiKey: string,
): Promise<ConversationAnalysis> {
  const client = new Anthropic({ apiKey })
  const response = await client.messages.create({
    model: ANALYSIS_MODEL,
    max_tokens: 700,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Transcript de la conversación:\n\n${buildTranscript(messages)}\n\nClasifícala. Responde SOLO el JSON.`,
      },
    ],
  })
  const block = response.content.find((b) => b.type === "text")
  const text = block && block.type === "text" ? block.text : ""
  return coerce(extractJson(text))
}
