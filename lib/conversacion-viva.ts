/**
 * NO SE TOCA A QUIEN ESTÁ CONVERSANDO (14-sep, orden de Lalo "dale con ambos").
 *
 * Los tres únicos toques que salieron con el RAZONAMIENTO del modelo en vez
 * del mensaje (08-sep, Montecosta y Luis Rivano) tienen la misma raíz, y no es
 * el prompt: el toque no correspondía y el modelo fue el único que se dio
 * cuenta. Luis llevaba ONCE minutos y tres mensajes suyos — estaba pensando la
 * respuesta a la pregunta que Vicky acababa de hacerle, no enfriándose.
 *
 * Medido sobre los 279 toques de 14 días: **69 (25 %) salieron con la
 * conversación viva** — el cliente había escrito hacía menos de 25 minutos y
 * ya llevaba dos o más mensajes. Uno de cada cuatro.
 *
 * El toque de los 10 minutos (cadencia de Rodrigo, 10-ago) se creó para quien
 * escribe y se va; acá NO se cancela, se POSPONE hasta que el silencio sea
 * real. Si el cliente efectivamente se enfría, el toque sale igual.
 *
 * PURO: decide con los mensajes y un reloj que se pasa por parámetro.
 */

export type MensajeConv = { role: string; at?: string; content?: string | null }

/** Minutos de silencio que hacen que una conversación deje de estar "viva". */
export const VENTANA_VIVA_MIN = Math.max(
  10,
  Number(process.env.VICKY_LOOP_VENTANA_VIVA_MIN || 25) || 25,
)

/** Mensajes del cliente que hacen conversación (uno solo es "escribió y se fue"). */
const MIN_MENSAJES_CLIENTE = 2

export type VeredictoViva = {
  viva: boolean
  /** Último mensaje del cliente, en ms. 0 si no hay. */
  ultimoClienteMs: number
  mensajesCliente: number
  /** Cuándo volver a evaluar el toque, en ms. Solo con `viva`. */
  reintentarEnMs: number | null
}

/**
 * ¿El cliente está en medio de la conversación ahora mismo?
 *
 * Dos condiciones, las dos necesarias: escribió hace poco Y ya hubo ida y
 * vuelta real. Quien mandó UN mensaje y desapareció no está conversando: ese
 * es justo el caso para el que existe el toque de los 10 minutos.
 */
export function conversacionViva(
  mensajes: ReadonlyArray<MensajeConv>,
  ahoraMs: number,
  opts: { ventanaMin?: number } = {},
): VeredictoViva {
  const ventana = Math.max(1, opts.ventanaMin ?? VENTANA_VIVA_MIN)
  const delCliente = (mensajes || []).filter((m) => m?.role === "user")
  const tiempos = delCliente
    .map((m) => (m.at ? Date.parse(m.at) : NaN))
    .filter((n) => Number.isFinite(n)) as number[]
  const ultimoClienteMs = tiempos.length ? Math.max(...tiempos) : 0
  const mensajesCliente = delCliente.length
  if (!ultimoClienteMs || mensajesCliente < MIN_MENSAJES_CLIENTE) {
    return { viva: false, ultimoClienteMs, mensajesCliente, reintentarEnMs: null }
  }
  const silencioMin = (ahoraMs - ultimoClienteMs) / 60000
  if (silencioMin >= ventana) {
    return { viva: false, ultimoClienteMs, mensajesCliente, reintentarEnMs: null }
  }
  // Se pospone hasta completar la ventana de silencio, más un minuto de
  // margen para no re-evaluar justo en el borde.
  return {
    viva: true,
    ultimoClienteMs,
    mensajesCliente,
    reintentarEnMs: ultimoClienteMs + ventana * 60000 + 60000,
  }
}
