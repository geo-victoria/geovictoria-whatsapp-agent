/**
 * Tool: enviar_certificacion
 *
 * Devuelve el link oficial del pronunciamiento de la Dirección del Trabajo
 * (Ordinario N° 861, 13.12.2024) que autoriza el sistema de control de
 * asistencia de GeoVictoria bajo la Resolución Exenta N°38.
 *
 * El documento es público y estático, por lo que el link es una constante.
 * Se entrega como tool (y no como texto del prompt) para que Vicky NUNCA
 * tenga que tipear ni "recordar" la URL: la copia literal del campo
 * `mensajeParaProspecto`, igual que con cotizar_referencial. Así no hay riesgo
 * de que la deforme o la invente.
 */

const CERTIFICACION_DT_URL =
  process.env.CERTIFICACION_DT_URL ||
  "https://www.dt.gob.cl/legislacion/1624/articles-127208_recurso_1.pdf"

export const enviarCertificacionSchema = {
  name: "enviar_certificacion",
  description:
    "Entrega el documento oficial de la Dirección del Trabajo que autoriza el sistema de control de asistencia de GeoVictoria (cumple la Resolución Exenta N°38). Úsala cuando el prospecto pregunta si GeoVictoria está autorizado/certificado por la Dirección del Trabajo (DT), si cumple la normativa de control de asistencia, o pide el documento/certificación/dictamen que lo respalde (ej. 'están autorizados por la DT?', 'tienen la certificación?', 'cumple con la ley?', 'me lo pueden enviar?'). No requiere parámetros. Devuelve un campo mensajeParaProspecto que debes copiar TAL CUAL al prospecto, sin modificar el link.",
  input_schema: {
    type: "object" as const,
    properties: {},
    required: [],
  },
}

export type EnviarCertificacionInput = Record<string, never>

export type EnviarCertificacionResultado = {
  ok: true
  url: string
  mensajeParaProspecto: string
}

export async function enviarCertificacion(): Promise<EnviarCertificacionResultado> {
  const url = CERTIFICACION_DT_URL
  const mensajeParaProspecto =
    `Sí 😊 El sistema de control de asistencia de GeoVictoria está autorizado por la Dirección del Trabajo, ` +
    `según su pronunciamiento oficial (Ordinario N° 861), que valida el cumplimiento de la Resolución Exenta N°38. ` +
    `Te dejo el documento acá: ${url}\n¿Necesitas algo más?`

  return { ok: true, url, mensajeParaProspecto }
}
