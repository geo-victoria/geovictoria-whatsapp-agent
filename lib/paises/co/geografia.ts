/**
 * Clasificación geográfica de COLOMBIA para la tarifa de envío/instalación.
 *
 * Modelo (observado en Creator CO: "Departamento + Zona Capital/resto"):
 *   - "capital": la ciudad es capital de departamento (Bogotá, Medellín,
 *     Neiva, etc.) → tarifa capital.
 *   - "resto": cualquier otro municipio, o ubicación no reconocida (tarifa
 *     más alta = conservador, igual que el fallback chileno a "regiones").
 *
 * Vicky NUNCA clasifica: transcribe la ubicación y este helper resuelve.
 */

export type ClasificacionCO = {
  zona: "capital" | "resto"
  reconocida: boolean
  canonico: string
}

// Las 32 capitales departamentales + Bogotá D.C. (con aliases frecuentes).
const CAPITALES = [
  "Bogotá", "Bogotá D.C.", "Medellín", "Cali", "Barranquilla", "Cartagena",
  "Cartagena de Indias", "Cúcuta", "Bucaramanga", "Pereira", "Santa Marta",
  "Ibagué", "Pasto", "Manizales", "Neiva", "Villavicencio", "Armenia",
  "Valledupar", "Montería", "Sincelejo", "Popayán", "Tunja", "Riohacha",
  "Quibdó", "Florencia", "Yopal", "Mocoa", "San José del Guaviare", "Mitú",
  "Puerto Carreño", "Inírida", "Leticia", "Arauca", "San Andrés",
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

const CAPITALES_NORM = new Set(CAPITALES.map(normalizar))

export function clasificarUbicacionCO(input: string): ClasificacionCO {
  const norm = normalizar(input || "")
  if (!norm) return { zona: "resto", reconocida: false, canonico: "" }
  if (CAPITALES_NORM.has(norm)) return { zona: "capital", reconocida: true, canonico: norm }
  // Sub-frase ("Bogotá, Chapinero" / "zona industrial de Medellín").
  const acolchado = ` ${norm} `
  for (const c of CAPITALES_NORM) {
    if (acolchado.includes(` ${c} `)) return { zona: "capital", reconocida: true, canonico: c }
  }
  // Municipio no capital o no reconocido → resto (tarifa conservadora).
  return { zona: "resto", reconocida: false, canonico: norm }
}
