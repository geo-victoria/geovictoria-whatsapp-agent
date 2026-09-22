/**
 * Guardrail de ESTILO del agente de onboarding (Lalo 24-ago: "vicky vendedora
 * tiene guardrails que no le permiten enviar mucho texto junto — respetemos
 * eso"). La vendedora lo logra por prompt; el onboarding —que confirma fichas
 * y reporta nóminas— es el escenario con más tentación de párrafos largos,
 * así que acá el tope es DETERMINISTA: si el modelo se pasa, el canal corta
 * limpio en un borde de oración/párrafo antes de enviar.
 *
 * Módulo puro (frontera de lib/onboarding/): solo texto adentro, texto afuera.
 */

/** Tope por mensaje. El mensaje más largo legítimo del flujo (alta exitosa
 * con los 3 pasos) mide ~750 caracteres — el tope lo deja pasar entero. */
export const MAX_CARACTERES_ONBOARDING = 850

/**
 * Corta el texto en el ÚLTIMO borde natural (fin de párrafo, o fin de
 * oración) antes del tope. Nunca corta a mitad de palabra ni deja "…":
 * lo que se envía es un mensaje completo, solo que más corto — la
 * conversación sigue y lo omitido se retoma en el turno siguiente si el
 * cliente lo necesita.
 */
export function acortarParaWhatsApp(texto: string, max = MAX_CARACTERES_ONBOARDING): string {
  const limpio = String(texto || "").trim()
  if (limpio.length <= max) return limpio
  const ventana = limpio.slice(0, max)
  // Preferencia: borde de párrafo → fin de oración → salto de línea simple.
  const bordes = [ventana.lastIndexOf("\n\n"), buscarFinDeOracion(ventana), ventana.lastIndexOf("\n")]
  const corte = Math.max(...bordes)
  // Sin borde razonable (una sola oración kilométrica): corte en el último
  // espacio — jamás a mitad de palabra.
  const posicion = corte > max * 0.4 ? corte : ventana.lastIndexOf(" ")
  return (posicion > 0 ? limpio.slice(0, posicion) : ventana).trim()
}

function buscarFinDeOracion(texto: string): number {
  // Último . ! o ? seguido de espacio/fin — el punto de una sigla o un número
  // (76.242.779) no cuenta porque va pegado al siguiente carácter.
  const m = texto.match(/^[\s\S]*[.!?](?=\s)/)
  return m ? m[0].length : -1
}
