/**
 * ¿El dueño actual del lead lo puso NUESTRA regla de leads hace poco?
 *
 * Caso Ernesto / ITV Cambridge (Perú, 01-oct): la derivación sobre el umbral
 * entregó el lead por la regla de leads calificados (Mónica) y 4 segundos
 * después la escalera (RUC + 420 personas) lo convirtió en trato. Como el lead
 * ya tenía "dueño humano", el trato lo heredó y la tómbola de tratos —que
 * para 200-2999 personas lo mandaba a otro equipo— nunca corrió. En Chile pasó
 * lo mismo con CAJA DE AHORROS (25-sep) y no se notó porque la regla de leads
 * y el tramo ≤300 de la tómbola reparten entre la misma gente.
 *
 * Una asignación que hizo nuestro propio código no es gestión humana: dentro
 * de la ventana, el trato se sortea en su tramo. Pasada la ventana, el dueño
 * ya pudo haber trabajado el caso y se respeta (regla 04-ago / 18-ago).
 *
 * Módulo PURO: la marca la escribe lib/zoho-leads (moverPendientes) en vic_kv
 * `lead_regla_<leadId>` = {at, ownerId, ownerEmail}.
 */
export const VENTANA_DUENO_REGLA_MIN_DEFAULT = 120

export function ventanaDuenoReglaMin(): number {
  const n = Number((process.env.VICKY_DUENO_REGLA_MIN || "").trim())
  return Number.isFinite(n) && n > 0 ? n : VENTANA_DUENO_REGLA_MIN_DEFAULT
}

export function duenoPuestoPorRegla(
  marcaRaw: string | null | undefined,
  ownerIdActual: string,
  ahoraMs: number,
  ventanaMin: number = VENTANA_DUENO_REGLA_MIN_DEFAULT,
): boolean {
  if (!marcaRaw || !ownerIdActual) return false
  let marca: { at?: number; ownerId?: string } | null = null
  try {
    marca = JSON.parse(marcaRaw)
  } catch {
    return false
  }
  const at = Number(marca?.at || 0)
  if (!at || ahoraMs - at > ventanaMin * 60_000 || ahoraMs < at) return false
  // Si la marca trae el dueño y hoy el lead es de OTRA persona, alguien lo
  // movió después de nuestra regla: esa decisión manda.
  if (marca?.ownerId && marca.ownerId !== ownerIdActual) return false
  return true
}
