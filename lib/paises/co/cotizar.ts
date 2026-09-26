/**
 * Cotización referencial de COLOMBIA = el MOTOR ÚNICO (lib/cotizacion/motor.ts)
 * con los datos de Colombia (26-sep, paso 2 de la unificación). La lógica ya
 * no vive acá: este archivo declara las reglas del país y traduce la forma del
 * resultado a la que esperan las tools y el cotizador (campos en COP).
 *
 * Datos de Colombia:
 *   - Plan: 1-10 → $315.000 fijo · 11-20 → $13.700 por usuario (catálogo).
 *     RANGO DE VICKY = 1-20; el 21-50 del catálogo es solo excepción.
 *   - Equipo biométrico: alquiler $86.000/mes en la base (Bogotá y
 *     conurbados), $98.000/mes fuera (despacho incluido); venta $620.000.
 *   - Envío en venta por punto: $42.000 base / $69.000 fuera.
 *   - Instalación por punto: $175.000 base / $530.000 intermedia / $875.000
 *     resto; en ALQUILER en la base va BONIFICADA.
 *   - IMPUESTOS: precios FINALES en todo salvo el equipo (arriendo y venta),
 *     que lleva IVA 19 % y se declara ("incluye el IVA del equipo").
 *   - Descuento = Chile: 10 → 20 % solo en el plan, 6 meses.
 *   - Capacitación online de regalo (se menciona, no es ítem).
 *   - PAGO INICIAL = pagos únicos + PRIMER MES (plan con su descuento +
 *     alquiler), igual que el cotizador. La fila "Activación" ya no existe.
 */

import { CATALOGO_MODULOS_CO } from "./catalogo.ts"
import type { ZonaCO } from "./geografia.ts"
export type { ZonaCO } from "./geografia.ts"
import { ESCALERA_DESCUENTO_CO } from "./descuento.ts"
import { cotizar, precioPlan, tierPlan, unirPartes, type ReglasMotor, type TierPlan, type ZonaMotor } from "../../cotizacion/motor.ts"

// Solo el hardware (equipo en alquiler y en venta) lleva IVA 19 %.
const IVA_HARDWARE = 0.19

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
  /** Escalón de descuento del PLAN: 0 = sin descuento, 1 = 10 %, 2 = 20 %. */
  escalonDescuento?: number
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

/** Item en el contrato del endpoint create-from-vicky-co del cotizador. */
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
  /** % de descuento de la línea (100 = bonificada: se muestra tachada en $0). */
  descuentoPct?: number
}

export const TARIFAS_CO = {
  relojArriendoMes: 86000,
  /** Alquiler fuera de la base (intermedia y resto), despacho incluido. */
  relojArriendoMesFuera: 98000,
  relojVenta: 620000,
  /** Envío por equipo en VENTA: base / fuera de la base. */
  envioVenta: { capital: 42000, fuera: 69000 },
  /** Instalación técnica por punto = 1 / 3 / 5 UF chilenas en pesos. */
  instalacion: { capital: 175000, intermedia: 530000, resto: 875000 },
} as const

export function formatearCOP(monto: number): string {
  return "$" + Math.round(monto).toLocaleString("es-CO")
}

function tiersCO(): readonly TierPlan[] {
  const asistencia = CATALOGO_MODULOS_CO.find((m) => m.id === "asistencia")
  if (!asistencia) throw new Error("Catálogo CO sin módulo asistencia")
  return asistencia.tiers as TierPlan[]
}

const ZONA_MOTOR: Record<ZonaCO, ZonaMotor> = { capital: "base", intermedia: "intermedia", resto: "resto" }

export const REGLAS_CO: ReglasMotor = {
  nombrePais: "de Colombia",
  get tiers() {
    return tiersCO()
  },
  escalera: ESCALERA_DESCUENTO_CO,
  decimales: 0,
  redondearPlanConDescuento: true,
  formatear: formatearCOP,
  impuesto: { tasa: IVA_HARDWARE, soloEquipo: true },
  presentacion: "final",
  sufijo: "",
  tarifas: {
    arriendoBase: TARIFAS_CO.relojArriendoMes,
    arriendoFuera: TARIFAS_CO.relojArriendoMesFuera,
    venta: TARIFAS_CO.relojVenta,
    envioVenta: { base: TARIFAS_CO.envioVenta.capital, fuera: TARIFAS_CO.envioVenta.fuera },
    instalacion: { base: TARIFAS_CO.instalacion.capital, intermedia: TARIFAS_CO.instalacion.intermedia, resto: TARIFAS_CO.instalacion.resto },
  },
  textos: {
    equipo: "equipo",
    modalidadArriendo: "Equipo biométrico en alquiler",
    modalidadVenta: "Equipo biométrico en compra",
    envioIncluido: " El despacho del equipo va incluido.",
    bonificadaEn: "(alquiler en Bogotá y alrededores)",
    detallePagoInicial: (v, e, i) => {
      const partes = [v ? "equipo con IVA" : "", e ? "envío" : "", i ? "instalación" : ""].filter(Boolean)
      return partes.length ? ` (${unirPartes(partes)})` : ""
    },
    notasFinales: ["La capacitación online (valorada en $95.000) va incluida sin costo 🎁"],
    lineaArriendo: "Alquiler de equipo biométrico",
    lineaArriendoFuera: "fuera de Bogotá",
    lineaDespacho: "despacho",
    lineaVenta: "Equipo biométrico (compra)",
    lineaEnvio: (u) => `Envío de equipo biométrico (${u})`,
    lineaInstalacion: (u) => `Instalación técnica del equipo (${u})`,
    zonaBaseEnvio: "Bogotá y alrededores",
    zonaFueraEnvio: "fuera de Bogotá",
    bonificadaDetalle: "bonificada en alquiler (Bogotá y alrededores)",
    idArriendo: "reloj_arriendo",
    idVenta: "reloj_venta",
    modalidadItemArriendo: "Arriendo mensual",
    itemArriendo: "Alquiler de equipo biométrico",
    itemArriendoFuera: "Alquiler de equipo biométrico (fuera de Bogotá, despacho incluido)",
    descArriendo: "Equipo biométrico de control de asistencia (facial y huella), con conexión WiFi y Ethernet. Despacho incluido.",
    itemVenta: "Equipo biométrico (compra)",
    descVenta: "Equipo biométrico de control de asistencia (facial y huella), con conexión WiFi y Ethernet.",
    itemEnvio: (u) => `Envío de equipo biométrico (${u})`,
    itemInstalacion: (u) => `Instalación técnica del equipo (${u})`,
    descInstalacionBonificada: "Visita de instalación por nuestro equipo técnico. Bonificada en alquiler en Bogotá y alrededores.",
    descInstalacionCobrada: "Visita de instalación por nuestro equipo técnico. Pago único.",
  },
}

/** Tramo del plan de asistencia CO para una dotación (fuente única: el catálogo). */
export function tierPlanCO(userCount: number): { modalidad: "fijo" | "por_usuario"; precioUF: number } {
  const t = tierPlan(REGLAS_CO, userCount)
  return { modalidad: t.modalidad, precioUF: t.precioUF }
}

/** Precio mensual del plan de asistencia (COP, sin IVA). Lanza fuera de 1-50. */
export function precioPlanCO(userCount: number): number {
  return precioPlan(REGLAS_CO, userCount)
}

export function cotizarCO(input: CotizacionCOInput): {
  lineas: LineaCO[]
  itemsCotizador: ItemCotizadorCO[]
  /** Plan del mes con el descuento del escalón. */
  mensualNetoPlan: number
  mensualArriendoNeto: number
  mensualArriendoIva: number
  mensualTotal: number
  /** Mensualidad a precio de LISTA (= mensualTotal cuando no hay descuento). */
  mensualTotalLista: number
  pagoInicialNeto: number
  pagoInicialIva: number
  pagoInicialTotal: number
  /** % de descuento del plan aplicado (0 · 0,1 · 0,2) y su escalón. */
  descuentoPct: number
  escalonDescuento: number
  mensajeParaProspecto: string
} {
  const r = cotizar(REGLAS_CO, {
    userCount: input.userCount,
    reloj: input.reloj,
    puntos: (input.puntos || []).map((p) => ({ ubicacion: p.ubicacion, zona: ZONA_MOTOR[p.zona] || "resto", autoInstalada: p.autoInstalada })),
    escalonDescuento: input.escalonDescuento,
  })
  return {
    lineas: r.lineas.map((l) => ({ concepto: l.concepto, detalle: l.detalle, neto: l.neto, iva: l.impuesto, recurrente: l.recurrente })),
    itemsCotizador: r.items.map((it) => ({
      tipo: it.tipo,
      id: it.id,
      nombre: it.nombre,
      ...(it.descripcion !== undefined ? { descripcion: it.descripcion } : {}),
      modalidad: it.modalidad as ItemCotizadorCO["modalidad"],
      cantidad: it.cantidad,
      precioUnitarioCOP: it.precioUnitario,
      subtotalCOP: it.subtotal,
      esRecurrente: it.esRecurrente,
      afectoIva: it.afectoImpuesto,
      ...(it.descuentoPct !== undefined ? { descuentoPct: it.descuentoPct } : {}),
    })),
    mensualNetoPlan: r.plan,
    mensualArriendoNeto: r.arriendoNeto,
    mensualArriendoIva: r.arriendoImpuesto,
    mensualTotal: r.mensualNeto + r.mensualImpuesto,
    mensualTotalLista: r.mensualNetoLista + r.mensualImpuestoLista,
    pagoInicialNeto: r.pagoInicialNeto,
    pagoInicialIva: r.pagoInicialImpuesto,
    pagoInicialTotal: r.pagoInicialTotal,
    descuentoPct: r.descuentoPct,
    escalonDescuento: r.escalonDescuento,
    mensajeParaProspecto: r.mensaje,
  }
}
