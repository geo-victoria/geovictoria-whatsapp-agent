/**
 * Clasificación geográfica de Chile para fines de cotización.
 *
 * Resuelve la ubicación que entrega un prospecto (comuna, región por
 * nombre, ordinal o número romano) y la clasifica en "RM" vs "regiones"
 * (dimensión del ENVÍO), más la zona de INSTALACIÓN en 3 tramos
 * (tarifa jul-2026): RM / intermedia (IV Coquimbo, V Valparaíso,
 * VI O'Higgins) / resto de las regiones.
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
 * Comunas de las regiones de Coquimbo (IV), Valparaíso (V) y O'Higgins (VI):
 * la "zona intermedia" de la tarifa de instalación (3 UF por punto; tarifa
 * jul-2026). Se declaran aparte para poder clasificar la zona, y se integran
 * al listado completo de comunas fuera de RM más abajo.
 */
const COMUNAS_ZONA_INTERMEDIA = [
  // Coquimbo (IV)
  "La Serena", "Coquimbo", "Andacollo", "La Higuera", "Paihuano", "Vicuña",
  "Illapel", "Canela", "Los Vilos", "Salamanca", "Ovalle", "Combarbalá",
  "Monte Patria", "Punitaqui", "Río Hurtado",
  // Valparaíso (V)
  "Valparaíso", "Casablanca", "Concón", "Juan Fernández", "Puchuncaví", "Quintero",
  "Viña del Mar", "Isla de Pascua", "Los Andes", "Calle Larga", "Rinconada",
  "San Esteban", "La Ligua", "Cabildo", "Papudo", "Petorca", "Zapallar", "Quillota",
  "La Calera", "Hijuelas", "La Cruz", "Nogales", "San Antonio", "Algarrobo",
  "Cartagena", "El Quisco", "El Tabo", "Santo Domingo", "San Felipe", "Catemu",
  "Llay-Llay", "Panquehue", "Putaendo", "Santa María", "Quilpué", "Limache",
  "Olmué", "Villa Alemana",
  // O'Higgins (VI)
  "Rancagua", "Codegua", "Coinco", "Coltauco", "Doñihue", "Graneros", "Las Cabras",
  "Machalí", "Malloa", "Mostazal", "Olivar", "Peumo", "Pichidegua",
  "Quinta de Tilcoco", "Rengo", "Requínoa", "San Vicente", "Pichilemu",
  "La Estrella", "Litueche", "Marchigüe", "Navidad", "Paredones", "San Fernando",
  "Chépica", "Chimbarongo", "Lolol", "Nancagua", "Palmilla", "Peralillo",
  "Placilla", "Pumanque", "Santa Cruz",
] as const

/**
 * Aliases de región/ciudad que caen en la zona intermedia (IV-V-VI).
 * Subconjunto de ALIAS_REGIONES_FUERA_RM + los canónicos que produce
 * la resolución de ordinales ("cuarta región" → "coquimbo", etc.).
 */
const ALIAS_ZONA_INTERMEDIA = [
  "coquimbo", "la serena",
  "valparaiso", "vina del mar", "vina",
  "ohiggins", "o'higgins", "rancagua",
] as const

/**
 * Listado COMPLETO de las comunas de Chile fuera de la Región Metropolitana
 * (las 294 comunas restantes; las 52 de RM están en COMUNAS_RM). Todas tributan
 * tarifa "regiones". Fuente: división político-administrativa oficial de Chile
 * (Anexo:Comunas de Chile). Con esta lista, una comuna real se reconoce siempre;
 * un nombre inexistente cae a no_clasificable y Vicky repregunta.
 */
const COMUNAS_REGIONES_FUERA_RM = [
  // Arica y Parinacota
  "Arica", "Camarones", "Putre", "General Lagos",
  // Tarapacá
  "Iquique", "Alto Hospicio", "Pozo Almonte", "Camiña", "Colchane", "Huara", "Pica",
  // Antofagasta
  "Antofagasta", "Mejillones", "Sierra Gorda", "Taltal", "Calama", "Ollagüe",
  "San Pedro de Atacama", "Tocopilla", "María Elena",
  // Atacama
  "Copiapó", "Caldera", "Tierra Amarilla", "Chañaral", "Diego de Almagro",
  "Vallenar", "Alto del Carmen", "Freirina", "Huasco",
  // Coquimbo (IV), Valparaíso (V) y O'Higgins (VI) — la "zona intermedia" de
  // la tarifa de instalación — se definen aparte para reutilizarlas.
  ...COMUNAS_ZONA_INTERMEDIA,
  // Maule
  "Talca", "Constitución", "Curepto", "Empedrado", "Maule", "Pelarco", "Pencahue",
  "Río Claro", "San Clemente", "San Rafael", "Cauquenes", "Chanco", "Pelluhue",
  "Curicó", "Hualañé", "Licantén", "Molina", "Rauco", "Romeral", "Sagrada Familia",
  "Teno", "Vichuquén", "Linares", "Colbún", "Longaví", "Parral", "Retiro",
  "San Javier", "Villa Alegre", "Yerbas Buenas",
  // Ñuble
  "Chillán", "Bulnes", "Chillán Viejo", "El Carmen", "Pemuco", "Pinto", "Quillón",
  "San Ignacio", "Yungay", "Quirihue", "Cobquecura", "Coelemu", "Ninhue",
  "Portezuelo", "Ránquil", "Trehuaco", "San Carlos", "Coihueco", "Ñiquén",
  "San Fabián", "San Nicolás",
  // Biobío
  "Concepción", "Coronel", "Chiguayante", "Florida", "Hualpén", "Hualqui", "Lota",
  "Penco", "San Pedro de la Paz", "Santa Juana", "Talcahuano", "Tomé", "Lebu",
  "Arauco", "Cañete", "Contulmo", "Curanilahue", "Los Álamos", "Tirúa",
  "Los Ángeles", "Antuco", "Cabrero", "Laja", "Mulchén", "Nacimiento", "Negrete",
  "Quilaco", "Quilleco", "San Rosendo", "Santa Bárbara", "Tucapel", "Yumbel",
  "Alto Biobío",
  // La Araucanía
  "Temuco", "Carahue", "Cholchol", "Cunco", "Curarrehue", "Freire", "Galvarino",
  "Gorbea", "Lautaro", "Loncoche", "Melipeuco", "Nueva Imperial", "Padre Las Casas",
  "Perquenco", "Pitrufquén", "Pucón", "Saavedra", "Teodoro Schmidt", "Toltén",
  "Vilcún", "Villarrica", "Angol", "Collipulli", "Curacautín", "Ercilla",
  "Lonquimay", "Los Sauces", "Lumaco", "Purén", "Renaico", "Traiguén", "Victoria",
  // Los Ríos
  "Valdivia", "Corral", "Lanco", "Los Lagos", "Máfil", "Mariquina", "Paillaco",
  "Panguipulli", "La Unión", "Futrono", "Lago Ranco", "Río Bueno",
  // Los Lagos
  "Puerto Montt", "Calbuco", "Cochamó", "Fresia", "Frutillar", "Los Muermos",
  "Llanquihue", "Maullín", "Puerto Varas", "Castro", "Ancud", "Chonchi",
  "Curaco de Vélez", "Dalcahue", "Puqueldón", "Queilén", "Quellón", "Quemchi",
  "Quinchao", "Osorno", "Puerto Octay", "Purranque", "Puyehue", "Río Negro",
  "San Juan de la Costa", "San Pablo", "Chaitén", "Futaleufú", "Hualaihué",
  "Palena",
  // Aysén
  "Coyhaique", "Lago Verde", "Aysén", "Cisnes", "Guaitecas", "Cochrane",
  "O'Higgins", "Tortel", "Chile Chico", "Río Ibáñez",
  // Magallanes
  "Punta Arenas", "Laguna Blanca", "Río Verde", "San Gregorio", "Cabo de Hornos",
  "Antártica", "Porvenir", "Primavera", "Timaukel", "Natales", "Torres del Paine",
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
const COMUNAS_REGIONES_NORM = new Set(COMUNAS_REGIONES_FUERA_RM.map(normalizar))
const ZONA_INTERMEDIA_NORM = new Set([
  ...COMUNAS_ZONA_INTERMEDIA.map(normalizar),
  ...ALIAS_ZONA_INTERMEDIA.map(normalizar),
])

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
  // (ej. "novena del biobio" → "novena"). PERO solo cuando lo que sigue es un
  // conector de región ("de", "del", "la", "region"): un sustantivo real tras
  // el ordinal significa que NO es una región (bug 24-jul: "Quinta Normal"
  // —comuna de Santiago— se resolvía como "quinta" = V Región de Valparaíso y
  // la cotización salía con tarifa de regiones).
  const palabras = limpio.split(" ")
  const primeraPalabra = palabras[0]
  const CONECTORES_REGION = new Set(["de", "del", "la", "region"])
  if (
    primeraPalabra &&
    ORDINAL_A_REGION[primeraPalabra] &&
    (palabras.length === 1 || CONECTORES_REGION.has(palabras[1]))
  ) {
    return ORDINAL_A_REGION[primeraPalabra]
  }

  return null
}

// ─── API pública ──────────────────────────────────────────────────────────

/**
 * Zona de la tarifa de INSTALACIÓN (jul-2026, 3 tramos por punto):
 *   - "RM":         Región Metropolitana → 1 UF
 *   - "intermedia": regiones IV (Coquimbo), V (Valparaíso), VI (O'Higgins) → 3 UF
 *   - "resto":      todas las demás regiones → 5 UF
 * El ENVÍO mantiene su dimensión clásica RM vs regiones (tipo de la clasificación).
 */
export type ZonaInstalacion = "RM" | "intermedia" | "resto"

export type ClasificacionUbicacion =
  | { tipo: "RM"; reconocida: true; canonico: string; zonaInstalacion: "RM" }
  | { tipo: "regiones"; reconocida: true; canonico: string; zonaInstalacion: "intermedia" | "resto" }
  | { tipo: "regiones"; reconocida: false; canonico: string; zonaInstalacion: "intermedia" | "resto" }
  | { tipo: "no_clasificable"; razon: string }

/** Zona de instalación para un nombre canónico ya normalizado fuera de RM. */
function zonaFueraRM(canonico: string): "intermedia" | "resto" {
  return ZONA_INTERMEDIA_NORM.has(canonico) ? "intermedia" : "resto"
}

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

  // 1.5. Una COMUNA real escrita tal cual gana SIEMPRE sobre cualquier otra
  // interpretación (bug 24-jul: "Quinta Normal" caía al resolvedor de
  // ordinales como "quinta región"). Se prueba el nombre normalizado exacto
  // contra las listas oficiales antes de intentar ordinales.
  const exacto = normalizarConPrefijos(input) || norm
  for (const candidato of new Set([norm, exacto])) {
    if (COMUNAS_RM_NORM.has(candidato)) {
      return { tipo: "RM", reconocida: true, canonico: candidato, zonaInstalacion: "RM" }
    }
    if (COMUNAS_REGIONES_NORM.has(candidato)) {
      return { tipo: "regiones", reconocida: true, canonico: candidato, zonaInstalacion: zonaFueraRM(candidato) }
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
    return { tipo: "RM", reconocida: true, canonico: target, zonaInstalacion: "RM" }
  }

  // 4. Match en regiones/ciudades/comunas fuera de RM (listado completo)
  if (ALIAS_REGIONES_NORM.has(target) || COMUNAS_REGIONES_NORM.has(target)) {
    return { tipo: "regiones", reconocida: true, canonico: target, zonaInstalacion: zonaFueraRM(target) }
  }

  // 4.5. Input COMPUESTO (ej. "Providencia, Santiago", "Las Condes - RM"): si el
  // match exacto falló, busca comuna/alias como sub-frase. Si aparece una
  // ciudad/región NO-RM conocida, ESA manda (ej. "San Pedro de Atacama" →
  // regiones); si no, una comuna o alias RM lo clasifica como RM.
  const acolchado = ` ${target} `
  for (const r of ALIAS_REGIONES_NORM) {
    if (acolchado.includes(` ${r} `)) {
      return { tipo: "regiones", reconocida: true, canonico: r, zonaInstalacion: zonaFueraRM(r) }
    }
  }
  for (const c of COMUNAS_RM_NORM) {
    if (acolchado.includes(` ${c} `)) {
      return { tipo: "RM", reconocida: true, canonico: c, zonaInstalacion: "RM" }
    }
  }
  for (const a of ALIAS_RM_NORM) {
    if (acolchado.includes(` ${a} `)) {
      return { tipo: "RM", reconocida: true, canonico: a, zonaInstalacion: "RM" }
    }
  }
  // Comuna fuera de RM como sub-frase (ej. "bodega en Quillota, V región")
  for (const c of COMUNAS_REGIONES_NORM) {
    if (acolchado.includes(` ${c} `)) {
      return { tipo: "regiones", reconocida: true, canonico: c, zonaInstalacion: zonaFueraRM(c) }
    }
  }

  // 5. No matchea ninguna comuna/región/alias real de Chile. Con el listado
  // completo de las 346 comunas, esto significa que el nombre NO existe (o está
  // mal escrito): se devuelve no_clasificable para que Vicky lo repregunte, en
  // vez de asumir una tarifa de regiones sobre una ubicación inventada.
  return {
    tipo: "no_clasificable",
    razon: `'${input}' no corresponde a una comuna ni región de Chile reconocida`,
  }
}
