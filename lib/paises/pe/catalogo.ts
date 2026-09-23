/**
 * Catálogo PERÚ.
 *
 * ⚠️ CONVENCIÓN DE UNIDADES: los campos `precioUF` guardan el precio en la
 * UNIDAD DE PRICING del país — en Perú es el SOL PERUANO (PEN) directo, sin
 * unidad indexada. El nombre del campo es herencia del catálogo chileno.
 *
 * LISTA VIGENTE (decisiones de Lalo 17-sep — SUPERSEDE el excel de
 * tropicalización del 04-ago y el VB de Diego del 05-ago):
 *   PLAN = "lista de Mónica" (la que telemarketing PE vende de verdad: 200
 *   notas de venta confirmadas en Creator, S/5,5 por usuario) con PISO de 10
 *   personas (propuesta aceptada por Lalo; el piso lo valida Diego Bendezú):
 *     1-10:  S/55/mes tarifa FIJA (= 10 × S/5,5)
 *     11-20: S/5,5 por usuario/mes  ← RANGO DE VICKY = 1-20, igual que Chile
 *            (Lalo 23-sep). 21-50 sigue a S/5,5 solo como excepción por contacto.
 *   Cruzado con Chile en dólares: Mónica es Chile −30 % en todo el rango; la
 *   lista de agosto era Chile +26 % en 1-10 y más del doble en 11-20.
 *   Sobre 50 la escalera sigue la de Mónica (51-100 S/5 · 101-500 S/4,5) para la
 *   tabla de cobro de la nota de venta — ese tramo NO lo vende Vicky.
 *
 *   RELOJ (ZKTECO Senseface 2A = artículo Books "304 - [PER] Reloj Gama
 *   Estándar FACIAL LAN WIFI", SKU PER-BIO-SF2A-ZKT-LW-HTF): su precio de LISTA
 *   es en DÓLARES — arriendo US$24/mes (golden NDV-32020 de Mónica) · venta
 *   US$90 (rate del artículo en Books) — y así va en la nota de venta (NDV en
 *   USD aparte, como se maneja desde siempre en Perú). De cara al CLIENTE se
 *   cotiza en SOLES: USD × dólar venta SUNAT del día (lib/paises/pe/tc-sunat.ts),
 *   redondeado a soles enteros.
 *   Envío:          S/0 en LIMA METROPOLITANA (ambas modalidades). A
 *                   PROVINCIA lo ASUME EL CLIENTE (VB Diego 05-ago): nosotros
 *                   no lo cobramos ni lo cotizamos — se informa que corre por
 *                   su cuenta. Sin línea de cobro en ningún caso.
 *   Instalación:    Lima Metropolitana según tarifario por distrito (nota,
 *                   jamás línea); fuera de Lima "se coordina con servicio
 *                   técnico, se cotiza aparte" + aviso a ssttperu@geovictoria.pro.
 *   Capacitación:   NO se ofrece en Perú (ni cobrada ni de regalo).
 *
 * PAGO INICIAL (patrón CL/CO): pagos únicos + primer mes del plan por
 * adelantado (neto + IGV). Luego facturación mensual según usuarios activos.
 *
 * IGV: 18% en TODOS los conceptos — lo aplica el motor (pe/cotizar.ts);
 * este catálogo es neto.
 *
 * DESCUENTO = CHILE (Lalo 17-sep, "los descuentos igualémoslos a Chile"):
 * escalera 10 % → 20 % sobre el PLAN mensual (no sobre el arriendo del reloj),
 * por 6 meses, SOLO ante objeción de precio (jamás proactivo), un escalón por
 * objeción. Muere el "20 % en las 4 primeras facturas" del 04-ago.
 */

import type { ModuloSoftware, Hardware, Servicio } from "../../catalogo/tipos.ts"

/**
 * Escalera de descuento del plan mensual PE = la chilena: 10 % → 20 % sobre el
 * PLAN, 6 meses, un escalón por objeción. `escalonDescuento` 1 = 10 %, 2 = 20 %.
 */
export const ESCALERA_DESCUENTO_PE = {
  /** Escalones acumulativos del plan mensual (índice = escalón − 1). */
  planMensual: [0.1, 0.2],
  /** Sin descuento de instalación (en Lima ya es gratis o va aparte). */
  instalacion: [0],
  /** Meses de vigencia del descuento (misma política que Chile). */
  meses: 6,
  /** Vigencia de la oferta una vez emitida (horas) — convención de la casa. */
  vigenciaHoras: 72,
} as const

/** Precios de LISTA del reloj PE en DÓLARES (artículo 304 de Books). */
export const RELOJ_PE_USD = {
  /** Arriendo mensual por unidad: US$20 + IGV (tabla de hardware de Mónica, 21-sep — Senseface 2A; Lalo: "la opción más barata"). */
  arriendoMes: 20,
  /** Venta por unidad: US$90 (rate del artículo 304 en Books; la tabla de Mónica dice US$150 — Lalo 21-sep eligió la más barata). */
  venta: 90,
  /**
   * Arriendo mensual por unidad cuando el reloj va a PROVINCIA: US$23 con el
   * despacho INCLUIDO (Lalo 22-sep, homólogo del +0,05 UF de regiones en
   * Chile). Supersede el "a provincia el envío lo asume el cliente" del
   * VB Diego 05-ago: toda zona tiene su número desde el inicio.
   */
  arriendoMesProvincia: 23,
  /** Envío del reloj en VENTA a provincia: US$30 por unidad, pago único (Lalo 22-sep). En Lima el envío va incluido. */
  envioVentaProvincia: 30,
  /**
   * Instalación técnica por punto = LOS VALORES DE CHILE en dólares (Lalo
   * 22-sep, "dejemos los valores de Chile en USD pero en su moneda local"):
   * base (Lima Metropolitana) = 1 UF ≈ US$43 · resto (provincias) = 5 UF ≈
   * US$214. Misma regla chilena: en ARRIENDO en la zona base va BONIFICADA
   * (línea a precio de lista tachada en $0); en venta y en provincia se
   * cobra. La auto-instalación es gratis siempre. Supersede el tarifario por
   * distrito del 11-ago (la clasificación por distrito sigue viva para
   * reconocer Lima).
   */
  instalacionLima: 43,
  /** Intermedia (Región Lima fuera de la capital + Ica) = 3 UF ≈ US$129. */
  instalacionIntermedia: 129,
  instalacionProvincias: 214,
  /** Artículo de Books/Creator al que se mapea en la nota de venta. */
  articulo: "304 - [PER] Reloj Gama Estándar FACIAL LAN WIFI",
} as const

export const CATALOGO_MODULOS_PE: ModuloSoftware[] = [
  {
    id: "asistencia",
    nombre: "Control de Asistencia",
    descripcion:
      "Marcaje web, app móvil con GPS y biometría. Gestión de turnos, vacaciones y horas extra. Reportería en línea.",
    tiers: [
      // Piso de 10 personas = 10 × S/5,5 (Lalo 17-sep).
      { minUsuarios: 1, maxUsuarios: 10, modalidad: "fijo", precioUF: 55 },
      { minUsuarios: 11, maxUsuarios: 20, modalidad: "por_usuario", precioUF: 5.5 },
      // ── RANGO DE VICKY = 1-20 (Lalo 23-sep: "iguala el rango de cotización de los
      // países al de Chile, solo hasta 20"). El tramo 21-50 NO es rango de Vicky:
      // queda, como el 21-50 de Chile, solo para la excepción por contacto
      // (umbral_contacto_) y como referencia de la tabla de cobro. La guarda del
      // umbral (lib/umbral-autonomia + agent-loop) rechaza la tool sobre 20/10.
      { minUsuarios: 21, maxUsuarios: 50, modalidad: "por_usuario", precioUF: 5.5 },
    ],
    disponibleParaVicky: true,
  },
]

export const CATALOGO_HARDWARE_PE: Hardware[] = [
  {
    id: "reloj_pe",
    // Modelo real (VB Diego 05-ago): ZKTECO Senseface 2A — interno, JAMÁS se
    // le dice al cliente (regla de no mencionar marcas/modelos).
    modelo: "Senseface 2A",
    displayName: "Reloj de control físico",
    conexion: "WiFi / Ethernet",
    // OJO: en Perú el precio de lista es en USD (RELOJ_PE_USD) y se convierte a
    // soles con el dólar SUNAT al cotizar. Estas celdas son el equivalente al
    // fallback TC_USD_PEN_FALLBACK y NO son la fuente de precio: la fuente es
    // pe/cotizar.ts con el tipo de cambio del día.
    ventaUF: 306,
    arriendoUF: 82,
    descripcion:
      "Reloj biométrico de control de asistencia (facial y huella), con conexión WiFi y Ethernet.",
    modalidadesDisponibles: ["arriendo", "venta"],
    cantidadSugerida: 1,
    disponibleParaVicky: true,
  },
]

export const CATALOGO_SERVICIOS_PE: Servicio[] = [
  {
    id: "envio_reloj",
    nombre: "Envío de reloj",
    descripcion:
      "Despacho del reloj. Incluido en Lima Metropolitana (ambas modalidades) y en el arriendo a provincia (tarifa US$23/mes con despacho). En venta a provincia: US$30 por reloj, pago único, en soles al dólar SUNAT.",
    // RM ≡ "lima" (Metropolitana) · region ≡ provincias. Las celdas quedan en
    // 0 porque la tarifa real vive en RELOJ_PE_USD (dólares → soles del día):
    // pe/cotizar.ts arma la línea de envío en venta a provincia y el arriendo
    // a provincia con despacho incluido (Lalo 22-sep; antes "lo asume el
    // cliente", VB Diego 05-ago).
    tarifa: {
      modelo: "modalidad_zona",
      arriendo: { RM: 0, region: 0 },
      venta: { RM: 0, region: 0 },
    },
    descontable: false,
    omitirSiAutoInstalada: false,
    obligatoriedad: "obligatoria",
    permiteAutoInstalacion: false,
    advertenciasAutoInstalacion: [],
    aplicaConHardware: true,
    disponibleParaVicky: true,
  },
  {
    id: "instalacion_reloj",
    nombre: "Instalación de reloj",
    descripcion:
      "Instalación técnica del reloj de control por punto. Lima Metropolitana US$43 (bonificada en arriendo); provincias US$214. En soles al dólar SUNAT. Auto-instalación gratis siempre.",
    // Lima (RM) = 0 → incluida sin costo. Provincias (region) = 0 NO
    // significa gratis: fuera de Lima la instalación NO la cotiza Vicky —
    // "se coordina con servicio técnico, se cotiza aparte" + aviso interno a
    // ssttperu@geovictoria.pro. Esa lógica vive en pe/cotizar.ts; la celda
    // queda en 0 porque no hay tarifa publicable.
    tarifa: {
      modelo: "modalidad_zona",
      arriendo: { RM: 0, region: 0 },
      venta: { RM: 0, region: 0 },
    },
    descontable: false,
    omitirSiAutoInstalada: true,
    obligatoriedad: "recomendada",
    permiteAutoInstalacion: true,
    advertenciasAutoInstalacion: [],
    aplicaConHardware: true,
    disponibleParaVicky: true,
  },
]

/** Correo del servicio técnico PE: recibe el aviso interno cuando un punto
 * queda fuera de Lima (instalación se cotiza aparte). */
export const CORREO_SSTT_PE = "ssttperu@geovictoria.pro"

/**
 * TARIFARIO DE VISITAS TÉCNICAS E INSTALACIONES — LIMA METROPOLITANA
 * (doc "Políticas de cobro visitas e instalaciones", vía Lalo 11-ago-2026).
 *
 * Supersede el "instalación gratis en toda Lima" del excel de tropicalización:
 * solo la ZONA AZUL es sin costo; el resto tiene tarifa POR DISTRITO en
 * DÓLARES + IGV. La tarifa es del ÁREA DE SERVICIO TÉCNICO: se INFORMA en la
 * cotización y se coordina/factura aparte con ellos (no viaja como línea de
 * cobro en soles — no hay tipo de cambio definido para meterla al checkout).
 * La auto-instalación sigue siendo gratis siempre. Exoneraciones: solo líder
 * de área + VB del country manager (fuera del alcance de Vicky).
 */
export const ZONAS_VISITA_LIMA_PE: ReadonlyArray<{ usd: number; distritos: readonly string[] }> = [
  {
    usd: 0, // ZONA AZUL — sin costo
    distritos: ["santiago de surco", "surco", "san borja", "surquillo", "miraflores", "san isidro"],
  },
  {
    usd: 20, // ZONA LILA
    distritos: ["el agustino", "santa anita", "la molina"],
  },
  {
    usd: 30, // ZONA AGUAMARINA (centro)
    distritos: [
      "rimac", "cercado de lima", "cercado", "lima cercado", "breña", "san luis",
      "la victoria", "lince", "jesus maria", "pueblo libre", "san miguel", "magdalena del mar", "magdalena",
    ],
  },
  {
    usd: 40, // ZONA NARANJA (cono sur cercano)
    distritos: [
      "barranco", "chorrillos", "san juan de miraflores", "villa maria del triunfo",
      "villa el salvador", "pachacamac",
    ],
  },
  {
    usd: 50, // ZONA AMARILLA (conos + Callao)
    distritos: [
      "lurin", "punta hermosa", "punta negra", "san bartolo", "santa maria del mar", "pucusana",
      "ancon", "santa rosa", "puente piedra", "carabayllo", "comas", "independencia",
      "los olivos", "san martin de porres",
      "callao", "mi peru", "ventanilla", "la perla", "carmen de la legua reynoso", "carmen de la legua",
      "san juan de lurigancho", "lurigancho", "chaclacayo", "ate", "cieneguilla", "ate vitarte",
    ],
  },
]

function normalizarDistrito(input: string): string {
  return String(input || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zñ\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Tarifa de visita/instalación para un punto en Lima Metropolitana.
 * Devuelve { usd, reconocido }: usd 0 = zona azul (sin costo); usd > 0 =
 * tarifa en dólares + IGV; reconocido=false = distrito no está en el mapa
 * (servicio técnico confirma el costo — trato conservador, sin prometer).
 */
export function tarifaVisitaLimaPE(ubicacion: string): { usd: number; reconocido: boolean } {
  const norm = normalizarDistrito(ubicacion)
  if (!norm) return { usd: 0, reconocido: false }
  for (const zona of ZONAS_VISITA_LIMA_PE) {
    for (const d of zona.distritos) {
      // Las entradas también se normalizan ("Breña" → "brena") y el match de
      // sub-frase exige BORDES de palabra: sin eso, "ate" calzaba dentro de
      // cualquier palabra que lo contuviera.
      const dn = normalizarDistrito(d)
      if (norm === dn || new RegExp(`(^| )${dn}( |$)`).test(norm)) {
        return { usd: zona.usd, reconocido: true }
      }
    }
  }
  return { usd: 0, reconocido: false }
}

// ── Clasificación de la UBICACIÓN de un punto (22-sep, caso Rodrigo) ────────
// Chile tiene `clasificarUbicacion` con el padrón completo de comunas y se
// NIEGA a cotizar con un texto que no es un lugar ("casa matriz" →
// no_clasificable → la tool pide la comuna). Perú deducía la zona con
// "todo lo que no es Lima = provincias", así que "casa matriz" pasaba como
// provincia y el precio salía sin preguntar dónde estará el reloj. Este
// clasificador es el equivalente peruano: Lima/Callao y sus distritos →
// "lima"; departamentos, capitales y ciudades conocidas → "provincias";
// cualquier otra cosa → "no_clasificable" y la tool pregunta, igual que en Chile.
export const CIUDADES_PE: readonly string[] = [
  // Departamentos / regiones
  "amazonas", "ancash", "apurimac", "arequipa", "ayacucho", "cajamarca", "cusco", "cuzco",
  "huancavelica", "huanuco", "ica", "junin", "la libertad", "lambayeque", "loreto",
  "madre de dios", "moquegua", "pasco", "piura", "puno", "san martin", "tacna", "tumbes",
  "ucayali",
  // Capitales y ciudades frecuentes
  "chachapoyas", "huaraz", "chimbote", "abancay", "andahuaylas", "camana", "mollendo",
  "huamanga", "jaen", "chota", "sicuani", "quillabamba", "chincha", "pisco", "nazca", "nasca",
  "huancayo", "tarma", "jauja", "la oroya", "satipo", "trujillo", "chepen", "pacasmayo",
  "chiclayo", "lambayeque", "ferrenafe", "iquitos", "yurimaguas", "puerto maldonado", "ilo",
  "cerro de pasco", "sullana", "talara", "paita", "sechura", "juliaca", "moyobamba",
  "tarapoto", "pucallpa", "huacho", "barranca", "canete", "san vicente de canete", "huaral",
  "chosica", "cajabamba", "bagua", "tingo maria", "huanta", "puquio",
]

// ZONA INTERMEDIA (Lalo 22-sep, "y si fueran 3 zonas como en Chile"): lo que
// el técnico alcanza por tierra en el día — Región Lima fuera de la capital
// e Ica. Solo cambia el precio de la VISITA técnica (US$129 = 3 UF); envío y
// arriendo la tratan como "fuera de Lima" (tarifa con despacho / línea única).
export const CIUDADES_INTERMEDIA_PE: readonly string[] = [
  "region lima", "lima provincias", "lima region", "huacho", "huaura", "barranca", "supe", "paramonga",
  "huaral", "chancay", "canete", "san vicente de canete", "mala", "asia", "imperial",
  "ica", "chincha", "chincha alta", "pisco", "nazca", "nasca", "palpa", "marcona",
]

// Palabras que describen el TIPO de lugar, no el lugar: con ellas la tool no
// puede clasificar aunque el modelo insista con una zona explícita.
const NO_ES_LUGAR_PE = /\b(casa matriz|matriz|oficina|oficinas|sucursal|sucursales|sede|planta|bodega|almacen|local|tienda|central|empresa|fabrica|taller|obra|mina|campo|fundo|punto|puntos|terreno)\b/

export type UbicacionPE =
  | { tipo: "lima"; razon?: undefined }
  | { tipo: "intermedia"; razon?: undefined }
  | { tipo: "provincias"; razon?: undefined }
  | { tipo: "no_clasificable"; razon: string }

/**
 * Clasifica la ubicación de un punto tal como la dijo el cliente.
 * `zonaDeclarada` es la que el modelo mandó explícita: se acepta como
 * respaldo SOLO cuando el texto no es un tipo de lugar (así una ciudad chica
 * fuera del catálogo pasa como provincia y "casa matriz" no).
 */
export function clasificarUbicacionPE(ubicacion: string, zonaDeclarada?: string): UbicacionPE {
  const norm = normalizarDistrito(ubicacion)
  if (!norm) return { tipo: "no_clasificable", razon: "ubicación vacía" }
  if (NO_ES_LUGAR_PE.test(norm)) {
    return { tipo: "no_clasificable", razon: `"${ubicacion}" describe un tipo de lugar, no una ciudad o distrito` }
  }
  // La intermedia va ANTES que el genérico "lima": "Región Lima" y "Lima
  // provincias" no son Lima Metropolitana.
  for (const c of CIUDADES_INTERMEDIA_PE) {
    if (norm === c || new RegExp(`(^| )${c}( |$)`).test(norm)) return { tipo: "intermedia" }
  }
  if (/\b(lima|callao)\b/.test(norm) || tarifaVisitaLimaPE(ubicacion).reconocido) return { tipo: "lima" }
  for (const c of CIUDADES_PE) {
    if (norm === c || new RegExp(`(^| )${c}( |$)`).test(norm)) return { tipo: "provincias" }
  }
  if (zonaDeclarada === "lima" || zonaDeclarada === "intermedia" || zonaDeclarada === "provincias") return { tipo: zonaDeclarada }
  return { tipo: "no_clasificable", razon: `"${ubicacion}" no es una ciudad ni un distrito que reconozca` }
}
