/**
 * Motor de cotización referencial de MÉXICO.
 *
 * Reglas de negocio (documento oficial de tropicalización MX):
 *   - Plan asistencia: 1-15 → $1,200 fijo · 16-20 → $83/usuario (Karen De la
 *     Garza, VB Lalo 24-sep).
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
 *   - PAGO INICIAL = pagos únicos + PRIMER MES del plan (y renta) por
 *     adelantado — patrón de Chile, Perú y Colombia (24-sep; antes en MX eran
 *     solo los pagos únicos). Sin fila de Activación: el primer mes lo arma
 *     el cotizador desde los recurrentes.
 *   - DESCUENTO = CHILE (Lalo 24-sep): escalera 10 → 20 % SOLO sobre el plan,
 *     6 meses, un escalón por objeción (mx/descuento.ts). Los ítems de la
 *     formal van a LISTA y el % viaja como escalonDescuento.
 *   - IMPUESTOS: IVA 16% (¡no 19!) en TODOS los conceptos. Al cliente se le
 *     muestran los NETOS con "+ IVA" (misma presentación que Perú: sin la
 *     aritmética del impuesto); los totales con IVA van al cotizador.
 *
 * El mensajeParaProspecto va en TUTEO mexicano cálido y formato MXN
 * (es-MX: miles con coma). Es la única fuente de precios que Vicky MX puede
 * comunicar (misma regla dura de Chile).
 */

import { CATALOGO_MODULOS_MX } from "./catalogo.ts"
import { nombreEquipoMX } from "./nombre-equipo.ts"
import { ESCALERA_DESCUENTO_MX, escalonDescuentoMX, pctDescuentoMX } from "./descuento.ts"
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

/** MXN con centavos solo cuando los hay ($1,200 · $1,195.20). */
export function formatearMXN(monto: number): string {
  const n = Math.round(Number(monto || 0) * 100) / 100
  const conCentavos = Math.abs(n - Math.round(n)) > 0.004
  return "$" + n.toLocaleString("es-MX", { minimumFractionDigits: conCentavos ? 2 : 0, maximumFractionDigits: 2 })
}

function redondear2(n: number): number {
  return Math.round(Number(n || 0) * 100) / 100
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
  const { userCount, reloj, puntos = [] } = input
  if (!Number.isFinite(userCount) || userCount < 1) {
    throw new Error("userCount inválido")
  }
  const tier = tierPlanMX(userCount)
  const planLista = precioPlanMX(userCount)
  const escalonDescuento = escalonDescuentoMX(input.escalonDescuento)
  const pctDescuento = pctDescuentoMX(escalonDescuento)
  const conDescuento = pctDescuento > 0
  const mesesDcto = ESCALERA_DESCUENTO_MX.meses
  // Plan con el descuento del escalón (MXN a centavos).
  const plan = conDescuento ? redondear2(planLista * (1 - pctDescuento)) : planLista
  const tope = tier.maxUsuarios
  const lineas: LineaMX[] = []

  // ── Recurrente ──
  lineas.push({
    concepto: "Control de Asistencia",
    detalle:
      (tier.modalidad === "fijo"
        ? `Plan mensual para hasta ${tope} usuarios (tarifa fija)`
        : `Plan mensual: ${userCount} usuarios × ${formatearMXN(tier.precioUF)}`) +
      (conDescuento ? ` — con ${Math.round(pctDescuento * 100)}% de descuento por ${mesesDcto} meses (lista ${formatearMXN(planLista)}/mes)` : ""),
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
  // SIN fila de Activación: el primer mes adelantado lo suman los totales de
  // abajo (y el cotizador desde los recurrentes), patrón CL/PE/CO (24-sep).
  // Capacitación online: incluida sin costo en toda cotización.
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
        concepto: `Envío de reloj checador (${g.ubicacion})${g.envios > 1 ? ` × ${g.envios}` : ""}`,
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
      concepto: `Instalación técnica del reloj checador (${li.ubicacion})`,
      detalle: li.bonificada ? `${li.cantidad} × ${formatearMXN(li.unit)} — bonificada en renta (CDMX y Zona Metropolitana)` : `${li.cantidad} × ${formatearMXN(li.unit)}`,
      neto: li.bonificada ? 0 : li.unit * li.cantidad,
      iva: li.bonificada ? 0 : li.unit * li.cantidad * IVA_MX,
      recurrente: false,
    })
  }

  // ── Totales ──
  // Pago inicial = pagos únicos + PRIMER MES (plan con su descuento + renta),
  // patrón de Chile, Perú y Colombia.
  const unicos = lineas.filter((l) => !l.recurrente)
  const unicosNeto = unicos.reduce((s, l) => s + l.neto, 0)
  const mensualArriendoIva = arriendoNeto * IVA_MX
  const mensualNeto = plan + arriendoNeto
  const mensualIva = mensualNeto * IVA_MX
  const mensualTotal = mensualNeto + mensualIva
  const mensualNetoLista = planLista + arriendoNeto
  const mensualTotalLista = mensualNetoLista * (1 + IVA_MX)
  const pagoInicialNeto = unicosNeto + mensualNeto
  const pagoInicialIva = pagoInicialNeto * IVA_MX
  const pagoInicialTotal = pagoInicialNeto + pagoInicialIva
  const ventaNeto = unicos.filter((l) => /compra/i.test(l.concepto)).reduce((s, l) => s + l.neto, 0)
  const envioNeto = unicos.filter((l) => /^Envío/.test(l.concepto)).reduce((s, l) => s + l.neto, 0)
  const instalacionNetoCobrada = unicos.filter((l) => /Instalación técnica/.test(l.concepto)).reduce((s, l) => s + l.neto, 0)
  const notasFinales = ["La capacitación online va incluida sin costo 🎁"]

  // ── Mensaje canónico (tuteo mexicano, MXN) — LA FORMA DE CHILE ──
  // Mismas reglas que Perú y Colombia: precios NETOS con "+ IVA" (sin la
  // aritmética del impuesto); sin pagos únicos NO se habla de "pago inicial"
  // (el primer pago ES la mensualidad); con reloj, DOBLE VALOR determinista
  // (opción con reloj y opción solo app) y cierre "Qué opción prefieres?".
  const filas: string[] = []
  filas.push("Resumen mensual recurrente:")
  filas.push("")
  filas.push(`- Control de Asistencia (${userCount} usuario${userCount === 1 ? "" : "s"}): ${formatearMXN(planLista)}/mes`)
  if (arriendoNeto > 0) {
    filas.push(`- Renta de reloj checador: ${formatearMXN(arriendoNeto)}/mes (envío incluido)`)
  }
  filas.push("")
  filas.push(`Total mensual: ${formatearMXN(mensualNetoLista)} + IVA`)
  if (conDescuento) {
    filas.push(
      `Con el ${Math.round(pctDescuento * 100)}% de descuento en el plan durante ${mesesDcto} meses: ${formatearMXN(mensualNeto)} + IVA/mes (desde el mes ${mesesDcto + 1}, ${formatearMXN(mensualNetoLista)} + IVA/mes)`,
    )
  }
  const unicosCobrados = unicos.filter((l) => !/Capacitación/.test(l.concepto))
  if (unicosNeto > 0 || unicosCobrados.some((l) => /Instalación técnica/.test(l.concepto))) {
    filas.push("")
    filas.push("Pago único:")
    filas.push("")
    for (const l of unicosCobrados) {
      if (l.neto === 0 && /Instalación técnica/.test(l.concepto)) {
        filas.push(`- ${l.concepto}: incluida sin costo`)
        continue
      }
      filas.push(`- ${l.concepto}: ${formatearMXN(l.neto)}`)
    }
    if (unicosNeto > 0) {
      filas.push("")
      filas.push(`Total único: ${formatearMXN(unicosNeto)} + IVA`)
      filas.push("")
      filas.push("[---]")
      filas.push("")
      filas.push(
        `Al aceptar pagas el pago inicial de ${formatearMXN(pagoInicialNeto)} + IVA: incluye ${ventaNeto > 0 ? "el reloj" : "los pagos únicos"}${envioNeto > 0 ? ", el envío" : ""}${instalacionNetoCobrada > 0 ? ", la instalación" : ""} + el primer mes del plan por adelantado.`,
      )
    }
  }
  if (fraseInstalacion) {
    filas.push("")
    filas.push("[---]")
    filas.push("")
    filas.push(fraseInstalacion)
  }
  for (const nota of [...notasEjecutivo, ...notasFinales]) {
    filas.push("")
    filas.push("[---]")
    filas.push("")
    filas.push(nota)
  }

  // ── DOBLE VALOR: con reloj y solo con app (regla de Chile/Perú/Colombia).
  // Con el reloj en COMPRA el mensual es el MISMO en las dos: el encabezado
  // no puede decir "más económica"; lo que cambia es el desembolso inicial.
  let mensaje = filas.join("\n")
  if (reloj && reloj.cantidad > 0) {
    const modalidadLabel = reloj.modalidad === "arriendo" ? "Reloj checador en renta" : "Reloj checador en compra"
    const personas = `${userCount} persona${userCount === 1 ? "" : "s"}`
    const ahorraMensual = plan < mensualNeto - 0.01
    const ahorraEntrada = unicosNeto > 0
    const op1: string[] = [
      `1 - Para ${personas} te recomiendo ${modalidadLabel} + App:`,
      `💰 ${formatearMXN(mensualNeto)} + IVA al mes.`,
      ``,
      `Tus trabajadores pueden marcar desde el reloj o desde el celular, como les acomode.${reloj.modalidad === "arriendo" ? " El envío del reloj va incluido." : ""}`,
    ]
    if (fraseInstalacion) op1.push(fraseInstalacion)
    if (conDescuento) {
      op1.push(
        `Incluye el ${Math.round(pctDescuento * 100)}% de descuento en el plan durante ${mesesDcto} meses (desde el mes ${mesesDcto + 1}, ${formatearMXN(mensualNetoLista)} + IVA/mes).`,
      )
    }
    if (ahorraEntrada) {
      op1.push(`Se suma un pago inicial único de ${formatearMXN(unicosNeto)} + IVA (reloj${envioNeto > 0 ? ", envío" : ""}${instalacionNetoCobrada > 0 ? " e instalación" : ""}).`)
    }
    const encabezado2 = ahorraMensual
      ? `2.- Una alternativa más económica sería si marcan solo mediante nuestra app:`
      : ahorraEntrada
        ? `2.- Si prefieres partir sin desembolso inicial, marcando solo con nuestra app (misma mensualidad, sin el pago único):`
        : `2.- También puedes partir marcando solo con nuestra app:`
    const partes = [...op1, "", "[---]", "", encabezado2, `💰 ${formatearMXN(plan)} + IVA al mes.`]
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
    // A precio de LISTA: el descuento viaja como escalonDescuento y el
    // cotizador lo estampa (Descuento_Recurrente_Pct) — misma mecánica que CL/PE/CO.
    precioUnitarioMXN: tier.modalidad === "fijo" ? planLista : tier.precioUF,
    subtotalMXN: planLista,
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
    mensualIva: redondear2(mensualIva),
    mensualTotal: redondear2(mensualTotal),
    mensualTotalLista: redondear2(mensualTotalLista),
    mensualNeto: redondear2(mensualNeto),
    mensualNetoLista: redondear2(mensualNetoLista),
    pagoInicialNeto: redondear2(pagoInicialNeto),
    pagoInicialIva: redondear2(pagoInicialIva),
    pagoInicialTotal: redondear2(pagoInicialTotal),
    descuentoPct: pctDescuento,
    escalonDescuento,
    // "reloj" a secas jamás en México (Lalo 24-sep): "reloj checador" o "checador".
    mensajeParaProspecto: nombreEquipoMX(mensaje),
  }
}
