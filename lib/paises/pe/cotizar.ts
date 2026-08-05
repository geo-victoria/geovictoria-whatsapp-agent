/**
 * Motor de cotización referencial de PERÚ.
 *
 * Reglas de negocio (excel Tropicalizacion_Vicky_2, 04-ago):
 *   - Plan asistencia: 1-10 → S/100 fijo · 11-20 → S/200 fijo ·
 *     21-50 → S/5/usuario. (Anomalía 21+ documentada en pe/catalogo.ts:
 *     literal del excel, aprobada.)
 *   - Reloj: arriendo S/70/mes por unidad · venta S/525 por unidad.
 *   - Envío: S/0 SIEMPRE (todo Perú, ambas modalidades) — no se emite línea.
 *   - Instalación: LIMA sin costo (incluida). FUERA de Lima NO se cotiza:
 *     "se coordina con servicio técnico, se cotiza aparte" — nota al
 *     prospecto + flag para que la capa de tools avise a
 *     ssttperu@geovictoria.pro. La venta nunca se frena.
 *   - Capacitación: NO existe en Perú (ni cobrada ni de regalo).
 *   - PAGO INICIAL (patrón CL/CO): pagos únicos (reloj en venta) + PRIMER
 *     MES del plan por adelantado, todo neto + IGV. Luego facturación
 *     mensual según usuarios activos.
 *   - IMPUESTOS: IGV 18% en TODOS los conceptos (los fijos también). Los
 *     totales al prospecto van CON IGV (neto + IGV = total).
 *   - DESCUENTO (único, herramienta de CIERRE — jamás proactivo): 20% en
 *     las 4 primeras facturas. Con descuento, el primer mes del pago
 *     inicial ya va al 20%; facturas 2-4 con 20%; desde la 5ª, lista.
 *
 * El mensajeParaProspecto va en peruano neutro (tuteo cordial) y formato
 * PEN ("S/318.60"). Es la única fuente de precios que Vicky PE comunica.
 *
 * Ejemplo CONFIRMADO por Lalo (04-ago): 15 personas + reloj arriendo Lima =
 * S/270 neto → S/318.60/mes con IGV; con descuento S/254.88 las primeras 4.
 */

import { CATALOGO_MODULOS_PE, ESCALERA_DESCUENTO_PE } from "./catalogo.ts"

// IGV peruano: 18% parejo en todos los conceptos. Solo lo escribe este motor.
const IGV_PE = 0.18

export type ZonaPE = "lima" | "provincias"

export type PuntoInstalacionPE = {
  /** Ciudad/distrito como lo dijo el cliente (se transcribe, no se clasifica acá). */
  ubicacion: string
  zona: ZonaPE
  autoInstalada: boolean
}

export type CotizacionPEInput = {
  userCount: number
  reloj?: {
    modalidad: "arriendo" | "venta"
    cantidad: number
  }
  puntos?: PuntoInstalacionPE[]
  /** true si el cliente ACEPTÓ el 20% de cierre (4 primeras facturas). */
  conDescuentoCierre?: boolean
}

export type LineaPE = {
  concepto: string
  detalle: string
  /** Monto neto en PEN. */
  neto: number
  /** IGV en PEN (18% en todos los conceptos). */
  igv: number
  recurrente: boolean
}

/**
 * Item en el contrato del endpoint create-from-vicky-pe del cotizador
 * (misma forma que CO/MX). El envío nunca viaja (S/0); la instalación solo
 * viaja como nota cuando el punto está fuera de Lima (sin ítem). La fila de
 * ACTIVACIÓN (primer mes por adelantado) la agrega el endpoint, patrón CO.
 */
export type ItemCotizadorPE = {
  tipo: "plan" | "hardware" | "servicio"
  id: string
  nombre: string
  descripcion?: string
  modalidad: "Por usuario" | "Fijo" | "Arriendo mensual" | "Venta única" | "Cobro único"
  cantidad: number
  precioUnitarioPEN: number
  subtotalPEN: number
  esRecurrente: boolean
  afectoIgv: boolean
}

const TARIFAS_PE = {
  relojArriendoMes: 70,
  relojVenta: 525,
} as const

/** "S/318.60" · "S/270" — soles con 2 decimales solo si hay fracción. */
export function formatearPEN(monto: number): string {
  const r = Math.round(monto * 100) / 100
  return "S/" + (Number.isInteger(r) ? r.toLocaleString("es-PE") : r.toFixed(2))
}

/** Tier del plan aplicable a un userCount (para detalle e items). */
function tierPlanPE(userCount: number) {
  const asistencia = CATALOGO_MODULOS_PE.find((m) => m.id === "asistencia")
  if (!asistencia) throw new Error("Catálogo PE sin módulo asistencia")
  const tier = asistencia.tiers.find(
    (t) => userCount >= t.minUsuarios && userCount <= t.maxUsuarios,
  )
  if (!tier) {
    throw new Error(
      `El plan de Perú cubre de 1 a 50 usuarios (pedidos: ${userCount}). Sobre 50, derivar a un ejecutivo.`,
    )
  }
  return tier
}

/** Precio mensual del plan (PEN neto, sin IGV). Lanza fuera de 1-50. */
export function precioPlanPE(userCount: number): number {
  const tier = tierPlanPE(userCount)
  return tier.modalidad === "fijo" ? tier.precioUF : tier.precioUF * userCount
}

export function cotizarPE(input: CotizacionPEInput): {
  lineas: LineaPE[]
  itemsCotizador: ItemCotizadorPE[]
  mensualNetoPlan: number
  mensualArriendoNeto: number
  mensualNeto: number
  mensualIgv: number
  mensualTotal: number
  /** Total mensual de las primeras 4 facturas si aplica el 20% (0 si no). */
  mensualTotalConDescuento: number
  pagoInicialNeto: number
  pagoInicialIgv: number
  pagoInicialTotal: number
  /** true si algún punto quedó fuera de Lima con instalación pedida:
   *  la capa de tools debe avisar a ssttperu@geovictoria.pro. */
  avisoSsttPeru: boolean
  mensajeParaProspecto: string
} {
  const { userCount, reloj, puntos = [], conDescuentoCierre = false } = input
  if (!Number.isFinite(userCount) || userCount < 1) {
    throw new Error("userCount inválido")
  }
  const tier = tierPlanPE(userCount)
  const plan = precioPlanPE(userCount)
  const lineas: LineaPE[] = []

  // ── Recurrente ──
  lineas.push({
    concepto: "Control de Asistencia",
    detalle:
      tier.modalidad === "fijo"
        ? `Plan mensual (tarifa fija del tramo ${tier.minUsuarios}-${tier.maxUsuarios} usuarios)`
        : `Plan mensual: ${userCount} usuarios × ${formatearPEN(tier.precioUF)}`,
    neto: plan,
    igv: plan * IGV_PE,
    recurrente: true,
  })

  let arriendoNeto = 0
  if (reloj && reloj.modalidad === "arriendo" && reloj.cantidad > 0) {
    arriendoNeto = TARIFAS_PE.relojArriendoMes * reloj.cantidad
    lineas.push({
      concepto: "Arriendo de reloj de control",
      detalle: `${reloj.cantidad} × ${formatearPEN(TARIFAS_PE.relojArriendoMes)}/mes (envío sin costo; instalación sin costo en Lima)`,
      neto: arriendoNeto,
      igv: arriendoNeto * IGV_PE,
      recurrente: true,
    })
  }

  // ── Agrupación de puntos por ubicación/zona (patrón CO/MX heredado) ──
  const grupos = new Map<
    string,
    { ubicacion: string; zona: ZonaPE; instalaciones: number }
  >()
  for (const punto of puntos) {
    const key = `${punto.ubicacion}|${punto.zona}`
    const g = grupos.get(key) || { ubicacion: punto.ubicacion, zona: punto.zona, instalaciones: 0 }
    if (!punto.autoInstalada) g.instalaciones++
    grupos.set(key, g)
  }

  // Instalación fuera de Lima: NO se cotiza — texto oficial del excel + aviso
  // interno al servicio técnico (lo dispara la capa de tools con este flag).
  const notasEjecutivo: string[] = []
  let avisoSsttPeru = false
  if (reloj && reloj.cantidad > 0) {
    for (const g of grupos.values()) {
      if (g.zona === "provincias" && g.instalaciones > 0) {
        avisoSsttPeru = true
        notasEjecutivo.push(
          `La instalación en ${g.ubicacion} se coordina con nuestro servicio técnico y se cotiza aparte (te contactarán para agendarla). También puedes instalarlo tú sin costo — es sencillo y te guiamos.`,
        )
      }
    }
  }

  // ── Pago único ──
  // Envío: S/0 siempre → sin línea. Instalación Lima: S/0 (incluida) → sin
  // línea. Capacitación: no existe en Perú. Solo el reloj en VENTA genera
  // pago único de catálogo; la ACTIVACIÓN (primer mes adelantado) se suma
  // como concepto del pago inicial (patrón CL/CO).
  let ventaNeto = 0
  if (reloj && reloj.modalidad === "venta" && reloj.cantidad > 0) {
    ventaNeto = TARIFAS_PE.relojVenta * reloj.cantidad
    lineas.push({
      concepto: "Reloj de control (compra)",
      detalle: `${reloj.cantidad} × ${formatearPEN(TARIFAS_PE.relojVenta)} (envío sin costo; instalación sin costo en Lima)`,
      neto: ventaNeto,
      igv: ventaNeto * IGV_PE,
      recurrente: false,
    })
  }

  // ── Totales (mostrados CON IGV 18%) ──
  const mensualNeto = plan + arriendoNeto
  const mensualIgv = mensualNeto * IGV_PE
  const mensualTotal = mensualNeto + mensualIgv
  // Descuento de cierre: 20% sobre el plan mensual COMPLETO (plan + arriendo)
  // en las 4 primeras facturas — el ejemplo confirmado (S/270 → S/254.88)
  // aplica el 20% al total mensual, arriendo incluido.
  const pctDescuento = ESCALERA_DESCUENTO_PE.planMensual[0]
  const mensualTotalConDescuento = conDescuentoCierre
    ? mensualNeto * (1 - pctDescuento) * (1 + IGV_PE)
    : 0
  // Pago inicial = pagos únicos + PRIMER MES por adelantado (con descuento si
  // el cliente lo aceptó: la primera factura ES parte de las 4).
  const primerMesNeto = conDescuentoCierre ? mensualNeto * (1 - pctDescuento) : mensualNeto
  const pagoInicialNeto = ventaNeto + primerMesNeto
  const pagoInicialIgv = pagoInicialNeto * IGV_PE
  const pagoInicialTotal = pagoInicialNeto + pagoInicialIgv

  // ── Mensaje canónico (peruano neutro, PEN) ──
  const filas: string[] = []
  filas.push("Te comparto el detalle de tu cotización referencial (precios en soles):")
  filas.push("")
  filas.push("Mensualidad del servicio:")
  filas.push(
    `- Control de Asistencia (${userCount} usuario${userCount === 1 ? "" : "s"}): ${formatearPEN(plan)}/mes`,
  )
  if (arriendoNeto > 0) {
    filas.push(
      `- Arriendo de reloj de control: ${formatearPEN(arriendoNeto)}/mes (envío sin costo; instalación sin costo en Lima)`,
    )
  }
  filas.push(
    `Total mensual: ${formatearPEN(mensualNeto)} + IGV (18%) = ${formatearPEN(mensualTotal)}/mes`,
  )
  if (conDescuentoCierre) {
    filas.push(
      `Con el 20% de descuento en tus 4 primeras facturas: ${formatearPEN(mensualTotalConDescuento)}/mes (desde la 5ª factura, ${formatearPEN(mensualTotal)}/mes)`,
    )
  }
  filas.push("")
  filas.push("Pago inicial (al aceptar):")
  if (ventaNeto > 0) filas.push(`- Reloj de control (compra): ${formatearPEN(ventaNeto)}`)
  filas.push(`- Primer mes del plan por adelantado: ${formatearPEN(primerMesNeto)}`)
  filas.push(
    `Total pago inicial: ${formatearPEN(pagoInicialNeto)} + IGV (18%) = ${formatearPEN(pagoInicialTotal)}`,
  )
  for (const nota of notasEjecutivo) {
    filas.push("")
    filas.push(`Nota: ${nota}`)
  }

  // ── Items para la cotización FORMAL (contrato create-from-vicky-pe) ──
  // Misma matemática que las líneas, en formato del endpoint. La Activación
  // (primer mes adelantado) la agrega el endpoint (patrón CO). El descuento
  // viaja por escalonDescuento, no en los items.
  const itemsCotizador: ItemCotizadorPE[] = []
  itemsCotizador.push({
    tipo: "plan",
    id: "plan_asistencia",
    nombre: "Control de Asistencia",
    descripcion:
      "Marcaje web, app móvil con GPS y biometría. Gestión de turnos, vacaciones y horas extra. Reportería en línea.",
    modalidad: tier.modalidad === "fijo" ? "Fijo" : "Por usuario",
    cantidad: tier.modalidad === "fijo" ? 1 : userCount,
    precioUnitarioPEN: tier.modalidad === "fijo" ? plan : tier.precioUF,
    subtotalPEN: plan,
    esRecurrente: true,
    afectoIgv: true,
  })
  if (reloj && reloj.modalidad === "arriendo" && reloj.cantidad > 0) {
    itemsCotizador.push({
      tipo: "hardware",
      id: "reloj_arriendo",
      nombre: "Arriendo de reloj de control",
      descripcion:
        "Reloj biométrico de control de asistencia (facial y huella), con conexión WiFi y Ethernet. Envío sin costo; instalación sin costo en Lima.",
      modalidad: "Arriendo mensual",
      cantidad: reloj.cantidad,
      precioUnitarioPEN: TARIFAS_PE.relojArriendoMes,
      subtotalPEN: arriendoNeto,
      esRecurrente: true,
      afectoIgv: true,
    })
  }
  if (reloj && reloj.modalidad === "venta" && reloj.cantidad > 0) {
    itemsCotizador.push({
      tipo: "hardware",
      id: "reloj_venta",
      nombre: "Reloj de control (compra)",
      descripcion:
        "Reloj biométrico de control de asistencia (facial y huella), con conexión WiFi y Ethernet. Envío sin costo; instalación sin costo en Lima.",
      modalidad: "Venta única",
      cantidad: reloj.cantidad,
      precioUnitarioPEN: TARIFAS_PE.relojVenta,
      subtotalPEN: ventaNeto,
      esRecurrente: false,
      afectoIgv: true,
    })
  }
  // Envío S/0 e instalación Lima S/0: sin ítems. Fuera de Lima: sin ítem —
  // queda en la nota del mensaje + avisoSsttPeru para el correo interno.

  return {
    lineas,
    itemsCotizador,
    mensualNetoPlan: plan,
    mensualArriendoNeto: arriendoNeto,
    mensualNeto,
    mensualIgv,
    mensualTotal,
    mensualTotalConDescuento,
    pagoInicialNeto,
    pagoInicialIgv,
    pagoInicialTotal,
    avisoSsttPeru,
    mensajeParaProspecto: filas.join("\n"),
  }
}
