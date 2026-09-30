/**
 * PLANILLA DE INGRESO en el formato de los implementadores (30-sep, Lalo:
 * "la regla de oro es siempre al crear implementación crear plantilla de
 * usuarios, en caso de que al cliente haya que migrarlo de GV Avanzado a GV
 * Portal" + "la planilla de ingreso no va así").
 *
 * Es la plantilla "INGRESO EMPRESA" que el equipo sube al campo
 * Planilla_de_Ingreso (verificado contra IMP-11822 Dolce, IMP-11810 Bondi e
 * IMP-11772 Francisca): datos de empresa en C14:C20, hasta 4 administradores
 * en B29:G32 y la tabla de trabajadores desde la fila 40 (Perfil · RUT sin
 * puntos ni guión · correo personal · nombres · apellidos · grupo).
 *
 * Se rellena la plantilla REAL a nivel de XML (no se regenera con una
 * librería): así se conservan logo, estilos, listas desplegables, formato
 * condicional y la hoja oculta de rubros tal cual los ve el implementador.
 * Nombre de archivo = convención de Bondi: "Planilla sin planificacion
 * <Razón social> (N usuarios).xlsx".
 */
import { zip } from "./escribir-excel.ts"
import { descomprimirZip } from "./leer-excel.ts"
import { PLANTILLA_INGRESO_XLSX_BASE64 } from "./planilla-ingreso-base.ts"

export type AdminPlanilla = { nombre?: string; apellido?: string; rut?: string; telefono?: string; correo?: string }
export type TrabajadorPlanilla = { rut?: string; correo?: string; nombres?: string; apellidos?: string; grupo?: string }
export type DatosPlanillaIngreso = {
  razonSocial?: string
  nombreFantasia?: string
  rut?: string
  giro?: string
  direccion?: string
  comuna?: string
  rubro?: string
  admins: AdminPlanilla[]
  trabajadores: TrabajadorPlanilla[]
}

/** Rubros de la hoja oculta de la plantilla (lista desplegable de C20). */
export const RUBROS_PLANILLA = [
  "1. Agricola", "2. Condominio", "3. Construcción", "4. Inmobilaria", "5. Consultoria", "6. Banca y Finanzas",
  "7. Educación", "8. Municipio", "9. Gobierno", "10. Mineria", "11. Naviera", "12. Outsourcing Seguridad",
  "13. Outsourcing General", "14. Outsourcing Retail", "15. Planta Productiva", "16. Logistica",
  "17. Retail Enterprise", "18. Retail SMB", "19. Salud", "20. Servicios", "21. Transporte",
  "22. Turismo, Hotelería y Gastronomía",
]

const sinTildes = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim()

/** Rubro de la lista desplegable que calza con un texto libre (Industry de la cuenta); "" si ninguno. */
export function rubroDeLista(texto: string | undefined): string {
  const t = sinTildes(String(texto || "").replace(/^\d+\.\s*/, ""))
  if (!t) return ""
  for (const r of RUBROS_PLANILLA) {
    const base = sinTildes(r.replace(/^\d+\.\s*/, ""))
    if (t === base || t.startsWith(base) || base.startsWith(t)) return r
  }
  return ""
}

/**
 * Rubro deducido del GIRO del SII (Lalo 30-sep: la lista no tiene "Otro" ni
 * "Desconocido"; se deduce del giro y, si no calza, "20. Servicios"). Reglas
 * en orden: la primera palabra clave que aparece en el giro manda.
 */
const RUBRO_POR_GIRO: Array<[RegExp, string]> = [
  [/restaur|comida|aliment|gastronom|cafe|cafeteria|panader|pasteler|hotel|hostal|turis|bar\b|banquet|casino|catering|empanad/, "22. Turismo, Hotelería y Gastronomía"],
  [/salud|medic|clinic|odontol|dental|hospital|enfermer|kinesiol|veterinar|farmac|laboratorio clinico|psicolog/, "19. Salud"],
  [/condominio|comunidad de copropietarios|edificio|administracion de edificios/, "2. Condominio"],
  [/construc|obras? (civiles|menores)|ingenieria|montaje|electric|instalacion|ascensor|gasfiter|carpinter|arquitect|demolic|pavimento/, "3. Construcción"],
  [/inmobiliar|arriendo de inmuebles|bienes raices|corretaje de propiedades/, "4. Inmobilaria"],
  [/transporte|flete|camion|carga|taxi|buses|pasajeros/, "21. Transporte"],
  [/logistic|bodega|almacenamiento|distribucion|courier|despacho/, "16. Logistica"],
  [/agric|agropecuari|fruti|vitivin|forestal|ganader|avicol|vivero|cultivo/, "1. Agricola"],
  [/educa|colegio|escuela|jardin infantil|capacitacion|universidad|instituto|academia/, "7. Educación"],
  [/banco|financ|credito|seguros|inversion|cooperativa de ahorro/, "6. Banca y Finanzas"],
  [/mineri|minera|extraccion de|canteras/, "10. Mineria"],
  [/navier|maritim|portuari|pesca/, "11. Naviera"],
  [/segurid|vigilancia|guardias/, "12. Outsourcing Seguridad"],
  [/aseo|limpieza|outsourcing|suministro de personal|servicios generales/, "13. Outsourcing General"],
  [/fabric|manufactur|elaboracion|industri|planta|produccion de/, "15. Planta Productiva"],
  [/municipal/, "8. Municipio"],
  [/consult|asesor|contab|auditor|abogad|juridic|marketing|publicidad|software|informatic|tecnolog/, "5. Consultoria"],
  [/comercio|venta al por menor|minorista|tienda|almacen|supermercado|ferreteri|botiller|minimarket|venta al por mayor|mayorista|importad|distribuidora/, "18. Retail SMB"],
]
export const RUBRO_POR_DEFECTO = "20. Servicios"

export function rubroDesdeGiro(giro: string | undefined): string {
  const g = sinTildes(String(giro || ""))
  if (!g) return ""
  for (const [re, rubro] of RUBRO_POR_GIRO) if (re.test(g)) return rubro
  return ""
}

/** RUT como lo pide la plantilla: sin puntos ni guión, con DV ("17739019K", "177390194"). */
export function rutSinFormato(rut: string | undefined): string {
  return String(rut || "").replace(/[^0-9kK]/g, "").toUpperCase()
}

/** Teléfono chileno a 9 dígitos (como en las planillas manuales). */
export function telefonoPlanilla(tel: string | undefined): string {
  const d = String(tel || "").replace(/\D/g, "")
  return d.length === 11 && d.startsWith("56") ? d.slice(2) : d
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

/**
 * Escribe un valor en una celda existente conservando su estilo (o el dado).
 * Números puros (RUT sin K, teléfono) van como número, igual que en las
 * planillas manuales; el resto como texto en línea.
 */
export function escribirCelda(xml: string, ref: string, valor: string | number | undefined, estilo?: string): string {
  const v = valor === undefined || valor === null ? "" : String(valor).trim()
  const pat = new RegExp(`<c r="${ref}"((?: [a-zA-Z:]+="[^"]*")*?)(?:/>|>[\\s\\S]*?</c>)`)
  const m = xml.match(pat)
  let attrs = m ? m[1].replace(/ t="[^"]*"/, "") : ""
  if (estilo) attrs = / s="/.test(attrs) ? attrs.replace(/ s="[^"]*"/, ` s="${estilo}"`) : `${attrs} s="${estilo}"`
  const celda = !v
    ? `<c r="${ref}"${attrs}/>`
    : /^\d{1,15}$/.test(v) && !/^0/.test(v)
      ? `<c r="${ref}"${attrs}><v>${v}</v></c>`
      : `<c r="${ref}"${attrs} t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`
  if (m) return xml.replace(pat, celda)
  // La celda no existe en la fila: se agrega al final de la fila (orden A..AA se respeta en la plantilla).
  const fila = ref.replace(/^[A-Z]+/, "")
  return xml.replace(new RegExp(`(<row r="${fila}"[^>]*>)([\\s\\S]*?)(</row>)`), (_x, a, b, c) => a + b + celda + c)
}

// Estilos de la tabla de trabajadores en la plantilla (fila 40 en adelante).
const ESTILO_TRAB: Record<string, string> = { B: "36", C: "32", D: "33", E: "37", F: "34", G: "35" }
const PRIMERA_FILA_TRAB = 40
const MAX_ADMINS = 4

export function nombreArchivoPlanilla(razonSocial: string | undefined, usuarios: number): string {
  const limpio = String(razonSocial || "Empresa").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 90)
  return `Planilla sin planificacion ${limpio} (${usuarios} ${usuarios === 1 ? "usuario" : "usuarios"}).xlsx`
}

/** Usuarios distintos (admins + trabajadores) por RUT; los sin RUT cuentan una vez cada uno. */
export function contarUsuarios(d: DatosPlanillaIngreso): number {
  const ruts = new Set<string>()
  let sinRut = 0
  for (const p of [...d.admins, ...d.trabajadores]) {
    const r = rutSinFormato(p.rut)
    if (r) ruts.add(r)
    else if ((p as AdminPlanilla).correo || (p as TrabajadorPlanilla).correo) sinRut++
  }
  return ruts.size + sinRut
}

export function armarPlanillaIngreso(d: DatosPlanillaIngreso): { buffer: Buffer; filename: string; usuarios: number } {
  const archivos = descomprimirZip(Buffer.from(PLANTILLA_INGRESO_XLSX_BASE64, "base64"))
  const hoja = "xl/worksheets/sheet1.xml"
  let xml = archivos.get(hoja)!.toString("utf8")

  xml = escribirCelda(xml, "C14", d.razonSocial)
  xml = escribirCelda(xml, "C15", d.nombreFantasia)
  xml = escribirCelda(xml, "C16", rutSinFormato(d.rut))
  xml = escribirCelda(xml, "C17", d.giro)
  xml = escribirCelda(xml, "C18", d.direccion)
  xml = escribirCelda(xml, "C19", d.comuna)
  xml = escribirCelda(xml, "C20", rubroDeLista(d.rubro) || rubroDesdeGiro(d.giro) || RUBRO_POR_DEFECTO)

  const admins = d.admins.filter((a) => a.nombre || a.correo || a.rut).slice(0, MAX_ADMINS)
  admins.forEach((a, i) => {
    const r = 29 + i
    xml = escribirCelda(xml, `C${r}`, a.nombre)
    xml = escribirCelda(xml, `D${r}`, a.apellido)
    xml = escribirCelda(xml, `E${r}`, rutSinFormato(a.rut))
    xml = escribirCelda(xml, `F${r}`, telefonoPlanilla(a.telefono))
    xml = escribirCelda(xml, `G${r}`, a.correo)
  })

  const rutsAdmin = new Set(admins.map((a) => rutSinFormato(a.rut)).filter(Boolean))
  d.trabajadores.forEach((t, i) => {
    const r = PRIMERA_FILA_TRAB + i
    const rut = rutSinFormato(t.rut)
    const celdas: Record<string, string | undefined> = {
      B: rut && rutsAdmin.has(rut) ? "Administrador" : "",
      C: rut,
      D: t.correo,
      E: t.nombres,
      F: t.apellidos,
      G: t.grupo,
    }
    for (const col of Object.keys(ESTILO_TRAB)) xml = escribirCelda(xml, `${col}${r}`, celdas[col], ESTILO_TRAB[col])
  })

  archivos.set(hoja, Buffer.from(xml, "utf8"))
  const buffer = zip([...archivos.entries()].map(([nombre, datos]) => ({ nombre, datos })))
  const usuarios = contarUsuarios(d)
  return { buffer, filename: nombreArchivoPlanilla(d.razonSocial, usuarios), usuarios }
}
