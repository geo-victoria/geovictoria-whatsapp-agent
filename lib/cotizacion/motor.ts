/**
 * MOTOR ÚNICO DE COTIZACIÓN REFERENCIAL (26-sep, paso 2 de la unificación).
 *
 * Antes cada país tenía su motor (lib/paises/{pe,co,mx}/cotizar.ts, ~550
 * líneas cada uno) con la misma lógica copiada y divergencias que nadie
 * decidió: Perú escondía el "pago inicial único" cuando la instalación
 * cobrada iba con alquiler, Colombia dejaba el primer mes del alquiler fuera
 * del pago inicial (el cotizador sí lo cobra), el envío se contaba distinto
 * en cada uno. Acá la lógica vive UNA vez; el país aporta solo datos:
 * tramos del plan, tarifas, impuesto, moneda y vocabulario (ReglasMotor).
 *
 * Los archivos por país quedan como adaptadores de nombres (sus firmas
 * públicas no cambian) y se verifican contra los resultados congelados de
 * los motores viejos: mismos ítems y totales, peso por peso.
 *
 * PURO: sin imports de red; lo cargan los tests con node --test.
 *
 * Las reglas de negocio (idénticas a las de Chile salvo los datos):
 *   - Plan de asistencia por tramos; Vicky cotiza hasta 20 (el umbral lo
 *     aplican el prompt y la guarda del agent-loop, no este motor).
 *   - Equipo en arriendo: tarifa base en la zona principal y tarifa "fuera"
 *     (con el despacho incluido) para los equipos que van a otra zona. En
 *     venta, precio único + envío por punto según la zona (0 = incluido).
 *   - Instalación técnica por punto con precio cerrado por zona (base /
 *     intermedia / resto). En ARRIENDO en la zona base va BONIFICADA (línea a
 *     lista con descuento 100 %). La auto-instalación es gratis y va por
 *     defecto; la visita se cobra si el cliente la pide.
 *   - Descuento: escalera sobre el PLAN (nunca sobre el equipo), por N meses,
 *     solo ante objeción. Los ítems de la formal van a LISTA y el % viaja
 *     aparte como escalonDescuento.
 *   - Pago inicial = pagos únicos + PRIMER MES (plan con su descuento +
 *     arriendo) por adelantado, igual que el cotizador.
 *   - Mensaje: la forma de Chile. Sin equipo: resumen mensual. Con equipo:
 *     DOBLE VALOR (con equipo / solo app) y cierre "Qué opción prefieres?".
 */

export type ZonaMotor = "base" | "intermedia" | "resto"

export type PuntoMotor = {
  /** Ciudad/distrito/municipio como lo dijo el cliente. */
  ubicacion: string
  zona: ZonaMotor
  autoInstalada: boolean
}

export type EntradaMotor = {
  userCount: number
  reloj?: { modalidad: "arriendo" | "venta"; cantidad: number }
  puntos?: PuntoMotor[]
  escalonDescuento?: number
}

export type TierPlan = {
  minUsuarios: number
  maxUsuarios: number
  modalidad: "fijo" | "por_usuario"
  /** Precio en la moneda del país (el nombre del campo viene del catálogo chileno). */
  precioUF: number
}

/** Todo lo que distingue a un país. Solo DATOS y textos: la lógica es una. */
export type ReglasMotor = {
  /** "de Perú" / "de Colombia" / "de México" (mensaje de error de tramo). */
  nombrePais: string
  tiers: readonly TierPlan[]
  escalera: { planMensual: readonly number[]; meses: number }
  /** Decimales de la moneda (0 = pesos enteros, 2 = con centavos). */
  decimales: 0 | 2
  /** Redondeo del plan con descuento: Colombia a enteros, México a centavos, Perú sin redondear. */
  redondearPlanConDescuento: boolean
  formatear: (monto: number) => string
  impuesto: {
    tasa: number
    /** true = solo el equipo (arriendo y venta) lleva impuesto (Colombia). */
    soloEquipo: boolean
  }
  /**
   * Cómo se muestran los montos al cliente:
   *  - "neto": netos con sufijo (" + IGV" / " + IVA"), sin la aritmética del impuesto.
   *  - "final": precio final; solo el equipo suma su impuesto y se declara.
   */
  presentacion: "neto" | "final"
  /** " + IGV" · " + IVA" · "" */
  sufijo: string
  tarifas: {
    arriendoBase: number
    arriendoFuera: number
    venta: number
    /** Envío por punto en VENTA (0 = incluido). */
    envioVenta: { base: number; fuera: number }
    instalacion: { base: number; intermedia: number; resto: number }
  }
  textos: {
    /** "reloj" · "equipo" — sujeto de "marcar desde el …" y "El … es autoinstalable". */
    equipo: string
    /** "Reloj en alquiler" · "Equipo biométrico en alquiler" · "Reloj checador en renta" */
    modalidadArriendo: string
    modalidadVenta: string
    /** Frase cuando el envío no se cobra: " El envío del reloj va incluido." */
    envioIncluido: string
    /** "(alquiler en Lima Metropolitana)" — la instalación bonificada. */
    bonificadaEn: string
    /** Paréntesis del pago inicial único con el detalle ("" = sin paréntesis). */
    detallePagoInicial: (hayVenta: boolean, hayEnvio: boolean, hayInstalacion: boolean) => string
    /** Notas que van al final del mensaje, cada una en su burbuja. */
    notasFinales: string[]
    // ── Líneas (desglose) ──
    lineaArriendo: string
    lineaArriendoFuera: string
    lineaDespacho: string
    lineaVenta: string
    lineaEnvio: (ubicacion: string) => string
    lineaInstalacion: (ubicacion: string) => string
    zonaBaseEnvio: string
    zonaFueraEnvio: string
    bonificadaDetalle: string
    // ── Ítems de la formal ──
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
  }
  /** Ítem de capacitación incluido en TODA cotización (México), a lista con subtotal 0. */
  capacitacion?: {
    linea: { concepto: string; detalle: string }
    item: { id: string; nombre: string; descripcion: string; precioLista: number }
  }
  /** Post-proceso del mensaje (México: "reloj" → "reloj checador"). */
  postMensaje?: (texto: string) => string
}

export type LineaMotor = {
  concepto: string
  detalle: string
  neto: number
  impuesto: number
  recurrente: boolean
}

export type ItemMotor = {
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
  /** 100 = bonificada: se muestra tachada en $0. */
  descuentoPct?: number
}

export type ResultadoMotor = {
  lineas: LineaMotor[]
  items: ItemMotor[]
  tier: TierPlan
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
  /** Algún punto pidió visita técnica (Perú avisa a servicio técnico). */
  visitaTecnicaPedida: boolean
  mensaje: string
}

/** "a", "a y b", "a, b e instalación" — une el detalle del pago inicial. */
export function unirPartes(partes: string[]): string {
  if (partes.length <= 1) return partes.join("")
  const ultimo = partes[partes.length - 1]
  const y = /^h?i/i.test(ultimo) ? " e " : " y "
  return partes.slice(0, -1).join(", ") + y + ultimo
}

const redondear = (n: number, d: 0 | 2) => (d === 0 ? Math.round(n) : Math.round(n * 100) / 100)

export function escalonDescuento(reglas: ReglasMotor, escalon: unknown): number {
  return Math.max(0, Math.min(reglas.escalera.planMensual.length, Math.floor(Number(escalon) || 0)))
}

export function pctDescuento(reglas: ReglasMotor, escalon: unknown): number {
  const e = escalonDescuento(reglas, escalon)
  return e === 0 ? 0 : reglas.escalera.planMensual[e - 1]
}

export function tierPlan(reglas: ReglasMotor, userCount: number): TierPlan {
  const tier = reglas.tiers.find((t) => userCount >= t.minUsuarios && userCount <= t.maxUsuarios)
  if (!tier) {
    throw new Error(
      `El catálogo ${reglas.nombrePais} cubre de 1 a 50 usuarios (pedidos: ${userCount}); Vicky cotiza solo hasta 20 (umbral, igual que Chile). Sobre eso, derivar a un ejecutivo.`,
    )
  }
  return tier
}

export function precioPlan(reglas: ReglasMotor, userCount: number): number {
  const t = tierPlan(reglas, userCount)
  return t.modalidad === "fijo" ? t.precioUF : t.precioUF * userCount
}

export function cotizar(reglas: ReglasMotor, input: EntradaMotor): ResultadoMotor {
  const { userCount, reloj, puntos = [] } = input
  if (!Number.isFinite(userCount) || userCount < 1) throw new Error("userCount inválido")
  const R = reglas
  const T = R.textos
  const fmt = R.formatear
  const tasa = R.impuesto.tasa
  const impPlan = R.impuesto.soloEquipo ? 0 : tasa
  const impServicio = R.impuesto.soloEquipo ? 0 : tasa

  const tier = tierPlan(R, userCount)
  const planLista = precioPlan(R, userCount)
  const escalon = escalonDescuento(R, input.escalonDescuento)
  const pct = pctDescuento(R, escalon)
  const conDescuento = pct > 0
  const plan = conDescuento
    ? R.redondearPlanConDescuento
      ? redondear(planLista * (1 - pct), R.decimales)
      : planLista * (1 - pct)
    : planLista
  const meses = R.escalera.meses
  const hayEquipo = Boolean(reloj && reloj.cantidad > 0)
  const esArriendo = hayEquipo && reloj!.modalidad === "arriendo"
  const esVenta = hayEquipo && reloj!.modalidad === "venta"

  const lineas: LineaMotor[] = []
  lineas.push({
    concepto: "Control de Asistencia",
    detalle:
      (tier.modalidad === "fijo"
        ? `Plan mensual para hasta ${tier.maxUsuarios} usuarios (tarifa fija)`
        : `Plan mensual: ${userCount} usuarios × ${fmt(tier.precioUF)}`) +
      (conDescuento ? ` — con ${Math.round(pct * 100)}% de descuento por ${meses} meses (lista ${fmt(planLista)}/mes)` : ""),
    neto: plan,
    impuesto: plan * impPlan,
    recurrente: true,
  })

  // Equipos FUERA de la zona base (intermedia + resto): arriendo con la tarifa
  // que trae el despacho. Sin puntos declarados se cotiza como base.
  const puntosFuera = puntos.filter((p) => p.zona !== "base")
  const equiposFuera = hayEquipo ? Math.min(reloj!.cantidad, puntosFuera.length) : 0

  let arriendoNeto = 0
  let arriendoBaseCant = 0
  let arriendoFueraCant = 0
  if (esArriendo) {
    arriendoFueraCant = equiposFuera
    arriendoBaseCant = reloj!.cantidad - arriendoFueraCant
    arriendoNeto = R.tarifas.arriendoBase * arriendoBaseCant + R.tarifas.arriendoFuera * arriendoFueraCant
    const partes: string[] = []
    if (arriendoBaseCant > 0) partes.push(`${arriendoBaseCant} × ${fmt(R.tarifas.arriendoBase)}/mes`)
    if (arriendoFueraCant > 0) partes.push(`${arriendoFueraCant} × ${fmt(R.tarifas.arriendoFuera)}/mes ${T.lineaArriendoFuera}`)
    lineas.push({
      concepto: T.lineaArriendo,
      detalle: `${partes.join(" + ")} (${T.lineaDespacho} incluido)`,
      neto: arriendoNeto,
      impuesto: arriendoNeto * tasa,
      recurrente: true,
    })
  }
  const arriendoImpuesto = arriendoNeto * tasa

  // Puntos agrupados por ubicación y zona: un envío por punto y una visita por
  // punto que la pidió (nada de una fila por equipo).
  const grupos = new Map<string, { ubicacion: string; zona: ZonaMotor; puntos: number; instalaciones: number }>()
  for (const p of puntos) {
    const k = `${p.ubicacion}|${p.zona}`
    const g = grupos.get(k) || { ubicacion: p.ubicacion, zona: p.zona, puntos: 0, instalaciones: 0 }
    g.puntos++
    if (!p.autoInstalada) g.instalaciones++
    grupos.set(k, g)
  }

  // Instalación = la regla de Chile.
  const frases: string[] = []
  const instalaciones: Array<{ ubicacion: string; cantidad: number; unit: number; bonificada: boolean }> = []
  let visitaTecnicaPedida = false
  if (hayEquipo) {
    for (const g of grupos.values()) {
      const unit = R.tarifas.instalacion[g.zona]
      const bonificada = esArriendo && g.zona === "base"
      const pedida = g.instalaciones > 0
      if (pedida) visitaTecnicaPedida = true
      if (bonificada) {
        instalaciones.push({ ubicacion: g.ubicacion, cantidad: Math.max(1, g.instalaciones), unit, bonificada: true })
        frases.push(
          pedida
            ? `La instalación por nuestro equipo técnico va incluida sin costo ${T.bonificadaEn}.`
            : `La instalación por nuestro equipo técnico va incluida sin costo ${T.bonificadaEn}; si prefieres, el ${T.equipo} también es autoinstalable.`,
        )
      } else if (pedida) {
        instalaciones.push({ ubicacion: g.ubicacion, cantidad: g.instalaciones, unit, bonificada: false })
        frases.push(
          `La instalación por nuestro equipo técnico en ${g.ubicacion} tiene un costo único de ${fmt(unit * g.instalaciones)}${R.sufijo} (va en el pago inicial).`,
        )
      } else {
        frases.push(
          `El ${T.equipo} es autoinstalable. Si prefieres que nosotros lo instalemos, tiene un costo único adicional de ${fmt(unit)}${R.sufijo}.`,
        )
      }
    }
  }
  const fraseInstalacion = [...new Set(frases)].join(" ")

  // ── Pagos únicos ──
  if (R.capacitacion) {
    lineas.push({ ...R.capacitacion.linea, neto: 0, impuesto: 0, recurrente: false })
  }
  let ventaNeto = 0
  let envioNeto = 0
  const envios: Array<{ ubicacion: string; cantidad: number; unit: number }> = []
  if (esVenta) {
    ventaNeto = R.tarifas.venta * reloj!.cantidad
    lineas.push({
      concepto: T.lineaVenta,
      detalle: `${reloj!.cantidad} × ${fmt(R.tarifas.venta)}`,
      neto: ventaNeto,
      impuesto: ventaNeto * tasa,
      recurrente: false,
    })
    for (const g of grupos.values()) {
      const enBase = g.zona === "base"
      const unit = enBase ? R.tarifas.envioVenta.base : R.tarifas.envioVenta.fuera
      if (unit <= 0) continue
      envios.push({ ubicacion: g.ubicacion, cantidad: g.puntos, unit })
      envioNeto += unit * g.puntos
      lineas.push({
        concepto: T.lineaEnvio(g.ubicacion),
        detalle: `${g.puntos} × ${fmt(unit)} — ${enBase ? T.zonaBaseEnvio : T.zonaFueraEnvio}`,
        neto: unit * g.puntos,
        impuesto: unit * g.puntos * impServicio,
        recurrente: false,
      })
    }
  }
  let instalacionNeto = 0
  for (const li of instalaciones) {
    const neto = li.bonificada ? 0 : li.unit * li.cantidad
    instalacionNeto += neto
    lineas.push({
      concepto: T.lineaInstalacion(li.ubicacion),
      detalle: `${li.cantidad} × ${fmt(li.unit)}${li.bonificada ? ` — ${T.bonificadaDetalle}` : ""}`,
      neto,
      impuesto: neto * impServicio,
      recurrente: false,
    })
  }

  // ── Totales ──
  const unicos = lineas.filter((l) => !l.recurrente)
  const unicosNeto = unicos.reduce((s, l) => s + l.neto, 0)
  const unicosImpuesto = unicos.reduce((s, l) => s + l.impuesto, 0)
  const mensualNetoLista = planLista + arriendoNeto
  const mensualNeto = plan + arriendoNeto
  const mensualImpuestoLista = planLista * impPlan + arriendoImpuesto
  const mensualImpuesto = plan * impPlan + arriendoImpuesto
  // Pago inicial = únicos + PRIMER MES (plan con su descuento + arriendo).
  const pagoInicialNeto = unicosNeto + mensualNeto
  const pagoInicialImpuesto = unicosImpuesto + mensualImpuesto
  const pagoInicialTotal = pagoInicialNeto + pagoInicialImpuesto

  // ── Mensaje (la forma de Chile) ──
  // Lo que ve el cliente: "neto" = netos con sufijo; "final" = el equipo suma su impuesto.
  const ver = (neto: number, imp: number) => (R.presentacion === "final" ? neto + imp : neto)
  const verMensualLista = ver(mensualNetoLista, arriendoImpuesto)
  const verMensual = ver(mensualNeto, arriendoImpuesto)
  const notaImpEquipo = R.presentacion === "final" && arriendoNeto > 0 ? " (incluye el IVA del equipo)" : ""
  const dctoDesde = `desde el mes ${meses + 1}, ${fmt(verMensualLista)}${R.sufijo}/mes`

  let mensaje: string
  if (!hayEquipo) {
    const filas = [
      "Resumen mensual recurrente:",
      "",
      `- Control de Asistencia (${userCount} usuario${userCount === 1 ? "" : "s"}): ${fmt(planLista)}/mes`,
      "",
      `Total mensual: ${fmt(verMensualLista)}${R.sufijo}${notaImpEquipo}`,
    ]
    if (conDescuento) {
      filas.push(
        `Con el ${Math.round(pct * 100)}% de descuento en el plan durante ${meses} meses: ${fmt(verMensual)}${R.sufijo}/mes (${dctoDesde})`,
      )
    }
    for (const nota of T.notasFinales) filas.push("", "[---]", "", nota)
    mensaje = filas.join("\n")
  } else {
    // DOBLE VALOR: con equipo y solo con la app. La app va SIEMPRE incluida:
    // lo que se paga es el equipo. En COMPRA el mensual es el mismo en las dos,
    // así que la opción 2 no puede decir "más económica" (cicatriz CL 03-sep).
    const unicosVer = ver(unicosNeto, unicosImpuesto)
    const personas = `${userCount} persona${userCount === 1 ? "" : "s"}`
    const ahorraMensual = plan < verMensual - (R.decimales === 0 ? 1 : 0.01)
    const ahorraEntrada = unicosNeto > 0
    // El envío va incluido en arriendo, y en venta cuando no se cobró (zona sin tarifa).
    const envioIncluido = esArriendo || (envioNeto === 0 && R.tarifas.envioVenta.base === 0)
    const op1: string[] = [
      `1 - Para ${personas} te recomiendo ${esArriendo ? T.modalidadArriendo : T.modalidadVenta} + App:`,
      `💰 ${fmt(verMensual)}${R.sufijo} al mes${notaImpEquipo}.`,
      ``,
      `Tus trabajadores pueden marcar desde el ${T.equipo} o desde el celular, como les acomode.${envioIncluido ? T.envioIncluido : ""}`,
    ]
    if (fraseInstalacion) op1.push(fraseInstalacion)
    if (conDescuento) {
      op1.push(`Incluye el ${Math.round(pct * 100)}% de descuento en el plan durante ${meses} meses (${dctoDesde}).`)
    }
    if (ahorraEntrada) {
      op1.push(
        `Se suma un pago inicial único de ${fmt(unicosVer)}${R.sufijo}${T.detallePagoInicial(ventaNeto > 0, envioNeto > 0, instalacionNeto > 0)}.`,
      )
    }
    const encabezado2 = ahorraMensual
      ? "2.- Una alternativa más económica sería si marcan solo mediante nuestra app:"
      : ahorraEntrada
        ? "2.- Si prefieres partir sin desembolso inicial, marcando solo con nuestra app (misma mensualidad, sin el pago único):"
        : "2.- También puedes partir marcando solo con nuestra app:"
    const partes = [...op1, "", "[---]", "", encabezado2, `💰 ${fmt(plan)}${R.sufijo} al mes.`]
    for (const nota of T.notasFinales) partes.push("", "[---]", "", nota)
    partes.push("", "[---]", "", "Qué opción prefieres? Con la que elijas te genero la cotización formal de inmediato.")
    mensaje = partes.join("\n")
  }
  if (R.postMensaje) mensaje = R.postMensaje(mensaje)

  // ── Ítems de la formal (a precio de LISTA; el % viaja como escalonDescuento) ──
  const items: ItemMotor[] = [
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
  if (esArriendo) {
    const filas: Array<{ cant: number; unit: number; nombre: string }> = []
    if (arriendoBaseCant > 0) filas.push({ cant: arriendoBaseCant, unit: R.tarifas.arriendoBase, nombre: T.itemArriendo })
    if (arriendoFueraCant > 0) filas.push({ cant: arriendoFueraCant, unit: R.tarifas.arriendoFuera, nombre: T.itemArriendoFuera })
    for (const f of filas) {
      items.push({
        tipo: "hardware",
        id: T.idArriendo,
        nombre: f.nombre,
        descripcion: T.descArriendo,
        modalidad: T.modalidadItemArriendo,
        cantidad: f.cant,
        precioUnitario: f.unit,
        subtotal: f.unit * f.cant,
        esRecurrente: true,
        afectoImpuesto: true,
      })
    }
  }
  if (R.capacitacion) {
    items.push({
      tipo: "servicio",
      id: R.capacitacion.item.id,
      nombre: R.capacitacion.item.nombre,
      descripcion: R.capacitacion.item.descripcion,
      modalidad: "Cobro único",
      cantidad: 1,
      precioUnitario: R.capacitacion.item.precioLista,
      subtotal: 0,
      esRecurrente: false,
      afectoImpuesto: impServicio > 0,
    })
  }
  if (esVenta) {
    items.push({
      tipo: "hardware",
      id: T.idVenta,
      nombre: T.itemVenta,
      descripcion: T.descVenta,
      modalidad: "Venta única",
      cantidad: reloj!.cantidad,
      precioUnitario: R.tarifas.venta,
      subtotal: ventaNeto,
      esRecurrente: false,
      afectoImpuesto: true,
    })
    for (const e of envios) {
      items.push({
        tipo: "servicio",
        id: "envio_reloj",
        nombre: T.itemEnvio(e.ubicacion),
        ...(T.descEnvio ? { descripcion: T.descEnvio(e.ubicacion) } : {}),
        modalidad: "Cobro único",
        cantidad: e.cantidad,
        precioUnitario: e.unit,
        subtotal: e.unit * e.cantidad,
        esRecurrente: false,
        afectoImpuesto: impServicio > 0,
      })
    }
  }
  for (const li of instalaciones) {
    items.push({
      tipo: "servicio",
      id: "instalacion_reloj",
      nombre: T.itemInstalacion(li.ubicacion),
      descripcion: li.bonificada ? T.descInstalacionBonificada : T.descInstalacionCobrada,
      modalidad: "Cobro único",
      cantidad: li.cantidad,
      precioUnitario: li.unit,
      subtotal: li.bonificada ? 0 : li.unit * li.cantidad,
      esRecurrente: false,
      afectoImpuesto: impServicio > 0,
      ...(li.bonificada ? { descuentoPct: 100 } : {}),
    })
  }

  return {
    lineas,
    items,
    tier,
    planLista,
    plan,
    arriendoNeto,
    arriendoImpuesto,
    mensualNetoLista,
    mensualNeto,
    mensualImpuestoLista,
    mensualImpuesto,
    unicosNeto,
    unicosImpuesto,
    pagoInicialNeto,
    pagoInicialImpuesto,
    pagoInicialTotal,
    descuentoPct: pct,
    escalonDescuento: escalon,
    visitaTecnicaPedida,
    mensaje,
  }
}
