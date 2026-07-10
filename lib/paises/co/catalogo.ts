/**
 * Catálogo COLOMBIA (tabla de precios oficial compartida por Lalo, 09-jul-2026).
 *
 * ⚠️ CONVENCIÓN DE UNIDADES: los campos `precioUF`/`arriendoUF`/`ventaUF` del
 * catálogo guardan el precio en la UNIDAD DE PRICING del país. En Chile esa
 * unidad es la UF (se convierte a CLP con la UF del día); en Colombia es el
 * PESO COLOMBIANO directo (sin unidad indexada: `moneda.unidadIndexada = null`
 * en el perfil, no hay conversión). El nombre del campo es herencia del
 * catálogo chileno.
 *
 * Precios Colombia (COP):
 *   Asistencia 1-10:  $315.000/mes fijo (sin micro-plan de 1 persona)
 *   Asistencia 11-50: $13.700/usuario/mes (tarifa única, sin tramos)
 *   Reloj venta:      $620.000 pago único · arriendo $86.000/mes
 *   Envío:      arriendo $0/$0 · venta $42.000 (capital) / $69.000 (resto)
 *   Instalación: arriendo $0/$0 · venta $67.000 (capital) / $92.000 (resto)
 *   → El ARRIENDO va con envío e instalación GRATIS (argumento de venta CO).
 *
 * TODO (definiciones pendientes de Lalo/comercial CO):
 *   1. Qué cubre "capital" (¿solo Bogotá D.C. + área metropolitana?).
 *   2. Capacitación $95.000: ¿se cobra o va con 100% dcto como Chile?
 *   3. ¿Precios netos + IVA 19% o IVA incluido?
 *   4. Escalera de descuentos CO (instalación 20%/20% + plan 10→20%): confirmar.
 */

import type { ModuloSoftware, Hardware, Servicio } from "../../catalogo/tipos"

export const CATALOGO_MODULOS_CO: ModuloSoftware[] = [
  {
    id: "asistencia",
    nombre: "Control de Asistencia",
    descripcion:
      "Marcaje web, app móvil con GPS y biometría. Gestión de turnos, vacaciones y horas extra. Reportería en línea.",
    tiers: [
      { minUsuarios: 1, maxUsuarios: 10, modalidad: "fijo", precioUF: 315000 },
      { minUsuarios: 11, maxUsuarios: 50, modalidad: "por_usuario", precioUF: 13700 },
    ],
    disponibleParaVicky: true,
  },
]

export const CATALOGO_HARDWARE_CO: Hardware[] = [
  {
    id: "reloj_co",
    modelo: "reloj_co",
    displayName: "Reloj control físico",
    conexion: "WiFi / Ethernet",
    ventaUF: 620000,
    arriendoUF: 86000,
    descripcion:
      "Reloj biométrico de control de asistencia (facial y huella), con conexión WiFi y Ethernet.",
    modalidadesDisponibles: ["arriendo", "venta"],
    cantidadSugerida: 1,
    disponibleParaVicky: true,
  },
]

export const CATALOGO_SERVICIOS_CO: Servicio[] = [
  {
    id: "envio_reloj",
    nombre: "Envío de reloj",
    descripcion:
      "Despacho del reloj de control al punto del cliente. Cobro único por punto. Gratis en modalidad arriendo.",
    // RM ≡ "capital" (TODO 1: definir cobertura exacta) · region ≡ resto del país.
    tarifa: {
      modelo: "modalidad_zona",
      arriendo: { RM: 0, region: 0 },
      venta: { RM: 42000, region: 69000 },
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
      "Visita técnica para instalación on-site del reloj de control. Cobro único por punto. Gratis en modalidad arriendo.",
    tarifa: {
      modelo: "modalidad_zona",
      arriendo: { RM: 0, region: 0 },
      venta: { RM: 67000, region: 92000 },
    },
    // TODO 4: la tabla CO indica escalera de descuento de instalación 20%/20%
    // (a diferencia de Chile, que la eliminó). Se activa cuando el cotizador
    // CO exista; el flag de catálogo queda en false hasta confirmar.
    descontable: false,
    omitirSiAutoInstalada: true,
    obligatoriedad: "recomendada",
    permiteAutoInstalacion: true,
    advertenciasAutoInstalacion: [],
    aplicaConHardware: true,
    disponibleParaVicky: true,
  },
]
