/**
 * CUÁNDO PUEDE AGENDAR SU CAPACITACIÓN (Lalo 04-sep).
 *
 * "Demos 2 días laborales de holgura para poder elegir cita: lo más pronto que
 * puedo agendar es de acá a pasado mañana."
 *
 * Los dos días son para el RELATOR, no para el cliente: Diego y Nacho tienen
 * su semana armada y una capacitación que aparece para mañana les desordena la
 * agenda. Dos días hábiles es el margen con el que alcanzan a acomodarla.
 *
 * Se cuentan días HÁBILES, así que el fin de semana no consume holgura:
 *   jueves  → lunes      (viernes 1, lunes 2)
 *   viernes → martes     (lunes 1, martes 2)
 *   lunes   → miércoles
 *
 * Módulo PURO — sin red, sin fecha implícita: el llamador pasa el ahora. Así se
 * testea sin congelar relojes y la frontera de lib/onboarding sigue limpia.
 */

/** Cuántos días hábiles de holgura antes del primer cupo ofrecible. */
export const HOLGURA_DIAS_HABILES = 2

/** Feriados en formato YYYY-MM-DD; el llamador los inyecta si los tiene. */
export type Feriados = ReadonlySet<string>

/** YYYY-MM-DD en la zona horaria de Chile, que es donde vive la agenda. */
export function fechaCL(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Santiago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d)
}

/** Día de la semana en Chile: 0 domingo … 6 sábado. */
function diaSemanaCL(d: Date): number {
  const s = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Santiago",
    weekday: "short",
  }).format(d)
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(s)
}

export function esDiaHabil(d: Date, feriados: Feriados = new Set()): boolean {
  const dow = diaSemanaCL(d)
  if (dow === 0 || dow === 6) return false
  return !feriados.has(fechaCL(d))
}

/**
 * Primera fecha en la que el cliente puede tomar un cupo: hoy + 2 días
 * hábiles. El día de HOY nunca cuenta, aunque sea hábil y sea temprano.
 */
export function primeraFechaAgendable(ahora: Date, feriados: Feriados = new Set()): string {
  const cursor = new Date(ahora.getTime())
  let habilesContados = 0
  while (habilesContados < HOLGURA_DIAS_HABILES) {
    cursor.setUTCDate(cursor.getUTCDate() + 1)
    if (esDiaHabil(cursor, feriados)) habilesContados++
  }
  return fechaCL(cursor)
}

/**
 * Las próximas `cuantas` fechas hábiles ofrecibles, desde la primera válida.
 * Es lo que Vicky recorre para juntar cupos que mostrarle al cliente.
 */
export function fechasAgendables(ahora: Date, cuantas = 5, feriados: Feriados = new Set()): string[] {
  const out: string[] = []
  const cursor = new Date(ahora.getTime())
  let habilesContados = 0
  while (out.length < cuantas) {
    cursor.setUTCDate(cursor.getUTCDate() + 1)
    if (!esDiaHabil(cursor, feriados)) continue
    habilesContados++
    if (habilesContados >= HOLGURA_DIAS_HABILES) out.push(fechaCL(cursor))
  }
  return out
}

/** Formato que exige la API de Bookings: dd-MMM-yyyy (ej. 08-Sep-2026). */
export function aFormatoBookings(fechaISO: string): string {
  const MESES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
  const [a, m, d] = fechaISO.split("-")
  return `${d}-${MESES[Number(m) - 1]}-${a}`
}

/**
 * El servicio de Bookings que le toca a este cliente. NO es una tómbola nueva:
 * la implementación ya eligió jefe de proyecto entre Diego y Nacho, y la
 * capacitación sigue a ESA persona — el cliente ve la misma cara en el CRM y
 * en el curso. Cada relator tiene su propio servicio en el espacio
 * "GeoAvanzado" (verificado 04-sep: un servicio por relator y por curso).
 */
export const SERVICIOS_GEOAVANZADO = {
  workspace: "4631613000006516347",
  curso1: {
    "isalinas@geovictoria.com": "4631613000006516369",
    "dalegre@geovictoria.com": "4631613000006546573",
  } as Record<string, string>,
  curso2: {
    "isalinas@geovictoria.com": "4631613000006546494",
    "dalegre@geovictoria.com": "4631613000006546604",
  } as Record<string, string>,
  /** Bookings pide el id del relator aparte del servicio (verificados en vivo). */
  staff: {
    "isalinas@geovictoria.com": "4631613000006534230",
    "dalegre@geovictoria.com": "4631613000006545465",
  } as Record<string, string>,
} as const

const norm = (correo: string) => correo.trim().toLowerCase()

export function servicioCurso1De(correoRelator: string): string | null {
  return SERVICIOS_GEOAVANZADO.curso1[norm(correoRelator)] || null
}

export function staffDe(correoRelator: string): string | null {
  return SERVICIOS_GEOAVANZADO.staff[norm(correoRelator)] || null
}

/**
 * "2026-09-08" + "14:30" → "08-Sep-2026 14:30:00", que es lo que come Bookings.
 * Acepta la hora en 24h o con AM/PM, porque los cupos vienen como "02:30 PM"
 * y el cliente escribe "14:30" — traducir eso a mano es pedir un bug.
 */
export function momentoBookings(fechaISO: string, hora: string): string | null {
  const h = hora.trim().toUpperCase()
  const m = h.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/)
  if (!m) return null
  let hh = Number(m[1])
  const mm = Number(m[2])
  if (hh > 23 || mm > 59) return null
  if (m[3] === "PM" && hh < 12) hh += 12
  if (m[3] === "AM" && hh === 12) hh = 0
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaISO)) return null
  return `${aFormatoBookings(fechaISO)} ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00`
}

/** Compara dos horas escritas distinto ("02:30 PM" vs "14:30") sin fallar. */
export function mismaHora(a: string, b: string): boolean {
  const norm24 = (x: string): string | null => {
    const m = x.trim().toUpperCase().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/)
    if (!m) return null
    let hh = Number(m[1])
    if (m[3] === "PM" && hh < 12) hh += 12
    if (m[3] === "AM" && hh === 12) hh = 0
    return `${String(hh).padStart(2, "0")}:${m[2]}`
  }
  const na = norm24(a)
  const nb = norm24(b)
  return Boolean(na && nb && na === nb)
}

/** "Martes 8 de septiembre" — como lo lee una persona, nunca 2026-09-08.
 *  Vivía duplicada en onboarding-canal; fuente única acá (14-sep). */
export function etiquetaFechaCL(fechaISO: string): string {
  const d = new Date(`${fechaISO}T12:00:00-04:00`)
  const t = new Intl.DateTimeFormat("es-CL", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "America/Santiago",
  }).format(d)
  return t.charAt(0).toUpperCase() + t.slice(1)
}

/** Zona horaria de la agenda de los relatores (el workspace de Bookings vive en Chile). */
export const TZ_AGENDA = "America/Santiago"

/** Minutos de desfase de `tz` respecto de UTC en el instante `d` (DST incluido). */
function desfaseMin(tz: string, d: Date): number {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(d)
  const v = (t: string) => Number(p.find((x) => x.type === t)?.value || 0)
  const comoUtc = Date.UTC(v("year"), v("month") - 1, v("day"), v("hour") % 24, v("minute"))
  return Math.round((comoUtc - d.getTime()) / 60000)
}

/**
 * Convierte una hora de agenda ("04:30 PM" o "16:30") de la fecha `fechaISO`
 * desde la zona `desde` a la zona `hacia`, devolviendo el MISMO formato de
 * Bookings ("02:30 PM"). Lalo 24-sep: los cupos del relator (hora de Chile) se
 * muestran en la hora local del cliente, y la que elige el cliente vuelve a
 * la hora de Chile para reservar. Misma zona → la hora tal cual.
 */
export function convertirHoraAgenda(fechaISO: string, hora: string, desde: string, hacia: string): string {
  if (!desde || !hacia || desde === hacia) return hora
  const m = String(hora || "").trim().toUpperCase().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/)
  if (!m || !/^\d{4}-\d{2}-\d{2}$/.test(fechaISO)) return hora
  let hh = Number(m[1])
  const mm = Number(m[2])
  if (m[3] === "PM" && hh < 12) hh += 12
  if (m[3] === "AM" && hh === 12) hh = 0
  const [y, mo, da] = fechaISO.split("-").map(Number)
  const aprox = new Date(Date.UTC(y, mo - 1, da, hh, mm))
  const instante = new Date(aprox.getTime() - desfaseMin(desde, aprox) * 60000)
  const out = new Intl.DateTimeFormat("en-US", {
    timeZone: hacia,
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(instante)
  return out.replace(/ | /g, " ").toUpperCase()
}
