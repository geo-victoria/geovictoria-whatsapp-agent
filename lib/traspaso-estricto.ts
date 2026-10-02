/**
 * TRASPASO ESTRICTO (Perú, Lalo 02-oct): con la conversación ya traspasada a
 * un ejecutivo, Vicky no habla de precios ni de capacitación. Caso Electric
 * World / Mónica: con la ejecutiva ya asignada, Vicky calculó el total,
 * prometió "descuento por volumen" y habló de la puesta en marcha — la
 * clienta llamó a Mónica esperando condiciones que nadie le ofreció.
 *
 * PURO (sin red): lo usan el orquestador (cinturón de salida) y los tests.
 * El país lo decide la ficha operativa: procesos.traspasoSinPreciosNiCapacitacion.
 */

/** Tools que entregan, recalculan o emiten precios: bloqueadas tras el traspaso. */
export const TOOLS_PRECIO_TRASPASO = new Set([
  "cotizar_referencial",
  "consultar_descuento_referencial",
  "generar_link_cotizadora",
  "actualizar_cotizacion",
  "consultar_siguiente_descuento",
  "aplicar_siguiente_descuento",
  "anualizar_cotizacion",
])

const norm = (s: string) =>
  String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")

// Montos y vocabulario de precio. Sin `\b` antes de palabras con tilde (se
// normaliza primero, pero los patrones van sin tildes igual).
const PATRONES_PRECIO: RegExp[] = [
  /(?:s\/|us\$|\$)\s?\.?\s?\d/, // S/ 118 · S/.418 · US$20 · $26.000
  /\b\d[\d.,]*\s*(?:soles|dolares|pesos|uf)\b/,
  /\bigv\b|\biva\b/,
  /\b(?:precio|precios|costo|costos|tarifa|tarifas|mensualidad|monto|montos|descuento|descuentos)\b/,
  /\bcuanto\s+(?:cuesta|sale|vale|seria|saldria|pagarias)\b/,
  /\bpor\s+volumen\b/,
]

const PATRONES_CAPACITACION: RegExp[] = [
  /\bcapacit\w*/,
  /\bimplementa(?:cion|dor|dora|dores)\b/,
  /\brelator(?:a|es)?\b/,
  /\bcurso\b/,
  /\bpuesta en marcha\b/,
  /\bonboarding\b/,
]

export function hablaDePrecio(texto: string): boolean {
  const t = norm(texto)
  return PATRONES_PRECIO.some((re) => re.test(t))
}

export function hablaDeCapacitacion(texto: string): boolean {
  const t = norm(texto)
  return PATRONES_CAPACITACION.some((re) => re.test(t))
}

/**
 * Revisa la respuesta del modelo. Si habla de precio o capacitación, la
 * reemplaza por un texto que remite al ejecutivo con su nombre.
 */
export function cinturonTraspasoEstricto(
  reply: string,
  ejecutivo: string,
  opts: { datos?: string; yaRemitido?: boolean } = {},
): { violacion: "" | "precio" | "capacitacion"; reemplazo: string } {
  const precio = hablaDePrecio(reply)
  const cap = !precio && hablaDeCapacitacion(reply)
  if (!precio && !cap) return { violacion: "", reemplazo: reply }
  const quien = ejecutivo || "tu ejecutivo"
  // Datos de contacto (línea del bloque del ejecutivo, sin el nombre).
  const contacto = String(opts.datos || "")
    .split(" · ")
    .slice(1)
    .filter(Boolean)
    .join(" · ")
  const conDatos = contacto ? ` (${contacto})` : ""
  const tema = precio ? "el valor y las condiciones" : "la capacitación y la puesta en marcha"
  const reemplazo = opts.yaRemitido
    ? `Como te comenté, ${tema} los ves directamente con ${quien}${conDatos}. Cualquier duda de cómo funciona el sistema, aquí estoy 😊`
    : `Eso lo ves directamente con ${quien}, que ya tiene tu caso: ${tema} los coordina contigo. ` +
      (contacto ? `Puedes escribirle o llamarle: ${contacto}. ` : `Sus datos de contacto te los dejé más arriba en este chat. `) +
      `Si tienes otra duda del sistema o de cómo funciona, aquí estoy 😊`
  return { violacion: precio ? "precio" : "capacitacion", reemplazo }
}

/** ¿Vicky ya remitió al ejecutivo en su último mensaje? (para no repetir el texto entero). */
export function yaRemitidoAlEjecutivo(ultimoDeVicky: string): boolean {
  return /\blo ves directamente con\b/i.test(String(ultimoDeVicky || ""))
}

/** Bloque extra del prompt (va dentro del bloque del ejecutivo asignado). */
export function reglaTraspasoEstricto(quien: string): string {
  return (
    `\nESTA CONVERSACIÓN YA ESTÁ TRASPASADA A ${quien}. Desde ahora NO hablas de PRECIOS de ninguna forma: ni montos, ni totales, ni el IGV, ni descuentos, ni cotizaciones (tampoco los precios que tú misma diste antes en esta conversación) y NO llamas tools de precio ni de cotización. ` +
    `Tampoco hablas de CAPACITACIÓN, implementación, curso, relator ni puesta en marcha. Si el cliente pregunta por cualquiera de esos temas, dile que lo ve directamente con ${quien} y dale sus datos de contacto de arriba. ` +
    `Sí puedes responder dudas de cómo funciona el sistema (marcaje, app, reloj, reportes) sin dar valores.`
  )
}
