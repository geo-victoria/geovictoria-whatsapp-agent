/**
 * Clasificación geográfica de MÉXICO para la tarifa de instalación.
 *
 * Modelo (documento de tropicalización MX):
 *   - "cdmx_metro": CDMX (las 16 alcaldías) + municipios conurbados más
 *     comunes de la Zona Metropolitana del Valle de México (Estado de
 *     México) → instalación profesional cotizable por Vicky ($700/punto;
 *     GRATIS en arriendo).
 *   - "resto": cualquier otra ubicación, o no reconocida → la instalación
 *     profesional NO la cotiza Vicky (la cotiza el ejecutivo aparte, o el
 *     cliente auto-instala gratis). El ENVÍO no depende de la zona (tarifa
 *     única nacional en venta, gratis en arriendo).
 *
 * OJO: Toluca queda FUERA de la zona metropolitana cubierta (decisión del
 * documento oficial) — por eso no está en la lista.
 *
 * Vicky NUNCA clasifica: transcribe la ubicación y este helper resuelve.
 * Insensible a acentos y mayúsculas (mismo normalizador que co/geografia.ts).
 */

export type ClasificacionMX = {
  zona: "cdmx_metro" | "resto"
  reconocida: boolean
  canonico: string
}

// CDMX (nombres genéricos + 16 alcaldías) y municipios conurbados del Estado
// de México más comunes, con aliases frecuentes.
const CDMX_METRO = [
  // Nombres genéricos de la capital.
  "Ciudad de México", "CDMX", "DF", "D.F.", "Distrito Federal", "México DF",
  // Las 16 alcaldías de la CDMX.
  "Iztapalapa", "Gustavo A. Madero", "Álvaro Obregón", "Coyoacán", "Tlalpan",
  "Cuauhtémoc", "Venustiano Carranza", "Azcapotzalco", "Benito Juárez",
  "Iztacalco", "Xochimilco", "Miguel Hidalgo", "Tláhuac",
  "Magdalena Contreras", "La Magdalena Contreras",
  "Cuajimalpa", "Cuajimalpa de Morelos", "Milpa Alta",
  // Municipios conurbados del Estado de México (los más comunes de la ZMVM).
  "Ecatepec", "Ecatepec de Morelos", "Nezahualcóyotl", "Ciudad Nezahualcóyotl",
  "Naucalpan", "Naucalpan de Juárez", "Tlalnepantla", "Tlalnepantla de Baz",
  "Chimalhuacán", "Cuautitlán Izcalli", "Atizapán", "Atizapán de Zaragoza",
  "Tultitlán", "Coacalco", "Huixquilucan", "Nicolás Romero", "Tecámac",
  "Chalco", "Ixtapaluca", "Valle de Chalco", "Texcoco",
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

export function clasificarUbicacionMX(input: string): ClasificacionMX {
  const norm = normalizar(input || "")
  if (!norm) return { zona: "resto", reconocida: false, canonico: "" }
  if (CDMX_METRO_NORM.has(norm)) return { zona: "cdmx_metro", reconocida: true, canonico: norm }
  // Sub-frase ("Colonia Roma, Cuauhtémoc" / "bodega en Ecatepec").
  const acolchado = ` ${norm} `
  for (const c of CDMX_METRO_NORM) {
    if (acolchado.includes(` ${c} `)) return { zona: "cdmx_metro", reconocida: true, canonico: c }
  }
  // Fuera de la zona metropolitana cubierta, o no reconocida → resto
  // (la instalación profesional queda para el ejecutivo — nunca se inventa
  // una tarifa; el envío no cambia).
  return { zona: "resto", reconocida: false, canonico: norm }
}
