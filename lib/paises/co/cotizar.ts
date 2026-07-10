/**
 * Motor de cotización referencial de COLOMBIA.
 *
 * Reglas de negocio (cerradas con Lalo 09/10-jul):
 *   - Plan asistencia: 1-10 → $315.000 fijo · 11-50 → $13.700 por usuario.
 *   - Reloj: arriendo $86.000/mes por unidad · venta $620.000 por unidad.
 *   - Envío e instalación (por punto): GRATIS en arriendo. En venta: envío
 *     $42.000 capital / $69.000 resto · instalación $67.000 capital /
 *     $92.000 resto (0 si auto-instala).
 *   - ACTIVACIÓN: primer mes del plan cobrado por adelantado (equivalente
 *     del "pago inicial incluye el primer mes" chileno).
 *   - PRECIOS FINALES (decisión 10-jul): el IVA NO existe en la experiencia
 *     del cliente — ni en el chat, ni en la cotización, ni en el cobro. El
 *     tratamiento tributario vive en la factura electrónica de GeoVictoria
 *     Colombia. Por eso IVA=0 en todo este motor (el campo `iva` queda por
 *     estructura, siempre 0).
 *
 * El mensajeParaProspecto va en REGISTRO DE USTED y formato COP. Es la única
 * fuente de precios que Vicky CO puede comunicar (misma regla dura de Chile).
 */

import { CATALOGO_MODULOS_CO } from "./catalogo"

const IVA = 0 // precios finales: sin IVA en la experiencia (decisión 10-jul)

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
    iva: 0,
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
  // Activación: primer mes del plan por adelantado.
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
  // Decisión de negocio (Lalo, 10-jul): en Colombia los precios son FINALES —
  // el IVA no existe en la experiencia (ni en el chat, ni en la cotización,
  // ni en el cobro). El tratamiento tributario vive en la factura electrónica.
  const filas: string[] = []
  filas.push("Le comparto el detalle de su cotización referencial:")
  filas.push("")
  filas.push("Mensualidad del servicio:")
  filas.push(`- Control de Asistencia (${userCount} usuario${userCount === 1 ? "" : "s"}): ${formatearCOP(plan)}/mes`)
  if (arriendoNeto > 0) {
    filas.push(
      `- Arriendo de reloj control: ${formatearCOP(arriendoNeto)}/mes (envío e instalación incluidos)`,
    )
  }
  filas.push(`Total mensual: ${formatearCOP(mensualTotal)}`)
  filas.push("")
  filas.push("Pago inicial (una sola vez):")
  for (const l of unicos) {
    filas.push(`- ${l.concepto}: ${formatearCOP(l.neto)}`)
  }
  filas.push(`Total pago inicial: ${formatearCOP(pagoInicialTotal)}`)
  filas.push("")
  filas.push(
    "La capacitación online, valorada en $95.000, va incluida con el 100% de descuento.",
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
      afectoIva: false,
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
      afectoIva: false,
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
        afectoIva: false,
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
          afectoIva: false,
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
