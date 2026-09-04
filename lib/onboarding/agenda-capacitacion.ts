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
} as const

export function servicioCurso1De(correoRelator: string): string | null {
  return SERVICIOS_GEOAVANZADO.curso1[correoRelator.trim().toLowerCase()] || null
}
