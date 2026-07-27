/**
 * Respuestas por BOTÓN de las plantillas de WhatsApp.
 *
 * CASO QUE ORIGINA ESTE ARCHIVO (27-jul, contacto 56992047070): el cliente
 * tocó el botón "Elegimos otro proveedor" de vicky_react_47_razones el 25-jul.
 * Dos días después el Loop v2 le mandó un toque preguntándole cuántas personas
 * marcarían asistencia.
 *
 * El motivo: cuando el cliente responde con un botón, Botmaker no manda el
 * texto — manda el payload crudo del intent:
 *
 *   {"button":"Elegimos otro proveedor","entities":"{}","intent":"RuleBuilder…"}
 *
 * Ese JSON entra tal cual como `message`. El detector determinista de rechazo
 * (`esRechazo`) exige `length <= 60` antes de mirar el patrón, así que el
 * payload lo saltaba SIEMPRE por largo: ninguna respuesta por botón se ha
 * clasificado nunca. Y también llegaba crudo al modelo y al historial.
 *
 * Este módulo es PURO (sin red ni base de datos): normaliza el mensaje al
 * texto del botón y traduce los botones de cierre a un motivo.
 *
 * Los tres botones son los de vicky_react_47_razones / _v2, leídos de la API
 * de Botmaker el 27-jul:
 *   QUICK_REPLY "Aún nos interesa" · "Elegimos otro proveedor" · "Ya no lo necesitamos"
 */

/** Texto del botón si `raw` es un payload de botón; "" si es un mensaje normal. */
export function textoDeBoton(raw: string): string {
  const s = (raw || "").trim()
  if (!s.startsWith("{") || !s.includes('"button"')) return ""
  try {
    const obj = JSON.parse(s) as { button?: unknown }
    return typeof obj.button === "string" ? obj.button.trim() : ""
  } catch {
    // Botmaker manda `entities` como string con JSON adentro; si el escapado
    // viene roto, JSON.parse falla y el regex rescata igual el valor.
    const m = s.match(/"button"\s*:\s*"((?:[^"\\]|\\.)*)"/)
    return m ? m[1].replace(/\\"/g, '"').trim() : ""
  }
}

/**
 * Mensaje listo para clasificar, persistir y mandarle al modelo: el texto del
 * botón cuando lo hay, el mensaje original cuando no. Nunca el JSON crudo.
 */
export function normalizarMensajeEntrante(raw: string): string {
  return textoDeBoton(raw) || (raw || "").trim()
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()

/** Botones que cierran el ciclo, con el motivo que corresponde en el CRM. */
const BOTONES_DE_CIERRE: Record<string, "perdido"> = {
  "elegimos otro proveedor": "perdido",
  "ya no lo necesitamos": "perdido",
}

/** Botones que dicen lo contrario: el cliente sigue vivo, no cerrar nada. */
const BOTONES_DE_INTERES = new Set(["aun nos interesa"])

/**
 * true si el TEXTO (ya normalizado, sin JSON alrededor) es uno de los botones
 * que cierran. Se expone aparte de `cierrePorBoton` porque los clasificadores
 * de rechazo corren aguas abajo de `normalizarMensajeEntrante`: para cuando
 * llegan, el payload ya no existe y solo queda la etiqueta.
 */
export function esTextoDeBotonDeCierre(texto: string): boolean {
  return !!BOTONES_DE_CIERRE[norm(texto || "")]
}

/**
 * Motivo de cierre si el mensaje es un botón de cierre; null en cualquier otro
 * caso (mensaje normal, botón de interés, botón desconocido). El default es
 * NO cerrar: un botón nuevo que nadie mapeó no puede matar una conversación
 * viva por su cuenta.
 *
 * Acepta tanto el payload crudo como la etiqueta ya normalizada.
 */
export function cierrePorBoton(raw: string): "perdido" | null {
  const texto = textoDeBoton(raw) || (raw || "").trim()
  if (!texto) return null
  return BOTONES_DE_CIERRE[norm(texto)] || null
}

/** true si el cliente tocó el botón que dice que sigue interesado. */
export function botonDeInteres(raw: string): boolean {
  const texto = textoDeBoton(raw)
  return !!texto && BOTONES_DE_INTERES.has(norm(texto))
}
