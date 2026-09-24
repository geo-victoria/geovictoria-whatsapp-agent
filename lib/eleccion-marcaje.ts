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
