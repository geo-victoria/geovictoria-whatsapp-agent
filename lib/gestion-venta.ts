/**
 * ¿LA VENTA FUE AUTÓNOMA O ASISTIDA?
 *
 * Definición de Lalo (10-sep, para la columna Pagada del dash):
 *   · **autónoma** = NO hubo actividad del equipo de TELEMARKETING, sin
 *     importar si la conversación se traspasó o no ("puede haber traspaso y
 *     que el ejecutivo no haya hecho nada").
 *   · **asistida** = actividad REAL de un ejecutivo de telemarketing.
 *
 * Y la aclaración que define el borde (Lalo 10-sep): **Aleydis y Aracelli NO
 * cuentan**. Son SDR: o califican leads, o hacen la gestión comercial
 * POSTVENTA de una venta autónoma de Vicky. Que ellas escriban al cliente no
 * convierte la venta en asistida — es justamente lo que hacen DESPUÉS de que
 * Vicky vendió sola. Tampoco cuenta nadie fuera del equipo comercial
 * (implementadores, marketing, cobranza): esa también es postventa.
 *
 * ACTIVIDAD = una de estas cuatro, siempre de alguien del roster TLMK:
 *   nota suya en el deal · nota del ESPEJO de su WhatsApp · mensaje suyo por
 *   su WhatsApp espejado · llamada `accept` en su sesión de espejo.
 *
 * El espejo se mira directo en Supabase además de las notas porque el cron
 * que las sincroniza corre cada ~15 min y una venta recién cerrada quedaría
 * mal clasificada por ese lag.
 *
 * OJO: `hayGestionEnDeal` (traspaso-postpago) sigue con el criterio ANCHO
 * (cualquier humano) porque decide otra cosa — si la venta se le quita al
 * dueño y vuelve al de ventas autónomas — y con el criterio angosto una venta
 * que Aracelli trabajó de verdad se le quitaría. Al implementar el pase
 * retroactivo de owner hay que resolver ese borde con Lalo.
 */

/** Roster de TELEMARKETING: los únicos cuya actividad hace ASISTIDA una
 * venta. Formato "email:zohoId:Nombre,..." (ids verificados en Zoho el
 * 10-sep); override sin deploy con env `VICKY_TLMK_ACTIVIDAD`. La sesión de
 * espejo es la parte local del correo (emujica, alopez, …). */
const ROSTER_TLMK_DEFAULT = [
  "emujica@geovictoria.com:3525045000000211283:Eddyluz Mujica",
  "adiazg@geovictoria.com:3525045000426432190:Anderson Díaz",
  "tmartinezq@geovictoria.com:3525045000223766001:Tamara Martínez",
  "alopez@geovictoria.com:3525045000126464001:Ana Paula López",
  "pdiaz@geovictoria.com:3525045000000211651:Paola Díaz",
  "dgalvez@geovictoria.com:3525045000124240013:Daniela Gálvez",
  "gmelendez@geovictoria.com:3525045000146108001:Grey Meléndez",
].join(",")

export type EjecutivoTlmk = { email: string; id: string; nombre: string; sesion: string }

export function rosterTelemarketing(): EjecutivoTlmk[] {
  return (process.env.VICKY_TLMK_ACTIVIDAD || ROSTER_TLMK_DEFAULT)
    .split(",")
    .map((par) => {
      const [email, id, nombre] = par.split(":").map((x) => (x || "").trim())
      const e = (email || "").toLowerCase()
      return { email: e, id: id || "", nombre: nombre || e.split("@")[0], sesion: e.split("@")[0] }
    })
    .filter((d) => d.email || d.id)
}

/** Sesiones de espejo cuya actividad cuenta (las de las SDR quedan fuera). */
export function sesionesTelemarketing(): Set<string> {
  return new Set(rosterTelemarketing().map((d) => d.sesion).filter(Boolean))
}

export type GestionVenta = "asistida" | "autonoma" | "sd"

export type NotaDeal = { Note_Title?: string | null; Created_By?: { id?: string } | null }

const norm = (s: unknown): string =>
  String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()

/**
 * PURA: ¿esta nota del deal es actividad de TELEMARKETING? El autor de las
 * notas-espejo es el robot (las crea el cron), así que ahí manda el título:
 * "WhatsApp <sesión o nombre> ↔ cliente (espejo…)".
 */
export function esNotaDeTelemarketing(n: NotaDeal): boolean {
  const titulo = norm(n?.Note_Title)
  const roster = rosterTelemarketing()
  if (/\(espejo/.test(titulo)) {
    return roster.some((d) => (d.sesion && titulo.includes(norm(d.sesion))) || (d.nombre && titulo.includes(norm(d.nombre))))
  }
  const autor = String(n?.Created_By?.id || "")
  return Boolean(autor) && roster.some((d) => d.id === autor)
}

export type SenalesGestion = {
  /** Notas del deal ya leídas (undefined = no se pudieron leer). */
  notas?: NotaDeal[]
  /** Mensaje del vendedor por su WhatsApp espejado, YA filtrado a sesiones
   * de telemarketing por el llamador. */
  espejoDeTelemarketing?: boolean
  /** Llamada contestada en una sesión de telemarketing. */
  llamadaDeTelemarketing?: boolean
}

/**
 * PURA: clasifica una venta. Sin ninguna señal legible responde "sd" —
 * declarar "autónoma" lo que no se pudo verificar infla justo la cifra con la
 * que se decide a quién le queda la venta.
 */
export function clasificarGestion(s: SenalesGestion): GestionVenta {
  if (s.espejoDeTelemarketing || s.llamadaDeTelemarketing) return "asistida"
  if (Array.isArray(s.notas)) return s.notas.some(esNotaDeTelemarketing) ? "asistida" : "autonoma"
  return "sd"
}

/** Clave de caché por cotización (vic_kv). El sufijo de versión invalida lo
 * cacheado con el criterio ANCHO de la primera versión del día (contaba a las
 * SDR como asistencia): sube el número al cambiar la regla. */
export const claveGestion = (quoteId: string): string => `venta_gestion_v2_${quoteId}`

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
