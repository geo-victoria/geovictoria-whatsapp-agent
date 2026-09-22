/**
 * Tool: enviar_ficha_reloj
 *
 * Devuelve el link de la ficha técnica del reloj de asistencia (SenseFace),
 * publicada como asset del cotizador. REACTIVA: solo cuando el prospecto pide
 * información/especificaciones del reloj — mismo patrón que
 * enviar_certificacion, para que Vicky nunca tipee ni invente la URL.
 *
 * El PDF vive en el storage público del cotizador y se actualiza vía
 * /api/admin/upload-asset sin cambiar la URL.
 */

const FICHA_RELOJ_URL =
  process.env.FICHA_RELOJ_URL ||
  "https://cotizacion.geovictoria.com/pdf/assets/ficha-reloj-senseface.pdf"

export const enviarFichaRelojSchema = {
  name: "enviar_ficha_reloj",
  description:
    "Entrega la ficha técnica (PDF) del reloj de control de asistencia de GeoVictoria. Úsala SOLO de forma REACTIVA: cuando el prospecto pide información, especificaciones, características o detalles del reloj/huellero ('qué reloj es?', 'tiene huella?', 'me mandas la ficha?', 'cómo funciona el reloj?', 'sirve para exterior?'). NUNCA la envíes proactivamente ni la uses para responder el PRECIO del reloj (eso va por la cotización). No requiere parámetros. Devuelve un campo mensajeParaProspecto que debes copiar TAL CUAL al prospecto, sin modificar el link.",
  input_schema: {
    type: "object" as const,
    properties: {},
    required: [],
  },
}

export type EnviarFichaRelojResultado = {
  ok: true
  url: string
  mensajeParaProspecto: string
}

export async function enviarFichaReloj(): Promise<EnviarFichaRelojResultado> {
  const url = FICHA_RELOJ_URL
  const mensajeParaProspecto =
    `Te dejo la ficha técnica del reloj de asistencia para que veas todos los detalles: ${url}\n` +
    `Cualquier duda que te quede del equipo, me dices 😊`

  return { ok: true, url, mensajeParaProspecto }
}
