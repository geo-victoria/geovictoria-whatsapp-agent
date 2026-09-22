/**
 * Clasificación geográfica de COLOMBIA para la tarifa de envío/instalación.
 *
 * TRES ZONAS = LA LÓGICA DE CHILE (propuesta aprobada por Lalo 22-sep):
 *   - "capital"   = BASE: Bogotá D.C. y los municipios conurbados (Soacha,
 *                   Chía, Cota, Funza, Mosquera, La Calera, Cajicá, Madrid).
 *                   Homólogo de la Región Metropolitana.
 *   - "intermedia" = lo que el técnico alcanza por tierra en el día: el resto
 *                   de Cundinamarca + Boyacá, Tolima y Meta (Tunja, Ibagué,
 *                   Villavicencio, Girardot, Fusagasugá, Zipaquirá…). Homólogo
 *                   de la IV, V y VI Región. Solo cambia el precio de la
 *                   INSTALACIÓN; envío y alquiler la tratan como "fuera de la
 *                   base".
 *   - "resto"     = todo lo demás, incluidas Medellín, Cali y Barranquilla, y
 *                   cualquier ubicación no reconocida (tarifa más alta =
 *                   conservador, igual que el fallback chileno a "regiones").
 *
 * OJO: antes (09-jul→22-sep) "capital" significaba capital de DEPARTAMENTO;
 * hoy significa Bogotá y su área. Las demás capitales son "resto".
 *
 * Vicky NUNCA clasifica: transcribe la ubicación y este helper resuelve.
 */

export type ZonaCO = "capital" | "intermedia" | "resto"

export type ClasificacionCO = {
  zona: ZonaCO
  reconocida: boolean
  canonico: string
}

// BASE: Bogotá y conurbados.
const BASE = [
  "Bogotá", "Bogotá D.C.", "Bogota DC", "Santa Fe de Bogotá", "Soacha", "Chía", "Cota", "Funza",
  "Mosquera", "La Calera", "Cajicá", "Madrid", "Tocancipá", "Sopó", "Tenjo",
] as const

// INTERMEDIA: resto de Cundinamarca + Boyacá + Tolima + Meta (departamentos y
// sus ciudades más frecuentes).
const INTERMEDIA = [
  "Cundinamarca", "Boyacá", "Tolima", "Meta",
  "Zipaquirá", "Facatativá", "Fusagasugá", "Girardot", "Ubaté", "Villeta", "La Mesa", "Melgar",
  "Tunja", "Duitama", "Sogamoso", "Chiquinquirá", "Paipa",
  "Ibagué", "Espinal", "Honda", "Mariquita", "Líbano",
  "Villavicencio", "Acacías", "Granada", "Puerto López", "Restrepo",
] as const

// Otras capitales departamentales: reconocidas, pero "resto" (sin técnico
// propio; la visita se cobra a precio cerrado).
const OTRAS_CAPITALES = [
  "Medellín", "Cali", "Barranquilla", "Cartagena", "Cartagena de Indias", "Cúcuta",
  "Bucaramanga", "Pereira", "Santa Marta", "Pasto", "Manizales", "Neiva", "Armenia",
  "Valledupar", "Montería", "Sincelejo", "Popayán", "Riohacha", "Quibdó", "Florencia",
  "Yopal", "Mocoa", "San José del Guaviare", "Mitú", "Puerto Carreño", "Inírida", "Leticia",
  "Arauca", "San Andrés",
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

const BASE_NORM = new Set(BASE.map(normalizar))
const INTERMEDIA_NORM = new Set(INTERMEDIA.map(normalizar))
const OTRAS_NORM = new Set(OTRAS_CAPITALES.map(normalizar))

function buscar(norm: string, set: Set<string>): string | null {
  if (set.has(norm)) return norm
  const acolchado = ` ${norm} `
  for (const c of set) {
    if (acolchado.includes(` ${c} `)) return c
  }
  return null
}

export function clasificarUbicacionCO(input: string): ClasificacionCO {
  const norm = normalizar(input || "")
  if (!norm) return { zona: "resto", reconocida: false, canonico: "" }
  const b = buscar(norm, BASE_NORM)
  if (b) return { zona: "capital", reconocida: true, canonico: b }
  const i = buscar(norm, INTERMEDIA_NORM)
  if (i) return { zona: "intermedia", reconocida: true, canonico: i }
  const o = buscar(norm, OTRAS_NORM)
  if (o) return { zona: "resto", reconocida: true, canonico: o }
  // Municipio no reconocido → resto (tarifa conservadora).
  return { zona: "resto", reconocida: false, canonico: norm }
}
