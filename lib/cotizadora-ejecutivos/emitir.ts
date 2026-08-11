/**
 * ADAPTADOR DE EMISIÓN — del motor de Nacho a la tubería existente.
 *
 * Hallazgo que lo hace chico (11-ago): create-from-vicky NUNCA calculó
 * precios — siempre recibió `cotizacion.items` pre-calculados del agente y
 * solo los mapea al subform de Zoho/Creator. La tubería completa (cotización
 * + Creator + PDF + aceptación + pago) es agnóstica al catálogo. Este módulo
 * traduce las LineaPropuesta del motor ejecutivo al formato ItemCotizacion
 * que esa tubería come, con la escalera de tramos de NACHO para la tabla de
 * cobro de Creator y el PDF.
 *
 * PURO (sin red, sin env): el POST a create-from-vicky lo hace el agente de
 * Fase 2 con la misma plomería de generar-link-cotizadora (reintentos,
 * anclas _draft*, owner del ejecutivo).
 */

import type { LineaPropuesta, ResultadoPropuesta } from "./motor.ts"
import { TRAMOS_ASISTENCIA, OTROS_SERVICIOS, type OtroServicioId, type TramoUF } from "./catalogo.ts"

const IVA_RATE = 0.19

/** Mismo shape que ItemCotizacion de generar-link-cotizadora (contrato del
 * payload de create-from-vicky). Duplicado a propósito: este módulo no puede
 * importar del mundo Vicky (separación de agentes, principio 0). */
export type ItemEmision = {
  tipo: "modulo" | "hardware" | "servicio"
  id: string
  nombre: string
  modalidad: string
  cantidad: number
  precioUnitarioUF: number
  subtotalUF: number
  tierAplicado?: string
  escalera?: Array<{ desde: number; hasta: number; modalidad: "fijo" | "por_usuario"; precioUF: number }>
  zonaTarifa?: "RM" | "regiones"
}

function escaleraDe(tramos: TramoUF[]): ItemEmision["escalera"] {
  return tramos.map((t) => ({
    desde: t.min,
    hasta: t.max,
    modalidad: t.tipo,
    precioUF: t.uf,
  }))
}

function itemDeLinea(l: LineaPropuesta): ItemEmision {
  const base = {
    id: l.id,
    nombre: l.nombre,
    cantidad: l.cantidad,
    precioUnitarioUF: l.precioUnitarioUF,
    subtotalUF: l.subtotalUF,
    tierAplicado: l.detalle,
  }
  switch (l.tipo) {
    case "asistencia":
      return { ...base, tipo: "modulo", modalidad: l.cantidad === 1 ? "Fijo" : "Por usuario", escalera: escaleraDe(TRAMOS_ASISTENCIA) }
    case "addon":
      return { ...base, tipo: "modulo", modalidad: "Por usuario" }
    case "otro_servicio": {
      const def = OTROS_SERVICIOS[l.id as OtroServicioId]
      return {
        ...base,
        tipo: "modulo",
        modalidad: l.cantidad === 1 ? "Fijo" : "Por usuario",
        escalera: def ? escaleraDe([...def.tramos]) : undefined,
      }
    }
    case "equipo":
    case "accesorio":
      return { ...base, tipo: "hardware", modalidad: l.recurrencia === "mensual" ? "Arriendo mensual" : "Venta única" }
    case "servicio_asociado":
      // Sin marcador de zona en el nombre (envío sin zona declarada — regla
      // Anderson) la tarifa no depende del lugar: zonaTarifa se omite.
      return {
        ...base,
        tipo: "servicio",
        modalidad: "Cobro único",
        zonaTarifa: /\(RM\)/.test(l.nombre) ? "RM" : /\(Regiones\)/.test(l.nombre) ? "regiones" : undefined,
      }
    case "promo":
      // Promos de producto (1 UF, SF2A) son mensuales tipo módulo/hardware;
      // kits y bundles siguen su recurrencia. La distinción fina no cambia el
      // cobro: modalidad correcta = lo único que Creator/PDF necesitan.
      if (l.id === "senseface_2a_promo" || l.id === "kit_qr" || l.id === "bundle_in01") {
        return { ...base, tipo: "hardware", modalidad: l.recurrencia === "mensual" ? "Arriendo mensual" : "Venta única" }
      }
      return { ...base, tipo: "modulo", modalidad: "Fijo" }
  }
}

export type PayloadCotizacionEjecutiva = {
  items: ItemEmision[]
  subtotalUF: number
  ivaUF: number
  totalUF: number
  ufActual: number
  totalCLP: number
}

/** Arma el bloque `cotizacion` del payload de create-from-vicky desde el
 * resultado del motor. `ufActual` viene del pipeline (getUFActualSafe) al
 * momento de emitir — acá solo se congela en números. */
export function payloadDesdePropuesta(resultado: ResultadoPropuesta, ufActual: number): PayloadCotizacionEjecutiva {
  const items = resultado.lineas.map(itemDeLinea)
  const subtotalUF = Number(items.reduce((a, i) => a + i.subtotalUF, 0).toFixed(3))
  const ivaUF = Number((subtotalUF * IVA_RATE).toFixed(3))
  const totalUF = Number((subtotalUF + ivaUF).toFixed(3))
  const uf = Number(ufActual || 0)
  return {
    items,
    subtotalUF,
    ivaUF,
    totalUF,
    ufActual: Number(uf.toFixed(2)),
    totalCLP: uf > 0 ? Math.round(totalUF * uf) : 0,
  }
}
