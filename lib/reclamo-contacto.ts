/**
 * RECLAMO DEL CLIENTE (02-oct, caso Robin / Consorcio Ingeniería Vial, Perú):
 * a los 27 minutos del traspaso escribió "hasta el momento andie se comunco"
 * y Vicky contestó "Déjame revisar tu caso de inmediato" — sin que nadie se
 * enterara. La directiva del umbral le decía que "el sistema registra su
 * reclamo y alerta al equipo", pero el rescate solo corría cuando VICKY
 * prometía un llamado sin tool, nunca cuando el CLIENTE reclamaba. Las frases
 * son reales (incluidas las faltas de ortografía).
 */
const RECLAMO_CONTACTO = [
  /\b(nadie|andie|ninguno|ning[uú]n\s+ejecutiv\w*)\b[^.?!\n]{0,25}\b(llam|contact|comuni|comunc|escrib|respond)/i,
  /\bno\s+me\s+(han\s+|ha\s+)?(llamad|contactad|contactaron|llamaron|escrib|respond|comunic)/i,
  /\b(a[uú]n|todav[ií]a)\s+no\s+(me\s+)?(ha\s+|han\s+)?(llam|contact|comunic|escrib|respond)/i,
  /\b(sigo|estoy|seguimos|estamos)\s+(esperando|a\s+la\s+espera)\b/i,
  /\ba[uú]n\s+espero\b/i,
  /\bno\s+(me\s+)?responde\b/i,
]

export function clienteReclamaContacto(texto: string): boolean {
  const t = String(texto || "")
  return t.length <= 400 && RECLAMO_CONTACTO.some((re) => re.test(t))
}
