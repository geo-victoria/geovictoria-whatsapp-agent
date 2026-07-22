/**
 * Motor de cotización referencial de MÉXICO.
 *
 * Reglas de negocio (documento oficial de tropicalización MX):
 *   - Plan asistencia: 1-10 → $1,000 fijo · 11-20 → $83/usuario ·
 *     21-30 → $79/usuario · 31-50 → $75/usuario.
 *   - Reloj: renta $350/mes por unidad · venta $2,100 por unidad.
 *   - Envío (por punto, solo VENTA): $400, MISMA tarifa en todo México, no
 *     descontable. En renta $0.
 *   - Instalación (por punto): $700 SOLO si el punto está en CDMX o Zona
 *     Metropolitana del Valle de México ("cdmx_metro"); en RENTA dentro de
 *     esa zona es GRATIS (mismo trato que CO: renta = cero costos por
 *     punto en zona cubierta). FUERA de la zona la instalación profesional NO
 *     se cotiza acá: se deja NOTA de que el ejecutivo la cotiza aparte (o el
 *     cliente auto-instala gratis) — la venta nunca se frena.
 *   - CAPACITACIÓN online: $600 pago único y SE COBRA — va como ítem de
 *     servicio en TODA cotización (nunca "de regalo" como Chile/Colombia).
 *   - ACTIVACIÓN: primer mes del plan cobrado por adelantado (mismo patrón
 *     CL/CO).
 *   - IMPUESTOS: IVA 16% (¡no 19!) en TODOS los conceptos. Los totales
 *     mostrados al prospecto van CON el IVA incluido (neto + IVA = total).
 *
 * El mensajeParaProspecto va en TUTEO mexicano cálido y formato MXN
 * (es-MX: miles con coma). Es la única fuente de precios que Vicky MX puede
 * comunicar (misma regla dura de Chile).
 */

import { CATALOGO_MODULOS_MX } from "./catalogo"

// IVA mexicano: 16% parejo en todos los conceptos (plan, activación,
// capacitación, hardware, envío e instalación). Solo lo escribe este motor.
const IVA_MX = 0.16

export type ZonaMX = "cdmx_metro" | "resto"

export type PuntoInstalacionMX = {
  /** Ciudad/alcaldía/municipio como lo dijo el cliente (se transcribe, no se clasifica acá). */
  ubicacion: string
  zona: ZonaMX
  autoInstalada: boolean
}

export type CotizacionMXInput = {
  userCount: number
  reloj?: {
    modalidad: "arriendo" | "venta"
    cantidad: number
  }
  puntos?: PuntoInstalacionMX[]
}

export type LineaMX = {
  concepto: string
  detalle: string
  /** Monto neto en MXN. */
  neto: number
  /** IVA en MXN (16% en todos los conceptos). */
  iva: number
  recurrente: boolean
}

/**
 * Item en el contrato del endpoint create-from-vicky-mx del cotizador
 * (misma forma que el CO). En México NO existe la Activación (ni acá ni en
 * el endpoint: la mensualidad se factura desde la activación del servicio).
 * La Capacitación SÍ se envía: es un ítem cobrado, no una línea de regalo.
 */
export type ItemCotizadorMX = {
  tipo: "plan" | "hardware" | "servicio"
  id: string
  nombre: string
  descripcion?: string
  modalidad: "Por usuario" | "Fijo" | "Renta mensual" | "Venta única" | "Cobro único"
  cantidad: number
  precioUnitarioMXN: number
  subtotalMXN: number
  esRecurrente: boolean
  afectoIva: boolean
}

const TARIFAS_MX = {
  relojArriendoMes: 350,
  relojVenta: 2100,
  /** Envío por punto en VENTA — tarifa única nacional (no depende de zona). */
  envioVentaPunto: 400,
  /** Instalación por punto — SOLO CDMX/Zona Metropolitana. */
  instalacionCdmxMetro: 700,
  /** Capacitación online — pago único, SIEMPRE cobrada. */
  capacitacionOnline: 600,
} as const

export function formatearMXN(monto: number): string {
  return "$" + Math.round(monto).toLocaleString("es-MX")
}

/** Tier del plan aplicable a un userCount (para detalle e items). */
function tierPlanMX(userCount: number) {
  const asistencia = CATALOGO_MODULOS_MX.find((m) => m.id === "asistencia")
  if (!asistencia) throw new Error("Catálogo MX sin módulo asistencia")
  const tier = asistencia.tiers.find(
    (t) => userCount >= t.minUsuarios && userCount <= t.maxUsuarios,
  )
  if (!tier) {
    throw new Error(
      `El plan de México cubre de 1 a 50 usuarios (pedidos: ${userCount}). Sobre 50, derivar a un ejecutivo.`,
    )
  }
  return tier
}

/** Precio mensual del plan de asistencia (MXN neto, sin IVA). Lanza fuera de 1-50. */
export function precioPlanMX(userCount: number): number {
  const tier = tierPlanMX(userCount)
  return tier.modalidad === "fijo" ? tier.precioUF : tier.precioUF * userCount
}

export function cotizarMX(input: CotizacionMXInput): {
  lineas: LineaMX[]
  itemsCotizador: ItemCotizadorMX[]
  mensualNetoPlan: number
  mensualArriendoNeto: number
  mensualArriendoIva: number
  mensualIva: number
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
  const tier = tierPlanMX(userCount)
  const plan = precioPlanMX(userCount)
  const lineas: LineaMX[] = []

  // ── Recurrente ──
  lineas.push({
    concepto: "Control de Asistencia",
    detalle:
      tier.modalidad === "fijo"
        ? `Plan mensual para hasta 10 usuarios (tarifa fija)`
        : `Plan mensual: ${userCount} usuarios × ${formatearMXN(tier.precioUF)}`,
    neto: plan,
    iva: plan * IVA_MX,
    recurrente: true,
  })

  let arriendoNeto = 0
  if (reloj && reloj.modalidad === "arriendo" && reloj.cantidad > 0) {
    arriendoNeto = TARIFAS_MX.relojArriendoMes * reloj.cantidad
    lineas.push({
      concepto: "Renta de reloj checador",
      detalle: `${reloj.cantidad} × ${formatearMXN(TARIFAS_MX.relojArriendoMes)}/mes (envío incluido sin costo; instalación sin costo en CDMX y Zona Metropolitana)`,
      neto: arriendoNeto,
      iva: arriendoNeto * IVA_MX,
      recurrente: true,
    })
  }

  // ── Agrupación de puntos por ubicación/zona (feedback CO 15-jul heredado:
  // con varios relojes, envío e instalación se TOTALIZAN por ubicación con
  // cantidad — nada de una fila por reloj). Sirve a venta y renta.
  const grupos = new Map<
    string,
    { ubicacion: string; zona: ZonaMX; envios: number; instalaciones: number }
  >()
  for (const punto of puntos) {
    const key = `${punto.ubicacion}|${punto.zona}`
    const g = grupos.get(key) || { ubicacion: punto.ubicacion, zona: punto.zona, envios: 0, instalaciones: 0 }
    g.envios++
    if (!punto.autoInstalada) g.instalaciones++
    grupos.set(key, g)
  }

  // Notas de instalación fuera de zona (venta o renta): la instalación
  // profesional NO se cotiza acá — la cotiza el ejecutivo aparte, o el
  // cliente auto-instala gratis. La venta nunca se frena por esto.
  const notasEjecutivo: string[] = []
  if (reloj && reloj.cantidad > 0) {
    for (const g of grupos.values()) {
      if (g.zona === "resto" && g.instalaciones > 0) {
        notasEjecutivo.push(
          `La instalación profesional en ${g.ubicacion} queda fuera de CDMX y su Zona Metropolitana: tu ejecutivo te la cotiza aparte. También puedes instalarlo tú sin costo — es sencillo y te guiamos.`,
        )
      }
    }
  }

  // ── Pago único ──
  // SIN Activación: en la tropicalización MX no existe el primer mes por
  // adelantado (a diferencia de CL/CO) — el documento oficial no la lista y la
  // cotización formal tampoco la cobra ("la mensualidad se factura desde la
  // activación del servicio"). Detectado 22-jul: el preform del chat la
  // cobraba y contradecía al PDF formal.
  // Capacitación online: ítem COBRADO en toda cotización (diferencia con
  // Chile/Colombia — acá nunca es de regalo).
  lineas.push({
    concepto: "Capacitación online",
    detalle: "Curso online de uso de la plataforma (pago único)",
    neto: TARIFAS_MX.capacitacionOnline,
    iva: TARIFAS_MX.capacitacionOnline * IVA_MX,
    recurrente: false,
  })

  if (reloj && reloj.modalidad === "venta" && reloj.cantidad > 0) {
    const ventaNeto = TARIFAS_MX.relojVenta * reloj.cantidad
    lineas.push({
      concepto: "Reloj checador (compra)",
      detalle: `${reloj.cantidad} × ${formatearMXN(TARIFAS_MX.relojVenta)}`,
      neto: ventaNeto,
      iva: ventaNeto * IVA_MX,
      recurrente: false,
    })
    for (const g of grupos.values()) {
      const envio = TARIFAS_MX.envioVentaPunto
      lineas.push({
        concepto: `Envío de reloj (${g.ubicacion})${g.envios > 1 ? ` × ${g.envios}` : ""}`,
        detalle:
          g.envios > 1
            ? `Tarifa única nacional — ${g.envios} × ${formatearMXN(envio)}`
            : "Tarifa única nacional",
        neto: envio * g.envios,
        iva: envio * g.envios * IVA_MX,
        recurrente: false,
      })
      if (g.zona === "cdmx_metro" && g.instalaciones > 0) {
        const inst = TARIFAS_MX.instalacionCdmxMetro
        lineas.push({
          concepto: `Instalación de reloj (${g.ubicacion})${g.instalaciones > 1 ? ` × ${g.instalaciones}` : ""}`,
          detalle:
            g.instalaciones > 1
              ? `CDMX / Zona Metropolitana — ${g.instalaciones} × ${formatearMXN(inst)}`
              : "CDMX / Zona Metropolitana",
          neto: inst * g.instalaciones,
          iva: inst * g.instalaciones * IVA_MX,
          recurrente: false,
        })
      }
      // zona "resto" con instalación pedida → sin línea (nota del ejecutivo).
    }
  }

  // ── Totales (los mostrados van CON IVA 16% incluido) ──
  const unicos = lineas.filter((l) => !l.recurrente)
  const pagoInicialNeto = unicos.reduce((s, l) => s + l.neto, 0)
  const pagoInicialIva = unicos.reduce((s, l) => s + l.iva, 0)
  const pagoInicialTotal = pagoInicialNeto + pagoInicialIva
  const mensualArriendoIva = arriendoNeto * IVA_MX
  const mensualNeto = plan + arriendoNeto
  const mensualIva = mensualNeto * IVA_MX
  const mensualTotal = mensualNeto + mensualIva

  // ── Mensaje canónico (tuteo mexicano, MXN es-MX) ──
  // Cada línea va en neto; los TOTALES muestran el IVA 16% incluido.
  const filas: string[] = []
  filas.push("Te comparto el detalle de tu cotización referencial (precios en pesos mexicanos):")
  filas.push("")
  filas.push("Mensualidad del servicio:")
  filas.push(`- Control de Asistencia (${userCount} usuario${userCount === 1 ? "" : "s"}): ${formatearMXN(plan)}/mes`)
  if (arriendoNeto > 0) {
    filas.push(
      `- Renta de reloj checador: ${formatearMXN(arriendoNeto)}/mes (envío incluido sin costo; instalación sin costo en CDMX y Zona Metropolitana)`,
    )
  }
  filas.push(`Total mensual: ${formatearMXN(mensualNeto)} + IVA (16%) = ${formatearMXN(mensualTotal)} MXN`)
  filas.push("")
  filas.push("Pago inicial (una sola vez):")
  for (const l of unicos) {
    filas.push(`- ${l.concepto}: ${formatearMXN(l.neto)}`)
  }
  filas.push(
    `Total pago inicial: ${formatearMXN(pagoInicialNeto)} + IVA (16%) = ${formatearMXN(pagoInicialTotal)} MXN`,
  )
  for (const nota of notasEjecutivo) {
    filas.push("")
    filas.push(`Nota: ${nota}`)
  }

  // ── Items para la cotización FORMAL (contrato create-from-vicky-mx) ──
  // Misma matemática que las líneas de arriba, en formato del endpoint. Sin
  // Activación (no existe en MX); la Capacitación SÍ va (ítem cobrado). Todo
  // afecto a IVA 16%.
  const itemsCotizador: ItemCotizadorMX[] = []
  itemsCotizador.push({
    tipo: "plan",
    id: "plan_asistencia",
    nombre: "Control de Asistencia",
    descripcion:
      "Marcaje web, app móvil con GPS y biometría. Gestión de turnos, vacaciones y horas extra. Reportería en línea.",
    modalidad: tier.modalidad === "fijo" ? "Fijo" : "Por usuario",
    cantidad: tier.modalidad === "fijo" ? 1 : userCount,
    precioUnitarioMXN: tier.modalidad === "fijo" ? plan : tier.precioUF,
    subtotalMXN: plan,
    esRecurrente: true,
    afectoIva: true,
  })
  if (reloj && reloj.modalidad === "arriendo" && reloj.cantidad > 0) {
    itemsCotizador.push({
      tipo: "hardware",
      id: "reloj_arriendo",
      nombre: "Renta de reloj checador",
      descripcion:
        "Reloj biométrico de control de asistencia (facial y huella), con conexión WiFi y Ethernet. Envío incluido sin costo; instalación sin costo en CDMX y Zona Metropolitana.",
      modalidad: "Renta mensual",
      cantidad: reloj.cantidad,
      precioUnitarioMXN: TARIFAS_MX.relojArriendoMes,
      subtotalMXN: arriendoNeto,
      esRecurrente: true,
      afectoIva: true,
    })
  }
  // Capacitación online: ítem de servicio cobrado en TODA cotización.
  itemsCotizador.push({
    tipo: "servicio",
    id: "capacitacion_online",
    nombre: "Capacitación online",
    descripcion: "Curso online de uso de la plataforma (pago único).",
    modalidad: "Cobro único",
    cantidad: 1,
    precioUnitarioMXN: TARIFAS_MX.capacitacionOnline,
    subtotalMXN: TARIFAS_MX.capacitacionOnline,
    esRecurrente: false,
    afectoIva: true,
  })
  if (reloj && reloj.modalidad === "venta" && reloj.cantidad > 0) {
    itemsCotizador.push({
      tipo: "hardware",
      id: "reloj_venta",
      nombre: "Reloj checador (compra)",
      descripcion:
        "Reloj biométrico de control de asistencia (facial y huella), con conexión WiFi y Ethernet.",
      modalidad: "Venta única",
      cantidad: reloj.cantidad,
      precioUnitarioMXN: TARIFAS_MX.relojVenta,
      subtotalMXN: TARIFAS_MX.relojVenta * reloj.cantidad,
      esRecurrente: false,
      afectoIva: true,
    })
    // Misma totalización por ubicación/zona que en las líneas del mensaje.
    for (const g of grupos.values()) {
      const envio = TARIFAS_MX.envioVentaPunto
      itemsCotizador.push({
        tipo: "servicio",
        id: "envio_reloj",
        nombre: `Envío de reloj (${g.ubicacion})`,
        modalidad: "Cobro único",
        cantidad: g.envios,
        precioUnitarioMXN: envio,
        subtotalMXN: envio * g.envios,
        esRecurrente: false,
        afectoIva: true,
      })
      if (g.zona === "cdmx_metro" && g.instalaciones > 0) {
        const inst = TARIFAS_MX.instalacionCdmxMetro
        itemsCotizador.push({
          tipo: "servicio",
          id: "instalacion_reloj",
          nombre: `Instalación de reloj (${g.ubicacion})`,
          modalidad: "Cobro único",
          cantidad: g.instalaciones,
          precioUnitarioMXN: inst,
          subtotalMXN: inst * g.instalaciones,
          esRecurrente: false,
          afectoIva: true,
        })
      }
      // zona "resto": la instalación profesional NO viaja como ítem — la
      // cotiza el ejecutivo aparte (queda en la nota del mensaje).
    }
  }

  return {
    lineas,
    itemsCotizador,
    mensualNetoPlan: plan,
    mensualArriendoNeto: arriendoNeto,
    mensualArriendoIva,
    mensualIva,
    mensualTotal,
    pagoInicialNeto,
    pagoInicialIva,
    pagoInicialTotal,
    mensajeParaProspecto: filas.join("\n"),
  }
}
