/**
 * PUENTE CALCULADORA DE NACHO → EMISIÓN DE LA CASA (11-ago-2026).
 *
 * La calculadora comercial (copia literal de gv-cotizador, servida en
 * public/calculadora-comercial.html) arma la propuesta con SU propia lógica
 * de precios — la UI es la especificación (principio 2). Este módulo toma el
 * snapshot que produce su `gatherProposalData()` y lo traduce al contrato
 * ItemEmision de create-from-vicky, con una VERIFICACIÓN de integridad: los
 * totales se recomputan desde las líneas y deben calzar con los del snapshot
 * (si la página fue manipulada o hay drift de versiones, la emisión se niega
 * en vez de cobrar mal).
 *
 * PURO (sin red, sin env): lo vigila tests/cotizadora-ejecutivos.test.ts.
 */

import type { ItemEmision } from "./emitir.ts"

const IVA_RATE = 0.19

type LineaSnapshot = {
  nombre?: string
  tipo?: string
  cantidad?: number
  precioUnit?: number
  subtotalUF?: number
  descuento?: number
  rango?: string
  zona?: string
}

export type SnapshotCalculadora = {
  empresa?: string
  contacto?: string
  ejecutivo?: string
  servicios?: LineaSnapshot[]
  equipos?: LineaSnapshot[]
  accesorios?: LineaSnapshot[]
  serviciosAsoc?: LineaSnapshot[]
  totals?: {
    subtotalNeto?: number
    iva?: number
    totalConIva?: number
  }
  ufValue?: number
}

// TODO A 3 DECIMALES: los campos double del subform de Zoho
// (Precio_Unitario_UF / Subtotal_UF) aceptan máximo 3 decimales — un cuarto
// decimal hace fallar el createRecord completo con INVALID_DATA (caso VADIBA
// 11-ago: 0,090 UF con 25% dcto = 0,0675). El cobro real siempre usa el
// SUBTOTAL exacto de la calculadora; el unitario redondeado es cosmético,
// igual que en la UI de Nacho (muestra 0,068/u y cobra 1,282).
const r3 = (v: number) => Number(v.toFixed(3))

function slug(nombre: string): string {
  return nombre
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40) || "item"
}

export type ResultadoSnapshot =
  | {
      ok: true
      items: ItemEmision[]
      subtotalUF: number
      ivaUF: number
      totalUF: number
    }
  | { ok: false; error: string }

/**
 * Traduce el snapshot de la calculadora a ítems de emisión. Las líneas
 * informativas de los bundles ("Incluye: …", precio 0) se pliegan como
 * descripción de la línea anterior — no viajan como ítems propios.
 */
export function itemsDesdeSnapshot(data: SnapshotCalculadora): ResultadoSnapshot {
  const items: ItemEmision[] = []

  // ── Servicios de software (recurrentes mensuales) ──
  for (const s of data.servicios || []) {
    const nombre = String(s.nombre || "").trim()
    const subtotal = Number(s.subtotalUF)
    if (!nombre || !Number.isFinite(subtotal)) {
      return { ok: false, error: `Línea de servicio inválida: ${JSON.stringify(s).slice(0, 120)}` }
    }
    const esFijo = String(s.tipo || "").toLowerCase() === "fijo"
    const cantidad = esFijo ? 1 : Math.max(1, Math.trunc(Number(s.cantidad) || 1))
    items.push({
      tipo: "modulo",
      id: slug(nombre),
      nombre,
      modalidad: esFijo ? "Fijo" : "Por usuario",
      cantidad,
      // Precio NETO efectivo (con el descuento de la calculadora aplicado),
      // redondeado a la precisión que Zoho acepta; el subtotal viaja exacto.
      precioUnitarioUF: r3(subtotal / cantidad),
      subtotalUF: r3(subtotal),
      tierAplicado: [s.rango ? `${s.rango} usuarios` : "", s.descuento ? `${s.descuento}% dcto` : ""]
        .filter(Boolean)
        .join(" · ") || undefined,
    })
  }

  // ── Equipos y accesorios (hardware: arriendo mensual o venta única) ──
  const hardware = [...(data.equipos || []), ...(data.accesorios || [])]
  for (const e of hardware) {
    const nombre = String(e.nombre || "").trim()
    const subtotal = Number(e.subtotalUF)
    const unit = Number(e.precioUnit)
    if (!nombre) continue
    // Línea informativa de bundle ("Incluye: …", $0): se pliega a la anterior.
    if (!(subtotal > 0) && !(unit > 0)) {
      const prev = items[items.length - 1]
      if (prev && prev.tipo === "hardware") {
        prev.tierAplicado = [prev.tierAplicado, nombre].filter(Boolean).join(" — ")
      }
      continue
    }
    const esArriendo = String(e.tipo || "").toLowerCase().includes("arriendo")
    items.push({
      tipo: "hardware",
      id: slug(nombre),
      nombre,
      modalidad: esArriendo ? "Arriendo mensual" : "Venta única",
      cantidad: Math.max(1, Math.trunc(Number(e.cantidad) || 1)),
      precioUnitarioUF: r3(unit),
      subtotalUF: r3(subtotal),
    })
  }

  // ── Servicios asociados (siempre pago único) ──
  for (const s of data.serviciosAsoc || []) {
    const nombre = String(s.nombre || "").trim()
    const subtotal = Number(s.subtotalUF)
    if (!nombre || !Number.isFinite(subtotal)) continue
    const zona = String(s.zona || "").trim()
    items.push({
      tipo: "servicio",
      id: slug(nombre),
      nombre: zona ? `${nombre} (${zona})` : nombre,
      modalidad: "Cobro único",
      cantidad: Math.max(1, Math.trunc(Number(s.cantidad) || 1)),
      precioUnitarioUF: r3(Number(s.precioUnit) || 0),
      subtotalUF: r3(subtotal),
      zonaTarifa: /^rm$/i.test(zona) ? "RM" : zona ? "regiones" : undefined,
    })
  }

  if (!items.length) return { ok: false, error: "La propuesta no tiene líneas — agrega al menos un servicio." }

  // ── Verificación de integridad: las líneas deben sumar los totales que la
  // calculadora mostró (tolerancia 1 centésima de UF por redondeos). ──
  const subtotalUF = r3(items.reduce((a, i) => a + i.subtotalUF, 0))
  const declarado = Number(data.totals?.subtotalNeto)
  if (Number.isFinite(declarado) && Math.abs(subtotalUF - declarado) > 0.011) {
    return {
      ok: false,
      error: `Los totales no calzan (líneas suman ${subtotalUF} UF, la calculadora mostró ${declarado} UF). Recarga la página y reintenta.`,
    }
  }
  const ivaUF = r3(subtotalUF * IVA_RATE)
  const totalUF = r3(subtotalUF + ivaUF)
  return { ok: true, items, subtotalUF, ivaUF, totalUF }
}
