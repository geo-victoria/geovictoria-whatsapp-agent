/**
 * TOQUE 5 PERSONALIZADO (Rodrigo + Lalo 26-ago, documento v21 — solo CHILE).
 *
 * El toque 5 del loop deja la plantilla fija por etapa y pasa a TEXTO LIBRE
 * generado por conversación en el momento del despacho: menciona el dolor
 * operativo concreto que el cliente contó y la etapa exacta donde quedó —
 * el mismo patrón que la campaña del 10% del 26-ago, pero generado al vuelo
 * en vez de pre-redactado.
 *
 * Contratos:
 *  - Falla o conversación sin sustancia → null, y el llamador cae al texto
 *    fijo de siempre (el toque JAMÁS se pierde por culpa de la generación).
 *  - Guardrail determinista: tope de largo con corte en borde de oración,
 *    sin guiones largos, sin "Oye", una sola idea de retome.
 *  - Fuera de la ventana de 24h el texto viaja como variable `contexto` de la
 *    plantilla (patrón probado hoy con campana_contexto_vicky_p1_v2): sin
 *    saltos de línea y más corto.
 */

import Anthropic from "@anthropic-ai/sdk"
import { fetchHistoryV3 } from "./supabase-persistence-v3"

const MODEL = (process.env.VICKY_TOQUE5_MODEL || "claude-haiku-4-5-20251001").trim()
const MAX_CHARS = 480

const REGLAS = [
  "Eres Vicky, la vendedora de GeoVictoria por WhatsApp (control de asistencia y gestión de personal en Chile).",
  "Vas a escribir UN solo mensaje corto para retomar el contacto con un cliente que dejó de responder hace días.",
  "Reglas estrictas:",
  "1. Dos o tres frases, máximo 400 caracteres.",
  "2. Menciona la operación o el dolor CONCRETO que el cliente contó (su rubro, su equipo, su problema, con sus palabras) y el punto exacto donde quedó la conversación.",
  "3. UNA sola pregunta, al final del mensaje.",
  "4. NO saludes ni te presentes: tu texto va DENTRO de un mensaje que ya parte con 'Hola, todo bien?' — entra directo al tema.",
  "5. Prohibido partir con 'Oye'. Prohibido usar guiones largos, negritas o listas.",
  "6. Tuteo chileno neutro y cercano, sin jerga.",
  "7. No inventes datos, precios ni promesas que no estén en la conversación. No ofrezcas descuentos.",
  "Responde SOLO con el texto del mensaje, sin comillas ni explicaciones.",
].join("\n")

function recortarEnOracion(texto: string, max: number): string {
  if (texto.length <= max) return texto
  const corte = texto.slice(0, max)
  const fin = Math.max(corte.lastIndexOf(". "), corte.lastIndexOf("? "), corte.lastIndexOf("! "))
  return fin > 40 ? corte.slice(0, fin + 1).trim() : corte.trim()
}

export async function generarToqueContexto(
  contact: string,
  stage: "sin_precio" | "con_precio" | "formal",
): Promise<string | null> {
  try {
    const apiKey = (process.env.ANTHROPIC_API_KEY || "").trim()
    if (!apiKey) return null
    const historia = await fetchHistoryV3(contact, 30)
    // Sin conversación real no hay contexto que personalizar.
    if (!historia || historia.filter((m) => m.role === "user").length < 2) return null

    const transcript = historia
      .map((m) => `${m.role === "user" ? "Cliente" : "Vicky"}: ${String(m.content || "").slice(0, 400)}`)
      .join("\n")
      .slice(-6000)

    const etapa =
      stage === "sin_precio"
        ? "aún no ve precio; falta saber cuántas personas marcarían y cómo"
        : stage === "con_precio"
          ? "ya vio el valor referencial; solo falta el RUT (o su ok) para dejarle la cotización formal"
          : "tiene la cotización formal lista para aceptar y pagar en línea"

    const client = new Anthropic({ apiKey })
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 300,
      system: REGLAS,
      messages: [
        {
          role: "user",
          content: `TRANSCRIPCIÓN DE LA CONVERSACIÓN:\n${transcript}\n\nETAPA EN QUE QUEDÓ: ${etapa}\n\nEscribe el mensaje de retome.`,
        },
      ],
    })
    let texto = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join(" ")
      .trim()
    texto = texto.replace(/^["«“]+|["»”]+$/g, "").trim()
    if (!texto || texto.length < 30) return null
    if (/^oye\b/i.test(texto)) return null
    // Estilo sellado: sin guiones largos (parecen IA — Lalo 26-ago).
    texto = texto.replace(/\s*—\s*/g, ", ").replace(/\s{2,}/g, " ")
    return recortarEnOracion(texto, MAX_CHARS)
  } catch (e) {
    console.error(`[toque5] generación falló ${contact}:`, e instanceof Error ? e.message : e)
    return null
  }
}

/** Versión para variable de plantilla: una línea, corta, sin saltos. */
export function contextoParaPlantilla(texto: string): string {
  return recortarEnOracion(texto.replace(/\s*\n+\s*/g, " ").trim(), 340)
}
