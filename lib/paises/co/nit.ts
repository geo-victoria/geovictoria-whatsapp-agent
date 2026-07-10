/**
 * Validación del NIT colombiano (Número de Identificación Tributaria, DIAN).
 *
 * Formato: 8-10 dígitos + dígito de verificación (DV), ej. "900.123.456-7".
 * El DV se calcula con los pesos oficiales de la DIAN aplicados de derecha a
 * izquierda, módulo 11: resto 0 o 1 → DV = resto; si no, DV = 11 - resto.
 *
 * Equivalente colombiano de lib/rut.ts (módulo 11 chileno).
 */

const PESOS_DIAN = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71]

/** Deja solo dígitos y separa cuerpo/DV. Acepta "900123456-7", "900.123.456-7", "9001234567". */
export function normalizarNit(nitRaw: string): string {
  const limpio = String(nitRaw || "").replace(/[^\dkK-]/g, "").replace(/k/gi, "")
  const soloDigitos = limpio.replace(/-/g, "")
  if (soloDigitos.length < 2) return ""
  const cuerpo = soloDigitos.slice(0, -1)
  const dv = soloDigitos.slice(-1)
  return `${cuerpo}-${dv}`
}

export function digitoVerificacionNit(cuerpo: string): number {
  let suma = 0
  const digitos = cuerpo.split("").reverse()
  for (let i = 0; i < digitos.length; i++) {
    suma += Number(digitos[i]) * (PESOS_DIAN[i] ?? 0)
  }
  const resto = suma % 11
  return resto === 0 || resto === 1 ? resto : 11 - resto
}

export function nitValido(nitRaw: string): boolean {
  const norm = normalizarNit(nitRaw)
  if (!norm) return false
  const [cuerpo, dv] = norm.split("-")
  // NIT de empresa: 8 a 10 dígitos de cuerpo (los de persona natural pueden
  // ser más cortos; para venta B2B exigimos el rango empresarial).
  if (!/^\d{8,10}$/.test(cuerpo) || !/^\d$/.test(dv)) return false
  return digitoVerificacionNit(cuerpo) === Number(dv)
}
