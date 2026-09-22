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
 * Precios Colombia (COP) — DEFINICIONES CERRADAS (Lalo, 09-jul):
 *   Asistencia 1-10:  $315.000/mes fijo (sin micro-plan de 1 persona)
 *   Asistencia 11-50: $13.700/usuario/mes ("la más competitiva": el rango fijo
 *                     corta en 10, NO en 20 como muestra Creator hoy)
 *   Reloj venta:      $620.000 pago único · arriendo $86.000/mes
 *   ENVÍO/INSTALACIÓN (SUPERSEDIDO 22-sep, propuesta aprobada por Lalo —
 *   los números vigentes viven en TARIFAS_CO de co/cotizar.ts): alquiler
 *   $86.000 base / $98.000 fuera con despacho · envío venta $42.000 / $69.000
 *   · instalación $175.000 / $530.000 / $875.000 (Bogotá / intermedia /
 *   resto = 1/3/5 UF chilenas), bonificada en alquiler en Bogotá.
 *
 * ACTIVACIÓN (pago inicial CO, patrón de las cotizaciones reales de Creator):
 *   = 1 mes del plan cobrado por adelantado, facturado como concepto
 *   "Activación" CON IVA 19% (el servicio mensual va SIN IVA — excluido
 *   art. 476 E.T. como computación en la nube). Es la misma lógica del pago
 *   inicial chileno. NO se replica el esquema "mes 2 con 30% dcto" visto en
 *   2 cotizaciones (manual, no es política confirmada). No es un ítem de
 *   catálogo: se deriva del plan en la lógica de cotización CO.
 *
 * IVA por línea: plan SIN IVA · activación/equipos/envío/instalación +19%.
 * Pago online: MercadoPago Colombia (cuenta creada; credenciales pendientes).
 *
 * CAPACITACIÓN (definido por Lalo, 09-jul): igual que Chile — se muestra en la
 * cotización valorizada en $95.000 COP con 100% de descuento (tachada, $0).
 * Vive en el cotizador CO como línea fija de regalo, no como ítem cotizable.
 *
 * TODO restantes:
 *   1. Cobertura exacta de "capital" (Creator usa departamento + zona capital).
 *   2. Escalera de descuentos CO (instalación 20%/20% + plan 10→20%): confirmar
 *      con comercial CO antes de habilitar la negociación.
 */

import type { ModuloSoftware, Hardware, Servicio } from "../../catalogo/tipos.ts"

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
      "Despacho del equipo al punto del cliente. Incluido en alquiler (fuera de Bogotá la tarifa mensual ya trae el despacho); en venta $42.000 en Bogotá y alrededores / $69.000 en el resto del país.",
    // RM ≡ "capital" = Bogotá y conurbados · region ≡ fuera de la base. La
    // tarifa vigente vive en TARIFAS_CO (co/cotizar.ts); estas celdas son espejo.
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
      "Visita técnica de instalación por punto: Bogotá y alrededores $175.000 (bonificada en alquiler) · Cundinamarca, Boyacá, Tolima y Meta $530.000 · resto del país $875.000. Auto-instalación gratis siempre.",
    // Tres zonas (la intermedia vive en TARIFAS_CO de co/cotizar.ts; este
    // modelo solo tiene dos celdas — espejo informativo).
    tarifa: {
      modelo: "modalidad_zona",
      arriendo: { RM: 0, region: 875000 },
      venta: { RM: 175000, region: 875000 },
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
