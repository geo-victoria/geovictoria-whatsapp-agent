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
 *   Envío:          S/0 SIEMPRE (todo Perú, ambas modalidades — sin línea)
 *   Instalación:    Lima S/0 (incluida) · FUERA de Lima NO se cotiza:
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
    modelo: "reloj_pe",
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
      "Despacho del reloj al punto del cliente. Sin costo en todo el Perú, en ambas modalidades.",
    // RM ≡ "lima" · region ≡ provincias. Envío S/0 SIEMPRE: las cuatro
    // celdas van en 0 y el motor no emite línea de envío.
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
      "Instalación del reloj de control. Sin costo en Lima. Fuera de Lima se coordina con servicio técnico y se cotiza aparte.",
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
