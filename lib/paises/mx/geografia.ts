/**
 * Clasificación geográfica de MÉXICO para la tarifa de envío/instalación.
 *
 * TRES ZONAS = LA LÓGICA DE CHILE (propuesta aprobada por Lalo 22-sep):
 *   - "cdmx_metro" = BASE: CDMX (las 16 alcaldías) + municipios conurbados de
 *                    la Zona Metropolitana del Valle de México. Homólogo de la
 *                    Región Metropolitana.
 *   - "intermedia" = lo que el técnico alcanza por tierra en el día: la corona
 *                    de estados — Estado de México fuera de la ZM (Toluca,
 *                    Metepec, Lerma), Morelos, Puebla, Tlaxcala, Hidalgo y
 *                    Querétaro. Homólogo de la IV, V y VI Región. Solo cambia
 *                    el precio de la INSTALACIÓN; envío y renta la tratan como
 *                    "fuera de la base".
 *   - "resto"      = todo lo demás, incluidas Guadalajara y Monterrey, y
 *                    cualquier ubicación no reconocida (tarifa más alta =
 *                    conservador, igual que el fallback chileno a "regiones").
 *
 * Vicky NUNCA clasifica: transcribe la ubicación y este helper resuelve.
 * Insensible a acentos y mayúsculas (mismo normalizador que co/geografia.ts).
 */

export type ZonaMX = "cdmx_metro" | "intermedia" | "resto"

export type ClasificacionMX = {
  zona: ZonaMX
  reconocida: boolean
  canonico: string
}

// CDMX (nombres genéricos + 16 alcaldías) y municipios conurbados del Estado
// de México más comunes, con aliases frecuentes.
const CDMX_METRO = [
  "Ciudad de México", "CDMX", "DF", "D.F.", "Distrito Federal", "México DF",
  "Iztapalapa", "Gustavo A. Madero", "Álvaro Obregón", "Coyoacán", "Tlalpan",
  "Cuauhtémoc", "Venustiano Carranza", "Azcapotzalco", "Benito Juárez",
  "Iztacalco", "Xochimilco", "Miguel Hidalgo", "Tláhuac",
  "Magdalena Contreras", "La Magdalena Contreras",
  "Cuajimalpa", "Cuajimalpa de Morelos", "Milpa Alta",
  "Ecatepec", "Ecatepec de Morelos", "Nezahualcóyotl", "Ciudad Nezahualcóyotl",
  "Naucalpan", "Naucalpan de Juárez", "Tlalnepantla", "Tlalnepantla de Baz",
  "Chimalhuacán", "Cuautitlán Izcalli", "Atizapán", "Atizapán de Zaragoza",
  "Tultitlán", "Coacalco", "Huixquilucan", "Nicolás Romero", "Tecámac",
  "Chalco", "Ixtapaluca", "Valle de Chalco", "Texcoco",
] as const

// INTERMEDIA: corona de estados y sus ciudades más frecuentes.
const INTERMEDIA = [
  "Estado de México", "Edomex", "Morelos", "Puebla", "Tlaxcala", "Hidalgo", "Querétaro",
  "Toluca", "Metepec", "Lerma", "Zinacantepec", "Tenango", "Ixtlahuaca", "Atlacomulco",
  "Cuernavaca", "Cuautla", "Jiutepec", "Temixco", "Yautepec",
  "Puebla de Zaragoza", "Cholula", "San Andrés Cholula", "San Pedro Cholula", "Tehuacán", "Atlixco", "Huejotzingo",
  "Apizaco", "Huamantla", "Chiautempan",
  "Pachuca", "Tula", "Tula de Allende", "Tulancingo", "Tizayuca", "Mineral de la Reforma",
  "Santiago de Querétaro", "San Juan del Río", "Corregidora", "El Marqués",
] as const

// Otras ciudades grandes: reconocidas, pero "resto" (sin técnico propio; la
// visita se cobra a precio cerrado).
const OTRAS = [
  "Guadalajara", "Zapopan", "Tlaquepaque", "Monterrey", "San Pedro Garza García", "Apodaca",
  "San Nicolás de los Garza", "Guadalupe", "Tijuana", "León", "Ciudad Juárez", "Chihuahua",
  "Mérida", "Cancún", "Aguascalientes", "Hermosillo", "Saltillo", "Mexicali", "Culiacán",
  "Veracruz", "Xalapa", "Villahermosa", "Tampico", "Morelia", "Torreón", "Durango",
  "San Luis Potosí", "Oaxaca", "Tuxtla Gutiérrez", "Acapulco", "Mazatlán", "Los Cabos",
  "La Paz", "Campeche", "Chetumal", "Colima", "Tepic", "Zacatecas", "Irapuato", "Celaya",
  "Jalisco", "Nuevo León", "Baja California", "Guanajuato", "Yucatán", "Quintana Roo",
  "Sonora", "Coahuila", "Sinaloa", "Michoacán", "Tabasco", "Chiapas", "Guerrero", "Nayarit",
] as const

function normalizar(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[().,;/]/g, " ")
    .trim()
    .replace(/\s+/g, " ")
}

const CDMX_METRO_NORM = new Set(CDMX_METRO.map(normalizar))
const INTERMEDIA_NORM = new Set(INTERMEDIA.map(normalizar))
const OTRAS_NORM = new Set(OTRAS.map(normalizar))

function buscar(norm: string, set: Set<string>): string | null {
  if (set.has(norm)) return norm
  const acolchado = ` ${norm} `
  for (const c of set) {
    if (acolchado.includes(` ${c} `)) return c
  }
  return null
}

export function clasificarUbicacionMX(input: string): ClasificacionMX {
  const norm = normalizar(input || "")
  if (!norm) return { zona: "resto", reconocida: false, canonico: "" }
  const b = buscar(norm, CDMX_METRO_NORM)
  if (b) return { zona: "cdmx_metro", reconocida: true, canonico: b }
  const i = buscar(norm, INTERMEDIA_NORM)
  if (i) return { zona: "intermedia", reconocida: true, canonico: i }
  const o = buscar(norm, OTRAS_NORM)
  if (o) return { zona: "resto", reconocida: true, canonico: o }
  return { zona: "resto", reconocida: false, canonico: norm }
}
