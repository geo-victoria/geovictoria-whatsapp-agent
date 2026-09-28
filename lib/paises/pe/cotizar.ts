/**
 * Cotización referencial de PERÚ = el MOTOR ÚNICO, que es el código de CHILE
 * (lib/cotizacion-unica/motor.ts, 28-sep), con los datos de Perú. La lógica
 * no vive acá: este archivo solo declara los datos del país y traduce la forma
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
import type { ReglasCotizacion, TierCot, ZonaCot } from "../../cotizacion-unica/motor.ts"
import { cotizarPais, pctDescuentoPais, precioPlanPais, ID_EQUIPO, type TextosFormal } from "../../cotizacion-unica/pais.ts"

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

function tiersPE(): readonly TierCot[] {
  const asistencia = CATALOGO_MODULOS_PE.find((m) => m.id === "asistencia")
  if (!asistencia) throw new Error("Catálogo PE sin módulo asistencia")
  return asistencia.tiers as TierCot[]
}

const ZONA_MOTOR: Record<ZonaPE, ZonaCot> = { lima: "base", intermedia: "intermedia", provincias: "resto" }

const conIGV = (n: number) => `${formatearPEN(n)} + IGV`

/** Datos de Perú para el motor único (dependen del dólar del día). */
export function reglasPE(tipoCambio?: number): ReglasCotizacion {
  const t = tarifasRelojPE(Number(tipoCambio))
  return {
    scopeMaxUsuarios: 50,
    modulos: [{ id: "asistencia", nombre: "Control de Asistencia", tiers: tiersPE(), disponibleParaVicky: true }],
    hardware: [
      {
        id: ID_EQUIPO,
        displayName: "Reloj de control",
        arriendoUF: t.relojArriendoMes,
        arriendoFueraUF: t.relojArriendoMesProvincia,
        ventaUF: t.relojVenta,
        modalidadesDisponibles: ["arriendo", "venta"],
        cantidadSugerida: 1,
        requiereInstalacionOnsite: true,
        disponibleParaVicky: true,
      },
    ],
    servicios: [
      {
        id: "envio_reloj",
        nombre: "Envío de reloj",
        tarifa: { modelo: "modalidad_zona", arriendo: { base: 0, fuera: 0 }, venta: { base: 0, fuera: t.envioVentaProvincia } },
        omitirSiAutoInstalada: false,
        advertenciasAutoInstalacion: [],
      },
      {
        id: "instalacion_reloj",
        nombre: "Instalación de reloj",
        tarifa: { modelo: "zona", base: t.instalacionLima, intermedia: t.instalacionIntermedia, resto: t.instalacionProvincias },
        omitirSiAutoInstalada: true,
        advertenciasAutoInstalacion: [],
      },
    ],
    esRelojDePared: (id) => id === ID_EQUIPO,
    clasificar: (p) => ({ tipo: "zona", zona: p.zona ?? "base", reconocida: true }),
    recargoArriendoFuera: 0,
    // En Lima la instalación va incluida también en la venta (Lalo 27-sep).
    instalacionBonificada: (_modalidad, zona) => zona === "base",
    exigePuntosConHardware: false,
    impuesto: { tasa: IGV_PE, soloEquipo: false, agregacion: "por_concepto" },
    redondeoLinea: (n) => n,
    escalera: ESCALERA_DESCUENTO_PE,
    redondearPlanConDescuento: (n) => n,
    presentacion: {
      monto: formatearPEN,
      unitario: formatearPEN,
      lineaTotalMensual: (m) => `Total mensual: ${conIGV(m.neto)}`,
      lineaSubtotal: (neto) => `Subtotal sin IGV: ${formatearPEN(neto)}`,
      opcionMensual: (m) => `${conIGV(m.neto)} al mes`,
      pagoUnico: (m) => conIGV(m.neto),
      montoCorto: (m) => conIGV(m.neto),
      notaUnidad: null,
    },
    textos: {
      equipo: "reloj",
      equipoPlural: "relojes",
      modalidadArriendo: "Reloj en alquiler",
      modalidadVenta: "Reloj en compra",
      modalidadMixta: "Reloj",
      bonificadaEn: "en Lima Metropolitana",
      segunZona: "según el distrito",
      sufijoArriendoFuera: " (provincia)",
      envioIncluido: " El envío del reloj va incluido.",
      notaMicroPlan: null,
      notasFinales: [],
    },
  }
}

const TC_TXT = "en soles al tipo de cambio oficial (SUNAT) del día"

/** Ítems de la formal de Perú (contrato de create-from-vicky-pe). */
const FORMAL_PE: TextosFormal = {
  // Mismo id para arriendo y venta: la Modalidad distingue; en Creator/Books
  // es el artículo [PER] 304.
  idArriendo: "reloj_pe",
  idVenta: "reloj_pe",
  modalidadItemArriendo: "Arriendo mensual",
  itemArriendo: "Alquiler de reloj de control",
  itemArriendoFuera: "Alquiler de reloj de control (provincia, despacho incluido)",
  descArriendo: `Reloj biométrico de control de asistencia (facial y huella), con conexión WiFi y Ethernet. Despacho incluido. Precio ${TC_TXT}.`,
  itemVenta: "Reloj de control (compra)",
  descVenta: `Reloj biométrico de control de asistencia (facial y huella), con conexión WiFi y Ethernet. Envío e instalación incluidos en Lima Metropolitana. Precio ${TC_TXT}.`,
  itemEnvio: () => "Envío de reloj a provincia",
  descEnvio: (u) => `Despacho del reloj fuera de Lima Metropolitana (${u}). Pago único, ${TC_TXT}.`,
  itemInstalacion: (u) => `Instalación técnica del reloj (${u})`,
  descInstalacionBonificada: "Visita de instalación por nuestro equipo técnico. Incluida en Lima Metropolitana.",
  descInstalacionCobrada: `Visita de instalación por nuestro equipo técnico. Pago único, ${TC_TXT}.`,
}

/** % de descuento del plan para un escalón (0 → 0, 1 → 0,1, 2 → 0,2). */
export function pctDescuentoPE(escalonDescuento: number): number {
  return pctDescuentoPais(reglasPE(), escalonDescuento)
}

/** Precio mensual del plan (PEN neto, sin IGV). Lanza fuera de 1-50. */
export function precioPlanPE(userCount: number): number {
  return precioPlanPais(reglasPE(), "de Perú", userCount)
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
  const r = cotizarPais(reglasPE(tipoCambio), FORMAL_PE, "de Perú", {
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
