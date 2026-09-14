/**
 * CINTURÓN DE LA CERTIFICACIÓN DE LA DT (14-sep, orden de Lalo "dale con eso").
 *
 * El mismo defecto dos veces: el 02-sep (Soledad / Comercial Zero) Vicky
 * ofreció tres veces "te envío el documento de la DT" y no llamó nunca
 * `enviar_certificacion`; el 14-sep (Dubraska, taller mecánico de Antofagasta)
 * el cliente preguntó "¿este sistema está vinculado con DT?" y Vicky contestó
 * bien —citó la Resolución Exenta N°38— pero tampoco adjuntó el documento.
 *
 * La causa es que en TODO el prompt la certificación está escrita como
 * condicional: "si pide respaldo", "si el cliente quiere el documento". El
 * modelo decide, y ya decidió mal dos veces sobre el mismo punto. Este módulo
 * lo saca de su criterio: si el CLIENTE pregunta por la autorización de la
 * Dirección del Trabajo y la respuesta sale sin el link oficial, el link se
 * ANEXA. Nunca reemplaza el texto del modelo — solo agrega lo que faltaba, así
 * que no puede romper una respuesta correcta.
 *
 * PURO: sin red. La URL es la misma constante de lib/tools/enviar-certificacion
 * (documento público y estático), leída de la misma env para que exista un
 * solo lugar donde cambiarla.
 */

export const CERTIFICACION_DT_URL =
  process.env.CERTIFICACION_DT_URL ||
  "https://www.dt.gob.cl/legislacion/1624/articles-127208_recurso_1.pdf"

/** Sin tildes y en minúsculas: `\b` de JS no trata "ó" como carácter de
 * palabra, y esa cicatriz ya costó tres veces (venció, é de "está"). */
function normalizar(texto: string): string {
  return String(texto || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
}

/**
 * ¿El cliente está preguntando por la autorización/certificación de la DT?
 *
 * Deliberadamente ANCHO en el objeto (DT, Dirección del Trabajo, fiscalización,
 * certificación, dictamen) y ESTRECHO en el verbo: preguntar "cuánto vale" o
 * "cómo marco" jamás entra. Cubre las tres formas reales vistas: la pregunta
 * directa por la autorización, el pedido del documento y la duda de validez
 * ante una fiscalización.
 */
export function preguntaPorCertificacionDT(texto: string): boolean {
  const t = normalizar(texto)
  if (!t.trim()) return false

  // Nombrar el DOCUMENTO ya es pedirlo: "el dictamen", "la certificación", "la
  // Resolución Exenta" no necesitan verbo — nadie los menciona de paso.
  if (/\b(dictamen|certificad[oa]|certificacion|resolucion exenta|res\.? ex\.? ?n?°? ?38)\b/.test(t)) return true

  const objeto =
    /\b(d\.?\s?t\.?|direccion del trabajo|inspeccion del trabajo|resolucion exenta|res\.? ex\.?|dictamen|certificad[oa]|certificacion|fiscalizacion|fiscaliza|normativa)\b/.test(t)
  // "¿esto cumple con la ley?" no nombra a la DT pero es la misma pregunta —
  // está incluso en la descripción de la tool. La ley SOLA no basta (el bloque
  // legal del prompt responde art. 22, 40 horas y biometría sin documento):
  // tiene que venir con el verbo de validez.
  const cumpleLaLey = /\b(cumple|cumplen|valido|valida|legal(mente)?)\b.{0,25}\b(la\s+)?(ley|legislacion|normativa)\b/.test(t)
  if (!objeto && !cumpleLaLey) return false

  const pregunta =
    /\b(autorizad|certificad|valid[oa]|vale|sirve|acredita|cumple|cumplen|homologad|aprobad|reconocid|vinculad|registrad|legal)\b/.test(t) ||
    /\b(me lo puedes? (enviar|mandar|pasar)|lo puedes? (enviar|mandar|pasar)|tienen (el|la|algun)|hay (algun|un) (documento|respaldo|certificado)|documento|respald|comprobante)\b/.test(t) ||
    /\?/.test(t)
  return pregunta
}

/** ¿La respuesta ya trae el documento? Basta con el link: es lo único que el
 * cliente necesita, y es lo que la tool entrega. */
export function respuestaTraeCertificacion(texto: string): boolean {
  const t = String(texto || "")
  if (t.includes(CERTIFICACION_DT_URL)) return true
  // Por si algún día cambia el archivo dentro del mismo dominio oficial.
  return /dt\.gob\.cl\/[^\s]+\.pdf/i.test(t)
}

/** El bloque que se anexa. Mismo contenido que `mensajeParaProspecto` de la
 * tool, sin la pregunta de cierre: acá va pegado a una respuesta que el modelo
 * ya escribió y que suele terminar con su propia pregunta. */
export function anexoCertificacion(): string {
  return (
    `Te dejo el documento oficial para que lo tengas: el pronunciamiento de la Dirección del Trabajo ` +
    `(Ordinario N° 861) que valida el cumplimiento de la Resolución Exenta N°38 👉 ${CERTIFICACION_DT_URL}`
  )
}

/**
 * Punto de entrada del cinturón: devuelve la respuesta con el documento
 * anexado si hacía falta, o la misma respuesta intacta.
 */
export function conCertificacionSiFalta(mensajeCliente: string, reply: string): { texto: string; anexado: boolean } {
  const texto = String(reply || "")
  if (!texto.trim()) return { texto, anexado: false }
  if (!preguntaPorCertificacionDT(mensajeCliente)) return { texto, anexado: false }
  if (respuestaTraeCertificacion(texto)) return { texto, anexado: false }
  return { texto: `${texto.trimEnd()}\n\n${anexoCertificacion()}`, anexado: true }
}
