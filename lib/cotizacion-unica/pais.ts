/**
 * Perú, Colombia y México sobre el MOTOR ÚNICO (el de Chile).
 *
 * `cotizarPais` corre el motor con las reglas del país (el mensaje, los
 * totales y el desglose salen de ahí, igual que en Chile) y arma los ÍTEMS DE
 * LA FORMAL en el contrato de los endpoints create-from-vicky-pe/co/mx.
 *
 * Los ítems de la formal NO son los del estimado: en Chile los arma otra
 * función (construirItemsCotizacion de generar_link_cotizadora, con el envío
 * del arriendo tachado, la escalera de Creator y la regla "un solo servicio
 * técnico por punto"). Fuera de Chile se conserva el armado que ya tenían las
 * cotizaciones de estos países (instalación agrupada por ubicación, la línea
 * bonificada aunque el cliente auto-instale, capacitación de México, ids del
 * artículo de Books) — unificarlo con el de Chile cambia lo que se EMITE y
 * es el paso siguiente, no este.
 *
 * PURO.
 */

import {
  cotizarReferencialConReglas,
  escalonSaneado,
  pctDelEscalon,
  precioServicio,
  tierAplicable,
  type ItemCot,
  type ModalidadHw,
  type ReglasCotizacion,
  type TierCot,
  type ZonaCot,
} from "./motor.ts"

export type PuntoPais = { ubicacion: string; zona: ZonaCot; autoInstalada: boolean }

export type EntradaPais = {
  userCount: number
  reloj?: { modalidad: ModalidadHw; cantidad: number }
  puntos?: PuntoPais[]
  escalonDescuento?: number
}

export type TextosFormal = {
  idArriendo: string
  idVenta: string
  modalidadItemArriendo: string
  itemArriendo: string
  itemArriendoFuera: string
  descArriendo: string
  itemVenta: string
  descVenta: string
  itemEnvio: (ubicacion: string) => string
  descEnvio?: (ubicacion: string) => string
  itemInstalacion: (ubicacion: string) => string
  descInstalacionBonificada: string
  descInstalacionCobrada: string
  /** Ítem de capacitación en toda cotización (México), a lista con subtotal 0. */
  capacitacion?: { id: string; nombre: string; descripcion: string; precioLista: number }
}

export type ItemFormal = {
  tipo: "plan" | "hardware" | "servicio"
  id: string
  nombre: string
  descripcion?: string
  modalidad: string
  cantidad: number
  precioUnitario: number
  subtotal: number
  esRecurrente: boolean
  afectoImpuesto: boolean
  descuentoPct?: number
}

export type LineaPais = { concepto: string; detalle: string; neto: number; impuesto: number; recurrente: boolean }

/** El país de las reglas lleva UN equipo (el reloj/equipo biométrico) con este id en el motor. */
export const ID_EQUIPO = "reloj"

export function tierPlanPais(R: ReglasCotizacion, nombrePais: string, userCount: number): TierCot {
  const asistencia = R.modulos.find((m) => m.id === "asistencia")
  const tier = asistencia ? tierAplicable(asistencia, userCount) : null
  if (!tier) {
    throw new Error(
      `El catálogo ${nombrePais} cubre de 1 a 50 usuarios (pedidos: ${userCount}); Vicky cotiza solo hasta 20 (umbral, igual que Chile). Sobre eso, derivar a un ejecutivo.`,
    )
  }
  return tier
}

export function precioPlanPais(R: ReglasCotizacion, nombrePais: string, userCount: number): number {
  const t = tierPlanPais(R, nombrePais, userCount)
  return t.modalidad === "fijo" ? t.precioUF : t.precioUF * userCount
}

function servicio(R: ReglasCotizacion, id: string) {
  const s = R.servicios.find((x) => x.id === id)
  if (!s) throw new Error(`Reglas sin servicio ${id}`)
  return s
}

function equipo(R: ReglasCotizacion) {
  const h = R.hardware.find((x) => x.id === ID_EQUIPO)
  if (!h) throw new Error("Reglas sin equipo")
  return h
}

/** Ítems de la cotización formal (a precio de LISTA; el % viaja como escalonDescuento). */
function itemsFormal(R: ReglasCotizacion, F: TextosFormal, tier: TierCot, input: EntradaPais): ItemFormal[] {
  const { userCount, reloj, puntos = [] } = input
  const h = equipo(R)
  const planLista = tier.modalidad === "fijo" ? tier.precioUF : tier.precioUF * userCount
  const impPlan = R.impuesto.soloEquipo ? 0 : R.impuesto.tasa
  const impServicio = impPlan
  const hayEquipo = Boolean(reloj && reloj.cantidad > 0)
  const esArriendo = hayEquipo && reloj!.modalidad === "arriendo"
  const esVenta = hayEquipo && reloj!.modalidad === "venta"
  const items: ItemFormal[] = [
    {
      tipo: "plan",
      id: "plan_asistencia",
      nombre: "Control de Asistencia",
      descripcion: "Marcaje web, app móvil con GPS y biometría. Gestión de turnos, vacaciones y horas extra. Reportería en línea.",
      modalidad: tier.modalidad === "fijo" ? "Fijo" : "Por usuario",
      cantidad: tier.modalidad === "fijo" ? 1 : userCount,
      precioUnitario: tier.modalidad === "fijo" ? planLista : tier.precioUF,
      subtotal: planLista,
      esRecurrente: true,
      afectoImpuesto: impPlan > 0,
    },
  ]
  const puntosFuera = puntos.filter((p) => p.zona !== "base")
  if (esArriendo) {
    const fueraCant = Math.min(reloj!.cantidad, puntosFuera.length)
    const baseCant = reloj!.cantidad - fueraCant
    const filas: Array<{ cant: number; unit: number; nombre: string }> = []
    if (baseCant > 0) filas.push({ cant: baseCant, unit: h.arriendoUF, nombre: F.itemArriendo })
    if (fueraCant > 0) filas.push({ cant: fueraCant, unit: h.arriendoFueraUF ?? h.arriendoUF, nombre: F.itemArriendoFuera })
    for (const f of filas) {
      items.push({
        tipo: "hardware",
        id: F.idArriendo,
        nombre: f.nombre,
        descripcion: F.descArriendo,
        modalidad: F.modalidadItemArriendo,
        cantidad: f.cant,
        precioUnitario: f.unit,
        subtotal: f.unit * f.cant,
        esRecurrente: true,
        afectoImpuesto: true,
      })
    }
  }
  if (F.capacitacion) {
    items.push({
      tipo: "servicio",
      id: F.capacitacion.id,
      nombre: F.capacitacion.nombre,
      descripcion: F.capacitacion.descripcion,
      modalidad: "Cobro único",
      cantidad: 1,
      precioUnitario: F.capacitacion.precioLista,
      subtotal: 0,
      esRecurrente: false,
      afectoImpuesto: impServicio > 0,
    })
  }
  // Puntos agrupados por ubicación y zona: un envío por punto y una visita por punto que la pidió.
  const grupos = new Map<string, { ubicacion: string; zona: ZonaCot; puntos: number; instalaciones: number }>()
  for (const p of puntos) {
    const k = `${p.ubicacion}|${p.zona}`
    const g = grupos.get(k) || { ubicacion: p.ubicacion, zona: p.zona, puntos: 0, instalaciones: 0 }
    g.puntos++
    if (!p.autoInstalada) g.instalaciones++
    grupos.set(k, g)
  }
  if (esVenta) {
    items.push({
      tipo: "hardware",
      id: F.idVenta,
      nombre: F.itemVenta,
      descripcion: F.descVenta,
      modalidad: "Venta única",
      cantidad: reloj!.cantidad,
      precioUnitario: h.ventaUF,
      subtotal: h.ventaUF * reloj!.cantidad,
      esRecurrente: false,
      afectoImpuesto: true,
    })
    const envio = servicio(R, "envio_reloj")
    for (const g of grupos.values()) {
      const unit = precioServicio(envio, g.zona, "venta")
      if (unit <= 0) continue
      items.push({
        tipo: "servicio",
        id: "envio_reloj",
        nombre: F.itemEnvio(g.ubicacion),
        ...(F.descEnvio ? { descripcion: F.descEnvio(g.ubicacion) } : {}),
        modalidad: "Cobro único",
        cantidad: g.puntos,
        precioUnitario: unit,
        subtotal: unit * g.puntos,
        esRecurrente: false,
        afectoImpuesto: impServicio > 0,
      })
    }
  }
  if (hayEquipo) {
    const inst = servicio(R, "instalacion_reloj")
    for (const g of grupos.values()) {
      const unit = precioServicio(inst, g.zona, reloj!.modalidad)
      const bonificada = R.instalacionBonificada(reloj!.modalidad, g.zona)
      if (!bonificada && g.instalaciones === 0) continue
      const cantidad = bonificada ? Math.max(1, g.instalaciones) : g.instalaciones
      items.push({
        tipo: "servicio",
        id: "instalacion_reloj",
        nombre: F.itemInstalacion(g.ubicacion),
        descripcion: bonificada ? F.descInstalacionBonificada : F.descInstalacionCobrada,
        modalidad: "Cobro único",
        cantidad,
        precioUnitario: unit,
        subtotal: bonificada ? 0 : unit * cantidad,
        esRecurrente: false,
        afectoImpuesto: impServicio > 0,
        ...(bonificada ? { descuentoPct: 100 } : {}),
      })
    }
  }
  return items
}

export type ResultadoPais = {
  lineas: LineaPais[]
  items: ItemFormal[]
  tier: TierCot
  planLista: number
  plan: number
  arriendoNeto: number
  arriendoImpuesto: number
  mensualNetoLista: number
  mensualNeto: number
  mensualImpuestoLista: number
  mensualImpuesto: number
  unicosNeto: number
  unicosImpuesto: number
  pagoInicialNeto: number
  pagoInicialImpuesto: number
  pagoInicialTotal: number
  descuentoPct: number
  escalonDescuento: number
  visitaTecnicaPedida: boolean
  mensaje: string
}

export function cotizarPais(R: ReglasCotizacion, F: TextosFormal, nombrePais: string, input: EntradaPais): ResultadoPais {
  const { userCount, reloj, puntos = [] } = input
  if (!Number.isFinite(userCount) || userCount < 1) throw new Error("userCount inválido")
  const tier = tierPlanPais(R, nombrePais, userCount)
  const hayEquipo = Boolean(reloj && reloj.cantidad > 0)
  const r = cotizarReferencialConReglas(
    R,
    {
      userCount,
      modulos: ["asistencia"],
      hardware: hayEquipo ? [{ id: ID_EQUIPO, cantidad: reloj!.cantidad, modalidad: reloj!.modalidad }] : [],
      puntosInstalacion: hayEquipo ? puntos.map((p) => ({ ubicacion: p.ubicacion, autoInstalada: p.autoInstalada, zona: p.zona })) : [],
      escalonDescuento: input.escalonDescuento,
    },
    null,
  )
  if (!r.ok) throw new Error(r.error)
  const tasa = R.impuesto.tasa
  const esRecurrente = (i: ItemCot) => i.modalidad === "Fijo" || i.modalidad === "Por usuario" || i.modalidad === "Arriendo mensual"
  const impLinea = (i: ItemCot) => (R.impuesto.soloEquipo && i.tipo !== "hardware" ? 0 : i.subtotal * tasa)
  const fmt = R.presentacion.monto
  const lineas: LineaPais[] = r.itemsConsolidados.map((i) => ({
    concepto: i.nombre,
    detalle: `${i.cantidad} × ${fmt(i.precioUnitario)}${i.descuentoPct === 100 ? " — bonificada" : ""}`,
    neto: i.subtotal,
    impuesto: impLinea(i),
    recurrente: esRecurrente(i),
  }))
  const arriendoNeto = r.itemsConsolidados
    .filter((i) => i.tipo === "hardware" && i.modalidad === "Arriendo mensual")
    .reduce((s, i) => s + i.subtotal, 0)
  return {
    lineas,
    items: itemsFormal(R, F, tier, input),
    tier,
    planLista: r.planLista,
    plan: r.plan,
    arriendoNeto,
    arriendoImpuesto: arriendoNeto * tasa,
    mensualNetoLista: r.subtotalRecurrente,
    mensualNeto: r.mensualNeto,
    mensualImpuestoLista: r.impuestoRecurrente,
    mensualImpuesto: r.mensualImpuesto,
    unicosNeto: r.subtotalUnico,
    unicosImpuesto: r.impuestoUnico,
    pagoInicialNeto: r.pagoInicialNeto,
    pagoInicialImpuesto: r.pagoInicialImpuesto,
    pagoInicialTotal: r.pagoInicialNeto + r.pagoInicialImpuesto,
    descuentoPct: r.descuentoPct,
    escalonDescuento: r.escalonDescuento,
    visitaTecnicaPedida: r.visitaTecnicaPedida,
    mensaje: r.mensajeParaProspecto,
  }
}

/** % del escalón (0 · 0,1 · 0,2) con la escalera del país. */
export function pctDescuentoPais(R: ReglasCotizacion, escalon: unknown): number {
  return pctDelEscalon(R, escalon)
}

export { escalonSaneado }
