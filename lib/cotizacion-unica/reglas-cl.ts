/**
 * Datos de CHILE para el motor único (lib/cotizacion-unica/motor.ts).
 *
 * Todo sale de las fuentes de siempre —catálogo (lib/catalogo), geografía
 * (lib/geografia)— y de los textos que tenía la tool cotizar_referencial.
 * No hay precios escritos acá: si el catálogo cambia, cambia la cotización.
 *
 * PURO (imports relativos .ts; los del catálogo son solo de tipos).
 */

import { CATALOGO_MODULOS } from "../catalogo/modulos.ts"
import { CATALOGO_HARDWARE, ARRIENDO_RECARGO_REGIONES_UF, esRelojDePared } from "../catalogo/hardware.ts"
import { CATALOGO_SERVICIOS } from "../catalogo/servicios.ts"
import { clasificarUbicacion } from "../geografia.ts"
import type { ItemCot, ReglasCotizacion, ResultadoCot, ServicioCot, ZonaCot } from "./motor.ts"

const IVA_CL = 0.19
const SCOPE_MAX_USUARIOS = 50

// Formato chileno: "." miles, "," decimal. Ej: 40522.38 → "40.522,38".
export function fmtNumCL(n: number, decimals: number): string {
  const [entero, dec] = n.toFixed(decimals).split(".")
  const conMiles = entero.replace(/\B(?=(\d{3})+(?!\d))/g, ".")
  return dec ? `${conMiles},${dec}` : conMiles
}

// UF: hasta 2 decimales, sin ceros sobrantes, coma decimal (regla con Rodrigo).
export function fmtUF(n: number): string {
  const rounded = Math.round(n * 100) / 100
  if (Number.isInteger(rounded)) return fmtNumCL(rounded, 0)
  return fmtNumCL(rounded, 2).replace(/0+$/, "").replace(/,$/, "")
}

// Unitario: hasta 3 decimales para que "cantidad × unitario = subtotal" calce (0,055).
export function fmtUFUnit(n: number): string {
  const rounded = Math.round(n * 1000) / 1000
  if (Number.isInteger(rounded)) return fmtNumCL(rounded, 0)
  return fmtNumCL(rounded, 3).replace(/0+$/, "").replace(/,$/, "")
}

const ZONA: Record<string, ZonaCot> = { RM: "base", intermedia: "intermedia", resto: "resto" }

function servicioCot(s: (typeof CATALOGO_SERVICIOS)[number]): ServicioCot {
  const t = s.tarifa
  return {
    id: s.id,
    nombre: s.nombre,
    tarifa:
      t.modelo === "zona"
        ? { modelo: "zona", base: t.RM, intermedia: t.intermedia, resto: t.resto }
        : {
            modelo: "modalidad_zona",
            arriendo: { base: t.arriendo.RM, fuera: t.arriendo.region },
            venta: { base: t.venta.RM, fuera: t.venta.region },
          },
    omitirSiAutoInstalada: s.omitirSiAutoInstalada,
    advertenciasAutoInstalacion: s.advertenciasAutoInstalacion,
  }
}

export const REGLAS_CL: ReglasCotizacion = {
  scopeMaxUsuarios: SCOPE_MAX_USUARIOS,
  modulos: CATALOGO_MODULOS,
  hardware: CATALOGO_HARDWARE,
  // Los que se inyectan solos con equipo, en el orden del catálogo (envío, instalación).
  servicios: CATALOGO_SERVICIOS.filter((s) => s.disponibleParaVicky && s.aplicaConHardware).map(servicioCot),
  esRelojDePared,
  clasificar: (p) => {
    const c = clasificarUbicacion(p.ubicacion)
    if (c.tipo === "no_clasificable") return { tipo: "no_clasificable", razon: c.razon }
    return { tipo: "zona", zona: ZONA[c.zonaInstalacion], reconocida: c.reconocida }
  },
  recargoArriendoFuera: ARRIENDO_RECARGO_REGIONES_UF,
  // Arriendo en la RM (Lalo 07-sep): la visita técnica va sin costo.
  instalacionBonificada: (modalidad, zona) => modalidad === "arriendo" && zona === "base",
  exigePuntosConHardware: true,
  impuesto: { tasa: IVA_CL, soloEquipo: false, agregacion: "suma" },
  redondeoLinea: (n) => Number(n.toFixed(3)),
  // El descuento de Chile lo calcula el cotizador (consultar_descuento_referencial).
  escalera: null,
  redondearPlanConDescuento: (n) => n,
  presentacion: {
    monto: (n) => `${fmtUF(n)} UF`,
    unitario: (n) => `${fmtUFUnit(n)} UF`,
    lineaTotalMensual: (m) => `Total mensual con IVA: ${fmtUF(m.total)} UF (aprox. $${fmtNumCL(m.local ?? 0, 0)})`,
    lineaSubtotal: (neto) => `Subtotal sin IVA: ${fmtUF(neto)} UF`,
    opcionMensual: (m) => `${fmtUF(m.neto)} UF + IVA al mes (aprox. $${fmtNumCL(m.local ?? 0, 0)})`,
    pagoUnico: (m) => `${fmtUF(m.neto)} UF + IVA (aprox. $${fmtNumCL(m.local ?? 0, 0)})`,
    montoCorto: (m) => `${fmtUF(m.neto)} UF + IVA`,
    notaUnidad: "El cobro se realiza en UF, por lo que el valor en pesos puede variar mes a mes.",
  },
  textos: {
    equipo: "reloj",
    equipoPlural: "relojes",
    modalidadArriendo: "Reloj en arriendo",
    modalidadVenta: "Reloj en venta",
    modalidadMixta: "Reloj",
    bonificadaEn: "(arriendo en la Región Metropolitana)",
    segunZona: "según la comuna",
    sufijoArriendoFuera: " (regiones)",
    envioIncluido: "",
    notaMicroPlan: () =>
      "Este plan base cubre 2 usuarios: el trabajador que marca + 1 administrador para gestionar la plataforma.",
    notasFinales: [],
  },
}

/**
 * El resultado del motor en el contrato de la tool chilena cotizar_referencial
 * (campos en UF, montos en CLP con la UF del día). Puro: lo usan la tool y el
 * test de identidad.
 */
export function resultadoChile(r: ResultadoCot, ufActual: number) {
  if (!r.ok) return { ok: false as const, error: r.error }
  const uf = (i: ItemCot) => ({
    tipo: i.tipo,
    id: i.id,
    nombre: i.nombre,
    modalidad: i.modalidad,
    cantidad: i.cantidad,
    precioUnitarioUF: i.precioUnitario,
    subtotalUF: i.subtotal,
    ...(i.tierAplicado !== undefined ? { tierAplicado: i.tierAplicado } : {}),
    ...(i.descuentoPct !== undefined ? { descuentoPct: i.descuentoPct } : {}),
  })
  return {
    ok: true as const,
    userCount: r.userCount,
    items: r.items.map(uf),
    subtotalUF: Number(r.subtotal.toFixed(3)),
    ivaUF: Number(r.impuesto.toFixed(3)),
    totalUF: Number(r.total.toFixed(3)),
    ufActual: Number(ufActual.toFixed(2)),
    totalCLP: r.totalLocal ?? 0,
    subtotalRecurrenteUF: Number(r.subtotalRecurrente.toFixed(3)),
    ivaRecurrenteUF: Number(r.impuestoRecurrente.toFixed(3)),
    totalRecurrenteUF: Number(r.totalRecurrente.toFixed(3)),
    totalRecurrenteCLP: r.totalRecurrenteLocal ?? 0,
    subtotalUnicoUF: Number(r.subtotalUnico.toFixed(3)),
    ivaUnicoUF: Number(r.impuestoUnico.toFixed(3)),
    totalUnicoUF: Number(r.totalUnico.toFixed(3)),
    totalUnicoCLP: r.totalUnicoLocal ?? 0,
    // resumenLegible (uso interno del modelo) = el mismo texto: una sola fuente.
    resumenLegible: r.mensajeParaProspecto,
    mensajeParaProspecto: r.mensajeParaProspecto,
    advertencias: r.advertencias,
  }
}
