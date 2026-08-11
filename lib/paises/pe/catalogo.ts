/**
 * Catálogo PERÚ (excel oficial Tropicalizacion_Vicky_2, 04-ago-2026 —
 * fuente de verdad).
 *
 * ⚠️ CONVENCIÓN DE UNIDADES: los campos `precioUF`/`arriendoUF`/`ventaUF`
 * guardan el precio en la UNIDAD DE PRICING del país — en Perú es el SOL
 * PERUANO (PEN) directo, sin unidad indexada. El nombre del campo es
 * herencia del catálogo chileno.
 *
 * Precios Perú (PEN, netos — el IGV 18% lo aplica el motor):
 *   Asistencia 1-10:  S/100/mes tarifa FIJA
 *   Asistencia 11-20: S/200/mes tarifa FIJA
 *   Asistencia 21-50: S/5 por usuario/mes
 *   ⚠️ ANOMALÍA DEL EXCEL (avisada a Lalo 04-ago y APROBADA tal cual):
 *   21 usuarios pagan S/105 (21×5), MENOS que los S/200 fijos del tramo
 *   11-20. Es literal del excel — no "corregir" sin orden expresa.
 *   Reloj venta:    S/525 pago único · arriendo S/70/mes
 *   Envío:          S/0 en LIMA METROPOLITANA (ambas modalidades). A
 *                   PROVINCIA lo ASUME EL CLIENTE (VB Diego 05-ago): nosotros
 *                   no lo cobramos ni lo cotizamos — se informa que corre por
 *                   su cuenta. Sin línea de cobro en ningún caso.
 *   Instalación:    Lima Metropolitana S/0 (incluida) · FUERA NO se cotiza:
 *                   "se coordina con servicio técnico, se cotiza aparte" +
 *                   aviso interno a ssttperu@geovictoria.pro. La venta
 *                   nunca se frena por esto.
 *   Capacitación:   NO se ofrece en Perú (ni cobrada ni de regalo).
 *
 * PAGO INICIAL (patrón CL/CO): pagos únicos + primer mes del plan por
 * adelantado (neto + IGV). Luego facturación mensual según usuarios activos.
 *
 * IGV: 18% en TODOS los conceptos — lo aplica el motor (pe/cotizar.ts);
 * este catálogo es neto.
 *
 * DESCUENTO (Lalo 04-ago, tras ida y vuelta — DEFINITIVO): única herramienta
 * de negociación = 20% en las 4 PRIMERAS FACTURAS (escalera de UN escalón).
 * Vicky lo ofrece como CIERRE, nunca proactivo de entrada. El pago inicial
 * con descuento ya lleva el primer mes al 20%; facturas 2-4 con 20%; desde
 * la 5ª, precio de lista.
 */

import type { ModuloSoftware, Hardware, Servicio } from "../../catalogo/tipos.ts"

/**
 * Escalera de descuento del plan mensual PE. Un solo escalón (20%), aplica
 * a las 4 PRIMERAS FACTURAS (no a 6 meses como CL/CO/MX).
 */
export const ESCALERA_DESCUENTO_PE = {
  /** Un único escalón de descuento del plan mensual. */
  planMensual: [0.2],
  /** Sin descuento de instalación (en Lima ya es gratis). */
  instalacion: [0],
  /** El descuento aplica a las primeras 4 FACTURAS (no meses calendario). */
  facturasConDescuento: 4,
  /** Vigencia de la oferta una vez emitida (horas) — convención de la casa. */
  vigenciaHoras: 72,
} as const

export const CATALOGO_MODULOS_PE: ModuloSoftware[] = [
  {
    id: "asistencia",
    nombre: "Control de Asistencia",
    descripcion:
      "Marcaje web, app móvil con GPS y biometría. Gestión de turnos, vacaciones y horas extra. Reportería en línea.",
    tiers: [
      { minUsuarios: 1, maxUsuarios: 10, modalidad: "fijo", precioUF: 100 },
      { minUsuarios: 11, maxUsuarios: 20, modalidad: "fijo", precioUF: 200 },
      // Anomalía 21+ documentada arriba: literal del excel, aprobada.
      { minUsuarios: 21, maxUsuarios: 50, modalidad: "por_usuario", precioUF: 5 },
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
    ventaUF: 525,
    arriendoUF: 70,
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
      "Despacho del reloj. Sin costo en Lima Metropolitana (ambas modalidades); a provincia el envío corre por cuenta del cliente.",
    // RM ≡ "lima" (Metropolitana) · region ≡ provincias. Celdas en 0 porque
    // GeoVictoria nunca cobra el envío: en Lima Metropolitana es gratis y a
    // provincia lo asume el CLIENTE (VB Diego 05-ago) — el motor lo informa
    // como nota, sin línea de cobro.
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
      "Instalación del reloj de control. Sin costo en Lima Metropolitana. Fuera de Lima se coordina con servicio técnico y se cotiza aparte.",
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
