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

// ── Buffer de entrada (ráfaga de mensajes) ──────────────────────────────────
//
// vic_v3_inbox acumula los mensajes entrantes por contacto. El procesador que
// toma el lock DRENA todos los pendientes y los procesa como un solo turno, en
// vez de descartar los que llegan durante el procesamiento (bug del caso
// Rodrigo: rubro/nombre/dirección en 3 mensajes seguidos se perdían).

export type InboxMessage = { message: string; created_at: string }

/**
 * Encola un mensaje entrante en el buffer del contacto. Best-effort.
 * Dedup de reintentos de Botmaker vía índice único (contact, msg_hash):
 * `resolution=ignore-duplicates` hace que un retry no se encole dos veces.
 */
export async function bufferInboundMessage(
  contact: string,
  message: string,
  msgHash: string,
): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/vic_v3_inbox`, {
      method: "POST",
      headers: { ...HEADERS, Prefer: "resolution=ignore-duplicates,return=minimal" },
      body: JSON.stringify({ contact, message, msg_hash: msgHash }),
      cache: "no-store",
    })
  } catch (err) {
    console.error("[v3-inbox] Error encolando mensaje:", err)
  }
}

/**
 * Drena (borra y devuelve) TODOS los mensajes pendientes del contacto, en orden
 * cronológico. El DELETE ... RETURNING es atómico: dos procesadores nunca
 * obtienen la misma fila. Devuelve [] si no hay nada o si Supabase falla.
 */
export async function drainInbox(contact: string): Promise<InboxMessage[]> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return []
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/vic_v3_inbox?contact=eq.${encodeURIComponent(contact)}&select=message,created_at`,
      {
        method: "DELETE",
        headers: { ...HEADERS, Prefer: "return=representation" },
        cache: "no-store",
      },
    )
    if (!res.ok) return []
    const rows = (await res.json().catch(() => [])) as InboxMessage[]
    if (!Array.isArray(rows)) return []
    return rows.sort(
      (a, b) => Date.parse(a.created_at || "") - Date.parse(b.created_at || ""),
    )
  } catch (err) {
    console.error("[v3-inbox] Error drenando buffer:", err)
    return []
  }
}

/**
 * ¿Hay mensajes pendientes en el buffer del contacto? (sin borrarlos).
 * Se usa para cerrar la ventana de carrera entre el último drenaje vacío y la
 * liberación del lock.
 */
export async function inboxHasPending(contact: string): Promise<boolean> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return false
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/vic_v3_inbox?contact=eq.${encodeURIComponent(contact)}&select=id&limit=1`,
      { headers: HEADERS, cache: "no-store" },
    )
    if (!res.ok) return false
    const rows = (await res.json().catch(() => [])) as unknown[]
    return Array.isArray(rows) && rows.length > 0
  } catch {
    return false
  }
}
