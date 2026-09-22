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

/** Guarda el último valor bueno para que un lambda FRÍO no caiga al fallback
 * (caso Kevin 14-ago: mismo chat mostró 40.851,38 y minutos después 40.700 —
 * el hardcode— porque la instancia nueva no tenía cache en memoria). */
async function recordarUF(valor: number): Promise<void> {
  try {
    const { setKvValue } = await import("./supabase-persistence-v3")
    await setKvValue("uf_ultimo_valor", JSON.stringify({ valor, ts: Date.now() }))
  } catch {
    /* best-effort: la UF nunca depende de esto para responder */
  }
}

async function ufRecordada(): Promise<number | null> {
  try {
    const { getKvValue } = await import("./supabase-persistence-v3")
    const raw = await getKvValue("uf_ultimo_valor")
    const v = raw ? (JSON.parse(raw) as { valor?: number }).valor : null
    return typeof v === "number" && v > 0 ? v : null
  } catch {
    return null
  }
}

export async function getUFActual(): Promise<number> {
  if (cache && Date.now() - cache.ts < TTL_MS) return cache.valor
  // Fuente primaria: mindicador. Secundaria: gael (mismo dato oficial del
  // BCCh) — así una caída puntual de una API no cambia el precio que ve el
  // cliente a mitad de conversación.
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
        void recordarUF(valor)
        return valor
      }
    }
  } catch {
    /* sigue a la fuente secundaria */
  }
  try {
    const res = await fetch("https://api.gael.cloud/general/public/monedas/UF", {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    })
    if (res.ok) {
      const data = (await res.json()) as { Valor?: string | number }
      const crudo = String(data?.Valor ?? "").replace(/\./g, "").replace(",", ".")
      const valor = Number(crudo)
      if (Number.isFinite(valor) && valor > 0) {
        cache = { valor, ts: Date.now() }
        void recordarUF(valor)
        return valor
      }
    }
  } catch {
    /* usa cache/kv/fallback abajo */
  }
  if (cache?.valor) return cache.valor
  // Instancia fría sin cache: el último valor bueno vive en vic_kv. El
  // hardcode queda solo para el caso en que nunca se pudo consultar nada.
  const recordado = await ufRecordada()
  return recordado ?? UF_FALLBACK
}
