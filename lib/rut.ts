/**
 * Validación del RUT/RUN chileno con dígito verificador (módulo 11).
 *
 * Acepta cualquier RUT o RUN válido (empresa o persona natural; mismo formato y
 * mismo algoritmo). Tolera el formato con puntos y guion ("77.111.222-3"),
 * compacto ("771112223") y la K en mayúscula o minúscula.
 */

// Normaliza a cuerpo+DV sin puntos ni guion, DV en mayúscula.
export function normalizarRut(rutRaw: string): string {
  return String(rutRaw || "")
    .replace(/[.\s-]/g, "")
    .toUpperCase()
}

// Calcula el dígito verificador (módulo 11) de un cuerpo numérico.
function dvModulo11(cuerpo: string): string {
  let suma = 0
  let mult = 2
  for (let i = cuerpo.length - 1; i >= 0; i--) {
    suma += Number(cuerpo[i]) * mult
    mult = mult === 7 ? 2 : mult + 1
  }
  const resto = 11 - (suma % 11)
  if (resto === 11) return "0"
  if (resto === 10) return "K"
  return String(resto)
}

/**
 * true si el RUT/RUN es válido (formato razonable + DV correcto por módulo 11).
 * Exige 7 u 8 dígitos de cuerpo (rango real de RUT/RUN en uso: 1.000.000 a
 * 99.999.999), para no aceptar como válidos números cortos que igual cuadren
 * con el módulo 11.
 */
export function rutValido(rutRaw: string): boolean {
  const limpio = normalizarRut(rutRaw)
  if (limpio.length < 8 || limpio.length > 9) return false // 7-8 dígitos + DV
  const cuerpo = limpio.slice(0, -1)
  const dv = limpio.slice(-1)
  if (!/^\d{7,8}$/.test(cuerpo)) return false
  if (!/^[0-9K]$/.test(dv)) return false
  return dvModulo11(cuerpo) === dv
}

/**
 * Devuelve el RUT en el formato canónico del CRM: SIN puntos y CON guion
 * ("77861333-6"), sin importar cómo lo haya tecleado el cliente. Es la
 * convención del equipo comercial (pedido de Anderson, jul-2026): las SDR
 * buscan los tratos por RUT y el formato con puntos no calza en la búsqueda.
 * Si no es un RUT válido, devuelve el original recortado (la validación se
 * hace aparte). El dedup del cotizador busca todas las variantes, así que el
 * cambio no rompe el match con cuentas antiguas guardadas con puntos.
 */
export function formatearRut(rutRaw: string): string {
  if (!rutValido(rutRaw)) return String(rutRaw || "").trim()
  const limpio = normalizarRut(rutRaw)
  const cuerpo = limpio.slice(0, -1)
  const dv = limpio.slice(-1)
  return `${cuerpo}-${dv}`
}

// ── PERÚ: RUC (Registro Único de Contribuyentes) ────────────────────────────
//
// 11 dígitos: los dos primeros indican el tipo (10 = persona natural con
// negocio, 20 = persona jurídica, 15/16/17 legados), los ocho siguientes son
// el número y el último es el dígito verificador por módulo 11 con pesos
// 5,4,3,2,7,6,5,4,3,2. Igual que el RUT chileno: si no valida, Vicky pide el
// dato de nuevo en vez de emitir una cotización con RUC malo.

export function rucValido(rucRaw: string): boolean {
  const ruc = String(rucRaw || "").replace(/\D/g, "")
  if (!/^\d{11}$/.test(ruc)) return false
  if (!/^(10|15|16|17|20)/.test(ruc)) return false
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]
  const suma = pesos.reduce((acc, p, i) => acc + p * Number(ruc[i]), 0)
  const resto = 11 - (suma % 11)
  const dv = resto === 10 ? 0 : resto === 11 ? 1 : resto
  return dv === Number(ruc[10])
}

/** RUC en formato canónico: solo los 11 dígitos, sin separadores. */
export function formatearRuc(rucRaw: string): string {
  const ruc = String(rucRaw || "").replace(/\D/g, "")
  return rucValido(ruc) ? ruc : String(rucRaw || "").trim()
}
