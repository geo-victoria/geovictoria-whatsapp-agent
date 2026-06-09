/**
 * Fuente ÚNICA y estable de la UF del día para toda la cotización.
 *
 * Antes había dos funciones separadas (getUFActual con fallback 39000 y
 * getUFActualSafe con fallback 0) que se consultaban de forma independiente en
 * cada tool. Si un fetch fallaba en un turno (timeout) caía a un fallback y
 * otro turno traía el valor real, así que los montos en CLP cambiaban entre el
 * estimado y la negociación/cotización de una misma conversación.
 *
 * Esta versión cachea en memoria el último valor bueno (la UF del día no
 * cambia) y, si el fetch falla, REUTILIZA ese valor en lugar de un número
 * distinto. Dentro de un mismo lambda caliente (turnos seguidos de una
 * conversación) todas las tools obtienen el mismo valor.
 */

let cache: { valor: number; ts: number } | null = null
const TTL_MS = 6 * 60 * 60 * 1000 // 6h: la UF es diaria, no cambia entre turnos
// Respaldo solo para el caso extremo en que nunca se pudo consultar la API.
// Mantener cercano al valor real para minimizar el salto si llegara a usarse.
const UF_FALLBACK = 40700

export async function getUFActual(): Promise<number> {
  if (cache && Date.now() - cache.ts < TTL_MS) return cache.valor
  try {
    const res = await fetch("https://mindicador.cl/api/uf", {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    })
    if (res.ok) {
      const data = (await res.json()) as { serie?: Array<{ valor: number }> }
      const valor = data?.serie?.[0]?.valor
      if (typeof valor === "number" && valor > 0) {
        cache = { valor, ts: Date.now() }
        return valor
      }
    }
  } catch {
    /* usa cache/fallback abajo */
  }
  // Fetch falló: reutiliza el último valor bueno antes que devolver uno distinto.
  return cache?.valor ?? UF_FALLBACK
}
