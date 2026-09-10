/**
 * MONTO DE UN BLOQUE DE PRECIO DEL CHAT (PURO).
 *
 * Nace el 10-sep con la pregunta de Lalo "y en monto cuánto es". La forma real
 * del bloque, verificada ese día en los chats, es:
 *
 *   Resumen mensual recurrente:
 *   - Control de Asistencia: 0,55 UF/mes
 *   Total mensual con IVA: 0,65 UF (aprox. $26.765)
 *
 * O sea: el valor duro está en UF y el CLP viene como aproximación entre
 * paréntesis. Se toma el CLP cuando existe; si el bloque solo trae UF (caso
 * del hardware, "0,35 UF + IVA al mes") se devuelve la UF para convertirla
 * aparte con la UF del día. Los montos son mensuales y CON IVA, porque así
 * los muestra el chat.
 *
 * CICATRIZ (10-sep, al revisar los deals sin valor): la forma larga del bloque
 * trae DOS líneas y la de arriba es NETA:
 *
 *   Subtotal mensual: 3,1 UF
 *   IVA (19%): 0,59 UF
 *   Total mensual con IVA: 3,69 UF
 *
 * "Subtotal mensual" CONTIENE "total mensual", así que la primera versión
 * enganchaba el SUBTOTAL y devolvía el monto NETO como si fuera con IVA — quien
 * después lo dividía por 1,19 dejaba el valor 16 % abajo. Ahora se busca
 * primero la línea del total CON IVA y el "total mensual" pelado se exige sin
 * el "sub" pegado adelante.
 *
 * Cuando el mismo mensaje ofrece DOS OPCIONES (con reloj / solo app) se toma la
 * PRIMERA que aparece, que es la que Vicky presenta como principal.
 */
export function montoDelBloque(texto: string): { clp?: number; uf?: number } {
  const t = String(texto || "")
  const linea = (
    t.match(/total mensual con iva[^\n]*/i) ||
    t.match(/(?<!sub)total mensual[^\n]*/i) ||
    t.match(/[^\n]*uf\s*\+\s*iva al mes[^\n]*/i) ||
    [""]
  )[0]
  // El CLP puede venir en la misma línea ("(aprox. $26.765)") o en la de abajo
  // ("Equivalente: $150.898 CLP/mes (UF del día: …)"). Ese peso es MEJOR que
  // convertir la UF con la de hoy: es la UF del día en que se cotizó. Se busca
  // desde la línea del total hacia adelante para no tomar el de otra opción.
  const desde = linea ? t.indexOf(linea) : -1
  const cola = desde >= 0 ? t.slice(desde, desde + 400) : ""
  const enLinea = linea.match(/\$\s*([\d.]+)/)
  const clpTxt =
    enLinea?.[1] ||
    cola.match(/(?:aprox\.?|equivalente:?)\s*\$\s*([\d.]+)/i)?.[1] ||
    t.match(/aprox\.?\s*\$\s*([\d.]+)/i)?.[1] ||
    ""
  const clp = clpTxt ? Number(clpTxt.replace(/\./g, "")) : NaN
  const ufTxt = linea.match(/([\d]+(?:[.,][\d]+)?)\s*UF/i)?.[1] || ""
  const uf = ufTxt ? Number(ufTxt.replace(",", ".")) : NaN
  return {
    clp: Number.isFinite(clp) && clp > 0 ? clp : undefined,
    uf: Number.isFinite(uf) && uf > 0 ? uf : undefined,
  }
}

