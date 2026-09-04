/**
 * GUARDRAIL: NINGÚN PRECIO SALE SIN RESPALDO (04-sep, caso Carlos/Anton Paar).
 *
 * Vicky le dijo a un cliente que su plan subía de $43.781 a "$47.642 con 6
 * personas". Es falso: el tramo 3-10 es FIJO, así que 5, 6 u 8 personas
 * cuestan lo mismo. Nadie calculó ese número — el modelo lo compuso. El
 * cliente lo cachó ("creo que subió el precio", "en la cotización inicial
 * tenía $43.780") y bajó su pedido de 6 personas a 5 por una cifra inventada.
 *
 * La regla del repo es vieja y clara: los precios los calcula el motor, jamás
 * el modelo. Faltaba el cinturón que la hiciera cumplir en la SALIDA.
 *
 * PROCEDENCIA, igual que el cinturón de URLs: un monto puede salir si
 *   (a) lo produjo una tool de precio de ESTE turno, o
 *   (b) Vicky ya se lo había dicho antes a este mismo contacto — repetir un
 *       precio vigente es legítimo y pasa todo el día ("¿cuánto era?").
 * Cualquier otro monto es inventado.
 *
 * Módulo PURO (sin red, sin Supabase): la decisión se toma con el texto, las
 * tools del turno y el historial que el webhook ya tiene en memoria.
 */

/** Tools cuyo resultado ES la fuente de verdad de un precio. */
export const TOOLS_DE_PRECIO = new Set([
  "cotizar_referencial",
  "generar_link_cotizadora",
  "actualizar_cotizacion",
  "anualizar_cotizacion",
  "aplicar_siguiente_descuento",
  "consultar_siguiente_descuento",
  "consultar_descuento_referencial",
  "reenviar_cotizacion_correo",
])

/** Montos en pesos ($ 43.781 / $43781) y en UF (0,98 UF · 1.07 UF). */
const RE_CLP = /\$\s?(\d{1,3}(?:[.\s]\d{3})+|\d{4,9})/g
const RE_UF = /(\d{1,4}(?:[.,]\d{1,4})?)\s*UF/gi

/** Cifras "de precio" que aparecen en un texto, normalizadas a número. */
export function montosDe(texto: string): number[] {
  const out: number[] = []
  for (const m of String(texto || "").matchAll(RE_CLP)) {
    const n = Number(String(m[1]).replace(/[.\s]/g, ""))
    // Menos de mil pesos no es un precio de este negocio (evita "$100" de
    // ejemplos y años sueltos).
    if (Number.isFinite(n) && n >= 1000) out.push(n)
  }
  for (const m of String(texto || "").matchAll(RE_UF)) {
    const n = Number(String(m[1]).replace(",", "."))
    // La UF se compara ×1000 para no chocar con los pesos en la misma lista.
    if (Number.isFinite(n) && n > 0) out.push(Math.round(n * 1000))
  }
  return out
}

/** ¿`monto` ya apareció en alguno de estos textos? Tolerancia por redondeo
 *  (el mismo valor se escribe $43.780 y $43.781 según la UF del día). */
function yaDicho(monto: number, textos: string[]): boolean {
  const tol = Math.max(2, monto * 0.02)
  return textos.some((t) => montosDe(t).some((v) => Math.abs(v - monto) <= tol))
}

export type ChequeoPrecio = {
  /** Montos que el modelo afirmó sin que ninguna tool ni el historial los respalde. */
  inventados: number[]
  /** true si hay al menos uno: el llamador debe forzar la tool. */
  hayInventado: boolean
}

/**
 * @param reply       borrador del modelo
 * @param toolsOkDelTurno nombres de las tools que corrieron OK en este turno
 * @param historialAsistente textos que Vicky YA le envió a este contacto
 */
export function chequearPreciosDelReply(
  reply: string,
  toolsOkDelTurno: string[],
  historialAsistente: string[],
): ChequeoPrecio {
  const montos = montosDe(reply)
  if (montos.length === 0) return { inventados: [], hayInventado: false }
  // Una tool de precio en este turno respalda TODO el mensaje: su
  // mensajeParaProspecto trae la cifra y el modelo la reformula (con IVA, en
  // UF, redondeada). Perseguir cifra por cifra ahí produciría falsos
  // positivos con la aritmética legítima del propio texto de la tool.
  if (toolsOkDelTurno.some((t) => TOOLS_DE_PRECIO.has(t))) {
    return { inventados: [], hayInventado: false }
  }
  const inventados = montos.filter((m) => !yaDicho(m, historialAsistente))
  return { inventados, hayInventado: inventados.length > 0 }
}
