/**
 * Cotización referencial de PERÚ = el MOTOR ÚNICO (lib/cotizacion/motor.ts)
 * con los datos de Perú (26-sep, paso 2 de la unificación). La lógica ya no
 * vive acá: este archivo solo declara las reglas del país y traduce la forma
 * del resultado a la que esperan las tools y el cotizador (campos en PEN).
 *
 * Datos de Perú:
 *   - Plan (lista del 25-sep): 1-10 → S/100 fijo · 11-20 → S/9/usuario.
 *     RANGO DE VICKY = 1-20 (igual que Chile); el 21-50 del catálogo es solo
 *     excepción por contacto.
 *   - Reloj: precio de LISTA en USD (RELOJ_PE_USD) convertido a SOLES ENTEROS
 *     con el dólar venta SUNAT del día (`tipoCambio`). Arriendo US$20 en Lima,
 *     US$23 fuera (despacho incluido); venta US$150 (instalación incluida en Lima) + envío US$30 por punto
 *     fuera de Lima (en Lima va incluido).
 *   - Instalación por punto: Lima US$43 · intermedia · provincias US$214; en
 *     ALQUILER en Lima va BONIFICADA. Aviso a ssttperu@ si hay visita pedida.
 *   - IGV 18 % en todo; al cliente se le muestran NETOS "+ IGV".
 *   - Descuento = Chile: 10 → 20 % solo en el plan, 6 meses.
 *   - Sin capacitación.
 */

import { CATALOGO_MODULOS_PE, ESCALERA_DESCUENTO_PE, RELOJ_PE_USD } from "./catalogo.ts"
import { TC_USD_PEN_FALLBACK, usdASoles } from "./tc-sunat.ts"
import {
  cotizar,
  pctDescuento,
  precioPlan,
  unirPartes,
  type ReglasMotor,
  type TierPlan,
  type ZonaMotor,
} from "../../cotizacion/motor.ts"

// IGV peruano: 18% parejo en todos los conceptos. Solo lo escribe este archivo.
const IGV_PE = 0.18

/** lima = Lima Metropolitana + Callao (base) · intermedia = Región Lima fuera
 *  de la capital + Ica · provincias = todo lo demás. */
export type ZonaPE = "lima" | "intermedia" | "provincias"

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
  /** Escalón de descuento del PLAN: 0 = sin descuento, 1 = 10 %, 2 = 20 %. */
  escalonDescuento?: number
  /** Dólar venta SUNAT (soles por dólar) para convertir el reloj. */
  tipoCambio?: number
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

/** Item en el contrato del endpoint create-from-vicky-pe del cotizador. */
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
  /** % de descuento de la línea (100 = bonificada: se muestra tachada en $0). */
  descuentoPct?: number
}

/** Tarifas del reloj EN SOLES para un tipo de cambio dado (soles enteros). */
export function tarifasRelojPE(tipoCambio: number) {
  const tc = Number.isFinite(tipoCambio) && tipoCambio > 0 ? tipoCambio : TC_USD_PEN_FALLBACK
  return {
    relojArriendoMes: usdASoles(RELOJ_PE_USD.arriendoMes, tc),
    relojVenta: usdASoles(RELOJ_PE_USD.venta, tc),
    /** Arriendo mensual a PROVINCIA, despacho incluido (US$23). */
    relojArriendoMesProvincia: usdASoles(RELOJ_PE_USD.arriendoMesProvincia, tc),
    /** Envío por reloj en VENTA a provincia (US$30, pago único). */
    envioVentaProvincia: usdASoles(RELOJ_PE_USD.envioVentaProvincia, tc),
    /** Instalación técnica por punto en Lima (US$43) y en provincias (US$214). */
    instalacionLima: usdASoles(RELOJ_PE_USD.instalacionLima, tc),
    instalacionIntermedia: usdASoles(RELOJ_PE_USD.instalacionIntermedia, tc),
    instalacionProvincias: usdASoles(RELOJ_PE_USD.instalacionProvincias, tc),
    tipoCambio: tc,
  }
}

/** "S/318.60" · "S/270" — soles con 2 decimales solo si hay fracción. */
export function formatearPEN(monto: number): string {
  const r = Math.round(monto * 100) / 100
  return "S/" + (Number.isInteger(r) ? r.toLocaleString("es-PE") : r.toFixed(2))
}

function tiersPE(): readonly TierPlan[] {
  const asistencia = CATALOGO_MODULOS_PE.find((m) => m.id === "asistencia")
  if (!asistencia) throw new Error("Catálogo PE sin módulo asistencia")
  return asistencia.tiers as TierPlan[]
}

const ZONA_MOTOR: Record<ZonaPE, ZonaMotor> = { lima: "base", intermedia: "intermedia", provincias: "resto" }

/** Reglas del motor único para Perú (dependen del dólar del día). */
export function reglasPE(tipoCambio?: number): ReglasMotor {
  const t = tarifasRelojPE(Number(tipoCambio))
  const tcTxt = "en soles al tipo de cambio oficial (SUNAT) del día"
  return {
    nombrePais: "de Perú",
    tiers: tiersPE(),
    escalera: ESCALERA_DESCUENTO_PE,
    decimales: 2,
    redondearPlanConDescuento: false,
    formatear: formatearPEN,
    impuesto: { tasa: IGV_PE, soloEquipo: false },
    // En Lima la instalación va incluida también en la venta (Lalo 27-sep).
    bonificaInstalacionBaseEnVenta: true,
    presentacion: "neto",
    sufijo: " + IGV",
    tarifas: {
      arriendoBase: t.relojArriendoMes,
      arriendoFuera: t.relojArriendoMesProvincia,
      venta: t.relojVenta,
      envioVenta: { base: 0, fuera: t.envioVentaProvincia },
      instalacion: { base: t.instalacionLima, intermedia: t.instalacionIntermedia, resto: t.instalacionProvincias },
    },
    textos: {
      equipo: "reloj",
      modalidadArriendo: "Reloj en alquiler",
      modalidadVenta: "Reloj en compra",
      envioIncluido: " El envío del reloj va incluido.",
      bonificadaEn: "en Lima Metropolitana",
      detallePagoInicial: (v, e, i) => {
        const partes = [v ? "reloj" : "", e ? "envío" : "", i ? "instalación" : ""].filter(Boolean)
        return partes.length ? ` (${unirPartes(partes)})` : ""
      },
      notasFinales: [],
      lineaArriendo: "Alquiler de reloj de control",
      lineaArriendoFuera: "a provincia",
      lineaDespacho: "despacho",
      lineaVenta: "Reloj de control (compra)",
      lineaEnvio: (u) => `Envío de reloj a ${u}`,
      lineaInstalacion: (u) => `Instalación técnica del reloj (${u})`,
      zonaBaseEnvio: "Lima Metropolitana",
      zonaFueraEnvio: "provincia",
      bonificadaDetalle: "bonificada en Lima Metropolitana",
      // Mismo id para arriendo y venta: la Modalidad distingue; en Creator/Books
      // es el artículo [PER] 304.
      idArriendo: "reloj_pe",
      idVenta: "reloj_pe",
      modalidadItemArriendo: "Arriendo mensual",
      itemArriendo: "Alquiler de reloj de control",
      itemArriendoFuera: "Alquiler de reloj de control (provincia, despacho incluido)",
      descArriendo: `Reloj biométrico de control de asistencia (facial y huella), con conexión WiFi y Ethernet. Despacho incluido. Precio ${tcTxt}.`,
      itemVenta: "Reloj de control (compra)",
      descVenta: `Reloj biométrico de control de asistencia (facial y huella), con conexión WiFi y Ethernet. Envío e instalación incluidos en Lima Metropolitana. Precio ${tcTxt}.`,
      itemEnvio: () => "Envío de reloj a provincia",
      descEnvio: (u) => `Despacho del reloj fuera de Lima Metropolitana (${u}). Pago único, ${tcTxt}.`,
      itemInstalacion: (u) => `Instalación técnica del reloj (${u})`,
      descInstalacionBonificada: "Visita de instalación por nuestro equipo técnico. Incluida en Lima Metropolitana.",
      descInstalacionCobrada: `Visita de instalación por nuestro equipo técnico. Pago único, ${tcTxt}.`,
    },
  }
}

/** % de descuento del plan para un escalón (0 → 0, 1 → 0,1, 2 → 0,2). */
export function pctDescuentoPE(escalonDescuento: number): number {
  return pctDescuento(reglasPE(), escalonDescuento)
}

/** Precio mensual del plan (PEN neto, sin IGV). Lanza fuera de 1-50. */
export function precioPlanPE(userCount: number): number {
  return precioPlan(reglasPE(), userCount)
}

export function cotizarPE(input: CotizacionPEInput): {
  lineas: LineaPE[]
  itemsCotizador: ItemCotizadorPE[]
  mensualNetoPlan: number
  mensualArriendoNeto: number
  mensualNeto: number
  mensualIgv: number
  mensualTotal: number
  /** % de descuento del plan aplicado (0 · 0,1 · 0,2). */
  descuentoPct: number
  /** Escalón aplicado (0, 1 o 2). */
  escalonDescuento: number
  /** Total mensual con IGV durante los meses con descuento (0 si no hay). */
  mensualTotalConDescuento: number
  /** Dólar SUNAT usado para el reloj. */
  tipoCambio: number
  pagoInicialNeto: number
  pagoInicialIgv: number
  pagoInicialTotal: number
  /** true si algún punto pidió visita técnica: la capa de tools avisa a ssttperu@. */
  avisoSsttPeru: boolean
  mensajeParaProspecto: string
} {
  const tipoCambio = tarifasRelojPE(Number(input.tipoCambio)).tipoCambio
  const r = cotizar(reglasPE(tipoCambio), {
    userCount: input.userCount,
    reloj: input.reloj,
    puntos: (input.puntos || []).map((p) => ({ ubicacion: p.ubicacion, zona: ZONA_MOTOR[p.zona] || "resto", autoInstalada: p.autoInstalada })),
    escalonDescuento: input.escalonDescuento,
  })
  return {
    lineas: r.lineas.map((l) => ({ concepto: l.concepto, detalle: l.detalle, neto: l.neto, igv: l.impuesto, recurrente: l.recurrente })),
    itemsCotizador: r.items.map((it) => ({
      tipo: it.tipo,
      id: it.id,
      nombre: it.nombre,
      ...(it.descripcion !== undefined ? { descripcion: it.descripcion } : {}),
      modalidad: it.modalidad as ItemCotizadorPE["modalidad"],
      cantidad: it.cantidad,
      precioUnitarioPEN: it.precioUnitario,
      subtotalPEN: it.subtotal,
      esRecurrente: it.esRecurrente,
      afectoIgv: it.afectoImpuesto,
      ...(it.descuentoPct !== undefined ? { descuentoPct: it.descuentoPct } : {}),
    })),
    // Los totales "mensual*" van a LISTA (sin descuento), como siempre en Perú;
    // la mensualidad con descuento viaja en mensualTotalConDescuento.
    mensualNetoPlan: r.planLista,
    mensualArriendoNeto: r.arriendoNeto,
    mensualNeto: r.mensualNetoLista,
    mensualIgv: r.mensualImpuestoLista,
    mensualTotal: r.mensualNetoLista + r.mensualImpuestoLista,
    descuentoPct: r.descuentoPct,
    escalonDescuento: r.escalonDescuento,
    mensualTotalConDescuento: r.descuentoPct > 0 ? r.mensualNeto + r.mensualImpuesto : 0,
    tipoCambio,
    pagoInicialNeto: r.pagoInicialNeto,
    pagoInicialIgv: r.pagoInicialImpuesto,
    pagoInicialTotal: r.pagoInicialTotal,
    avisoSsttPeru: r.visitaTecnicaPedida,
    mensajeParaProspecto: r.mensaje,
  }
}
