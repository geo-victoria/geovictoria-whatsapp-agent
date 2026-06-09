/**
 * Clasificación geográfica de Chile para fines de cotización.
 *
 * Resuelve la ubicación que entrega un prospecto (comuna, región por
 * nombre, ordinal o número romano) y la clasifica en "RM" vs "regiones",
 * que es la única distinción que importa para el modelo de tarifa actual.
 *
 * Vive en `lib/`, no en `lib/catalogo/`, porque es lógica transversal
 * reutilizable más allá del catálogo (asignación de KAM por región,
 * derivación a soporte regional, reglas de envío, etc.).
 *
 * Premisa rectora: Vicky NUNCA clasifica. Vicky transcribe lo que dice
 * el prospecto y este helper resuelve la clasificación.
 */

// ─── Listas oficiales ──────────────────────────────────────────────────────

/**
 * Las 52 comunas de la Región Metropolitana de Santiago según la división
 * administrativa de Chile. No cambian salvo reforma territorial.
 */
const COMUNAS_RM = [
  // Provincia de Santiago
  "Cerrillos", "Cerro Navia", "Conchalí", "El Bosque", "Estación Central",
  "Huechuraba", "Independencia", "La Cisterna", "La Florida", "La Granja",
  "La Pintana", "La Reina", "Las Condes", "Lo Barnechea", "Lo Espejo",
  "Lo Prado", "Macul", "Maipú", "Ñuñoa", "Pedro Aguirre Cerda",
  "Peñalolén", "Providencia", "Pudahuel", "Quilicura", "Quinta Normal",
  "Recoleta", "Renca", "San Joaquín", "San Miguel", "San Ramón",
  "Santiago", "Vitacura",
  // Provincia de Cordillera
  "Puente Alto", "Pirque", "San José de Maipo",
  // Provincia de Maipo
  "Buin", "Calera de Tango", "Paine", "San Bernardo",
  // Provincia de Melipilla
  "Alhué", "Curacaví", "María Pinto", "Melipilla", "San Pedro",
  // Provincia de Talagante
  "El Monte", "Isla de Maipo", "Padre Hurtado", "Peñaflor", "Talagante",
  // Provincia de Chacabuco
  "Colina", "Lampa", "Til Til",
] as const

/** Aliases comunes para referirse a la Región Metropolitana. */
const ALIAS_RM = [
  "rm", "region metropolitana", "metropolitana", "santiago",
  "gran santiago",
] as const

/**
 * Nombres canónicos y aliases de ciudades/regiones fuera de RM.
 * Lista no exhaustiva: cubre los casos más frecuentes. Lo que no esté
 * acá pero tenga formato razonable cae al fallback "regiones con
 * advertencia" para que el ejecutivo confirme.
 */
const ALIAS_REGIONES_FUERA_RM = [
  // Norte
  "arica", "arica y parinacota", "parinacota",
  "tarapaca", "iquique",
  "antofagasta", "calama",
  "atacama", "copiapo",
  "coquimbo", "la serena",
  // Centro
  "valparaiso", "vina del mar", "vina",
  "ohiggins", "o'higgins", "rancagua",
  "maule", "talca", "curico",
  "nuble", "chillan",
  // Sur
  "biobio", "bio bio", "concepcion", "los angeles",
  "araucania", "la araucania", "temuco",
  "los rios", "valdivia",
  "los lagos", "puerto montt", "osorno",
  // Austral
  "aysen", "coyhaique",
  "magallanes", "punta arenas", "puerto natales",
] as const

/**
 * Mapa de ordinales y números romanos al nombre canónico de la región.
 * Solo XIII (Metropolitana) clasifica como RM. Todas las demás son "regiones".
 *
 * Acepta variaciones: "novena", "9", "IX", "nueve", "decima primera", etc.
 */
const ORDINAL_A_REGION: Record<string, string> = {
  "1": "tarapaca", "i": "tarapaca", "primera": "tarapaca", "uno": "tarapaca",
  "2": "antofagasta", "ii": "antofagasta", "segunda": "antofagasta", "dos": "antofagasta",
  "3": "atacama", "iii": "atacama", "tercera": "atacama", "tres": "atacama",
  "4": "coquimbo", "iv": "coquimbo", "cuarta": "coquimbo", "cuatro": "coquimbo",
  "5": "valparaiso", "v": "valparaiso", "quinta": "valparaiso", "cinco": "valparaiso",
  "6": "ohiggins", "vi": "ohiggins", "sexta": "ohiggins", "seis": "ohiggins",
  "7": "maule", "vii": "maule", "septima": "maule", "siete": "maule",
  "8": "biobio", "viii": "biobio", "octava": "biobio", "ocho": "biobio",
  "9": "araucania", "ix": "araucania", "novena": "araucania", "nueve": "araucania",
  "10": "los lagos", "x": "los lagos", "decima": "los lagos", "diez": "los lagos",
  "11": "aysen", "xi": "aysen",
  "undecima": "aysen", "decima primera": "aysen", "once": "aysen",
  "12": "magallanes", "xii": "magallanes",
  "duodecima": "magallanes", "decima segunda": "magallanes", "doce": "magallanes",
  "13": "metropolitana", "xiii": "metropolitana",
  "decimotercera": "metropolitana", "decima tercera": "metropolitana", "trece": "metropolitana",
  "14": "los rios", "xiv": "los rios",
  "decimocuarta": "los rios", "decima cuarta": "los rios", "catorce": "los rios",
  "15": "arica y parinacota", "xv": "arica y parinacota",
  "decimoquinta": "arica y parinacota", "decima quinta": "arica y parinacota", "quince": "arica y parinacota",
  "16": "nuble", "xvi": "nuble",
  "decimosexta": "nuble", "decima sexta": "nuble", "dieciseis": "nuble",
}

// ─── Normalización ────────────────────────────────────────────────────────

/**
 * Normaliza un string para comparación robusta: minúsculas, sin tildes,
 * sin espacios extra. Maneja "Ñuñoa" vs "ñuñoa" vs "nunoa" vs "Nuñoa".
 */
function normalizar(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    // Puntuaci\u00f3n a espacio: "Providencia, Santiago" / "Providencia (Santiago)"
    // colapsan a "providencia santiago" para poder matchear sub-frases.
    .replace(/[().,;/]/g, " ")
    .trim()
    .replace(/\s+/g, " ")
}

/**
 * Versión más agresiva de normalización que además quita prefijos comunes
 * como "región de", "región del", "la región de la", etc. Devuelve el
 * núcleo del nombre de lugar para comparar contra listas.
 *
 * Ej: "Región de Los Lagos" → "los lagos"
 *     "La Región del Biobío" → "biobio"
 *     "región metropolitana" → "metropolitana"
 */
function normalizarConPrefijos(s: string): string {
  return normalizar(s)
    // OJO: NO quitar "los"/"las" porque son parte de nombres oficiales
    // ("Los Lagos", "Los Ríos"). Solo quitar "la"/"el" como artículos singulares.
    .replace(/^(la\s+)?(region\s+(de\s+(la\s+|el\s+)?|del\s+)?)/i, "")
    .replace(/\s*region\s*$/i, "")
    .trim()
    .replace(/\s+/g, " ")
}

const COMUNAS_RM_NORM = new Set(COMUNAS_RM.map(normalizar))
const ALIAS_RM_NORM = new Set(ALIAS_RM.map(normalizar))
const ALIAS_REGIONES_NORM = new Set(ALIAS_REGIONES_FUERA_RM.map(normalizar))

// ─── Resolución de ordinales ──────────────────────────────────────────────

/**
 * Intenta resolver un input como ordinal o número de región.
 * Acepta variaciones: "novena región", "9na region", "IX", "región 9",
 * "la 9", "octava región del biobío", etc.
 * Devuelve el nombre canónico de la región si reconoce, o null.
 */
function resolverOrdinal(input: string): string | null {
  const limpio = input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    // Quita prefijos: "la", "región", "región de la"
    .replace(/^(la\s+)?(region\s+(de\s+(la\s+)?|del\s+)?)?/i, "")
    // Quita sufijo "región" al final
    .replace(/\s*region\s*$/i, "")
    // Quita sufijos ordinales informales: "1ra", "9na", "10ma"
    .replace(/(\d+)(ra|da|ta|na|ma|va|ava)\b/g, "$1")
    .trim()
    .replace(/\s+/g, " ")

  if (ORDINAL_A_REGION[limpio]) return ORDINAL_A_REGION[limpio]

  // Si el input tiene varias palabras, probar también solo la primera
  // (ej. "novena del biobio" → "novena")
  const primeraPalabra = limpio.split(" ")[0]
  if (primeraPalabra && ORDINAL_A_REGION[primeraPalabra]) {
    return ORDINAL_A_REGION[primeraPalabra]
  }

  return null
}

// ─── API pública ──────────────────────────────────────────────────────────

export type ClasificacionUbicacion =
  | { tipo: "RM"; reconocida: true; canonico: string }
  | { tipo: "regiones"; reconocida: true; canonico: string }
  | { tipo: "regiones"; reconocida: false; canonico: string }
  | { tipo: "no_clasificable"; razon: string }

/**
 * Clasifica una ubicación entregada por el prospecto en RM vs regiones.
 *
 * Salidas:
 *   - { tipo: "RM" | "regiones", reconocida: true }: match en lista oficial,
 *     cotizar normalmente.
 *   - { tipo: "regiones", reconocida: false }: no se reconoció pero tiene
 *     formato razonable (probable comuna/localidad chilena). Se asume regiones
 *     (tarifa más alta) y la tool agrega una advertencia para que el ejecutivo
 *     confirme la ubicación al revisar la cotización.
 *   - { tipo: "no_clasificable" }: entrada vacía o genérica ("en regiones",
 *     "varias partes"). Vicky debe repreguntar.
 *
 * Acepta: comunas RM, comunas/ciudades de regiones, nombres de región,
 * ordinales ("novena región"), números romanos ("IX"), números arábigos
 * ("región 9") y aliases ("RM", "Metropolitana", "Santiago").
 */
export function clasificarUbicacion(input: string): ClasificacionUbicacion {
  if (!input || !input.trim()) {
    return { tipo: "no_clasificable", razon: "entrada vacía" }
  }

  const norm = normalizar(input)

  // 1. Términos genéricos que no permiten clasificar (matching por substring)
  const GENERICOS = [
    "regiones", "afuera", "fuera", "no se", "no lo se",
    "varias", "varios", "muchas", "muchos", "diferentes",
    "en regiones", "en varias", "varias partes", "varios lugares",
  ]
  if (GENERICOS.some((g) => norm === g || norm.startsWith(g + " ") || norm.endsWith(" " + g) || norm.includes(" " + g + " "))) {
    return {
      tipo: "no_clasificable",
      razon: `entrada genérica '${input}', se requiere comuna o región específica`,
    }
  }
  // Caso especial: el input completo es exactamente un genérico simple
  if (["regiones", "afuera", "fuera", "varias", "varios"].includes(norm)) {
    return {
      tipo: "no_clasificable",
      razon: `entrada genérica '${input}', se requiere comuna o región específica`,
    }
  }

  // 2. Resolución de ordinales: convierte "novena región" → "araucania"
  const desdeOrdinal = resolverOrdinal(input)
  // Si no es ordinal, probar también el normalizado agresivo
  // (quita "región de", "región del", etc. para matchear "Región de Los Lagos" → "los lagos")
  const normAgresivo = normalizarConPrefijos(input)
  const target = desdeOrdinal ?? (normAgresivo || norm)

  // 3. Match RM (comuna, alias, o "metropolitana" resuelto desde XIII)
  if (
    COMUNAS_RM_NORM.has(target) ||
    ALIAS_RM_NORM.has(target) ||
    target === "metropolitana"
  ) {
    return { tipo: "RM", reconocida: true, canonico: target }
  }

  // 4. Match en regiones/ciudades conocidas
  if (ALIAS_REGIONES_NORM.has(target)) {
    return { tipo: "regiones", reconocida: true, canonico: target }
  }

  // 4.5. Input COMPUESTO (ej. "Providencia, Santiago", "Las Condes - RM"): si el
  // match exacto falló, busca comuna/alias como sub-frase. Si aparece una
  // ciudad/región NO-RM conocida, ESA manda (ej. "San Pedro de Atacama" →
  // regiones); si no, una comuna o alias RM lo clasifica como RM.
  const acolchado = ` ${target} `
  for (const r of ALIAS_REGIONES_NORM) {
    if (acolchado.includes(` ${r} `)) {
      return { tipo: "regiones", reconocida: true, canonico: r }
    }
  }
  for (const c of COMUNAS_RM_NORM) {
    if (acolchado.includes(` ${c} `)) {
      return { tipo: "RM", reconocida: true, canonico: c }
    }
  }
  for (const a of ALIAS_RM_NORM) {
    if (acolchado.includes(` ${a} `)) {
      return { tipo: "RM", reconocida: true, canonico: a }
    }
  }

  // 5. Fallback: formato razonable de localidad chilena no listada
  // (ej. "Olmué", "El Quisco", "Pichilemu") → regiones con advertencia
  if (/^[a-z\s'-]{3,}$/.test(target)) {
    return { tipo: "regiones", reconocida: false, canonico: target }
  }

  return {
    tipo: "no_clasificable",
    razon: `no se pudo interpretar '${input}' como comuna o región chilena`,
  }
}
