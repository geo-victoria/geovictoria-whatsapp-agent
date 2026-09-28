/**
 * RUC AL INICIO DEL NOMBRE DEL TRATO (Perú, Lalo 28-sep). Espejo exacto de
 * api/_shared/nombre-trato-ruc.js del cotizador (que lo aplica al EMITIR la
 * formal); acá se aplica cuando el cliente da el RUC en el CHAT, antes de
 * cualquier formal. Convención del equipo de Perú: "RUC - RAZÓN SOCIAL ...",
 * conservando "- Cotización Vicky" al final.
 *
 * PURA. Si el nombre ya trae ese RUC, no cambia. Tope de Zoho: 120 caracteres.
 */
const SUFIJO_VICKY = " - Cotización Vicky"

export function nombreTratoConRuc(nombre: string, ruc: string): string {
  const doc = String(ruc || "").replace(/\D/g, "")
  const actual = String(nombre || "").trim()
  if (!/^\d{11}$/.test(doc) || !actual) return actual
  if (actual.replace(/\D/g, "").includes(doc)) return actual
  const completo = `${doc} - ${actual}`
  if (completo.length <= 120) return completo
  const tieneSufijo = actual.endsWith(SUFIJO_VICKY)
  const sufijo = tieneSufijo ? SUFIJO_VICKY : ""
  const cuerpo = tieneSufijo ? actual.slice(0, actual.length - SUFIJO_VICKY.length) : actual
  const espacio = 120 - `${doc} - `.length - sufijo.length
  return `${doc} - ${cuerpo.slice(0, espacio).trim()}${sufijo}`
}
