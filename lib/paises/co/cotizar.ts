/**
 * Motor de cotización referencial de COLOMBIA.
 *
 * Reglas de negocio (cerradas con Lalo 09/10-jul, validadas contra 15
 * cotizaciones reales de Creator CO):
 *   - Plan asistencia: 1-10 → $315.000 fijo · 11-50 → $13.700 por usuario.
 *     SIN IVA (servicio de computación en la nube, excluido art. 476 E.T.).
 *   - Reloj: arriendo $86.000/mes por unidad · venta $620.000 por unidad.
 *     Equipos SIEMPRE con IVA 19% (arriendo y venta).
 *   - Envío e instalación (por punto): GRATIS en arriendo. En venta: envío
 *     $42.000 capital / $69.000 resto · instalación $67.000 capital /
 *     $92.000 resto (0 si auto-instala). Con IVA 19%.
 *   - ACTIVACIÓN: primer mes del plan cobrado por adelantado como concepto
 *     aparte, CON IVA 19% (así lo factura GeoVictoria Colombia hoy). Es el
 *     equivalente del "pago inicial incluye el primer mes" chileno.
 *   - Pago inicial = activación + conceptos únicos (todo con su IVA).
 *   - Mensualidad (desde el mes siguiente) = plan (sin IVA) + arriendos (+IVA).
 *
 * El mensajeParaProspecto va en REGISTRO DE USTED y formato COP. Es la única
 * fuente de precios que Vicky CO puede comunicar (misma regla dura de Chile).
 */

import { CATALOGO_MODULOS_CO } from "./catalogo"

const IVA = 0.19

export type ZonaCO = "capital" | "resto"

export type PuntoInstalacionCO = {
  /** Ciudad/departamento como lo dijo el cliente (se transcribe, no se clasifica acá). */
  ubicacion: string
  zona: ZonaCO
  autoInstalada: boolean
}

export type CotizacionCOInput = {
  userCount: number
  reloj?: {
    modalidad: "arriendo" | "venta"
    cantidad: number
  }
  puntos?: PuntoInstalacionCO[]
}

export type LineaCO = {
  concepto: string
  detalle: string
  /** Monto neto en COP. */
  neto: number
  /** IVA en COP (0 si el concepto está excluido). */
  iva: number
  recurrente: boolean
}

/**
 * Item en el contrato del endpoint create-from-vicky-co del cotizador
 * (ver header de ese archivo). La Activación NO se envía: el endpoint la
 * garantiza solo (= 1 mes del plan, +IVA).
 */
export type ItemCotizadorCO = {
  tipo: "plan" | "hardware" | "servicio"
  id: string
  nombre: string
  descripcion?: string
  modalidad: "Por usuario" | "Fijo" | "Arriendo mensual" | "Venta única" | "Cobro único"
  cantidad: number
  precioUnitarioCOP: number
  subtotalCOP: number
  esRecurrente: boolean
  afectoIva: boolean
}

const TARIFAS_CO = {
  relojArriendoMes: 86000,
  relojVenta: 620000,
  envioVenta: { capital: 42000, resto: 69000 },
  instalacionVenta: { capital: 67000, resto: 92000 },
} as const

export function formatearCOP(monto: number): string {
  return "$" + Math.round(monto).toLocaleString("es-CO")
}

/** Precio mensual del plan de asistencia (COP, sin IVA). Lanza fuera de 1-50. */
export function precioPlanCO(userCount: number): number {
  const asistencia = CATALOGO_MODULOS_CO.find((m) => m.id === "asistencia")
  if (!asistencia) throw new Error("Catálogo CO sin módulo asistencia")
  const tier = asistencia.tiers.find(
    (t) => userCount >= t.minUsuarios && userCount <= t.maxUsuarios,
  )
  if (!tier) {
    throw new Error(
      `El plan de Colombia cubre de 1 a 50 usuarios (pedidos: ${userCount}). Sobre 50, derivar a un ejecutivo.`,
    )
  }
  return tier.modalidad === "fijo" ? tier.precioUF : tier.precioUF * userCount
}

export function cotizarCO(input: CotizacionCOInput): {
  lineas: LineaCO[]
  itemsCotizador: ItemCotizadorCO[]
  mensualNetoPlan: number
  mensualArriendoNeto: number
  mensualArriendoIva: number
  mensualTotal: number
  pagoInicialNeto: number
  pagoInicialIva: number
  pagoInicialTotal: number
  mensajeParaProspecto: string
} {
  const { userCount, reloj, puntos = [] } = input
  if (!Number.isFinite(userCount) || userCount < 1) {
    throw new Error("userCount inválido")
  }
  const plan = precioPlanCO(userCount)
  const lineas: LineaCO[] = []

  // ── Recurrente ──
  lineas.push({
    concepto: "Control de Asistencia",
    detalle:
      userCount <= 10
        ? `Plan mensual para hasta 10 usuarios (tarifa fija)`
        : `Plan mensual: ${userCount} usuarios × ${formatearCOP(13700)}`,
    neto: plan,
    iva: 0, // Servicio cloud excluido de IVA (art. 476 E.T.)
    recurrente: true,
  })

  let arriendoNeto = 0
  if (reloj && reloj.modalidad === "arriendo" && reloj.cantidad > 0) {
    arriendoNeto = TARIFAS_CO.relojArriendoMes * reloj.cantidad
    lineas.push({
      concepto: "Arriendo de reloj control",
      detalle: `${reloj.cantidad} × ${formatearCOP(TARIFAS_CO.relojArriendoMes)}/mes (envío e instalación incluidos sin costo)`,
      neto: arriendoNeto,
      iva: arriendoNeto * IVA,
      recurrente: true,
    })
  }

  // ── Pago único ──
  // Activación: primer mes del plan por adelantado, facturado con IVA.
  lineas.push({
    concepto: "Activación",
    detalle: "Equivale al primer mes de servicio, cobrado por adelantado",
    neto: plan,
    iva: plan * IVA,
    recurrente: false,
  })

  if (reloj && reloj.modalidad === "venta" && reloj.cantidad > 0) {
    const ventaNeto = TARIFAS_CO.relojVenta * reloj.cantidad
    lineas.push({
      concepto: "Reloj control (compra)",
      detalle: `${reloj.cantidad} × ${formatearCOP(TARIFAS_CO.relojVenta)}`,
      neto: ventaNeto,
      iva: ventaNeto * IVA,
      recurrente: false,
    })
    for (const punto of puntos) {
      const envio = TARIFAS_CO.envioVenta[punto.zona]
      lineas.push({
        concepto: `Envío de reloj (${punto.ubicacion})`,
        detalle: punto.zona === "capital" ? "Zona capital" : "Resto del país",
        neto: envio,
        iva: envio * IVA,
        recurrente: false,
      })
      if (!punto.autoInstalada) {
        const inst = TARIFAS_CO.instalacionVenta[punto.zona]
        lineas.push({
          concepto: `Instalación de reloj (${punto.ubicacion})`,
          detalle: punto.zona === "capital" ? "Zona capital" : "Resto del país",
          neto: inst,
          iva: inst * IVA,
          recurrente: false,
        })
      }
    }
  }

  // ── Totales ──
  const unicos = lineas.filter((l) => !l.recurrente)
  const pagoInicialNeto = unicos.reduce((s, l) => s + l.neto, 0)
  const pagoInicialIva = unicos.reduce((s, l) => s + l.iva, 0)
  const pagoInicialTotal = pagoInicialNeto + pagoInicialIva
  const mensualArriendoIva = arriendoNeto * IVA
  const mensualTotal = plan + arriendoNeto + mensualArriendoIva

  // ── Mensaje canónico (registro de usted, COP) ──
  const filas: string[] = []
  filas.push("Le comparto el detalle de su cotización referencial:")
  filas.push("")
  filas.push("Mensualidad del servicio:")
  filas.push(`- Control de Asistencia (${userCount} usuario${userCount === 1 ? "" : "s"}): ${formatearCOP(plan)}/mes`)
  if (arriendoNeto > 0) {
    filas.push(
      `- Arriendo de reloj control: ${formatearCOP(arriendoNeto)} + IVA = ${formatearCOP(arriendoNeto * (1 + IVA))}/mes (envío e instalación incluidos)`,
    )
  }
  filas.push(`Total mensual: ${formatearCOP(mensualTotal)}`)
  filas.push("")
  filas.push("Pago inicial (una sola vez):")
  for (const l of unicos) {
    filas.push(
      `- ${l.concepto}: ${formatearCOP(l.neto)}${l.iva > 0 ? ` + IVA = ${formatearCOP(l.neto + l.iva)}` : ""}`,
    )
  }
  filas.push(`Total pago inicial: ${formatearCOP(pagoInicialTotal)} (IVA incluido)`)
  filas.push("")
  filas.push(
    "El plan mensual del servicio está excluido de IVA (servicio de computación en la nube, art. 476 del Estatuto Tributario). La capacitación online, valorada en $95.000, va incluida con el 100% de descuento.",
  )

  // ── Items para la cotización FORMAL (contrato create-from-vicky-co) ──
  // Misma matemática que las líneas de arriba, en formato del endpoint. La
  // Activación no va: la garantiza el endpoint (= 1 mes del plan, +IVA).
  const itemsCotizador: ItemCotizadorCO[] = []
  itemsCotizador.push({
    tipo: "plan",
    id: "plan_asistencia",
    nombre: "Control de Asistencia",
    descripcion:
      "Marcaje web, app móvil con GPS y biometría. Gestión de turnos, vacaciones y horas extra. Reportería en línea.",
    modalidad: userCount <= 10 ? "Fijo" : "Por usuario",
    cantidad: userCount <= 10 ? 1 : userCount,
    precioUnitarioCOP: userCount <= 10 ? plan : 13700,
    subtotalCOP: plan,
    esRecurrente: true,
    afectoIva: false,
  })
  if (reloj && reloj.modalidad === "arriendo" && reloj.cantidad > 0) {
    itemsCotizador.push({
      tipo: "hardware",
      id: "reloj_arriendo",
      nombre: "Arriendo de reloj control",
      descripcion:
        "Reloj biométrico de control de asistencia (facial y huella), con conexión WiFi y Ethernet. Envío e instalación incluidos sin costo.",
      modalidad: "Arriendo mensual",
      cantidad: reloj.cantidad,
      precioUnitarioCOP: TARIFAS_CO.relojArriendoMes,
      subtotalCOP: arriendoNeto,
      esRecurrente: true,
      afectoIva: true,
    })
  }
  if (reloj && reloj.modalidad === "venta" && reloj.cantidad > 0) {
    itemsCotizador.push({
      tipo: "hardware",
      id: "reloj_venta",
      nombre: "Reloj control (compra)",
      descripcion:
        "Reloj biométrico de control de asistencia (facial y huella), con conexión WiFi y Ethernet.",
      modalidad: "Venta única",
      cantidad: reloj.cantidad,
      precioUnitarioCOP: TARIFAS_CO.relojVenta,
      subtotalCOP: TARIFAS_CO.relojVenta * reloj.cantidad,
      esRecurrente: false,
      afectoIva: true,
    })
    for (const punto of puntos) {
      const envio = TARIFAS_CO.envioVenta[punto.zona]
      itemsCotizador.push({
        tipo: "servicio",
        id: "envio_reloj",
        nombre: `Envío de reloj (${punto.ubicacion})`,
        modalidad: "Cobro único",
        cantidad: 1,
        precioUnitarioCOP: envio,
        subtotalCOP: envio,
        esRecurrente: false,
        afectoIva: true,
      })
      if (!punto.autoInstalada) {
        const inst = TARIFAS_CO.instalacionVenta[punto.zona]
        itemsCotizador.push({
          tipo: "servicio",
          id: "instalacion_reloj",
          nombre: `Instalación de reloj (${punto.ubicacion})`,
          modalidad: "Cobro único",
          cantidad: 1,
          precioUnitarioCOP: inst,
          subtotalCOP: inst,
          esRecurrente: false,
          afectoIva: true,
        })
      }
    }
  }

  return {
    lineas,
    itemsCotizador,
    mensualNetoPlan: plan,
    mensualArriendoNeto: arriendoNeto,
    mensualArriendoIva,
    mensualTotal,
    pagoInicialNeto,
    pagoInicialIva,
    pagoInicialTotal,
    mensajeParaProspecto: filas.join("\n"),
  }
}
