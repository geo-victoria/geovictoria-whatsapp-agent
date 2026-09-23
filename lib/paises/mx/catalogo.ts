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
 *   Asistencia 11-20: $83/usuario/mes   ← RANGO DE VICKY = 1-20, igual que Chile (Lalo 23-sep)
 *   Asistencia 21-30: $79/usuario/mes   (fuera del rango de Vicky: solo excepción por contacto)
 *   Asistencia 31-50: $75/usuario/mes   (ídem)
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

import type { ModuloSoftware, Hardware, Servicio } from "../../catalogo/tipos.ts"

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
      // ── RANGO DE VICKY = 1-20 (Lalo 23-sep: "iguala el rango de cotización de los
      // países al de Chile, solo hasta 20"). El tramo 21-50 NO es rango de Vicky:
      // queda, como el 21-50 de Chile, solo para la excepción por contacto
      // (umbral_contacto_) y como referencia de la tabla de cobro. La guarda del
      // umbral (lib/umbral-autonomia + agent-loop) rechaza la tool sobre 20/10.
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
      "Envío del reloj al punto del cliente. Incluido en renta (fuera de CDMX la renta mensual ya trae el envío); en venta $400 en CDMX y Zona Metropolitana / $560 en el resto del país.",
    // RM ≡ "cdmx_metro" (base) · region ≡ fuera de la base (Lalo 22-sep). La
    // tarifa vigente vive en TARIFAS_MX (mx/cotizar.ts); estas celdas son espejo.
    tarifa: {
      modelo: "modalidad_zona",
      arriendo: { RM: 0, region: 0 },
      venta: { RM: 400, region: 560 },
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
      "Visita técnica de instalación por punto: CDMX y Zona Metropolitana $800 (bonificada en renta) · Edomex, Morelos, Puebla, Tlaxcala, Hidalgo y Querétaro $2,400 · resto del país $4,000. Auto-instalación gratis siempre.",
    // Tres zonas (la intermedia vive en TARIFAS_MX de mx/cotizar.ts; este
    // modelo solo tiene dos celdas — espejo informativo).
    tarifa: {
      modelo: "modalidad_zona",
      arriendo: { RM: 0, region: 4000 },
      venta: { RM: 800, region: 4000 },
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
