/**
 * Tool: enviar_ficha_reloj
 *
 * Devuelve el link de la ficha técnica del reloj estándar del PAÍS del
 * contacto, publicada como asset del cotizador. REACTIVA: solo cuando el
 * prospecto pide información/especificaciones del reloj — mismo patrón que
 * enviar_certificacion, para que Vicky nunca tipee ni invente la URL.
 *
 * UN SOLO MECANISMO, DATO LOCAL (Lalo 23-sep): la URL vive en la ficha del
 * país (`fichaRelojUrl` de lib/prompt-nucleo/ficha · lib/paises/<cc>/ficha).
 * Chile → Senseface 4A (desde el 23-sep) · Perú → Senseface 2A · Colombia →
 * sin ficha (la tool lo dice en vez de inventar). El PDF vive en el storage
 * público del cotizador y se actualiza vía /api/admin/upload-asset sin
 * cambiar la URL.
 */

import { FICHA_CL } from "../prompt-nucleo/ficha.ts"
import { FICHA_PE } from "../paises/pe/ficha.ts"
import { FICHA_CO } from "../paises/co/ficha.ts"

export type PaisFicha = "cl" | "pe" | "co" | "mx"

/** URL de la ficha del reloj estándar del país (env FICHA_RELOJ_URL pisa la de Chile). */
export function fichaRelojUrlDe(pais: PaisFicha | string | null | undefined): string | null {
  const p = String(pais || "cl").toLowerCase()
  if (p === "pe") return FICHA_PE.fichaRelojUrl
  if (p === "co") return FICHA_CO.fichaRelojUrl
  if (p === "mx") return null
  return (process.env.FICHA_RELOJ_URL || "").trim() || FICHA_CL.fichaRelojUrl
}

/** País por prefijo del teléfono (51 PE · 57 CO · 52 MX · resto CL, Meta incluido). */
function paisDeContactoLocal(contact: string): PaisFicha {
  const d = String(contact || "").replace(/\D/g, "")
  if (/^519\d{8}$/.test(d)) return "pe"
  if (/^573\d{9}$/.test(d)) return "co"
  if (/^52\d{10}$/.test(d)) return "mx"
  return "cl"
}

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

export type EnviarFichaRelojResultado =
  | { ok: true; url: string; mensajeParaProspecto: string }
  | { ok: false; error: string; sinCapacidadEnPais: string; queHacer: string }

export async function enviarFichaReloj(input?: { _contact?: string; pais?: PaisFicha }): Promise<EnviarFichaRelojResultado> {
  const pais = input?.pais || paisDeContactoLocal(input?._contact || "")
  const url = fichaRelojUrlDe(pais)
  if (!url) {
    return {
      ok: false,
      error: "no hay ficha PDF del equipo en este país",
      sinCapacidadEnPais: pais,
      queHacer: "Descríbelo en texto: rostro, huella, tarjeta o clave; WiFi o cable de red; se conecta a la nube en minutos. Sin marcas ni modelos.",
    }
  }
  const mensajeParaProspecto =
    `Te dejo la ficha técnica del reloj de asistencia para que veas todos los detalles: ${url}\n` +
    `Cualquier duda que te quede del equipo, me dices 😊`

  return { ok: true, url, mensajeParaProspecto }
}
