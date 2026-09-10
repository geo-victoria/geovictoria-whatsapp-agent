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
 */
export function montoDelBloque(texto: string): { clp?: number; uf?: number } {
  const t = String(texto || "")
  const linea = (t.match(/total mensual[^\n]*/i) || t.match(/[^\n]*uf\s*\+\s*iva al mes[^\n]*/i) || [""])[0]
  const enLinea = linea.match(/\$\s*([\d.]+)/)
  const clpTxt = enLinea?.[1] || t.match(/aprox\.?\s*\$\s*([\d.]+)/i)?.[1] || ""
  const clp = clpTxt ? Number(clpTxt.replace(/\./g, "")) : NaN
  const ufTxt = linea.match(/([\d]+(?:[.,][\d]+)?)\s*UF/i)?.[1] || ""
  const uf = ufTxt ? Number(ufTxt.replace(",", ".")) : NaN
  return {
    clp: Number.isFinite(clp) && clp > 0 ? clp : undefined,
    uf: Number.isFinite(uf) && uf > 0 ? uf : undefined,
  }
}

