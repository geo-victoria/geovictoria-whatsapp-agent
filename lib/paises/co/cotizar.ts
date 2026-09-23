/**
 * Motor de cotización referencial de COLOMBIA.
 *
 * Reglas de negocio (cerradas con Lalo 09/10-jul):
 *   - Plan asistencia: 1-10 → $315.000 fijo · 11-20 → $13.700 por usuario.
 *     RANGO DE VICKY = 1-20 (igual que Chile, Lalo 23-sep); el 21-50 del
 *     catálogo es solo excepción por contacto.
 *   - Reloj: alquiler $86.000/mes por unidad en la zona base (Bogotá y
 *     conurbados) · $98.000/mes fuera de ella CON EL DESPACHO INCLUIDO
 *     (homólogo del +0,05 UF de regiones en Chile) · venta $620.000.
 *   - ENVÍO en venta (por punto): $42.000 base / $69.000 fuera de la base.
 *     En alquiler va incluido.
 *   - INSTALACIÓN técnica (por punto) = LOS VALORES DE CHILE en pesos
 *     (Lalo 22-sep): base $175.000 (1 UF) · intermedia $530.000 (3 UF) ·
 *     resto $875.000 (5 UF). En ALQUILER en la base va BONIFICADA (línea a
 *     lista con descuento 100 %, patrón chileno del arriendo en RM). La
 *     auto-instalación es gratis siempre y va por defecto; la visita se
 *     cobra si el cliente la pide. Precio cerrado en toda zona: nunca "se
 *     cotiza aparte". Supersede las tarifas del 09-jul.
 *   - ACTIVACIÓN: primer mes del plan cobrado por adelantado (equivalente
 *     del "pago inicial incluye el primer mes" chileno).
 *   - DESCUENTO = CHILE (Lalo 21-sep): escalera 10 → 20 % sobre el plan (y la
 *     Activación, que es un mes del plan) por 6 meses; el alquiler va a lista.
 *     Los ítems de la formal salen a LISTA y el % viaja como escalonDescuento.
 *   - IMPUESTOS (decisión 10-jul, refinada): los precios son FINALES en todo
 *     EXCEPTO el hardware — el reloj (arriendo y venta) lleva IVA 19%, único
 *     concepto donde el IVA existe y se muestra. Plan, activación, envío e
 *     instalación van con precio final (iva=0); retenciones y artículos
 *     tributarios no se mencionan jamás.
 *
 * El mensajeParaProspecto va en TUTEO cálido colombiano (feedback equipo CO 12-jul) y formato COP. Es la única
 * fuente de precios que Vicky CO puede comunicar (misma regla dura de Chile).
 */

import { CATALOGO_MODULOS_CO } from "./catalogo.ts"
import type { ZonaCO } from "./geografia.ts"
export type { ZonaCO } from "./geografia.ts"
import { ESCALERA_DESCUENTO_CO, escalonDescuentoCO, pctDescuentoCO } from "./descuento.ts"

// Refinamiento 10-jul (Lalo): precios FINALES en todo, EXCEPTO el hardware
// (reloj en arriendo y en venta), que lleva IVA 19% — único concepto donde se
// menciona IVA, y solo como lo escribe este motor.
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
  /**
   * Escalón de descuento del PLAN (escalera chilena, Lalo 21-sep): 0 = sin
   * descuento, 1 = 10 %, 2 = 20 %, por 6 meses. Rebaja el plan y la
   * Activación (primer mes del plan); el alquiler del equipo va a lista. Los
   * ítems para la formal salen SIEMPRE a precio de LISTA: el % viaja aparte
   * como `escalonDescuento` y el cotizador lo estampa en la cotización.
   */
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

/**
 * Item en el contrato del endpoint create-from-vicky-co del cotizador
 * (ver header de ese archivo). La Activación NO se envía: el endpoint la
 * garantiza solo (= 1 mes del plan, sin IVA).
 */
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

function unitInstalacionCO(zona: ZonaCO): number {
  return zona === "capital" ? TARIFAS_CO.instalacion.capital : zona === "intermedia" ? TARIFAS_CO.instalacion.intermedia : TARIFAS_CO.instalacion.resto
}

export function formatearCOP(monto: number): string {
  return "$" + Math.round(monto).toLocaleString("es-CO")
}

/** Precio mensual del plan de asistencia (COP, sin IVA). Lanza fuera de 1-50. */
/** Tramo del plan de asistencia CO para una dotación (fuente única: el catálogo). */
export function tierPlanCO(userCount: number): { modalidad: "fijo" | "por_usuario"; precioUF: number } {
  const asistencia = CATALOGO_MODULOS_CO.find((m) => m.id === "asistencia")
  if (!asistencia) throw new Error("Catálogo CO sin módulo asistencia")
  const tier = asistencia.tiers.find(
    (t) => userCount >= t.minUsuarios && userCount <= t.maxUsuarios,
  )
  if (!tier) {
    throw new Error(
      `El catálogo de Colombia cubre de 1 a 50 usuarios (pedidos: ${userCount}); Vicky cotiza solo hasta 20 (umbral, igual que Chile). Sobre eso, derivar a un ejecutivo.`,
    )
  }
  return { modalidad: tier.modalidad as "fijo" | "por_usuario", precioUF: tier.precioUF }
}

export function precioPlanCO(userCount: number): number {
  const tier = tierPlanCO(userCount)
  return tier.modalidad === "fijo" ? tier.precioUF : tier.precioUF * userCount
}

export function cotizarCO(input: CotizacionCOInput): {
  lineas: LineaCO[]
  itemsCotizador: ItemCotizadorCO[]
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
  const { userCount, reloj, puntos = [] } = input
  if (!Number.isFinite(userCount) || userCount < 1) {
    throw new Error("userCount inválido")
  }
  const planLista = precioPlanCO(userCount)
  // Precio por usuario del tramo (11-20): sale del catálogo, nunca literal
  // (23-sep: un cambio de lista dejó al literal 13.700 mintiendo; el precio
  // vive SOLO en el catálogo).
  const precioUsuario = tierPlanCO(userCount).precioUF
  const escalonDescuento = escalonDescuentoCO(input.escalonDescuento)
  const pctDescuento = pctDescuentoCO(escalonDescuento)
  const conDescuento = pctDescuento > 0
  // Plan con el descuento del escalón (COP enteros). La Activación es un mes
  // del plan, así que lleva el mismo descuento.
  const plan = conDescuento ? Math.round(planLista * (1 - pctDescuento)) : planLista
  const mesesDcto = ESCALERA_DESCUENTO_CO.meses
  const lineas: LineaCO[] = []

  // ── Recurrente ──
  lineas.push({
    concepto: "Control de Asistencia",
    detalle:
      (userCount <= 10
        ? `Plan mensual para hasta 10 usuarios (tarifa fija)`
        : `Plan mensual: ${userCount} usuarios × ${formatearCOP(precioUsuario)}`) +
      (conDescuento ? ` — con ${Math.round(pctDescuento * 100)}% de descuento por ${mesesDcto} meses (lista ${formatearCOP(planLista)}/mes)` : ""),
    neto: plan,
    iva: 0,
    recurrente: true,
  })

  // Equipos FUERA de la base (intermedia + resto): alquiler con despacho y
  // envío cobrado en venta. Sin puntos declarados se cotiza como base.
  const puntosFuera = puntos.filter((p) => p.zona !== "capital")
  const relojesFuera = reloj ? Math.min(reloj.cantidad, puntosFuera.length) : 0

  let arriendoNeto = 0
  let arriendoBaseCant = 0
  let arriendoFueraCant = 0
  if (reloj && reloj.modalidad === "arriendo" && reloj.cantidad > 0) {
    arriendoFueraCant = relojesFuera
    arriendoBaseCant = reloj.cantidad - arriendoFueraCant
    arriendoNeto = TARIFAS_CO.relojArriendoMes * arriendoBaseCant + TARIFAS_CO.relojArriendoMesFuera * arriendoFueraCant
    const partes: string[] = []
    if (arriendoBaseCant > 0) partes.push(`${arriendoBaseCant} × ${formatearCOP(TARIFAS_CO.relojArriendoMes)}/mes`)
    if (arriendoFueraCant > 0) partes.push(`${arriendoFueraCant} × ${formatearCOP(TARIFAS_CO.relojArriendoMesFuera)}/mes fuera de Bogotá`)
    lineas.push({
      concepto: "Alquiler de equipo biométrico",
      detalle: `${partes.join(" + ")} (despacho incluido)`,
      neto: arriendoNeto,
      iva: arriendoNeto * IVA_HARDWARE,
      recurrente: true,
    })
  }

  // ── Agrupación de puntos por ubicación/zona (para instalación en ambas
  // modalidades y envío en venta) ──
  const grupos = new Map<string, { ubicacion: string; zona: ZonaCO; envios: number; instalaciones: number }>()
  for (const punto of puntos) {
    const key = `${punto.ubicacion}|${punto.zona}`
    const g = grupos.get(key) || { ubicacion: punto.ubicacion, zona: punto.zona, envios: 0, instalaciones: 0 }
    g.envios++
    if (!punto.autoInstalada) g.instalaciones++
    grupos.set(key, g)
  }

  // INSTALACIÓN = LA REGLA DE CHILE: en alquiler en la base va INCLUIDA (línea
  // bonificada) y se dice; en el resto el equipo es autoinstalable y la visita
  // se ofrece con su precio cerrado, o se cobra si el cliente la pidió.
  const frasesInstalacion: string[] = []
  const lineasInstalacion: Array<{ ubicacion: string; zona: ZonaCO; cantidad: number; unit: number; bonificada: boolean }> = []
  if (reloj && reloj.cantidad > 0) {
    const esArriendo = reloj.modalidad === "arriendo"
    for (const g of grupos.values()) {
      const unit = unitInstalacionCO(g.zona)
      const bonificada = esArriendo && g.zona === "capital"
      const pedida = g.instalaciones > 0
      if (bonificada) {
        lineasInstalacion.push({ ubicacion: g.ubicacion, zona: g.zona, cantidad: Math.max(1, g.instalaciones), unit, bonificada: true })
        frasesInstalacion.push(
          pedida
            ? "La instalación por nuestro equipo técnico va incluida sin costo (alquiler en Bogotá y alrededores)."
            : "La instalación por nuestro equipo técnico va incluida sin costo (alquiler en Bogotá y alrededores); si prefieres, el equipo también es autoinstalable.",
        )
      } else if (pedida) {
        lineasInstalacion.push({ ubicacion: g.ubicacion, zona: g.zona, cantidad: g.instalaciones, unit, bonificada: false })
        frasesInstalacion.push(`La instalación por nuestro equipo técnico en ${g.ubicacion} tiene un costo único de ${formatearCOP(unit * g.instalaciones)} (va en el pago inicial).`)
      } else {
        frasesInstalacion.push(`El equipo es autoinstalable. Si prefieres que nosotros lo instalemos, tiene un costo único adicional de ${formatearCOP(unit)}.`)
      }
    }
  }
  const fraseInstalacion = [...new Set(frasesInstalacion)].join(" ")

  // ── Pago único ──
  // Activación: primer mes del plan por adelantado.
  lineas.push({
    concepto: "Activación",
    detalle: "Pago de iniciación: equivale al primer mes de servicio",
    neto: plan,
    iva: 0,
    recurrente: false,
  })

  if (reloj && reloj.modalidad === "venta" && reloj.cantidad > 0) {
    const ventaNeto = TARIFAS_CO.relojVenta * reloj.cantidad
    lineas.push({
      concepto: "Equipo biométrico (compra)",
      detalle: `${reloj.cantidad} × ${formatearCOP(TARIFAS_CO.relojVenta)}`,
      neto: ventaNeto,
      iva: ventaNeto * IVA_HARDWARE,
      recurrente: false,
    })
    // Envío en venta: base / fuera de la base, agrupado por ZONA TARIFARIA
    // (feedback Lalo 23-jul, caso 12 sedes: no una fila por sede).
    const zonasEnvio = new Map<"base" | "fuera", number>()
    for (const punto of puntos) {
      const k = punto.zona === "capital" ? "base" : "fuera"
      zonasEnvio.set(k, (zonasEnvio.get(k) || 0) + 1)
    }
    const unSoloPunto = puntos.length === 1 ? puntos[0] : null
    for (const [k, n] of zonasEnvio.entries()) {
      const zonaTxt = k === "base" ? "Bogotá y alrededores" : "Fuera de Bogotá"
      const rotulo = unSoloPunto ? ` (${unSoloPunto.ubicacion})` : ` (${n} sede${n === 1 ? "" : "s"}, ${zonaTxt.toLowerCase()})`
      const envio = k === "base" ? TARIFAS_CO.envioVenta.capital : TARIFAS_CO.envioVenta.fuera
      lineas.push({
        concepto: `Envío de equipo${n > 1 ? "s" : ""} biométrico${n > 1 ? "s" : ""}${rotulo}`,
        detalle: n > 1 ? `${n} × ${formatearCOP(envio)}` : zonaTxt,
        neto: envio * n,
        iva: 0,
        recurrente: false,
      })
    }
  }
  // Instalación técnica (ambas modalidades): bonificada en $0 o cobrada.
  for (const li of lineasInstalacion) {
    lineas.push({
      concepto: `Instalación técnica del equipo (${li.ubicacion})`,
      detalle: li.bonificada ? `${li.cantidad} × ${formatearCOP(li.unit)} — bonificada en alquiler (Bogotá y alrededores)` : `${li.cantidad} × ${formatearCOP(li.unit)}`,
      neto: li.bonificada ? 0 : li.unit * li.cantidad,
      iva: 0,
      recurrente: false,
    })
  }

  // ── Totales ──
  const unicos = lineas.filter((l) => !l.recurrente)
  const pagoInicialNeto = unicos.reduce((s, l) => s + l.neto, 0)
  const pagoInicialIva = unicos.reduce((s, l) => s + l.iva, 0)
  const pagoInicialTotal = pagoInicialNeto + pagoInicialIva
  const mensualArriendoIva = arriendoNeto * IVA_HARDWARE
  const mensualTotal = plan + arriendoNeto + mensualArriendoIva
  const mensualTotalLista = planLista + arriendoNeto + mensualArriendoIva

  // ── Mensaje canónico (tuteo colombiano, COP) — LA FORMA DE CHILE ──
  // (Lalo 21-sep para Perú, 23-sep para Colombia: "hazlo igual de simple que
  // el flujo chileno"). Tres reglas que allá son duras:
  //   · la línea que hace la ARITMÉTICA del impuesto no va (Eduardo 14-ago):
  //     se muestra el total, nunca "neto + IVA = total". En Colombia solo el
  //     equipo lleva IVA, así que el total mensual se dice con el IVA del
  //     equipo ya adentro y se declara entre paréntesis;
  //   · SIN PAGOS ÚNICOS NO SE HABLA DE "PAGO INICIAL": la Activación es el
  //     primer mes del plan, así que con solo plan (o plan + alquiler) el
  //     primer pago ES la mensualidad. El pago inicial aparece solo con
  //     compra de equipo (equipo, envío, instalación);
  //   · con equipo, DOBLE VALOR determinista (opción con equipo y opción solo
  //     app) y cierre "Qué opción prefieres?" — el modelo no arma comparaciones.
  const mensualListaTotal = planLista + arriendoNeto + mensualArriendoIva
  const mensualConDctoTotal = plan + arriendoNeto + mensualArriendoIva
  const unicosSinActivacion = unicos.filter((l) => l.concepto !== "Activación")
  const unicosSinActivacionTotal = unicosSinActivacion.reduce((s, l) => s + l.neto + l.iva, 0)
  const envioTotal = unicosSinActivacion.filter((l) => /^Envío/.test(l.concepto)).reduce((s, l) => s + l.neto, 0)
  const instalacionCobrada = lineasInstalacion.some((li) => !li.bonificada)
  const notaIvaEquipo = arriendoNeto > 0 ? " (incluye el IVA del equipo)" : ""
  const notasFinales: string[] = [
    "La capacitación online (valorada en $95.000) va incluida sin costo 🎁",
  ]

  const filas: string[] = []
  filas.push("Resumen mensual recurrente:")
  filas.push("")
  filas.push(`- Control de Asistencia (${userCount} usuario${userCount === 1 ? "" : "s"}): ${formatearCOP(planLista)}/mes`)
  if (arriendoNeto > 0) {
    filas.push(`- Alquiler de equipo biométrico: ${formatearCOP(arriendoNeto + mensualArriendoIva)}/mes con IVA (despacho incluido)`)
  }
  filas.push("")
  filas.push(`Total mensual: ${formatearCOP(mensualListaTotal)}${notaIvaEquipo}`)
  if (conDescuento) {
    filas.push(
      `Con el ${Math.round(pctDescuento * 100)}% de descuento en el plan durante ${mesesDcto} meses: ${formatearCOP(mensualConDctoTotal)}/mes (desde el mes ${mesesDcto + 1}, ${formatearCOP(mensualListaTotal)}/mes)`,
    )
  }
  if (unicosSinActivacion.length > 0) {
    filas.push("")
    filas.push("Pago único:")
    filas.push("")
    for (const l of unicosSinActivacion) {
      if (l.neto === 0 && /Instalación técnica/.test(l.concepto)) {
        filas.push(`- ${l.concepto}: incluida sin costo`)
        continue
      }
      filas.push(`- ${l.concepto}: ${formatearCOP(l.neto + l.iva)}${l.iva > 0 ? " con IVA" : ""}`)
    }
    filas.push("")
    filas.push(`Total único: ${formatearCOP(unicosSinActivacionTotal)}`)
    filas.push("")
    filas.push("[---]")
    filas.push("")
    filas.push(
      `Al aceptar pagas el pago inicial de ${formatearCOP(pagoInicialTotal)}: incluye el equipo${envioTotal > 0 ? ", el envío" : ""}${instalacionCobrada ? ", la instalación" : ""} + el primer mes del plan por adelantado.`,
    )
  }
  if (fraseInstalacion) {
    filas.push("")
    filas.push("[---]")
    filas.push("")
    filas.push(fraseInstalacion)
  }
  for (const nota of notasFinales) {
    filas.push("")
    filas.push("[---]")
    filas.push("")
    filas.push(nota)
  }

  // ── DOBLE VALOR: con equipo y solo con app (misma regla de Chile/Perú:
  // cualquier configuración con equipo muestra las DOS opciones en el mismo
  // turno). La app va SIEMPRE incluida: lo que se paga es el equipo. Con el
  // equipo en COMPRA el mensual es el MISMO en las dos, y el encabezado no
  // puede decir "más económica": lo que cambia es el desembolso inicial.
  let mensaje = filas.join("\n")
  if (reloj && reloj.cantidad > 0) {
    const planSolo = conDescuento ? plan : planLista
    const mensualElegido = conDescuento ? mensualConDctoTotal : mensualListaTotal
    const modalidadLabel = reloj.modalidad === "arriendo" ? "Equipo biométrico en alquiler" : "Equipo biométrico en compra"
    const personas = `${userCount} persona${userCount === 1 ? "" : "s"}`
    const ahorraMensual = planSolo < mensualElegido - 1
    const ahorraEntrada = unicosSinActivacionTotal > 0
    const op1: string[] = [
      `1 - Para ${personas} te recomiendo ${modalidadLabel} + App:`,
      `💰 ${formatearCOP(mensualElegido)} al mes${notaIvaEquipo}.`,
      ``,
      `Tus trabajadores pueden marcar desde el equipo o desde el celular, como les acomode.${envioTotal > 0 ? "" : " El despacho del equipo va incluido."}`,
    ]
    if (fraseInstalacion) op1.push(fraseInstalacion)
    if (conDescuento) {
      op1.push(
        `Incluye el ${Math.round(pctDescuento * 100)}% de descuento en el plan durante ${mesesDcto} meses (desde el mes ${mesesDcto + 1}, ${formatearCOP(mensualListaTotal)} al mes).`,
      )
    }
    if (ahorraEntrada) {
      op1.push(
        `Se suma un pago inicial único de ${formatearCOP(unicosSinActivacionTotal)} (equipo con IVA${envioTotal > 0 ? ", envío" : ""}${instalacionCobrada ? " e instalación" : ""}).`,
      )
    }
    const encabezado2 = ahorraMensual
      ? `2.- Una alternativa más económica sería si marcan solo mediante nuestra app:`
      : ahorraEntrada
        ? `2.- Si prefieres partir sin desembolso inicial, marcando solo con nuestra app (misma mensualidad, sin el pago único):`
        : `2.- También puedes partir marcando solo con nuestra app:`
    const partes = [...op1, "", "[---]", "", encabezado2, `💰 ${formatearCOP(planSolo)} al mes.`]
    for (const nota of notasFinales) {
      partes.push("")
      partes.push("[---]")
      partes.push("")
      partes.push(nota)
    }
    partes.push("")
    partes.push("[---]")
    partes.push("")
    partes.push("Qué opción prefieres? Con la que elijas te genero la cotización formal de inmediato.")
    mensaje = partes.join("\n")
  }

  // ── Items para la cotización FORMAL (contrato create-from-vicky-co) ──
  // Misma matemática que las líneas de arriba, en formato del endpoint. La
  // Activación no va: la garantiza el endpoint (= 1 mes del plan, sin IVA).
  const itemsCotizador: ItemCotizadorCO[] = []
  itemsCotizador.push({
    tipo: "plan",
    id: "plan_asistencia",
    nombre: "Control de Asistencia",
    descripcion:
      "Marcaje web, app móvil con GPS y biometría. Gestión de turnos, vacaciones y horas extra. Reportería en línea.",
    modalidad: userCount <= 10 ? "Fijo" : "Por usuario",
    cantidad: userCount <= 10 ? 1 : userCount,
    // A precio de LISTA: el descuento viaja como escalonDescuento y el
    // cotizador lo estampa (Descuento_Recurrente_Pct) — misma mecánica que CL/PE.
    precioUnitarioCOP: userCount <= 10 ? planLista : precioUsuario,
    subtotalCOP: planLista,
    esRecurrente: true,
    afectoIva: false,
  })
  if (reloj && reloj.modalidad === "arriendo" && reloj.cantidad > 0) {
    const filasArr: Array<{ cant: number; unit: number; sufijo: string }> = []
    if (arriendoBaseCant > 0) filasArr.push({ cant: arriendoBaseCant, unit: TARIFAS_CO.relojArriendoMes, sufijo: "" })
    if (arriendoFueraCant > 0) filasArr.push({ cant: arriendoFueraCant, unit: TARIFAS_CO.relojArriendoMesFuera, sufijo: " (fuera de Bogotá, despacho incluido)" })
    for (const f of filasArr) {
      itemsCotizador.push({
        tipo: "hardware",
        id: "reloj_arriendo",
        nombre: `Alquiler de equipo biométrico${f.sufijo}`,
        descripcion:
          "Equipo biométrico de control de asistencia (facial y huella), con conexión WiFi y Ethernet. Despacho incluido.",
        modalidad: "Arriendo mensual",
        cantidad: f.cant,
        precioUnitarioCOP: f.unit,
        subtotalCOP: f.unit * f.cant,
        esRecurrente: true,
        afectoIva: true,
      })
    }
  }
  if (reloj && reloj.modalidad === "venta" && reloj.cantidad > 0) {
    itemsCotizador.push({
      tipo: "hardware",
      id: "reloj_venta",
      nombre: "Equipo biométrico (compra)",
      descripcion:
        "Equipo biométrico de control de asistencia (facial y huella), con conexión WiFi y Ethernet.",
      modalidad: "Venta única",
      cantidad: reloj.cantidad,
      precioUnitarioCOP: TARIFAS_CO.relojVenta,
      subtotalCOP: TARIFAS_CO.relojVenta * reloj.cantidad,
      esRecurrente: false,
      afectoIva: true,
    })
    // Envío por ubicación (tarifa base / fuera de la base).
    for (const g of grupos.values()) {
      const envio = g.zona === "capital" ? TARIFAS_CO.envioVenta.capital : TARIFAS_CO.envioVenta.fuera
      itemsCotizador.push({
        tipo: "servicio",
        id: "envio_reloj",
        nombre: `Envío de equipo biométrico (${g.ubicacion})`,
        modalidad: "Cobro único",
        cantidad: g.envios,
        precioUnitarioCOP: envio,
        subtotalCOP: envio * g.envios,
        esRecurrente: false,
        afectoIva: false,
      })
    }
  }
  // Instalación técnica: ítem por punto (bonificada = lista con descuentoPct
  // 100, como el arriendo RM chileno; cobrada = pago único).
  for (const li of lineasInstalacion) {
    itemsCotizador.push({
      tipo: "servicio",
      id: "instalacion_reloj",
      nombre: `Instalación técnica del equipo (${li.ubicacion})`,
      descripcion: li.bonificada
        ? "Visita de instalación por nuestro equipo técnico. Bonificada en alquiler en Bogotá y alrededores."
        : "Visita de instalación por nuestro equipo técnico. Pago único.",
      modalidad: "Cobro único",
      cantidad: li.cantidad,
      precioUnitarioCOP: li.unit,
      subtotalCOP: li.bonificada ? 0 : li.unit * li.cantidad,
      esRecurrente: false,
      afectoIva: false,
      ...(li.bonificada ? { descuentoPct: 100 } : {}),
    })
  }

  return {
    lineas,
    itemsCotizador,
    mensualNetoPlan: plan,
    mensualArriendoNeto: arriendoNeto,
    mensualArriendoIva,
    mensualTotal,
    mensualTotalLista,
    pagoInicialNeto,
    pagoInicialIva,
    pagoInicialTotal,
    descuentoPct: pctDescuento,
    escalonDescuento,
    mensajeParaProspecto: mensaje,
  }
}
