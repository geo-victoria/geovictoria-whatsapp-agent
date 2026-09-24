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

import { rucValido, rutValido } from "./rut.ts"
import { nitEnTexto } from "./paises/co/nit.ts"

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
    (m) => m.role === "assistant" && /(\$\s?\d|\bUF\b|S\/\s?\d|\+\s*IGV\b)/i.test(String(m.content || "")),
  )
}

/**
 * Devuelve la directiva del turno, o "" si no corresponde.
 * El llamador la concatena al FINAL del system prompt.
 */
const RE_RUC = /(?<!\d)(\d{2}[\s.\-]?\d{8}[\s.\-]?\d)(?!\d)/g

/** ¿El texto trae un RUC peruano con dígito verificador correcto? */
export function traeRucValido(texto: string): boolean {
  for (const m of String(texto || "").matchAll(RE_RUC)) {
    if (rucValido(m[1].replace(/\D/g, ""))) return true
  }
  return false
}

export type DocumentoEmpresa = "RUT" | "RUC" | "NIT" | "RFC"

/** RFC mexicano: 3 letras (persona moral) o 4 (física) + fecha AAMMDD + homoclave. */
const RE_RFC = /(?<![A-Za-zÑñ&])[A-Za-zÑñ&]{3,4}[\s-]?\d{6}[\s-]?[A-Za-z0-9]{3}(?![A-Za-z0-9])/

/** ¿El texto trae el documento tributario de la empresa de ese país? */
export function traeDocumento(texto: string, documento: DocumentoEmpresa): boolean {
  const t = String(texto || "")
  if (documento === "RUT") return traeRutValido(t)
  if (documento === "RUC") return traeRucValido(t)
  if (documento === "NIT") return Boolean(nitEnTexto(t))
  return RE_RFC.test(t)
}

/** ¿Vicky ya entregó una cotización formal en esta conversación? */
function yaEmitioFormal(history: TurnoHistorial[]): boolean {
  return history.some(
    (m) => m.role === "assistant" && /\/q\/|quote-acceptance|lista tu cotizaci/i.test(String(m.content || "")),
  )
}

/**
 * EL CORREO NO SE VUELVE A PEDIR (Lalo 24-sep, regla GLOBAL; caso Rodrigo MX:
 * Vicky pidió "RFC · razón social · tu email", él mandó solo el RFC y Vicky
 * respondió "Y me confirmas la razón social de la empresa y tu email?" — un
 * turno quemado por un dato que no hace falta para emitir). El documento puede
 * llegar en ESTE mensaje o en uno anterior: mientras la formal no esté
 * emitida y el cliente nunca haya dado correo, el correo no se menciona más.
 * En México (RFC) la razón social SÍ es obligatoria (no hay padrón que la
 * resuelva): si falta, es la ÚNICA pregunta del turno.
 */
export function directivaRutSinCorreo(
  mensaje: string,
  history: TurnoHistorial[],
  opts: { documento?: DocumentoEmpresa } = {},
): string {
  const documento = opts.documento || "RUT"
  const enMensaje = traeDocumento(mensaje, documento)
  const antes = !enMensaje && history.some((m) => m.role === "user" && traeDocumento(String(m.content || ""), documento))
  if (!enMensaje && !antes) return ""
  if (clienteDioCorreo(mensaje, history)) return ""
  if (!yaVioPrecio(history)) return ""
  if (yaEmitioFormal(history)) return ""
  if (documento === "RFC") {
    return (
      `\n\n[DIRECTIVA DEL TURNO — obligatoria] El cliente ya te entregó el RFC y en toda la conversación NO te ha ` +
      "dado un correo. El correo NO es necesario para emitir: PROHIBIDO volver a pedirlo o mencionarlo. " +
      "Si ya tienes la RAZÓN SOCIAL (la dijo en este mensaje o antes), llama generar_link_cotizadora AHORA, en este " +
      "mismo turno, OMITIENDO `contactoEmail`. Si todavía no la tienes, tu ÚNICA pregunta de este turno es la razón " +
      "social, en una sola línea (\"Me confirmas la razón social de la empresa?\"), sin nombrar el correo."
    )
  }
  if (!enMensaje) {
    return (
      `\n\n[DIRECTIVA DEL TURNO — obligatoria] El cliente YA te entregó el ${documento} en un mensaje anterior y en ` +
      "toda la conversación NO te ha dado un correo. Con el " + documento + " basta: PROHIBIDO volver a pedirle el " +
      "email o mencionarlo. Si este mensaje no cambia la configuración, llama generar_link_cotizadora AHORA, en " +
      "este mismo turno, OMITIENDO `contactoEmail` (si hace una pregunta, respóndela y emite en el mismo turno)."
    )
  }
  return (
    `\n\n[DIRECTIVA DEL TURNO — obligatoria] El cliente acaba de entregarte el ${documento} y en toda la conversación ` +
    `NO te ha dado un correo. Con el ${documento} basta: llama generar_link_cotizadora AHORA, en este mismo turno, ` +
    "OMITIENDO `contactoEmail`. PROHIBIDO volver a pedirle el email, mencionarlo o explicar que no puedes " +
    "enviárselo — su correo se lo pide el formulario de facturación cuando acepte. Entregas con las dos líneas " +
    "de siempre (saludo + link); el PDF lo adjunta el sistema solo."
  )
}
