/**
 * Comprobante de transferencia en un adjunto → directiva EN EL MENSAJE
 * (21-sep noche, E2E Perú en sitio).
 *
 * El cliente mandó la constancia BBVA, la visión la transcribió bien (banco,
 * monto, cuenta de destino nuestra, nº de operación) y el modelo respondió
 * "recibí tu comprobante por S/70…" SIN llamar registrar_comprobante_transferencia
 * — dos veces seguidas, con el reintento del cinturón. La regla está escrita en
 * el prompt (Chile y el núcleo la traen) y no alcanzó: es el mismo hallazgo de
 * la nómina del 25-ago — el system prompt pierde contra la inercia del
 * historial; la instrucción en el contexto inmediato gana.
 *
 * PURO (sin red): detecta por la transcripción si el adjunto es un comprobante
 * de pago a NOSOTROS y arma la directiva con el monto ya extraído. Lo consumen
 * los webhooks al armar el bloque del adjunto. Alcance: global.
 */

const BANCOS = /\b(bbva|bcp|interbank|scotiabank|banco de la naci[oó]n|banco de chile|bci|santander|bancoestado|banco estado|ita[uú]|falabella|ripley|security|bice|bancolombia|davivienda|nequi|banorte|bbva m[eé]xico|banamex|mercado ?pago|fintoc|khipu|yape|plin)\b/i
const TRANSFERENCIA = /\b(transferencia|constancia|comprobante|operaci[oó]n\s+(exitosa|realizada|n[uú]mero|n[°º])|n[°º]\s*de\s+operaci[oó]n|cuenta\s+de\s+destino|cuenta\s+destino|abono|dep[oó]sito)\b/i
// Cuentas nuestras: CL Banco de Chile 8001204108 (Victoria S.A 76188587-1) ·
// PE BBVA 0011-0123-0100091134-75 (RUC 20605842055) · CO Bancolombia
// ahorros 20200000237 (GEOVICTORIA COLOMBIA SAS, NIT 901367959; 21-sep).
const NUESTRO = /geo\s*victoria|victoria\s+s\.?a\.?|8001204108|0011[\s-]?0123[\s-]?0100091134|011[\s-]?123[\s-]?000100091134|76188587|20605842055|20200000237|901[\s.]?367[\s.]?959/i

export function pareceComprobanteTransferencia(descripcion: string): boolean {
  const d = String(descripcion || "")
  if (d.length < 20) return false
  const senales = [BANCOS.test(d), TRANSFERENCIA.test(d), NUESTRO.test(d)].filter(Boolean).length
  // Banco + transferencia basta (la cuenta nuestra no siempre sale entera en una foto);
  // la cuenta nuestra + transferencia también (banco a veces solo como logo).
  return senales >= 2 && TRANSFERENCIA.test(d)
}

/** Primer monto con formato de dinero en la transcripción ("S/ 70.09", "$48.158", "70,09"). */
export function montoEnComprobante(descripcion: string): number {
  const d = String(descripcion || "")
  const m =
    d.match(/(?:monto|total|importe|valor)[^\d\n]{0,25}(?:S\/|\$|CLP|PEN|COP|MXN)?\s*([\d.,]+)/i) ||
    d.match(/(?:S\/|\$)\s*([\d.,]+)/)
  if (!m) return 0
  let s = m[1].replace(/\.$/, "")
  // "1.234.567" o "48.158" (miles con punto, CL) vs "70.09" (decimal, PE) vs "70,09".
  if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "")
  else if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(",", ".")
  else if (/^\d{1,3}(,\d{3})+$/.test(s)) s = s.replace(/,/g, "")
  const n = Number(s)
  return Number.isFinite(n) && n > 0 ? n : 0
}

export function directivaComprobante(descripcion: string): string {
  if (!pareceComprobanteTransferencia(descripcion)) return ""
  const monto = montoEnComprobante(descripcion)
  return (
    "\n\n[DIRECTIVA OBLIGATORIA: el adjunto es un COMPROBANTE DE TRANSFERENCIA. Llama registrar_comprobante_transferencia AHORA MISMO" +
    (monto > 0 ? ` con montoDetectado=${monto}` : " con montoDetectado 0 si el monto no se lee") +
    " y en detalle el banco, la fecha y el número de operación que aparecen. Copia su mensajeParaProspecto tal cual. " +
    "Sin esa tool NO afirmes que recibiste, registraste o confirmaste el pago.]"
  )
}
