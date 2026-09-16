/**
 * RÚBRICA DE NOTAS (Victoria 16-sep): ¿esta nota del ejecutivo registra fecha
 * y canal, resumen concreto, gestión comercial, resultado y próximo paso? ¿Y
 * describe una conversación REAL con el cliente o solo un intento?
 *
 * Determinista primero (notas de una palabra, "sgto", "en seguimiento", "se
 * llama y no contesta" no necesitan modelo); Haiku para el resto, con el
 * veredicto CACHEADO en vic_kv por id de nota (`nota_rubrica_v1_<id>`) para
 * que el pase sea repetible y auditable sin volver a pagar.
 */
import { rubricaDeterminista, type RubricaNota } from "./gestion-venta-v3"
import { getKvValue, setKvValue } from "./supabase-persistence-v3"

export const VERSION_RUBRICA = "v1"
const claveRubrica = (id: string): string => `nota_rubrica_${VERSION_RUBRICA}_${id}`

export async function evaluarNota(id: string, contenido: string, apiKey: string): Promise<RubricaNota | null> {
  const det = rubricaDeterminista(contenido)
  if (det) return det
  const cache = await getKvValue(claveRubrica(id)).catch(() => null)
  if (cache) { try { return JSON.parse(cache) as RubricaNota } catch { /* sigue */ } }
  if (!apiKey) return null
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 250,
        system:
          "Evalúas una NOTA que un ejecutivo de ventas dejó en el CRM sobre un cliente. Responde SOLO un JSON con esta forma exacta: " +
          '{"fechaCanal":bool,"resumen":bool,"gestion":bool,"resultado":bool,"proximoPaso":bool,"bidireccional":bool,"intentoSinRespuesta":bool}. ' +
          "fechaCanal = la nota dice cuándo y por qué canal se contactó al cliente (fecha explícita, o palabras como hoy/ayer, y llamada/WhatsApp/correo/reunión). " +
          "resumen = resume concretamente qué se conversó o qué necesita el cliente. " +
          "gestion = describe una gestión comercial realizada (levantar necesidades, explicar o enviar información, resolver dudas, presentar propuesta, manejar objeciones, acordar próximo paso). " +
          "resultado = dice qué se logró o cómo quedó el cliente. proximoPaso = fija un próximo paso concreto. " +
          "bidireccional = la nota evidencia que el CLIENTE respondió o conversó (contestó la llamada, respondió el WhatsApp, participó en reunión, dijo algo). " +
          "intentoSinRespuesta = la nota describe SOLO intentos sin respuesta del cliente (no contesta, buzón, se envía mensaje sin respuesta). " +
          "Una nota como 'en seguimiento' o 'sgto' tiene todo en false. Sé estricto: en duda, false. Sin texto fuera del JSON.",
        messages: [{ role: "user", content: contenido.slice(0, 4000) }],
      }),
      cache: "no-store",
    })
    if (!res.ok) return null
    const data = (await res.json().catch(() => ({}))) as { content?: Array<{ text?: string }> }
    const m = (data?.content?.[0]?.text || "").match(/\{[\s\S]*\}/)
    if (!m) return null
    const j = JSON.parse(m[0]) as Record<string, unknown>
    const r: RubricaNota = {
      fechaCanal: j.fechaCanal === true, resumen: j.resumen === true, gestion: j.gestion === true,
      resultado: j.resultado === true, proximoPaso: j.proximoPaso === true,
      bidireccional: j.bidireccional === true, intentoSinRespuesta: j.intentoSinRespuesta === true,
    }
    await setKvValue(claveRubrica(id), JSON.stringify(r)).catch(() => null)
    return r
  } catch {
    return null
  }
}
