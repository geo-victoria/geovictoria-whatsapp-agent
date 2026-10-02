/**
 * CAPACITACIÓN POR LINK (Sofía, implementación, 01-oct): en Chile el Curso 1
 * ya no se reserva con Diego Alegre / Ignacio Salinas por Bookings. El cliente
 * se inscribe él mismo según su tipo de marcaje:
 *
 *   - 1-20 usuarios, solo APP            → Capacitación masiva APP
 *   - 1-20 usuarios, con reloj (BOX/USB) → Capacitación masiva BOX
 *   - 21-50 usuarios                     → Capacitación individual (Bookings
 *                                          del equipo de implementación)
 *
 * "Si no se cambia les van a seguir agendando con ustedes hasta el fin de los
 * tiempos." Las clientas que YA tienen una reserva hecha por Vicky la
 * conservan (su reagendar/cancelar sigue por Bookings).
 *
 * PURO: sin red ni Supabase. Los links se pueden pisar por env sin deploy de
 * código (VICKY_CAP_LINK_APP / _BOX / _INDIVIDUAL).
 */

export type TipoCapacitacion = "masiva_app" | "masiva_box" | "individual"

const LINKS_DEFAULT: Record<TipoCapacitacion, string> = {
  masiva_app: "https://www.geovictoria.com/capacitaciones/capacitacion-masiva-gv4-app-chile/",
  masiva_box: "https://www.geovictoria.com/capacitaciones/capacitacion-masiva-gv4-box-chile/",
  individual: "https://geovictoria.zohobookings.com/4631613000006741310/#/4631613000006741310",
}

const ENV: Record<TipoCapacitacion, string> = {
  masiva_app: "VICKY_CAP_LINK_APP",
  masiva_box: "VICKY_CAP_LINK_BOX",
  individual: "VICKY_CAP_LINK_INDIVIDUAL",
}

/** Tope de la masiva: 20 usuarios entra a la masiva (21 en adelante, individual). */
export const TOPE_MASIVA = 20

export function linkCapacitacion(tipo: TipoCapacitacion, env: Record<string, string | undefined> = process.env): string {
  return (env[ENV[tipo]] || "").trim() || LINKS_DEFAULT[tipo]
}

/**
 * Decide el tipo. `usuarios` desconocido (null/0) = masiva: Vicky vende hasta
 * 20, así que el caso por defecto de un alta por chat es la masiva.
 */
export function tipoCapacitacion(p: { usuarios?: number | null; conEquipo: boolean }): TipoCapacitacion {
  const n = Number(p.usuarios) || 0
  if (n > TOPE_MASIVA) return "individual"
  return p.conEquipo ? "masiva_box" : "masiva_app"
}

export function nombreTipo(tipo: TipoCapacitacion): string {
  return tipo === "masiva_app"
    ? "capacitación masiva para marcaje con APP"
    : tipo === "masiva_box"
      ? "capacitación masiva para marcaje con reloj"
      : "capacitación individual"
}

/** Mensaje al cliente con el link de inscripción. */
export function mensajeCapacitacionLink(tipo: TipoCapacitacion, url: string): string {
  if (tipo === "individual") {
    return (
      `Tu capacitación es individual, con un implementador del equipo 🙌 Elige el día y la hora que te acomoden acá:\n${url}\n\n` +
      `Al reservar te llega la invitación al correo. Cualquier cosa me escribes por aquí 😊`
    )
  }
  return (
    `Tu capacitación es la ${nombreTipo(tipo)} 🙌 Son sesiones por videollamada con fechas fijas; ` +
    `inscríbete en la que te acomode acá:\n${url}\n\n` +
    `Al inscribirte te llega la invitación al correo. Cualquier cosa me escribes por aquí 😊`
  )
}

/** ¿Este país usa capacitación por link? Hoy solo Chile. */
export function paisConCapacitacionPorLink(pais: string): boolean {
  return pais === "cl"
}

/** Llave kv donde queda el link entregado (no se mezcla con onboarding_capacitacion_, que escribe el job de la IMP). */
export const claveCapacitacionLink = (contact: string) => `onb_cap_link_${String(contact).replace(/\D/g, "")}`

/**
 * SIN IMPLEMENTADOR NOMBRADO (Lalo 02-oct, "Vicky sigue presentando a Diego
 * Alegre e Ignacio Salinas; debería mostrar solo los links de las
 * capacitaciones masivas"): con la capacitación por link, el cliente no tiene
 * un relator asignado al que conocer. El prompt de onboarding traía "tu
 * implementador la sube en la capacitación" y "2 horas por videollamada con
 * su relator", y el modelo terminaba presentando nombres. Este reemplazo
 * reescribe esas frases del prompt; la regla dura va al final.
 */
const REEMPLAZOS_SIN_IMPLEMENTADOR: Array<[RegExp, string]> = [
  [/su IMPLEMENTADOR \(su relator\)/g, "el EQUIPO DE IMPLEMENTACIÓN"],
  [/tu implementador los sube y quedan listos para marcar en la capacitación/g, "el equipo de implementación los sube a la plataforma y quedan listos para marcar"],
  [/para que tu implementador la suba y quede lista en tu capacitación/g, "para que el equipo de implementación la suba a la plataforma"],
  [/la sube su implementador en la capacitación/g, "la sube el equipo de implementación"],
  [/a la plataforma la sube su implementador en la capacitación/g, "a la plataforma la sube el equipo de implementación"],
  [/\(Curso 1, 2 horas por videollamada con su relator\)/g, "(sesión online; el cliente se inscribe en el link de capacitación)"],
  [/\(Curso 1, 2 horas por videollamada\)/g, "(sesión online; se inscribe en el link de capacitación)"],
  [/\btu implementador\b/g, "el equipo de implementación"],
  [/\bsu implementador\b/g, "el equipo de implementación"],
  [/\bsu relator\b/g, "el equipo de implementación"],
  [/\btu relator\b/g, "el equipo de implementación"],
]

export const REGLA_SIN_IMPLEMENTADOR =
  "\n\n# REGLA DURA — CAPACITACIÓN POR LINK, SIN IMPLEMENTADOR NOMBRADO (Lalo 02-oct)\n" +
  "- Este cliente NO tiene un implementador ni un relator asignado: se capacita en la sesión online a la que se inscribe por link. " +
  "JAMÁS nombres a una persona del equipo de implementación (ni Diego Alegre ni Ignacio Salinas ni nadie), JAMÁS digas " +
  "'tu implementador', 'tu relator', 'te contacta', 'te llama' ni ofrezcas una videollamada individual.\n" +
  "- Cuando hables de la capacitación, llama ver_cupos_capacitacion y entrega el LINK que devuelve, tal cual.\n" +
  "- Si necesita partir antes o algo no funciona, usa escalar_a_implementador y repite su mensajeParaProspecto tal cual: " +
  "ese mensaje ya dice qué pasa sin nombrar a nadie."

export function sinImplementadorNombrado(texto: string): string {
  let t = String(texto || "")
  for (const [re, por] of REEMPLAZOS_SIN_IMPLEMENTADOR) t = t.replace(re, por)
  return t
}
