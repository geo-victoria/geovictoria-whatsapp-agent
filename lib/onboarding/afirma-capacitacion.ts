/**
 * ¿El texto le da al cliente una capacitación por AGENDADA?
 *
 * PURO: lo consume el cinturón de salida del onboarding (orquestador) para
 * negarse a mandar una confirmación que ninguna reserva respalda.
 *
 * Nació el 05-sep con la forma "tu capacitación quedó agendada" y el 29-sep
 * (caso TESLA AUSTRAL, IMP-11424) se le escapó esta: "te confirmo por este
 * chat: martes 29 de septiembre a las 09:15 AM con Diego Alegre" — sin la
 * palabra "capacitación" cerca de "agendada", pero con día, hora y relator,
 * que es exactamente lo que el cliente lee como cita tomada. Bookings había
 * rechazado la reserva, el relator recibió un escalamiento genérico y el
 * cliente se presentó a una capacitación que no existía.
 */

const DIA = "(?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)"
const HORA = "\\d{1,2}[:.]\\d{2}(?:\\s*(?:am|pm|a\\.?m\\.?|p\\.?m\\.?|hrs?\\.?))?"

const RE_AGENDADA = [
  /capacitaci[oó]n[^.\n]{0,80}\b(qued[oó]|queda|est[aá])\s+(agendad|confirmad|reservad|lista)/i,
  /\b(qued[oó]|queda)\s+agendad[ao]\b[^.\n]{0,60}\bcapacitaci[oó]n/i,
  // `\b` de JS no reconoce la tilde: "agendé" jamás matcheaba (5ª vez de la cicatriz).
  /\bte\s+(la\s+)?agend[eé](?![a-záéíóúñ])[^.\n]{0,60}\bcapacitaci[oó]n/i,
]

// "te confirmo (por este chat): <día> ... <hora> ... con <Relator>" y variantes:
// "confirmado: martes 29 a las 09:15", "quedamos el martes a las 9:15 con Diego".
const RE_CONFIRMA_DIA_HORA = new RegExp(
  `\\b(?:te\\s+)?confirm(?:o|ad[oa]|amos)\\b[^\\n]{0,80}?\\b${DIA}\\b[^\\n]{0,80}?\\b${HORA}`,
  "i",
)
const RE_QUEDAMOS_DIA_HORA = new RegExp(
  `\\b(?:quedamos|nos\\s+vemos|queda(?:s)?\\s+(?:para|el))\\b[^\\n]{0,40}?\\b${DIA}\\b[^\\n]{0,80}?\\b${HORA}[^\\n]{0,60}?\\bcon\\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+`,
  "i",
)
// Una hora con relator nombrado dentro de una frase de confirmación.
const RE_HORA_CON_RELATOR = new RegExp(
  `\\b${HORA}\\b[^\\n]{0,40}?\\bcon\\s+(?:tu\\s+relator\\s+|tu\\s+implementador\\s+)?[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)?\\b`,
  "i",
)

export function afirmaCapacitacionAgendada(texto: string): boolean {
  const t = String(texto || "")
  if (!t) return false
  if (RE_AGENDADA.some((re) => re.test(t))) return true
  if (RE_CONFIRMA_DIA_HORA.test(t)) return true
  if (RE_QUEDAMOS_DIA_HORA.test(t)) return true
  // "a las 09:15 con Diego Alegre" solo cuenta si además el texto habla de
  // confirmar/agendar: una lista de cupos ("Martes 29 • 09:15 AM") no confirma nada.
  if (RE_HORA_CON_RELATOR.test(t) && /\bconfirm|agend/i.test(t)) return true
  return false
}
