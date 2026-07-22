/**
 * Catálogo MÉXICO (documento oficial de tropicalización MX — fuente de verdad).
 *
 * ⚠️ CONVENCIÓN DE UNIDADES: los campos `precioUF`/`arriendoUF`/`ventaUF` del
 * catálogo guardan el precio en la UNIDAD DE PRICING del país. En Chile esa
 * unidad es la UF (se convierte a CLP con la UF del día); en México es el
 * PESO MEXICANO directo (sin unidad indexada: `moneda.unidadIndexada = null`
 * en el perfil, no hay conversión). El nombre del campo es herencia del
 * catálogo chileno.
 *
 * Precios México (MXN) — plan mensual asistencia:
 *   Asistencia 1-10:  $1,000/mes tarifa FIJA (no existe el micro-plan de 1
 *                     usuario de Chile: el tramo 1-10 parte en 1)
 *   Asistencia 11-20: $83/usuario/mes
 *   Asistencia 21-30: $79/usuario/mes
 *   Asistencia 31-50: $75/usuario/mes
 *   Reloj venta:      $2,100 pago único · renta $350/mes
 *   Envío:      renta $0 · venta $400 por punto (MISMA tarifa todo México,
 *               no descontable — el envío no depende de la zona)
 *   Instalación: $700 por punto SOLO en CDMX / Zona Metropolitana del Valle
 *               de México (gratis en renta dentro de esa zona). FUERA de
 *               la zona la instalación profesional NO la cotiza Vicky: la
 *               cotiza el ejecutivo aparte, o el cliente auto-instala gratis
 *               (la venta nunca se frena por esto).
 *   → El RENTA va con envío gratis en todo México e instalación gratis en
 *     CDMX/Zona Metropolitana (mismo trato que CO: renta = cero costos por
 *     punto en zona cubierta).
 *
 * ACTIVACIÓN (pago inicial MX, mismo patrón CL/CO): = 1 mes del plan cobrado
 * por adelantado. No es un ítem de catálogo: se deriva del plan en la lógica
 * de cotización MX (mx/cotizar.ts).
 *
 * IVA: 16% (¡no 19!) en TODOS los conceptos — lo aplica el motor de
 * cotización; los precios de este catálogo son netos.
 *
 * CAPACITACIÓN (diferencia clave con Chile/Colombia): la capacitación online
 * cuesta $600 MXN pago único y SE COBRA — NUNCA es "de regalo" ni "incluida".
 * No calza con el tipo Servicio (su tarifa es por punto físico y la
 * capacitación es por cotización), así que vive como tarifa fija del motor
 * (TARIFAS_MX.capacitacionOnline en mx/cotizar.ts), que la agrega como ítem
 * de servicio cobrado en TODA cotización.
 *
 * ESCALERA DE DESCUENTO (plan mensual): 10% → 15%, dos escalones, aplica a
 * los primeros 6 meses, vigencia 72h — misma mecánica que CO pero con tope
 * 15%. SIN descuento de instalación (0). La aplica el COTIZADOR (página de
 * aceptación), no Vicky: en el chat los descuentos siguen prohibidos.
 */

import type { ModuloSoftware, Hardware, Servicio } from "../../catalogo/tipos"

/**
 * Escalera de descuento del plan mensual MX (dato para el cotizador; Vicky
 * NUNCA la ofrece ni la menciona en el chat).
 */
export const ESCALERA_DESCUENTO_MX = {
  /** Escalones sucesivos de descuento del plan mensual (tope 15%). */
  planMensual: [0.1, 0.15],
  /** Sin descuento de instalación en México. */
  instalacion: [0, 0],
  /** El descuento aplica a los primeros 6 meses del plan. */
  mesesConDescuento: 6,
  /** Vigencia de la oferta una vez emitida (horas). */
  vigenciaHoras: 72,
} as const

export const CATALOGO_MODULOS_MX: ModuloSoftware[] = [
  {
    id: "asistencia",
    nombre: "Control de Asistencia",
    descripcion:
      "Marcaje web, app móvil con GPS y biometría. Gestión de turnos, vacaciones y horas extra. Reportería en línea.",
    tiers: [
      { minUsuarios: 1, maxUsuarios: 10, modalidad: "fijo", precioUF: 1000 },
      { minUsuarios: 11, maxUsuarios: 20, modalidad: "por_usuario", precioUF: 83 },
      { minUsuarios: 21, maxUsuarios: 30, modalidad: "por_usuario", precioUF: 79 },
      { minUsuarios: 31, maxUsuarios: 50, modalidad: "por_usuario", precioUF: 75 },
    ],
    disponibleParaVicky: true,
  },
]

export const CATALOGO_HARDWARE_MX: Hardware[] = [
  {
    id: "reloj_mx",
    modelo: "reloj_mx",
    displayName: "Reloj checador físico",
    conexion: "WiFi / Ethernet",
    ventaUF: 2100,
    arriendoUF: 350,
    descripcion:
      "Reloj biométrico de control de asistencia (facial y huella), con conexión WiFi y Ethernet.",
    modalidadesDisponibles: ["arriendo", "venta"],
    cantidadSugerida: 1,
    disponibleParaVicky: true,
  },
]

export const CATALOGO_SERVICIOS_MX: Servicio[] = [
  {
    id: "envio_reloj",
    nombre: "Envío de reloj",
    descripcion:
      "Despacho del reloj de control al punto del cliente. Cobro único por punto, misma tarifa en todo México. Gratis en modalidad renta.",
    // RM ≡ "cdmx_metro" · region ≡ resto. El envío MX NO depende de la zona:
    // $400 parejo en venta (por eso ambas celdas van iguales), $0 en renta.
    tarifa: {
      modelo: "modalidad_zona",
      arriendo: { RM: 0, region: 0 },
      venta: { RM: 400, region: 400 },
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
      "Visita técnica para instalación on-site del reloj de control. Cobro único por punto, disponible SOLO en CDMX y Zona Metropolitana del Valle de México. Gratis en modalidad renta dentro de esa zona.",
    // region = 0 NO significa "gratis": fuera de CDMX/Zona Metropolitana la
    // instalación profesional NO la cotiza Vicky (la cotiza el ejecutivo
    // aparte, o el cliente auto-instala gratis). La lógica vive en
    // mx/cotizar.ts; esta celda queda en 0 porque no hay tarifa publicable.
    tarifa: {
      modelo: "modalidad_zona",
      arriendo: { RM: 0, region: 0 },
      venta: { RM: 700, region: 0 },
    },
    // SIN descuento de instalación en México (escalera solo del plan).
    descontable: false,
    omitirSiAutoInstalada: true,
    obligatoriedad: "recomendada",
    permiteAutoInstalacion: true,
    advertenciasAutoInstalacion: [],
    aplicaConHardware: true,
    disponibleParaVicky: true,
  },
]
