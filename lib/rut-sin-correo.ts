/**
 * DIRECTIVA DETERMINISTA — "llegó el RUT, no hay correo, EMITE" (Lalo 31-ago).
 *
 * La regla de los tres escenarios vive en el prompt, pero la prueba en vivo
 * del 31-ago la desmintió: Lalo entregó solo el RUT y Vicky respondió
 * "Perfecto! Y tu email?". Es la misma lección del umbral (08-ago) y de la
 * nómina (25-ago): el guion de venta —que pide RUT + email en TODAS partes—
 * le gana a una regla escrita en el preámbulo. Lo que gana es una orden
 * imperativa AL FINAL del prompt, en el contexto inmediato del turno.
 *
 * Se dispara solo cuando las tres condiciones son ciertas:
 *   1. el mensaje del cliente trae un RUT con DV válido,
 *   2. en toda la conversación el cliente NUNCA dio un correo, y
 *   3. ya se le mostró un precio (si no, todavía no toca emitir).
 *
 * Módulo PURO: sin red ni base, para poder testearlo.
 */

import { rutValido } from "./rut.ts"

export type TurnoHistorial = { role: string; content: unknown }

const RE_RUT = /\b\d{1,2}\.?\d{3}\.?\d{3}\s*-?\s*[0-9kK]\b/g
const RE_EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]{2,}/

/** ¿El texto trae al menos un RUT con dígito verificador correcto? */
export function traeRutValido(texto: string): boolean {
  const candidatos = String(texto || "").match(RE_RUT) || []
  return candidatos.some((c) => rutValido(c))
}

/** ¿El cliente entregó un correo en algún momento de la conversación? */
export function clienteDioCorreo(mensaje: string, history: TurnoHistorial[]): boolean {
  if (RE_EMAIL.test(String(mensaje || ""))) return true
  return history.some(
    (m) => m.role === "user" && RE_EMAIL.test(String(m.content || "")),
  )
}

/** ¿Ya se le mostró un precio? (marca de moneda o UF en algo que dijo Vicky) */
function yaVioPrecio(history: TurnoHistorial[]): boolean {
  return history.some(
    (m) => m.role === "assistant" && /(\$\s?\d|\bUF\b)/i.test(String(m.content || "")),
  )
}

/**
 * Devuelve la directiva del turno, o "" si no corresponde.
 * El llamador la concatena al FINAL del system prompt.
 */
export function directivaRutSinCorreo(
  mensaje: string,
  history: TurnoHistorial[],
): string {
  if (!traeRutValido(mensaje)) return ""
  if (clienteDioCorreo(mensaje, history)) return ""
  if (!yaVioPrecio(history)) return ""
  return (
    "\n\n[DIRECTIVA DEL TURNO — obligatoria] El cliente acaba de entregarte el RUT y en toda la conversación " +
    "NO te ha dado un correo. Con el RUT basta: llama generar_link_cotizadora AHORA, en este mismo turno, " +
    "OMITIENDO `contactoEmail`. PROHIBIDO volver a pedirle el email, mencionarlo o explicar que no puedes " +
    "enviárselo — su correo se lo pide el formulario de facturación cuando acepte. Entregas con las dos líneas " +
    "de siempre (saludo + link); el PDF lo adjunta el sistema solo."
  )
}
