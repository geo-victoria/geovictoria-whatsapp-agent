/**
 * Cotización referencial de MÉXICO = el MOTOR ÚNICO, que es el código de CHILE
 * (lib/cotizacion-unica/motor.ts, 28-sep), con los datos de México. La lógica
 * no vive acá: este archivo declara los datos del país y traduce la forma del
 * resultado a la que esperan las tools y el cotizador (campos en MXN).
 *
 * Datos de México:
 *   - Plan: 1-15 → $1,200 fijo · 16-20 → $83/usuario (Karen, VB Lalo 24-sep).
 *     RANGO DE VICKY = 1-20; 21-50 solo como excepción por contacto.
 *   - Reloj checador: renta $350/mes en la base (CDMX y Zona Metropolitana),
 *     $400/mes fuera (envío incluido); venta $2,100.
 *   - Envío en venta por punto: $400 base / $560 fuera.
 *   - Instalación por punto: $800 base / $2,400 intermedia / $4,000 resto; en
 *     RENTA en la base va BONIFICADA.
 *   - Capacitación online incluida sin costo: ítem en TODA cotización (a lista
 *     $600 con subtotal $0; el valor no se menciona al cliente, Lalo 13-ago).
 *   - IVA 16 % en todo; al cliente se le muestran NETOS "+ IVA".
 *   - Descuento = Chile: 10 → 20 % solo en el plan, 6 meses.
 *   - Nunca "reloj" a secas: el texto pasa por nombreEquipoMX.
 */

import { CATALOGO_MODULOS_MX } from "./catalogo.ts"
import { nombreEquipoMX } from "./nombre-equipo.ts"
import { ESCALERA_DESCUENTO_MX } from "./descuento.ts"
import type { ZonaMX } from "./geografia.ts"
export type { ZonaMX } from "./geografia.ts"
import type { ReglasCotizacion, TierCot, ZonaCot } from "../../cotizacion-unica/motor.ts"
import { cotizarPais, precioPlanPais, ID_EQUIPO, type TextosFormal } from "../../cotizacion-unica/pais.ts"

const IVA_MX = 0.16

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
  /** Escalón de la escalera de descuento del plan (0 · 1 = 10 % · 2 = 20 %). */
  escalonDescuento?: number
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

/** Item en el contrato del endpoint create-from-vicky-mx del cotizador. */
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
  /** % de descuento de la línea (100 = bonificada: se muestra tachada en $0). */
  descuentoPct?: number
}

export const TARIFAS_MX = {
  relojArriendoMes: 350,
  /** Renta fuera de la base (intermedia y resto), envío incluido. */
  relojArriendoMesFuera: 400,
  relojVenta: 2100,
  /** Envío por reloj en VENTA: base / fuera de la base. */
  envioVenta: { base: 400, fuera: 560 },
  /** Instalación técnica por punto = 1 / 3 / 5 UF chilenas en pesos. */
  instalacion: { base: 800, intermedia: 2400, resto: 4000 },
  /** Capacitación online: se cobra $0 y el valor de lista NO se menciona. */
  capacitacionOnline: 600,
} as const

/** MXN con centavos solo cuando los hay ($1,200 · $1,195.20). */
export function formatearMXN(monto: number): string {
  const n = Math.round(Number(monto || 0) * 100) / 100
  const conCentavos = Math.abs(n - Math.round(n)) > 0.004
  return "$" + n.toLocaleString("es-MX", { minimumFractionDigits: conCentavos ? 2 : 0, maximumFractionDigits: 2 })
}

function redondear2(n: number): number {
  return Math.round(Number(n || 0) * 100) / 100
}

function tiersMX(): readonly TierCot[] {
  const asistencia = CATALOGO_MODULOS_MX.find((m) => m.id === "asistencia")
  if (!asistencia) throw new Error("Catálogo MX sin módulo asistencia")
  return asistencia.tiers as TierCot[]
}

const ZONA_MOTOR: Record<ZonaMX, ZonaCot> = { cdmx_metro: "base", intermedia: "intermedia", resto: "resto" }

const conIVA = (n: number) => `${formatearMXN(n)} + IVA`

/** Datos de México para el motor único. */
export const REGLAS_MX: ReglasCotizacion = {
  scopeMaxUsuarios: 50,
  get modulos() {
    return [{ id: "asistencia", nombre: "Control de Asistencia", tiers: tiersMX(), disponibleParaVicky: true }]
  },
  hardware: [
    {
      id: ID_EQUIPO,
      displayName: "Reloj checador",
      arriendoUF: TARIFAS_MX.relojArriendoMes,
      arriendoFueraUF: TARIFAS_MX.relojArriendoMesFuera,
      ventaUF: TARIFAS_MX.relojVenta,
      modalidadesDisponibles: ["arriendo", "venta"],
      cantidadSugerida: 1,
      requiereInstalacionOnsite: true,
      disponibleParaVicky: true,
    },
  ],
  servicios: [
    {
      id: "envio_reloj",
      nombre: "Envío de reloj checador",
      tarifa: {
        modelo: "modalidad_zona",
        arriendo: { base: 0, fuera: 0 },
        venta: { base: TARIFAS_MX.envioVenta.base, fuera: TARIFAS_MX.envioVenta.fuera },
      },
      omitirSiAutoInstalada: false,
      advertenciasAutoInstalacion: [],
    },
    {
      id: "instalacion_reloj",
      nombre: "Instalación del reloj checador",
      tarifa: { modelo: "zona", base: TARIFAS_MX.instalacion.base, intermedia: TARIFAS_MX.instalacion.intermedia, resto: TARIFAS_MX.instalacion.resto },
      omitirSiAutoInstalada: true,
      advertenciasAutoInstalacion: [],
    },
  ],
  esRelojDePared: (id) => id === ID_EQUIPO,
  clasificar: (p) => ({ tipo: "zona", zona: p.zona ?? "base", reconocida: true }),
  recargoArriendoFuera: 0,
  instalacionBonificada: (modalidad, zona) => modalidad === "arriendo" && zona === "base",
  exigePuntosConHardware: false,
  impuesto: { tasa: IVA_MX, soloEquipo: false, agregacion: "por_concepto" },
  redondeoLinea: (n) => n,
  escalera: ESCALERA_DESCUENTO_MX,
  redondearPlanConDescuento: redondear2,
  presentacion: {
    monto: formatearMXN,
    unitario: formatearMXN,
    lineaTotalMensual: (m) => `Total mensual: ${conIVA(m.neto)}`,
    lineaSubtotal: (neto) => `Subtotal sin IVA: ${formatearMXN(neto)}`,
    opcionMensual: (m) => `${conIVA(m.neto)} al mes`,
    pagoUnico: (m) => conIVA(m.neto),
    montoCorto: (m) => conIVA(m.neto),
    notaUnidad: null,
    // "reloj" a secas jamás en México (Lalo 24-sep): "reloj checador" o "checador".
    postMensaje: nombreEquipoMX,
  },
  textos: {
    equipo: "reloj",
    equipoPlural: "relojes",
    modalidadArriendo: "Reloj checador en renta",
    modalidadVenta: "Reloj checador en compra",
    modalidadMixta: "Reloj checador",
    bonificadaEn: "(renta en CDMX y Zona Metropolitana)",
    segunZona: "según la ciudad",
    sufijoArriendoFuera: " (fuera de CDMX)",
    envioIncluido: " El envío del reloj va incluido.",
    notaMicroPlan: null,
    notasFinales: ["La capacitación online va incluida sin costo 🎁"],
  },
}

/** Ítems de la formal de México (contrato de create-from-vicky-mx). */
const FORMAL_MX: TextosFormal = {
  idArriendo: "reloj_arriendo",
  idVenta: "reloj_venta",
  modalidadItemArriendo: "Renta mensual",
  itemArriendo: "Renta de reloj checador",
  itemArriendoFuera: "Renta de reloj checador (fuera de CDMX, envío incluido)",
  descArriendo: "Reloj biométrico de control de asistencia (facial y huella), con conexión WiFi y Ethernet. Envío incluido.",
  itemVenta: "Reloj checador (compra)",
  descVenta: "Reloj biométrico de control de asistencia (facial y huella), con conexión WiFi y Ethernet.",
  itemEnvio: (u) => `Envío de reloj (${u})`,
  itemInstalacion: (u) => `Instalación técnica del reloj (${u})`,
  descInstalacionBonificada: "Visita de instalación por nuestro equipo técnico. Bonificada en renta en CDMX y Zona Metropolitana.",
  descInstalacionCobrada: "Visita de instalación por nuestro equipo técnico. Pago único.",
  capacitacion: {
    id: "capacitacion_online",
    nombre: "Capacitación online",
    descripcion: "Curso online de uso de la plataforma — incluida sin costo.",
    precioLista: TARIFAS_MX.capacitacionOnline,
  },
}

/** Precio mensual del plan de asistencia (MXN neto, sin IVA). Lanza fuera de 1-50. */
export function precioPlanMX(userCount: number): number {
  return precioPlanPais(REGLAS_MX, "de México", userCount)
}

export function cotizarMX(input: CotizacionMXInput): {
  lineas: LineaMX[]
  itemsCotizador: ItemCotizadorMX[]
  mensualNetoPlan: number
  mensualArriendoNeto: number
  mensualArriendoIva: number
  mensualIva: number
  mensualTotal: number
  /** Mensualidad con IVA a precio de LISTA (= mensualTotal sin descuento). */
  mensualTotalLista: number
  /** Mensualidad NETA (con el descuento del escalón) y a lista — lo que ve el cliente. */
  mensualNeto: number
  mensualNetoLista: number
  pagoInicialNeto: number
  pagoInicialIva: number
  pagoInicialTotal: number
  /** % de descuento del plan aplicado (0 · 0,1 · 0,2) y su escalón. */
  descuentoPct: number
  escalonDescuento: number
  mensajeParaProspecto: string
} {
  const r = cotizarPais(REGLAS_MX, FORMAL_MX, "de México", {
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
      modalidad: it.modalidad as ItemCotizadorMX["modalidad"],
      cantidad: it.cantidad,
      precioUnitarioMXN: it.precioUnitario,
      subtotalMXN: it.subtotal,
      esRecurrente: it.esRecurrente,
      afectoIva: it.afectoImpuesto,
      ...(it.descuentoPct !== undefined ? { descuentoPct: it.descuentoPct } : {}),
    })),
    mensualNetoPlan: r.plan,
    mensualArriendoNeto: r.arriendoNeto,
    mensualArriendoIva: r.arriendoImpuesto,
    mensualIva: redondear2(r.mensualImpuesto),
    mensualTotal: redondear2(r.mensualNeto + r.mensualImpuesto),
    mensualTotalLista: redondear2(r.mensualNetoLista + r.mensualImpuestoLista),
    mensualNeto: redondear2(r.mensualNeto),
    mensualNetoLista: redondear2(r.mensualNetoLista),
    pagoInicialNeto: redondear2(r.pagoInicialNeto),
    pagoInicialIva: redondear2(r.pagoInicialImpuesto),
    pagoInicialTotal: redondear2(r.pagoInicialTotal),
    descuentoPct: r.descuentoPct,
    escalonDescuento: r.escalonDescuento,
    mensajeParaProspecto: r.mensaje,
  }
}
