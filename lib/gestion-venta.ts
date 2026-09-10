/**
 * ¿LA VENTA FUE AUTÓNOMA O ASISTIDA?
 *
 * Definición de Lalo (10-sep, para la columna Pagada del dash): **autónoma es
 * cuando NO hubo ACTIVIDAD del ejecutivo — no cuando no hubo traspaso**. Puede
 * haber traspaso y que el ejecutivo no haya hecho nada: esa venta es autónoma.
 * Asistida = traspaso MÁS actividad real.
 *
 * Es el mismo criterio que ya usan `hayGestionEnDeal` (traspaso-postpago, que
 * decide si la venta vuelve al dueño de ventas autónomas) y el correo de
 * PAGADA del cotizador, para que dash, correo y asignación no se contradigan:
 *
 *   ACTIVIDAD = nota de autor humano en el deal · nota del ESPEJO ("(espejo")
 *   · mensaje del vendedor por su WhatsApp espejado · llamada `accept`.
 *
 * El espejo se mira directo en Supabase además de las notas porque el cron
 * que las sincroniza corre cada ~15 min y una venta cerrada recién quedaría
 * mal clasificada por ese lag.
 */

/** Autores cuyas notas NO son gestión: el usuario del OAuth (Vicky) y el
 * token de integración (GeoVictoria Admin). Las notas del ESPEJO las crea el
 * robot pero SÍ cuentan: se reconocen por el título "(espejo". */
export const AUTORES_ROBOT_NOTAS = new Set(["3525045000484500876", "3525045000000200013"])

export type GestionVenta = "asistida" | "autonoma" | "sd"

export type NotaDeal = { Note_Title?: string | null; Created_By?: { id?: string } | null }

/** PURA: ¿esta nota del deal es actividad del ejecutivo? */
export function esNotaDeGestion(n: NotaDeal): boolean {
  if (/\(espejo/i.test(String(n?.Note_Title || ""))) return true
  const autor = String(n?.Created_By?.id || "")
  return Boolean(autor) && !AUTORES_ROBOT_NOTAS.has(autor)
}

export type SenalesGestion = {
  /** Notas del deal ya leídas (undefined = no se pudieron leer). */
  notas?: NotaDeal[]
  /** El vendedor le escribió por su WhatsApp espejado. */
  espejoDelVendedor?: boolean
  /** Llamada contestada en el espejo. */
  llamadaAtendida?: boolean
}

/**
 * PURA: clasifica una venta. Sin ninguna señal legible responde "sd" —
 * declarar "autónoma" lo que no se pudo verificar infla la cifra que Lalo
 * usa para decidir a quién le queda la venta.
 */
export function clasificarGestion(s: SenalesGestion): GestionVenta {
  if (s.espejoDelVendedor || s.llamadaAtendida) return "asistida"
  if (Array.isArray(s.notas)) return s.notas.some(esNotaDeGestion) ? "asistida" : "autonoma"
  return "sd"
}

/** Clave de caché por cotización (vic_kv). */
export const claveGestion = (quoteId: string): string => `venta_gestion_${quoteId}`

/**
 * ¿Hay que releer la clasificación de una venta ya cacheada? Una venta
 * antigua no cambia (nadie deja notas en un deal cerrado hace semanas), pero
 * una recién pagada puede recibir la nota del ejecutivo minutos después.
 */
export function refrescarGestion(
  cache: { g?: string; at?: string } | null,
  pagoMs: number,
  ahoraMs: number,
  diasFrescura = 7,
): boolean {
  if (!cache?.g) return true
  if (cache.g === "sd") return true
  const venta = Number.isFinite(pagoMs) ? ahoraMs - pagoMs : Infinity
  if (venta > diasFrescura * 86_400_000) return false
  const leido = Date.parse(String(cache.at || ""))
  return !Number.isFinite(leido) || ahoraMs - leido > 6 * 3_600_000
}
