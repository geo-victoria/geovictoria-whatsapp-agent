/**
 * Validación del RFC mexicano (Registro Federal de Contribuyentes, SAT).
 *
 * Criterio (documento de tropicalización MX — misma filosofía PERMISIVA del
 * NIT colombiano): el cliente puede darlo COMO QUIERA — con o sin espacios,
 * con o sin guiones, en mayúsculas o minúsculas. Solo se valida el formato
 * general:
 *   - Persona moral:  12 caracteres = 3 letras + 6 dígitos (fecha AAMMDD) + 3
 *     de homoclave (letras/dígitos). Ej: CEC200528XX4.
 *   - Persona física: 13 caracteres = 4 letras + 6 dígitos (fecha AAMMDD) + 3
 *     de homoclave. Ej: GOMA850101XY9.
 *   - Fecha plausible: mes 01-12, día 01-31. NO se valida el dígito
 *     verificador de la homoclave (rechazar un RFC real por un algoritmo
 *     estricto mata el flujo de cotización — lección del bug del NIT CO).
 *
 * Equivalente mexicano de co/nit.ts (permisivo por diseño).
 */

/** Normaliza a MAYÚSCULAS sin separadores (espacios, guiones, puntos). */
export function normalizarRfc(rfcRaw: string): string {
  return String(rfcRaw || "")
    .toUpperCase()
    .replace(/[\s.\-]/g, "")
}

/**
 * Válido = formato general de RFC: 3-4 letras (Ñ y & incluidas — aparecen en
 * razones sociales) + fecha AAMMDD plausible + homoclave de 3 alfanuméricos.
 * Largo total 12 (persona moral) o 13 (persona física).
 */
export function rfcValido(rfcRaw: string): boolean {
  const rfc = normalizarRfc(rfcRaw)
  if (rfc.length !== 12 && rfc.length !== 13) return false
  const m = rfc.match(/^([A-ZÑ&]{3,4})(\d{2})(\d{2})(\d{2})([A-Z0-9]{3})$/)
  if (!m) return false
  const mes = Number(m[3])
  const dia = Number(m[4])
  // Fecha AAMMDD plausible (sin calendario fino: 31 de febrero pasa — es
  // preferible aceptar de más que rechazar un RFC real).
  return mes >= 1 && mes <= 12 && dia >= 1 && dia <= 31
}
