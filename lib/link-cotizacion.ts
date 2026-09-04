/**
 * ¿ESTE LINK DE COTIZACIÓN ES DE VERDAD? (04-sep, caso Andrea/Andrés).
 *
 * El 03-sep Vicky entregó dos links que nunca existieron: `/q/COT-310` y
 * `/q/COT000394`. No se corrompieron — el modelo los compuso imitando el
 * patrón del historial cuando la tool de emisión no había corrido. Dos
 * clientes tocaron un 404 en el momento exacto de comprar.
 *
 * La verificación NO necesita red, y por eso es mejor que sondear la página:
 * el código corto es `<quoteId>-<firma>`, donde la firma es HMAC-SHA256 del
 * quoteId con `VICKY_COTIZADORA_SECRET` truncado a 10 hex. Con el secreto se
 * comprueba la firma; sin él, al menos la FORMA. Un `/q/COT-310` muere en el
 * primer filtro; un id de 19 dígitos inventado muere en el segundo.
 *
 * Por qué no un HEAD al link: `api/q.js` responde **404 cuando Zoho falla**
 * (su catch colapsa "no existe" con "no pude preguntar"), así que durante una
 * caída de Zoho —como la de anoche— un link bueno se vería como malo y le
 * negaríamos su cotización a un cliente. La firma no depende de nadie.
 */

import { createHmac } from "crypto"

/** Forma canónica del código corto: 19 dígitos, guion, 10 hex. */
const RE_CODIGO = /^(\d{5,25})-([0-9a-f]{10})$/i

function secreto(): string {
  return (process.env.VICKY_COTIZADORA_SECRET || "").trim()
}

export type VeredictoLink = "valido" | "forma_invalida" | "firma_invalida"

/** Juzga un código corto (lo que va después de `/q/`). */
export function juzgarCodigoCorto(codigo: string): VeredictoLink {
  const m = String(codigo || "").trim().match(RE_CODIGO)
  if (!m) return "forma_invalida"
  const s = secreto()
  // Sin secreto configurado no se puede verificar la firma: la forma es todo
  // lo que tenemos, y alcanza para matar `COT-310`. Jamás rechazar por no
  // poder verificar — ese es el error que convierte una caída propia en una
  // venta perdida.
  if (!s) return "valido"
  const esperada = createHmac("sha256", s).update(m[1]).digest("hex").slice(0, 10)
  return m[2].toLowerCase() === esperada ? "valido" : "firma_invalida"
}

/** Todos los links `/q/…` de un texto, con su veredicto. */
export function auditarLinksDeCotizacion(
  texto: string,
): Array<{ url: string; codigo: string; veredicto: VeredictoLink }> {
  const out: Array<{ url: string; codigo: string; veredicto: VeredictoLink }> = []
  const re = /https?:\/\/[^\s)]*\/q\/([^\s)\]<>,]+)/gi
  for (const m of String(texto || "").matchAll(re)) {
    const codigo = String(m[1] || "").replace(/[.,;:]+$/, "")
    out.push({ url: m[0], codigo, veredicto: juzgarCodigoCorto(codigo) })
  }
  return out
}

/** Links que NO deben salir jamás. */
export function linksInvalidos(texto: string): string[] {
  return auditarLinksDeCotizacion(texto)
    .filter((l) => l.veredicto !== "valido")
    .map((l) => l.url)
}
