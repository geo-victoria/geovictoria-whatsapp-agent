/**
 * Vicky no le pide el teléfono a alguien que le está escribiendo por WhatsApp.
 *
 * CASO QUE ORIGINA ESTE ARCHIVO (27-jul, Victor Bravo de Transportes Vibra):
 * tras acordar que lo contactara un ejecutivo, Vicky cerró con
 *
 *   "Para que un ejecutivo te contacte, me confirmas tu teléfono?
 *    (ya tengo tu nombre, email y empresa del formulario)"
 *
 * El teléfono es el canal por el que están hablando. Pedirlo delata que el
 * agente no sabe dónde está parado, y le agrega un paso al cliente para
 * entregar un dato que ya tenemos.
 *
 * Por qué un guardrail y no una regla de prompt: la regla YA ESTÁ, dos veces
 * — sección "Teléfono del cliente" ("usa el del canal AUTOMÁTICAMENTE... no
 * esperes a que el cliente lo confirme") y la ficha de
 * registrar_solicitud_callback ("NO lo preguntes"). El modelo la saltó igual.
 * Cuando una regla escrita ya falló en producción, la siguiente capa es
 * determinista — mismo criterio que lib/honestidad-entrega.ts.
 *
 * Reemplaza la PETICIÓN, no el mensaje: el resto del turno queda intacto.
 */

/** Cómo se refiere Vicky al número: teléfono, fono, número, celular, WhatsApp. */
const NUM = "(?:tel[eé]fono|fono|n[uú]mero|celular|whats?app)"

/** Lo que se pone en lugar de la pregunta. Cierra la frase, no la abre. */
const REEMPLAZO = "te contacta a este mismo número de WhatsApp"

// El signo de apertura y el de cierre se comen aparte: en WhatsApp la gente
// escribe "me confirmas tu teléfono?" sin abrir, y Vicky la imita.
const PETICIONES: RegExp[] = [
  // "¿me confirmas tu teléfono?" · "me das tu número" · "me compartes tu celular"
  new RegExp(
    `¿?\\s*(?:me\\s+)?(?:confirmas|das|pasas|compartes|dejas|indicas|env[ií]as|facilitas)\\s+(?:tu|el|un)\\s+${NUM}\\b[^.?!\\n]*[.?!]?`,
    "giu",
  ),
  // "¿cuál es tu teléfono?"
  new RegExp(`¿?\\s*cu[aá]l\\s+es\\s+(?:tu|el)\\s+${NUM}\\b[^.?!\\n]*[.?!]?`, "giu"),
  // "necesito tu teléfono" · "me falta tu número"
  new RegExp(
    `(?:necesito|me\\s+falta(?:r[ií]a)?|requiero)\\s+(?:tu|el)\\s+${NUM}\\b[^.?!\\n]*[.?!]?`,
    "giu",
  ),
  // "¿a qué número te llamamos?" · "¿a qué teléfono te contactamos?"
  new RegExp(`¿?\\s*a\\s+qu[eé]\\s+${NUM}\\s+(?:te\\s+)?\\w+[^.?!\\n]*[.?!]?`, "giu"),
]

/**
 * true si el texto le pide el número al cliente. Se expone para los evals: un
 * detector que no detecta pasa los tests sin arreglar nada.
 */
export function pideTelefono(texto: string): boolean {
  return PETICIONES.some((re) => {
    re.lastIndex = 0
    return re.test(texto || "")
  })
}

/**
 * Devuelve el texto sin la petición de teléfono. Si el mensaje era SOLO esa
 * pregunta, queda el reemplazo como frase única — nunca vacío.
 */
export function corregirPedidoDeTelefono(texto: string): string {
  if (!texto) return texto
  let out = texto
  for (const re of PETICIONES) {
    re.lastIndex = 0
    out = out.replace(re, REEMPLAZO + ".")
  }
  if (out === texto) return texto
  // Limpieza de costuras: doble espacio, espacio antes de coma, y el caso
  // "te contacta a este mismo número de WhatsApp.." por el punto que ya venía.
  return out
    .replace(/\.{2,}/g, ".")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^\s*[,;]\s*/gm, "")
    .trim()
}
