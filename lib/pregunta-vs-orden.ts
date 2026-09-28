/**
 * PREGUNTA ≠ ORDEN (28-sep, caso Irene / APPLICATION CALL GROUP, Perú).
 *
 * La clienta tenía su cotización formal con reloj en arriendo y preguntó
 * "¿También tienen en venta?". El modelo la tomó como orden: llamó
 * actualizar_cotizacion y le cambió la formal a venta sin mostrarle el precio
 * ni preguntarle. Después ella no entendía qué tenía en su link.
 *
 * La regla es la de Chile, escrita en la propia tool ("ANTES de llamarla,
 * repite el cambio al cliente y espera su confirmación"), pero una regla de
 * prompt se desobedece: este es el candado determinista. Si el último mensaje
 * del cliente es una PREGUNTA sin ninguna forma de pedido, actualizar la
 * formal se niega y la tool guía a mostrar la opción con cotizar_referencial
 * (el mismo doble valor de Chile) y preguntar.
 *
 * Peor caso de un falso positivo: Vicky muestra el valor y pregunta "¿te la
 * actualizo?" — que es exactamente la conducta pedida.
 */

function normalizar(s: string): string {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
}

/** Formas de PEDIR un cambio, aunque vengan con signo de pregunta ("¿me la cambias a venta?"). */
const ORDEN =
  /(cambi|actualiz|modific|ajust|agreg|quit|saca|sacal|pasal|pasam|ponl|ponm|pongal|dejal|dejam|hazl|hazm|hacel|cotizam|cotizal|cotizame|enviam|mandam|genera|emite|emitel|quiero|queremos|quisiera|prefiero|preferimos|dame|danos|me la |me lo |puedes|podrias|podes|seria posible|por favor|porfa|mejor en|mejor con|con esa|esa opcion|opcion \d|la \d\b|la primera|la segunda|me quedo|nos quedamos|vamos con|va con|avancemos|dale|listo|ok\b|okay)/

/** Arranques típicos de una pregunta informativa. */
const PREGUNTA_INICIO =
  /^(y\s+)?(tambien\s+)?(tienen|hay|existe|venden|arriendan|alquilan|rentan|se puede|es posible|cuanto|cuanta|cuantos|que|cual|como|donde|cuando|incluye|trae|viene|sirve|funciona|y (en|con|si|el|la|los|las)\b)/

/** true si el mensaje es una PREGUNTA informativa sin pedido de cambio. */
export function esPreguntaSinOrden(mensaje: string): boolean {
  const t = normalizar(mensaje).replace(/[¿¡]/g, "").trim()
  if (!t) return false
  const tienePregunta = /\?/.test(t) || PREGUNTA_INICIO.test(t)
  if (!tienePregunta) return false
  return !ORDEN.test(t)
}

export const GUIA_PREGUNTA_SIN_ORDEN =
  "REGLA DE PROCESO (no es un error técnico — no se lo menciones al cliente): el cliente PREGUNTÓ, no pidió cambiar su cotización formal. " +
  "No la modifiques todavía: muéstrale la opción que pregunta con cotizar_referencial (mismo formato de siempre: opción 1 y opción 2 con sus montos) " +
  "y pregúntale si quiere que actualice su cotización con esa opción. Recién con su confirmación llamas actualizar_cotizacion."
