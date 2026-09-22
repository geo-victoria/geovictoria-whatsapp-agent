/**
 * CANDADO DE TURNO para crones (10-ago, pedido de Lalo: "necesito que sea
 * más instantáneo el barrido").
 *
 * Para acelerar los barridos, los crones de toques y traspasos pasan a ser
 * disparados TAMBIÉN por vic-callback-cron (que corre cada ~2 minutos) además
 * de su agenda externa de siempre. Eso abre la puerta a que dos ticks del
 * mismo cron corran a la vez — y un loop-cron duplicado significa DOS
 * WhatsApp idénticos al mismo cliente. Este candado lo impide:
 *
 *   - `reclamarTurno(nombre)` intenta INSERTAR la llave `lock_<nombre>` en
 *     vic_kv SIN upsert: la restricción de unicidad de la tabla decide de
 *     forma atómica — el segundo tick recibe 409 y se retira limpio.
 *   - El candado lleva `expires_at` (backstop): si el proceso muere sin
 *     liberar, el siguiente tick barre el candado vencido y sigue. Nunca se
 *     puede quedar pegado más que el TTL.
 *   - `liberarTurno` al terminar (best-effort; el TTL cubre el olvido).
 */

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()

const H = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
}

/**
 * true = este tick tiene el turno; false = otro tick del mismo cron está
 * corriendo (retirarse sin hacer nada). Fail-open: si Supabase no responde,
 * se concede el turno — mejor arriesgar un solape improbable que apagar el
 * cron completo.
 */
export async function reclamarTurno(nombre: string, ttlSegundos = 240): Promise<boolean> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return true
  const key = `lock_cron_${nombre}`
  const ahora = new Date()
  try {
    // 1. Barrer un candado VENCIDO (proceso que murió sin liberar).
    await fetch(
      `${SUPABASE_URL}/rest/v1/vic_kv?key=eq.${encodeURIComponent(key)}&expires_at=lt.${encodeURIComponent(ahora.toISOString())}`,
      { method: "DELETE", headers: H, cache: "no-store" },
    ).catch(() => undefined)
    // 2. Insertar SIN resolución de conflicto: la unicidad de `key` es el
    //    árbitro atómico. 409 = otro tick llegó primero.
    const r = await fetch(`${SUPABASE_URL}/rest/v1/vic_kv`, {
      method: "POST",
      headers: { ...H, Prefer: "return=minimal" },
      body: JSON.stringify({
        key,
        value: ahora.toISOString(),
        expires_at: new Date(ahora.getTime() + ttlSegundos * 1000).toISOString(),
      }),
      cache: "no-store",
    })
    return r.ok
  } catch {
    return true
  }
}

/** Suelta el turno al terminar el tick. Best-effort: el TTL es el respaldo. */
export async function liberarTurno(nombre: string): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return
  await fetch(`${SUPABASE_URL}/rest/v1/vic_kv?key=eq.${encodeURIComponent(`lock_cron_${nombre}`)}`, {
    method: "DELETE",
    headers: H,
    cache: "no-store",
  }).catch(() => undefined)
}
