/**
 * Región de Chile (valores EXACTOS del picklist `Regi_n_inst_visita_env_o`
 * de TicketsST) a partir de una comuna, una ciudad o un nombre de región
 * escrito por el cliente. PURO. Complementa a lib/geografia (que clasifica
 * RM / intermedia / resto para la TARIFA) con el nombre que Servicio Técnico
 * necesita en el ticket.
 */
import { clasificarUbicacion } from "./geografia.ts"

export const REGIONES_TICKET = [
  "Metropolitana", "Arica Parinacota", "Tarapacá", "Antofagasta", "Atacama", "Coquimbo", "Valparaíso",
  "O'Higgins", "Maule", "Ñuble", "Biobío", "Araucanía", "Los Ríos", "Los Lagos", "Aysén", "Magallanes", "Internacional",
] as const
export type RegionTicket = (typeof REGIONES_TICKET)[number]

const norm = (s: string) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9ñ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()

/** Alias y ordinales por región (sin RM, que la resuelve geografía). */
const ALIAS: Array<[RegionTicket, string[]]> = [
  ["Arica Parinacota", ["arica y parinacota", "arica parinacota", "xv", "xv region", "decimoquinta"]],
  ["Tarapacá", ["tarapaca", "i region", "primera region"]],
  ["Antofagasta", ["antofagasta", "ii region", "segunda region"]],
  ["Atacama", ["atacama", "iii region", "tercera region"]],
  ["Coquimbo", ["coquimbo", "iv region", "cuarta region", "iv"]],
  ["Valparaíso", ["valparaiso", "v region", "quinta region", "v"]],
  ["O'Higgins", ["ohiggins", "o higgins", "libertador", "vi region", "sexta region", "vi"]],
  ["Maule", ["maule", "vii region", "septima region", "vii"]],
  ["Ñuble", ["ñuble", "nuble", "xvi region", "xvi"]],
  ["Biobío", ["biobio", "bio bio", "viii region", "octava region", "viii"]],
  ["Araucanía", ["araucania", "ix region", "novena region", "ix"]],
  ["Los Ríos", ["los rios", "xiv region", "xiv"]],
  ["Los Lagos", ["los lagos", "x region", "decima region"]],
  ["Aysén", ["aysen", "aisen", "xi region", "xi"]],
  ["Magallanes", ["magallanes", "xii region", "xii"]],
]

/** Comunas y ciudades más usadas por región (fuera de RM). */
const COMUNAS: Array<[RegionTicket, string[]]> = [
  ["Arica Parinacota", ["arica", "putre", "camarones", "general lagos"]],
  ["Tarapacá", ["iquique", "alto hospicio", "pozo almonte", "pica", "huara", "camina", "colchane"]],
  ["Antofagasta", ["antofagasta", "calama", "tocopilla", "mejillones", "taltal", "maria elena", "san pedro de atacama", "sierra gorda", "ollague"]],
  ["Atacama", ["copiapo", "vallenar", "caldera", "chañaral", "chanaral", "huasco", "tierra amarilla", "diego de almagro", "freirina", "alto del carmen"]],
  ["Coquimbo", ["la serena", "coquimbo", "ovalle", "illapel", "vicuña", "vicuna", "monte patria", "andacollo", "los vilos", "salamanca", "combarbala", "punitaqui", "paihuano", "la higuera", "canela", "rio hurtado"]],
  ["Valparaíso", ["valparaiso", "viña del mar", "vina del mar", "quilpue", "villa alemana", "san antonio", "quillota", "los andes", "san felipe", "limache", "concon", "la calera", "calera", "casablanca", "quintero", "olmue", "cartagena", "el quisco", "algarrobo", "el tabo", "llaillay", "llay llay", "la ligua", "cabildo", "petorca", "zapallar", "papudo", "nogales", "hijuelas", "la cruz", "putaendo", "santa maria", "catemu", "panquehue", "rinconada", "calle larga", "san esteban", "isla de pascua", "juan fernandez", "santo domingo", "puchuncavi"]],
  ["O'Higgins", ["rancagua", "machali", "san fernando", "rengo", "graneros", "san vicente", "san vicente de tagua tagua", "santa cruz", "chimbarongo", "pichilemu", "requinoa", "mostazal", "san francisco de mostazal", "codegua", "doñihue", "donihue", "coltauco", "coinco", "olivar", "malloa", "quinta de tilcoco", "peumo", "pichidegua", "las cabras", "nancagua", "placilla", "chepica", "palmilla", "peralillo", "lolol", "pumanque", "paredones", "marchigue", "litueche", "la estrella", "navidad"]],
  ["Maule", ["talca", "curico", "linares", "constitucion", "cauquenes", "molina", "san javier", "parral", "san clemente", "teno", "longavi", "maule", "rio claro", "pelarco", "pencahue", "villa alegre", "yerbas buenas", "retiro", "colbun", "romeral", "sagrada familia", "rauco", "hualañe", "hualane", "licanten", "vichuquen", "empedrado", "chanco", "pelluhue", "curepto", "san rafael"]],
  ["Ñuble", ["chillan", "chillan viejo", "san carlos", "bulnes", "quirihue", "coelemu", "yungay", "coihueco", "pinto", "el carmen", "pemuco", "quillon", "ranquil", "ninhue", "portezuelo", "treguaco", "cobquecura", "san nicolas", "san fabian", "ñiquen", "niquen", "san ignacio"]],
  ["Biobío", ["concepcion", "talcahuano", "hualpen", "san pedro de la paz", "chiguayante", "coronel", "lota", "penco", "tome", "los angeles", "arauco", "curanilahue", "lebu", "cañete", "canete", "cabrero", "mulchen", "nacimiento", "laja", "yumbel", "santa juana", "hualqui", "florida", "los alamos", "tirua", "contulmo", "quilleco", "negrete", "santa barbara", "tucapel", "san rosendo", "alto biobio", "quilaco", "antuco"]],
  ["Araucanía", ["temuco", "padre las casas", "villarrica", "pucon", "angol", "victoria", "lautaro", "nueva imperial", "freire", "pitrufquen", "collipulli", "traiguen", "loncoche", "gorbea", "carahue", "curacautin", "cunco", "vilcun", "lonquimay", "renaico", "puren", "los sauces", "ercilla", "lumaco", "galvarino", "cholchol", "perquenco", "melipeuco", "teodoro schmidt", "saavedra", "tolten", "curarrehue"]],
  ["Los Ríos", ["valdivia", "la union", "rio bueno", "panguipulli", "los lagos", "paillaco", "lanco", "futrono", "mariquina", "san jose de la mariquina", "mafil", "corral", "lago ranco"]],
  ["Los Lagos", ["puerto montt", "osorno", "puerto varas", "castro", "ancud", "quellon", "calbuco", "frutillar", "llanquihue", "purranque", "rio negro", "san pablo", "puerto octay", "puyehue", "fresia", "los muermos", "maullin", "cochamo", "chonchi", "dalcahue", "quinchao", "curaco de velez", "puqueldon", "queilen", "quemchi", "chaiten", "futaleufu", "palena", "hualaihue", "san juan de la costa"]],
  ["Aysén", ["coyhaique", "coihaique", "puerto aysen", "aysen", "chile chico", "cochrane", "rio ibañez", "rio ibanez", "puerto ibañez", "puerto ibanez", "cisnes", "puerto cisnes", "guaitecas", "lago verde", "tortel", "villa ohiggins"]],
  ["Magallanes", ["punta arenas", "puerto natales", "natales", "porvenir", "cabo de hornos", "puerto williams", "primavera", "san gregorio", "laguna blanca", "rio verde", "timaukel", "torres del paine", "antartica"]],
]

/**
 * Región del picklist para un texto (comuna, ciudad, región, o la cadena
 * "dirección · comuna · región" completa). "" si no se reconoce.
 */
export function regionDeUbicacion(texto: string): RegionTicket | "" {
  const t = norm(texto)
  if (!t) return ""
  // 1) nombre o alias de región dicho explícitamente (palabra completa).
  const tieneFrase = (frase: string) => new RegExp(`(^| )${frase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)`).test(t)
  if (/(^| )(rm|region metropolitana|metropolitana|santiago)( |$)/.test(t)) return "Metropolitana"
  for (const [region, alias] of ALIAS) for (const a of alias) if (a.length > 2 && tieneFrase(a)) return region
  // 2) comuna o ciudad conocida.
  for (const [region, comunas] of COMUNAS) for (const c of comunas) if (tieneFrase(c)) return region
  // 3) las 52 comunas de la RM las conoce geografía.
  for (const trozo of t.split(/ (?:y|de|en|la|el|los|las|del) |,/)) {
    const cl = clasificarUbicacion(trozo)
    if (cl.tipo === "RM" && cl.reconocida) return "Metropolitana"
  }
  const cl = clasificarUbicacion(t)
  if (cl.tipo === "RM" && cl.reconocida) return "Metropolitana"
  // 4) ordinales cortos de RM / alias que geografía entiende como región.
  for (const [region, alias] of ALIAS) for (const a of alias) if (tieneFrase(a)) return region
  return ""
}

/** Normaliza lo que trae el padrón SII ("REGION DE VALPARAISO", "XIII…") al picklist. */
export function regionDesdePadron(texto: string): RegionTicket | "" {
  const t = norm(texto)
  if (!t) return ""
  if (/metropolitana|xiii|santiago/.test(t)) return "Metropolitana"
  return regionDeUbicacion(t)
}
