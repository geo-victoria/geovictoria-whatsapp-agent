/**
 * Tipos compartidos del catálogo de productos de GeoVictoria.
 *
 * Premisa rectora:
 *   Solo se puede cotizar lo que existe en el catálogo Y tiene
 *   `disponibleParaVicky === true`. Si no cumple ambas condiciones,
 *   la tool falla con error legible.
 *
 * Soporte de tiers:
 *   Los módulos pueden tener distintos precios según el rango de usuarios
 *   (ej. Asistencia: fijo para 1-10, por usuario para 11+). El array `tiers`
 *   declara cada rango. El helper `obtenerTierAplicable` busca el tier
 *   correcto para un userCount dado.
 */

/** Familia conceptual de un producto en el catálogo. */
export type FamiliaProducto = "modulo_software" | "hardware_marcaje" | "accesorio" | "servicio"

/** Modalidad de cálculo de precio dentro de un tier. */
export type ModalidadTier = "fijo" | "por_usuario"

/** Modalidades de adquisición disponibles para un hardware. */
export type ModalidadHardware = "venta" | "arriendo"

/**
 * Tier de precio para un módulo. Cubre un rango de usuarios con una
 * modalidad y precio específicos.
 */
export type TierPrecio = {
  /** Cantidad mínima de usuarios cubierta por este tier (inclusive). */
  minUsuarios: number
  /** Cantidad máxima de usuarios cubierta por este tier (inclusive). */
  maxUsuarios: number
  /** Cómo se calcula el precio en este tier. */
  modalidad: ModalidadTier
  /**
   * Precio en UF.
   * Si `modalidad === "fijo"`: es el total mensual independiente de userCount.
   * Si `modalidad === "por_usuario"`: es el precio por usuario.
   */
  precioUF: number
}

/**
 * Módulo de software (Asistencia, Vacaciones, Banco de Horas, etc).
 */
export type ModuloSoftware = {
  /** Identificador único usado por el código y por la cotizadora oficial. */
  id: string

  /** Nombre visible al usuario final. */
  nombre: string

  /** Descripción breve para que Vicky pueda explicarlo conversacionalmente. */
  descripcion: string

  /** Tiers de precio. Cada uno cubre un rango de usuarios distinto. */
  tiers: TierPrecio[]

  /**
   * Mínimo global de usuarios para que el módulo aplique.
   * Ejemplo: Reporte/Victoria requieren 5+ trabajadores como precondición.
   * Si no se define, no hay mínimo global y solo aplican los rangos de los tiers.
   */
  minUsuariosTotal?: number

  /**
   * Si es `true`, Vicky puede ofrecerlo en la conversación.
   * Si es `false`, queda declarado pero no se cotiza (solo lo ve un ejecutivo).
   */
  disponibleParaVicky: boolean
}

/**
 * Hardware de marcaje (relojes biométricos, lectores, terminales).
 */
export type Hardware = {
  id: string
  modelo: string
  displayName: string
  conexion: string
  /** Precio venta única en UF (0 si no se vende, solo arriendo). */
  ventaUF: number
  /** Precio arriendo mensual en UF por unidad. */
  arriendoUF: number
  /** Descripción para que Vicky explique el dispositivo conversacionalmente. */
  descripcion: string
  /** Modalidades efectivamente disponibles (derivadas de venta/arriendo > 0). */
  modalidadesDisponibles: ModalidadHardware[]
  /** Cantidad sugerida por defecto para empresas chicas. */
  cantidadSugerida: number
  /** Si es `true`, Vicky puede ofrecerlo. */
  disponibleParaVicky: boolean
}

/**
 * Accesorio complementario (tarjetas, gabinetes, UPS, etc).
 * Declarados para mantener catálogo completo. Por defecto no se ofrecen.
 */
export type Accesorio = {
  id: string
  modelo: string
  displayName: string
  ventaUF: number
  arriendoUF: number
  descripcion: string
  disponibleParaVicky: boolean
}

/**
 * Servicio asociado (envío, instalación).
 */
export type Servicio = {
  id: string
  nombre: string
  descripcion: string
  precioUFRM: number       // Región Metropolitana
  precioUFRegion: number   // Otras regiones
  disponibleParaVicky: boolean
}
