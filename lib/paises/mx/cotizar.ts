/**
 * Motor de cotización referencial de MÉXICO.
 *
 * Reglas de negocio (documento oficial de tropicalización MX):
 *   - Plan asistencia: 1-10 → $1,000 fijo · 11-20 → $83/usuario.
 *     RANGO DE VICKY = 1-20 (igual que Chile, Lalo 23-sep); 21-30 $79 y
 *     31-50 $75 quedan solo como excepción por contacto.
 *   - Reloj: renta $350/mes por unidad en la zona base (CDMX y Zona
 *     Metropolitana) · $400/mes fuera de ella CON EL ENVÍO INCLUIDO
 *     (homólogo del +0,05 UF de regiones en Chile) · venta $2,100.
 *   - ENVÍO en venta (por punto): $400 base / $560 fuera de la base. En
 *     renta va incluido. (Lalo 22-sep, propuesta aprobada.)
 *   - INSTALACIÓN técnica (por punto) = LOS VALORES DE CHILE en pesos:
 *     base $800 (1 UF) · intermedia $2,400 (3 UF) · resto $4,000 (5 UF). En
 *     RENTA en la base va BONIFICADA (línea a lista con descuento 100 %,
 *     patrón chileno del arriendo en RM). La auto-instalación es gratis
 *     siempre y va por defecto; la visita se cobra si el cliente la pide.
 *     Precio cerrado en toda zona: nunca "el ejecutivo la cotiza aparte".
 *   - CAPACITACIÓN online: incluida sin costo (Lalo 13-ago, sin mencionar $600) — ítem de
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

import { CATALOGO_MODULOS_MX } from "./catalogo.ts"
import type { ZonaMX } from "./geografia.ts"
export type { ZonaMX } from "./geografia.ts"

// IVA mexicano: 16% parejo en todos los conceptos (plan, activación,
// capacitación, hardware, envío e instalación). Solo lo escribe este motor.
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
  /** Capacitación online — se cobra $0 y desde el 13-ago (Lalo) el valor de
   * lista ya NO se menciona (ni tachado). Constante conservada por historia. */
  capacitacionOnline: 600,
} as const

function unitInstalacionMX(zona: ZonaMX): number {
  return zona === "cdmx_metro" ? TARIFAS_MX.instalacion.base : zona === "intermedia" ? TARIFAS_MX.instalacion.intermedia : TARIFAS_MX.instalacion.resto
}

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
      `El catálogo de México cubre de 1 a 50 usuarios (pedidos: ${userCount}); Vicky cotiza solo hasta 20 (umbral, igual que Chile). Sobre eso, derivar a un ejecutivo.`,
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

  // Relojes FUERA de la base (intermedia + resto): renta con envío y envío
  // cobrado en venta. Sin puntos declarados se cotiza como base.
  const puntosFuera = puntos.filter((p) => p.zona !== "cdmx_metro")
  const relojesFuera = reloj ? Math.min(reloj.cantidad, puntosFuera.length) : 0

  let arriendoNeto = 0
  let arriendoBaseCant = 0
  let arriendoFueraCant = 0
  if (reloj && reloj.modalidad === "arriendo" && reloj.cantidad > 0) {
    arriendoFueraCant = relojesFuera
    arriendoBaseCant = reloj.cantidad - arriendoFueraCant
    arriendoNeto = TARIFAS_MX.relojArriendoMes * arriendoBaseCant + TARIFAS_MX.relojArriendoMesFuera * arriendoFueraCant
    const partes: string[] = []
    if (arriendoBaseCant > 0) partes.push(`${arriendoBaseCant} × ${formatearMXN(TARIFAS_MX.relojArriendoMes)}/mes`)
    if (arriendoFueraCant > 0) partes.push(`${arriendoFueraCant} × ${formatearMXN(TARIFAS_MX.relojArriendoMesFuera)}/mes fuera de CDMX`)
    lineas.push({
      concepto: "Renta de reloj checador",
      detalle: `${partes.join(" + ")} (envío incluido)`,
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

  // INSTALACIÓN = LA REGLA DE CHILE (Lalo 22-sep): en renta en la base la
  // visita va INCLUIDA (línea bonificada) y se dice; en el resto el reloj es
  // autoinstalable y la visita se ofrece con su precio cerrado, o se cobra si
  // el cliente la pidió. Murió la nota "el ejecutivo la cotiza aparte".
  const notasEjecutivo: string[] = []
  const frasesInstalacion: string[] = []
  const lineasInstalacion: Array<{ ubicacion: string; zona: ZonaMX; cantidad: number; unit: number; bonificada: boolean }> = []
  let instalacionNeto = 0
  if (reloj && reloj.cantidad > 0) {
    const esRenta = reloj.modalidad === "arriendo"
    for (const g of grupos.values()) {
      const unit = unitInstalacionMX(g.zona)
      const bonificada = esRenta && g.zona === "cdmx_metro"
      const pedida = g.instalaciones > 0
      if (bonificada) {
        lineasInstalacion.push({ ubicacion: g.ubicacion, zona: g.zona, cantidad: Math.max(1, g.instalaciones), unit, bonificada: true })
        frasesInstalacion.push(
          pedida
            ? "La instalación por nuestro equipo técnico va incluida sin costo (renta en CDMX y Zona Metropolitana)."
            : "La instalación por nuestro equipo técnico va incluida sin costo (renta en CDMX y Zona Metropolitana); si prefieres, el reloj también es autoinstalable.",
        )
      } else if (pedida) {
        lineasInstalacion.push({ ubicacion: g.ubicacion, zona: g.zona, cantidad: g.instalaciones, unit, bonificada: false })
        instalacionNeto += unit * g.instalaciones
        frasesInstalacion.push(`La instalación por nuestro equipo técnico en ${g.ubicacion} tiene un costo único de ${formatearMXN(unit * g.instalaciones)} + IVA (va en el pago inicial).`)
      } else {
        frasesInstalacion.push(`El reloj es autoinstalable. Si prefieres que nosotros lo instalemos, tiene un costo único adicional de ${formatearMXN(unit)} + IVA.`)
      }
    }
  }
  const fraseInstalacion = [...new Set(frasesInstalacion)].join(" ")

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
    // Lalo 13-ago: el $600 desaparece del discurso — ni cobrado ni tachado.
    // La capacitación se presenta simplemente incluida sin costo.
    detalle: "Curso online de uso de la plataforma — incluida sin costo",
    neto: 0,
    iva: 0,
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
      const enBase = g.zona === "cdmx_metro"
      const envio = enBase ? TARIFAS_MX.envioVenta.base : TARIFAS_MX.envioVenta.fuera
      lineas.push({
        concepto: `Envío de reloj (${g.ubicacion})${g.envios > 1 ? ` × ${g.envios}` : ""}`,
        detalle:
          g.envios > 1
            ? `${enBase ? "CDMX y Zona Metropolitana" : "Fuera de CDMX"} — ${g.envios} × ${formatearMXN(envio)}`
            : enBase ? "CDMX y Zona Metropolitana" : "Fuera de CDMX",
        neto: envio * g.envios,
        iva: envio * g.envios * IVA_MX,
        recurrente: false,
      })
    }
  }
  // Instalación técnica (ambas modalidades): bonificada en $0 o cobrada.
  for (const li of lineasInstalacion) {
    lineas.push({
      concepto: `Instalación técnica del reloj (${li.ubicacion})`,
      detalle: li.bonificada ? `${li.cantidad} × ${formatearMXN(li.unit)} — bonificada en renta (CDMX y Zona Metropolitana)` : `${li.cantidad} × ${formatearMXN(li.unit)}`,
      neto: li.bonificada ? 0 : li.unit * li.cantidad,
      iva: li.bonificada ? 0 : li.unit * li.cantidad * IVA_MX,
      recurrente: false,
    })
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
    filas.push(`- Renta de reloj checador: ${formatearMXN(arriendoNeto)}/mes (envío incluido)`)
  }
  filas.push(`Total mensual: ${formatearMXN(mensualNeto)} + IVA (16%) = ${formatearMXN(mensualTotal)} MXN`)
  filas.push("")
  filas.push("Pago inicial (una sola vez):")
  for (const l of unicos) {
    if (l.neto === 0 && /Instalación técnica/.test(l.concepto)) {
      filas.push(`- ${l.concepto}: incluida sin costo`)
      continue
    }
    filas.push(`- ${l.concepto}: ${formatearMXN(l.neto)}`)
  }
  filas.push(
    `Total pago inicial: ${formatearMXN(pagoInicialNeto)} + IVA (16%) = ${formatearMXN(pagoInicialTotal)} MXN`,
  )
  // Frase de instalación con la forma de Chile (autoinstalable / incluida /
  // costo único cerrado), después del desglose.
  if (fraseInstalacion) {
    filas.push("")
    filas.push(fraseInstalacion)
  }
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
    const filasArr: Array<{ cant: number; unit: number; sufijo: string }> = []
    if (arriendoBaseCant > 0) filasArr.push({ cant: arriendoBaseCant, unit: TARIFAS_MX.relojArriendoMes, sufijo: "" })
    if (arriendoFueraCant > 0) filasArr.push({ cant: arriendoFueraCant, unit: TARIFAS_MX.relojArriendoMesFuera, sufijo: " (fuera de CDMX, envío incluido)" })
    for (const f of filasArr) {
      itemsCotizador.push({
        tipo: "hardware",
        id: "reloj_arriendo",
        nombre: `Renta de reloj checador${f.sufijo}`,
        descripcion:
          "Reloj biométrico de control de asistencia (facial y huella), con conexión WiFi y Ethernet. Envío incluido.",
        modalidad: "Renta mensual",
        cantidad: f.cant,
        precioUnitarioMXN: f.unit,
        subtotalMXN: f.unit * f.cant,
        esRecurrente: true,
        afectoIva: true,
      })
    }
  }
  // Capacitación online: incluida sin costo (Lalo 13-ago — sin nombrar el $600)
  // viaja como unitario para que PDF y aceptación lo muestren TACHADO, y el
  // subtotal $0 es lo que se cobra.
  itemsCotizador.push({
    tipo: "servicio",
    id: "capacitacion_online",
    nombre: "Capacitación online",
    descripcion: "Curso online de uso de la plataforma — incluida sin costo.",
    modalidad: "Cobro único",
    cantidad: 1,
    precioUnitarioMXN: TARIFAS_MX.capacitacionOnline,
    subtotalMXN: 0,
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
    // Envío por ubicación (tarifa base / fuera de la base).
    for (const g of grupos.values()) {
      const envio = g.zona === "cdmx_metro" ? TARIFAS_MX.envioVenta.base : TARIFAS_MX.envioVenta.fuera
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
    }
  }
  // Instalación técnica: ítem por punto (bonificada = lista con descuentoPct
  // 100, como el arriendo RM chileno; cobrada = pago único).
  for (const li of lineasInstalacion) {
    itemsCotizador.push({
      tipo: "servicio",
      id: "instalacion_reloj",
      nombre: `Instalación técnica del reloj (${li.ubicacion})`,
      descripcion: li.bonificada
        ? "Visita de instalación por nuestro equipo técnico. Bonificada en renta en CDMX y Zona Metropolitana."
        : "Visita de instalación por nuestro equipo técnico. Pago único.",
      modalidad: "Cobro único",
      cantidad: li.cantidad,
      precioUnitarioMXN: li.unit,
      subtotalMXN: li.bonificada ? 0 : li.unit * li.cantidad,
      esRecurrente: false,
      afectoIva: true,
      ...(li.bonificada ? { descuentoPct: 100 } : {}),
    })
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
