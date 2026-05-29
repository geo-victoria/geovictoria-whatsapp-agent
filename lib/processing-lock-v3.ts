/**
 * Lock distribuido en Supabase para el endpoint /api/vic-botmaker-v3.
 *
 * Reemplaza el `Set<string>` en memoria del Race-condition guard original,
 * que no funciona en serverless porque cada invocación de Vercel puede correr
 * en un container distinto y no comparte memoria.
 *
 * Comportamiento:
 *   - `acquireLock(contact, messageHash)`: intenta crear una fila en
 *     `vic_v3_processing_locks`. Si ya existe (otra request del mismo
 *     contact en curso), devuelve `acquired: false` junto con el hash del
 *     mensaje en proceso, para distinguir retries (mismo hash) de mensajes
 *     nuevos en medio del procesamiento.
 *   - `releaseLock(contact)`: borra la fila al finalizar el procesamiento.
 *     Idempotente (si el lock ya expiró o no existe, no falla).
 *   - Los locks tienen TTL de 90s (default en la tabla). Se hace cleanup
 *     oportunista al adquirir, así no quedan locks zombies si una
 *     invocación serverless muere antes de liberar.
 */

import { createHash } from "node:crypto"

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()

const HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
}

/**
 * Hash determinístico del mensaje para idempotencia.
 * Permite distinguir un retry de Botmaker (mismo mensaje) de un mensaje
 * genuinamente nuevo que entró mientras procesábamos el anterior.
 */
export function hashMessage(contact: string, message: string): string {
  return createHash("sha256")
    .update(`${contact}:${message}`)
    .digest("hex")
    .slice(0, 16)
}

export type LockResult =
  | { acquired: true }
  | { acquired: false; existingHash: string }

/**
 * Adquiere un lock para el contact. Atómico vía PostgREST con
 * `Prefer: resolution=ignore-duplicates`: si ya hay una fila para ese
 * contact, el INSERT no falla pero retorna array vacío.
 *
 * En caso de error de conexión a Supabase, devuelve `acquired: true`
 * (fallback permisivo). Es preferible procesar algunas requests duplicadas
 * a romper el endpoint completo por una falla transitoria.
 */
export async function acquireLock(
  contact: string,
  messageHash: string,
): Promise<LockResult> {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.warn(
      "[v3-lock] SUPABASE_URL o SERVICE_ROLE_KEY no configurados, omitiendo lock",
    )
    return { acquired: true }
  }

  // Cleanup oportunista de locks expirados (fire-and-forget).
  fetch(
    `${SUPABASE_URL}/rest/v1/vic_v3_processing_locks?expires_at=lt.${new Date().toISOString()}`,
    { method: "DELETE", headers: HEADERS, cache: "no-store" },
  ).catch(() => {})

  // Intento atómico de insertar.
  let res: Response
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/vic_v3_processing_locks`, {
      method: "POST",
      headers: {
        ...HEADERS,
        Prefer: "return=representation,resolution=ignore-duplicates",
      },
      body: JSON.stringify({ contact, message_hash: messageHash }),
      cache: "no-store",
    })
  } catch (err) {
    console.error("[v3-lock] Excepción al adquirir:", err)
    return { acquired: true }
  }

  if (!res.ok) {
    console.error(`[v3-lock] Error adquiriendo lock: ${res.status}`)
    return { acquired: true }
  }

  const rows = (await res.json().catch(() => [])) as Array<{
    contact: string
    message_hash: string
  }>

  if (rows.length > 0) {
    // INSERT exitoso, lock adquirido por primera vez.
    return { acquired: true }
  }

  // El INSERT no insertó nada → ya existía un lock. Buscamos el hash
  // existente para que el caller pueda decidir si es retry o no.
  let existingHash = ""
  try {
    const lookupRes = await fetch(
      `${SUPABASE_URL}/rest/v1/vic_v3_processing_locks?contact=eq.${encodeURIComponent(contact)}&select=message_hash`,
      { headers: HEADERS, cache: "no-store" },
    )
    if (lookupRes.ok) {
      const existing = (await lookupRes.json()) as Array<{ message_hash: string }>
      existingHash = existing[0]?.message_hash ?? ""
    }
  } catch {
    // Si no podemos leer el hash existente, devolvemos string vacío.
    // El caller debe tratar ese caso como "lock ocupado, no sé por qué".
  }

  return { acquired: false, existingHash }
}

/**
 * Libera el lock del contact. Idempotente.
 * Best-effort: si falla, no propaga el error.
 */
export async function releaseLock(contact: string): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return
  try {
    await fetch(
      `${SUPABASE_URL}/rest/v1/vic_v3_processing_locks?contact=eq.${encodeURIComponent(contact)}`,
      { method: "DELETE", headers: HEADERS, cache: "no-store" },
    )
  } catch (err) {
    console.error(`[v3-lock] Error liberando lock ${contact}:`, err)
  }
}
