/**
 * Validación del NIT colombiano (Número de Identificación Tributaria, DIAN).
 *
 * Criterio (feedback equipo CO, 15-jul): el cliente puede darlo COMO QUIERA —
 * con o sin puntos, con o sin dígito de verificación (DV). El DV NO es
 * requisito: si no viene, lo calculamos nosotros con el algoritmo DIAN
 * (pesos oficiales de derecha a izquierda, módulo 11: resto 0 o 1 → DV =
 * resto; si no, DV = 11 - resto). El bug anterior asumía que el último
 * dígito SIEMPRE era el DV, así que un NIT de 9 dígitos sin DV se partía en
 * cuerpo de 8 + "DV" falso y se rechazaba — mataba el flujo de cotización.
 *
 * Equivalente colombiano de lib/rut.ts (módulo 11 chileno), pero permisivo.
 */

const PESOS_DIAN = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71]

export function digitoVerificacionNit(cuerpo: string): number {
  let suma = 0
  const digitos = cuerpo.split("").reverse()
  for (let i = 0; i < digitos.length; i++) {
    suma += Number(digitos[i]) * (PESOS_DIAN[i] ?? 0)
  }
  const resto = suma % 11
  return resto === 0 || resto === 1 ? resto : 11 - resto
}

/**
 * Extrae el CUERPO del NIT (8-10 dígitos, sin DV) desde cualquier formato:
 * "900.123.456-7", "900123456-7", "9001234567", "900123456". Devuelve "" si
 * no hay un cuerpo válido.
 */
function cuerpoNit(nitRaw: string): string {
  const raw = String(nitRaw || "").trim()
  // Con guion explícito el cliente ya separó cuerpo y DV: el DV se descarta
  // (lo recalculamos) y el cuerpo manda.
  if (raw.includes("-")) {
    const cuerpo = raw.split("-")[0].replace(/\D/g, "")
    return /^\d{8,10}$/.test(cuerpo) ? cuerpo : ""
  }
  const digitos = raw.replace(/\D/g, "")
  if (digitos.length < 8 || digitos.length > 11) return ""
  // 8-9 dígitos: es el cuerpo pelado (el caso más común: NIT sin DV).
  if (digitos.length <= 9) return digitos
  // 10-11 dígitos: ambiguo — puede ser cuerpo largo o cuerpo + DV pegado.
  // Si el último dígito coincide con el DV calculado del resto, era cuerpo+DV.
  const posibleCuerpo = digitos.slice(0, -1)
  const posibleDv = Number(digitos.slice(-1))
  if (digitoVerificacionNit(posibleCuerpo) === posibleDv) return posibleCuerpo
  // Si no coincide: todo es cuerpo (10 dígitos ok; 11 ya no es un NIT).
  return digitos.length <= 10 ? digitos : ""
}

/** Normaliza a "cuerpo-DV" con el DV SIEMPRE calculado por nosotros. */
export function normalizarNit(nitRaw: string): string {
  const cuerpo = cuerpoNit(nitRaw)
  if (!cuerpo) return ""
  return `${cuerpo}-${digitoVerificacionNit(cuerpo)}`
}

/** Válido = tiene un cuerpo de 8-10 dígitos. El DV nunca es requisito. */
export function nitValido(nitRaw: string): boolean {
  return cuerpoNit(nitRaw) !== ""
}

/**
 * Primer NIT de EMPRESA escrito en un texto libre (homólogo de rutEnTexto /
 * rucEnTexto): "900.123.456-7", "900123456-7", "NIT 800123456". Para no
 * confundirlo con un celular (10 dígitos que empiezan en 3) se exige UNA de
 * dos señales: dígito de verificación explícito con guion y correcto, o un
 * cuerpo de 9 dígitos que empiece en 8 o 9 (los NIT de persona jurídica).
 */
export function nitEnTexto(texto: string): string | null {
  const re = /(?<![\d.])(\d{3}[.\s]?\d{3}[.\s]?\d{3}|\d{8,10})(?:\s*-\s*(\d))?(?![\d.])/g
  for (const m of String(texto || "").matchAll(re)) {
    const cuerpo = m[1].replace(/\D/g, "")
    const dv = m[2]
    if (!/^\d{8,10}$/.test(cuerpo)) continue
    if (dv !== undefined) {
      if (digitoVerificacionNit(cuerpo) === Number(dv)) return `${cuerpo}-${dv}`
      continue
    }
    if (/^[89]\d{8}$/.test(cuerpo)) return `${cuerpo}-${digitoVerificacionNit(cuerpo)}`
  }
  return null
}
