/**
 * Al ENTREGAR una tarea o llamada del robot a una persona, que quede para HOY.
 *
 * CASO Robin (02-oct, Perú, 170 trabajadores): pidió que lo llamaran, el trato
 * se lo dio la tómbola a Priscila, y la tarea "llamar a Robin" que dejó el
 * workflow "TASK Y CALL NO CONTACTADO" llegó a su lista con vencimiento el
 * LUNES (3 días después); la llamada programada había nacido antes del trato
 * y ya figuraba VENCIDA. En la lista del ejecutivo, un cliente que pidió
 * llamada "lo antes posible" aparecía como algo para la semana siguiente.
 *
 * Regla: tarea con vencimiento futuro → hoy (una vencida conserva su fecha,
 * así sigue viéndose atrasada); llamada en el pasado o sin hora → en 15 min.
 * PURO: sin red, cargable por node --test.
 */

/** Fecha de hoy (YYYY-MM-DD) en la zona dada. */
export function hoyEnZona(tz = "America/Santiago", ahora = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(ahora)
}

/** Fecha-hora en formato Zoho (sin milisegundos, offset explícito). */
export function horaZohoUtc(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "+00:00")
}

export function camposUrgenciaAlEntregar(
  modulo: "Tasks" | "Calls",
  actividad: { Due_Date?: string | null; Call_Start_Time?: string | null },
  opts: { tz?: string; ahora?: Date } = {},
): Record<string, string> {
  const ahora = opts.ahora || new Date()
  if (modulo === "Tasks") {
    const hoy = hoyEnZona(opts.tz, ahora)
    const vence = String(actividad.Due_Date || "")
    return !vence || vence > hoy ? { Due_Date: hoy } : {}
  }
  const inicio = Date.parse(String(actividad.Call_Start_Time || ""))
  return !Number.isFinite(inicio) || inicio < ahora.getTime()
    ? { Call_Start_Time: horaZohoUtc(new Date(ahora.getTime() + 15 * 60e3)) }
    : {}
}
