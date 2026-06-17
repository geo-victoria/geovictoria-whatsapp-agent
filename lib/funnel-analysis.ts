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
  sub_bucket: "crosselling" | "lead" | "reunion" | "cotizacion" | "solo_dudas" | null
  cotizacion_outcome: "preform_mostrado" | "cotizacion_enviada" | "abandonado" | null
  // Etiqueta libre (snake_case) del motivo de no-cierre. Solo para flujo de
  // cotización que NO terminó en cotización enviada. Null en otro caso.
  motivo_no_cierre: string | null
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
   - "lead": el prospecto pidió que un ejecutivo lo contacte o lo llame de vuelta (callback), sin llegar a cotizar.
   - "crosselling": es un cliente ACTUAL de GeoVictoria que consulta por un producto o módulo ADICIONAL (venta cruzada / upsell).
   - "solo_dudas": mostró interés comercial pero SOLO hizo preguntas (precios, funcionamiento, condiciones) sin avanzar a cotizar, agendar, pedir callback ni ser cliente actual por otro producto.

3) "cotizacion_outcome" (solo si sub_bucket="cotizacion"; null en otro caso). Elige el estado MÁS avanzado del flujo de cotización:
   - "cotizacion_enviada": se generó y envió la cotización formal (link de aceptación o PDF).
   - "preform_mostrado": Vicky mostró un preform/estimación referencial de precio, pero NO llegó a enviar la cotización formal.
   - "abandonado": entró al flujo de cotización pero no se llegó a mostrar un preform ni a enviar cotización (el cliente se fue, rechazó, o quedó en datos incompletos).

4) "motivo_no_cierre" (string o null): SOLO cuando sub_bucket="cotizacion" y cotizacion_outcome es "preform_mostrado" o "abandonado" (es decir, entró a cotizar pero NO se envió la cotización formal). Es el motivo por el que no avanzó/cerró, en una etiqueta corta en snake_case. Reutiliza estas cuando apliquen: "precio" (objeción de precio/presupuesto/pidió descuento y no cerró), "faltaron_datos" (no entregó datos que Vicky necesitaba: RUT, nº trabajadores, instalación), "silencio" (dejó de responder sin dar motivo), "evaluando" (lo va a pensar/consultar internamente), "fuera_de_scope" (>50 trabajadores o pidió algo no ofrecido; suele derivar a ejecutivo), "prefirio_humano" (quiso hablar con una persona), "competencia" (evalúa o eligió otra solución), "error_bot" (falla o fricción del bot cortó el flujo). Si ninguna calza, crea una etiqueta corta en snake_case. En cualquier otro caso (no es cotización, o sí se envió), usa null.

5) "es_cliente_actual" (boolean): true si el prospecto da señales de ser ya cliente de GeoVictoria (menciona que ya lo usa, que tiene el sistema, problema operativo de su cuenta, etc.).

6) "resumen" (string, máx 140 caracteres): una línea en español chileno (tuteo, nunca voseo) describiendo qué pasó.

7) "confianza": "alta" | "media" | "baja" según qué tan clara es la clasificación.

8) "hallazgos": arreglo (puede ser vacío) de observaciones accionables para mejorar a Vicky o el proceso de venta. Cada una { "tipo": "<etiqueta_corta_snake_case>", "detalle": "<1 frase>" }. Detecta por ejemplo: objecion_precio_mal_manejada, ofrecio_venta_no_pedida, pidio_fuera_de_catalogo, pidio_humano, dimensionamiento_dudoso, demora_respuesta, confusion_producto, oportunidad_perdida. Solo incluye hallazgos REALES y relevantes de esta conversación.

Devuelve EXACTAMENTE este shape:
{"grupo":"...","sub_bucket":null,"cotizacion_outcome":null,"motivo_no_cierre":null,"es_cliente_actual":false,"resumen":"...","confianza":"...","hallazgos":[]}`

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
  let sub = ["crosselling", "lead", "reunion", "cotizacion", "solo_dudas"].includes(String(o.sub_bucket))
    ? (o.sub_bucket as ConversationAnalysis["sub_bucket"])
    : null
  if (grupo !== "comercial") sub = null
  let outcome =
    ["preform_mostrado", "cotizacion_enviada", "abandonado"].includes(String(o.cotizacion_outcome))
      ? (o.cotizacion_outcome as ConversationAnalysis["cotizacion_outcome"])
      : null
  if (sub !== "cotizacion") outcome = null
  // motivo_no_cierre: solo para cotización que no terminó en envío. Etiqueta
  // libre normalizada a snake_case corto.
  let motivo: string | null = null
  if (sub === "cotizacion" && (outcome === "preform_mostrado" || outcome === "abandonado")) {
    const raw = String(o.motivo_no_cierre || "").trim().toLowerCase()
    const norm = raw.replace(/[^a-z0-9áéíóúñ]+/gi, "_").replace(/^_+|_+$/g, "").slice(0, 40)
    motivo = norm || "sin_motivo"
  }
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
    motivo_no_cierre: motivo,
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
