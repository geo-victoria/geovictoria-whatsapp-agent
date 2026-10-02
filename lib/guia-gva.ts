/**
 * GUÍA DE USO DE GV AVANZADO (02-oct, Lalo: "no contamos con el implementador y
 * soporte no atiende GV Avanzado. Vicky es la única que puede guiar al cliente").
 *
 * Toda empresa que crea el alta por chat nace en GV Avanzado. El agente de
 * soporte de Foundry (consultar_agente_soporte) conoce GV Portal y la Mesa de
 * Ayuda no atiende GV Avanzado, así que ninguno de los dos sirve para estos
 * clientes. La fuente es el manual de GV Avanzado (lib/manual-gva/texto.ts):
 * esta función le hace la pregunta del cliente a un modelo que tiene el manual
 * COMPLETO en contexto y responde solo con lo que el manual dice — menús y
 * botones con su nombre exacto, paso a paso. Si el manual no lo cubre, lo dice
 * (`encontrado: false`) y Vicky no inventa.
 */

import { MANUAL_GVA } from "./manual-gva/texto.ts"
import { MAPA_PLATAFORMA_GVA } from "./manual-gva/mapa.ts"

const MODELO = (process.env.MODELO_GUIA_GVA || "claude-sonnet-4-5-20250929").trim()
const NO_ESTA = "NO_ESTA_EN_MANUAL"

const DOCUMENTO_POR_PAIS: Record<string, string> = { cl: "RUT", pe: "DNI o RUC", co: "cédula o NIT", mx: "RFC o CURP" }

function manualCompleto(): string {
  return (
    MANUAL_GVA.map((c) => `=== CAPÍTULO: ${c.titulo} ===\n${c.texto}`).join("\n\n") +
    "\n\n=== MAPA REAL DE LA PLATAFORMA (recorrido del 29-sep) ===\n" +
    MAPA_PLATAFORMA_GVA
  )
}

/** WhatsApp marca negrita con un asterisco; el modelo a veces usa dos y títulos con #. */
export function aFormatoWhatsapp(t: string): string {
  return String(t || "")
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/^#{1,6}\s*/gm, "")
    .trim()
}

function sistema(pais: string): string {
  const doc = DOCUMENTO_POR_PAIS[pais] || "documento de identidad"
  return (
    "Eres la guía de uso de la plataforma GV Avanzado de GeoVictoria. Abajo tienes su manual oficial " +
    "completo y, al final, el MAPA REAL de la plataforma (cada pantalla con su ruta y sus campos, " +
    "recorrido en la plataforma de verdad). Un cliente (administrador de su empresa) hizo una pregunta " +
    "por WhatsApp. Respóndela SOLO con lo que dicen el manual y el mapa: el manual dice CÓMO se hace; " +
    "el mapa dice DÓNDE está y qué campos tiene. Si se contradicen en ubicación o campos, manda el mapa.\n\n" +
    "Reglas:\n" +
    "- Paso a paso numerado, con los nombres EXACTOS de menús, íconos, pestañas y botones tal como " +
    "aparecen en el manual. Máximo 7 pasos; si el proceso es más largo, da los primeros 7 y di qué " +
    "sigue después.\n" +
    "- Si el proceso depende de algo previo (por ejemplo, un usuario necesita un grupo creado antes), " +
    "dilo primero en una línea.\n" +
    "- Formato WhatsApp: texto plano, sin títulos con #, negrita solo con *asteriscos* y solo para el " +
    "nombre de un botón o menú. Tuteo, tono cercano, máximo ~900 caracteres.\n" +
    `- El identificador de una persona en este país es su ${doc}; si el manual dice RUT, adáptalo.\n` +
    "- Las capturas del manual son de una empresa de ejemplo ('Interactuemos en Avanzado') y de un " +
    "ambiente de pruebas: JAMÁS cites esos nombres ni datos de ejemplo.\n" +
    "- No inventes rutas, opciones ni campos que ni el manual ni el mapa mencionan, ni digas 'normalmente " +
    "está en…': si no sabes dónde está, no lo afirmes. Si la respuesta NO está en el " +
    `manual, responde exactamente la palabra ${NO_ESTA} en la primera línea y, en la segunda, en una ` +
    "frase, qué parte sí cubre el manual que se le parezca (o nada).\n" +
    "- No hables del manual ni de 'según el documento': responde como quien conoce la plataforma.\n\n" +
    "MANUAL DE GV AVANZADO:\n\n"
  )
}

export type GuiaGva = { ok: true; encontrado: boolean; respuesta: string } | { ok: false; error: string }

export async function consultarGuiaGva(pregunta: string, opts: { pais?: string; contexto?: string } = {}): Promise<GuiaGva> {
  const apiKey = (process.env.ANTHROPIC_API_KEY || "").trim()
  if (!apiKey) return { ok: false, error: "sin_api_key" }
  const q = String(pregunta || "").trim().slice(0, 2000)
  if (!q) return { ok: false, error: "pregunta_vacia" }
  const pais = String(opts.pais || "cl").toLowerCase()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 30_000)
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: ctrl.signal,
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODELO,
        max_tokens: 900,
        temperature: 0,
        // El manual va en un bloque cacheado: es el mismo en cada consulta.
        system: [{ type: "text", text: sistema(pais) + manualCompleto(), cache_control: { type: "ephemeral" } }],
        messages: [
          {
            role: "user",
            content: (opts.contexto ? `Contexto de la conversación: ${String(opts.contexto).slice(0, 800)}\n\n` : "") +
              `Pregunta del cliente: ${q}`,
          },
        ],
      }),
    })
    if (!res.ok) return { ok: false, error: `anthropic_${res.status}` }
    const j = (await res.json()) as { content?: Array<{ type?: string; text?: string }> }
    const texto = (j.content || []).filter((c) => c.type === "text").map((c) => c.text || "").join("").trim()
    if (!texto) return { ok: false, error: "respuesta_vacia" }
    if (texto.startsWith(NO_ESTA)) {
      return { ok: true, encontrado: false, respuesta: texto.slice(NO_ESTA.length).trim() }
    }
    return { ok: true, encontrado: true, respuesta: aFormatoWhatsapp(texto) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * ¿El contacto es cliente de GV Avanzado? Hoy la señal confiable es que su
 * empresa la creó el alta por chat (`onboarding_alta_solicitada_<fono>` con
 * companyId). Fail-closed: si no se puede leer, false (el contacto sigue por
 * el camino de soporte de siempre).
 */
export async function esClienteGvAvanzado(contact: string): Promise<boolean> {
  const c = String(contact || "").replace(/\D/g, "")
  if (!c) return false
  try {
    const { getKvValue } = await import("./supabase-persistence-v3")
    const v = await getKvValue(`onboarding_alta_solicitada_${c}`)
    return Boolean(v && /companyId/.test(String(v)))
  } catch {
    return false
  }
}
