/**
 * ÚLTIMA ELECCIÓN DE MARCAJE DEL CLIENTE (24-sep). PURO.
 *
 * El doble valor (los cuatro países) presenta siempre "1 - … Reloj + App" y
 * "2.- … solo mediante nuestra app". Cuando el cliente responde "la 2",
 * "opción 2" o "solo app", esa es su elección vigente aunque antes haya dicho
 * "reloj y app". Recorre los mensajes del cliente del más reciente al más
 * antiguo y devuelve la PRIMERA elección que encuentra.
 */
function norm(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim()
}

const SOLO_APP =
  /\b(solo|nada mas|unicamente|solamente)\s+(con\s+|por\s+|la\s+|el\s+|mediante\s+)*(la\s+)?app\b|\bsin (el |un )?(reloj|checador|equipo|biometrico|huellero)\b|\bopcion\s*(n[o°º]?\s*)?(2|dos)\b|\bla\s+(2|dos|segunda)\b|\bsegunda opcion\b|\bla mas economica\b|\bme quedo con la app\b|\bsolo el celular\b/
const CON_RELOJ =
  /\breloj|\bchecador|\bhuellero|\bequipo (biometrico|fisico)\b|\bopcion\s*(n[o°º]?\s*)?(1|uno)\b|\bla\s+(1|uno|primera)\b|\bprimera opcion\b|\bmixt|\bambas\b|\blos dos\b|\blas dos\b/

export function ultimaEleccionEsSoloApp(mensajesCliente: string[]): boolean {
  for (let i = mensajesCliente.length - 1; i >= 0; i--) {
    const t = norm(String(mensajesCliente[i] || ""))
    if (!t) continue
    const app = SOLO_APP.test(t)
    // "sin reloj" contiene "reloj": la negación gana dentro del mismo mensaje.
    const reloj = CON_RELOJ.test(t.replace(/\bsin (el |un )?(reloj|checador|equipo|biometrico|huellero)\b/g, ""))
    if (app && !reloj) return true
    if (reloj) return false
  }
  return false
}

/**
 * ELECCIÓN POR NÚMERO (01-oct, caso Productora Disco Sur): el cliente elige
 * con un dígito pelado ("2" frente al menú, "1" frente al doble valor). La
 * cita de un solo carácter no sirve como evidencia y el texto del cliente no
 * dice "reloj", así que el candado bloqueaba la emisión una y otra vez. Este
 * respaldo lee la opción N en el mensaje de Vicky inmediatamente anterior a
 * la respuesta numérica: true si esa opción incluye reloj, false si no,
 * null si la última elección del cliente no fue un número.
 */
const RE_NUMERO_SOLO =
  /^(?:la|el|opcion|op\.?|numero|n[o°º]\.?)?\s*([1-4])\s*[.!)]?\s*$/
const RE_OPCION_RELOJ = /reloj|checador|huellero|biometrico|equipo (fisico|biometrico)|mixt/

export function eleccionNumericaConReloj(
  mensajes: Array<{ role: string; content: unknown }>,
): boolean | null {
  for (let i = mensajes.length - 1; i >= 0; i--) {
    const m = mensajes[i]
    if (m.role !== "user") continue
    const t = norm(String(m.content || ""))
    if (!t) continue
    const num = t.match(RE_NUMERO_SOLO)
    if (!num) {
      // Un mensaje con texto de elección explícita manda sobre un número viejo.
      if (SOLO_APP.test(t) || CON_RELOJ.test(t)) return null
      continue
    }
    const n = num[1]
    const previo = [...mensajes.slice(0, i)].reverse().find((x) => x.role === "assistant")
    if (!previo) return null
    const lineas = String(previo.content || "").split(/\n/).map(norm)
    const ini = lineas.findIndex((l) => new RegExp(`^\\s*(?:opcion\\s*)?${n}\\s*[-.)–:]`).test(l))
    if (ini < 0) return null
    const bloque: string[] = [lineas[ini]]
    for (let j = ini + 1; j < lineas.length; j++) {
      if (/^\s*(?:opcion\s*)?[1-4]\s*[-.)–:]/.test(lineas[j])) break
      bloque.push(lineas[j])
    }
    const texto = bloque.join(" ").replace(/\bsin (el |un )?(reloj|checador|equipo|biometrico|huellero)\b/g, "")
    return RE_OPCION_RELOJ.test(texto)
  }
  return null
}
