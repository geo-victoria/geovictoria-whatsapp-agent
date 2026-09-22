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

/** Cuán obligatoria es la oferta de un servicio en una cotización. */
export type ObligatoriedadServicio = "obligatoria" | "recomendada" | "opcional"

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
  /**
   * Si es `false`, el dispositivo NO requiere visita técnica de instalación
   * on-site (ej. un huellero USB que el cliente conecta a su PC — plug and
   * play). En ese caso la cotización NO cobra el servicio `instalacion_reloj`
   * (el envío sí se mantiene: el equipo se despacha igual). Si se omite o es
   * `true`, el dispositivo requiere instalación on-site (comportamiento del
   * reloj de pared), y la instalación se cobra salvo que el cliente auto-instale.
   */
  requiereInstalacionOnsite?: boolean
  /** Si es `true`, Vicky puede ofrecerlo. */
  disponibleParaVicky: boolean
  /** Accesorio que ACOMPAÑA a un reloj (tarjetas de proximidad): no cuenta
   * como hardware para envío/instalación/puntos ni para el arriendo por
   * zona — es una línea de venta única que viaja con el equipo (01-sep,
   * caso Valuaciones: el cliente quería cerrar y las tarjetas se agregaron
   * a mano; ahora Vicky puede sola). */
  esAccesorio?: boolean
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
 * Tarifa por punto físico según modalidad del reloj (arriendo/venta) × zona
 * (RM / otras regiones). El cobro es POR PUNTO (no por reloj). La usa el ENVÍO.
 */
export type TarifaPorModalidadZona = {
  modelo: "modalidad_zona"
  arriendo: { RM: number; region: number }
  venta: { RM: number; region: number }
}

/**
 * Tarifa plana por punto físico según zona de instalación en 3 tramos
 * (jul-2026), SIN distinción arriendo/compra. La usa la INSTALACIÓN:
 * RM 1 UF · intermedia (IV Coquimbo, V Valparaíso, VI O'Higgins) 3 UF ·
 * resto de las regiones 5 UF.
 */
export type TarifaPorZona = {
  modelo: "zona"
  RM: number
  intermedia: number
  resto: number
}

export type TarifaServicioPunto = TarifaPorModalidadZona | TarifaPorZona

/**
 * Servicio asociado (envío, instalación).
 *
 * Precio por punto según su modelo de tarifa (ver TarifaServicioPunto). Si más
 * adelante se necesita granularidad por región específica, agregar de forma
 * aditiva sin romper este modelo.
 */
export type Servicio = {
  id: string
  nombre: string
  descripcion: string

  /** Tarifa por punto (envío: modalidad × zona · instalación: 3 zonas). */
  tarifa: TarifaServicioPunto

  /**
   * Si es `true`, el servicio entra en el descuento negociable. Desde el
   * cambio de tarifas jul-2026 NINGÚN servicio es descontable (la instalación
   * pasó a tarifa plana por zona y dejó de tener descuento; el envío nunca lo
   * tuvo). El campo queda por si vuelve una política de descuento.
   */
  descontable: boolean

  /**
   * Si es `true`, el servicio NO se cobra cuando el cliente auto-instala
   * (la instalación). El envío se cobra igual (el reloj se despacha de todas
   * formas), así que va en `false`.
   */
  omitirSiAutoInstalada: boolean

  /**
   * Cuán obligatoria es la oferta del servicio. "recomendada" significa que
   * Vicky lo ofrece por defecto pero el prospecto puede declinarlo bajo
   * su responsabilidad.
   */
  obligatoriedad: ObligatoriedadServicio

  /**
   * Si es `true`, el prospecto puede declinar el servicio y asumirlo por
   * cuenta propia. Si es `false`, no hay opción: o se cotiza con el
   * servicio o no se vende el producto al que aplica.
   */
  permiteAutoInstalacion: boolean

  /**
   * Mensajes de advertencia que Vicky debe comunicar cuando el prospecto
   * elige auto-instalación. Se devuelven en el campo `advertencias` de las
   * tools para que Vicky los incluya en su mensaje al prospecto.
   */
  advertenciasAutoInstalacion: string[]

  /**
   * Si es `true`, el servicio se ofrece automáticamente cuando la cotización
   * incluye al menos un hardware físico. Permite que la tool detecte la
   * aplicabilidad sin que Vicky tenga que decidirlo.
   */
  aplicaConHardware: boolean

  /** Si es `true`, Vicky puede ofrecerlo. */
  disponibleParaVicky: boolean
}
