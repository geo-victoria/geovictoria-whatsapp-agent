/**
 * Motor de cotización referencial de PERÚ.
 *
 * Reglas de negocio (excel Tropicalizacion_Vicky_2, 04-ago):
 *   - Plan asistencia: 1-10 → S/100 fijo · 11-20 → S/200 fijo ·
 *     21-50 → S/5/usuario. (Anomalía 21+ documentada en pe/catalogo.ts:
 *     literal del excel, aprobada.)
 *   - Reloj: precio de LISTA en USD (RELOJ_PE_USD: arriendo US$24/mes ·
 *     venta US$90) convertido a SOLES ENTEROS con el dólar venta SUNAT del
 *     día (`tipoCambio` de la entrada). El tipo de cambio queda en la
 *     cotización para que el cotizador y la nota de venta lo conozcan.
 *   - Envío: S/0 en LIMA METROPOLITANA. A PROVINCIA lo ASUME EL CLIENTE
 *     (VB Diego 05-ago): sin línea de cobro; se informa en nota.
 *   - Instalación (doc "Políticas de cobro visitas e instalaciones",
 *     11-ago — supersede el "Lima gratis" del excel): en Lima rige el
 *     TARIFARIO POR DISTRITO (zona azul S/0; resto US$20-50 + IGV, lo
 *     coordina y factura servicio técnico APARTE — sin línea de checkout).
 *     FUERA de Lima no se cotiza: se coordina con servicio técnico. La
 *     auto-instalación es gratis siempre. Aviso a ssttperu@geovictoria.pro
 *     en todo punto con visita técnica. La venta nunca se frena.
 *   - Capacitación: NO existe en Perú (ni cobrada ni de regalo).
 *   - PAGO INICIAL (patrón CL/CO): pagos únicos (reloj en venta) + PRIMER
 *     MES del plan por adelantado, todo neto + IGV. Luego facturación
 *     mensual según usuarios activos.
 *   - IMPUESTOS: IGV 18% en TODOS los conceptos (los fijos también). Los
 *     totales al prospecto van CON IGV (neto + IGV = total).
 *   - DESCUENTO = CHILE (Lalo 17-sep): escalera 10 % → 20 % sobre el PLAN
 *     mensual (el arriendo del reloj NO se descuenta), por 6 meses, solo ante
 *     objeción de precio. `escalonDescuento` 1 = 10 %, 2 = 20 %. El primer
 *     mes del pago inicial ya va con el descuento; desde el mes 7, lista.
 *
 * El mensajeParaProspecto va en peruano neutro (tuteo cordial) y formato
 * PEN ("S/318.60"). Es la única fuente de precios que Vicky PE comunica.
 *
 * Ejemplo (lista 17-sep, TC 3,372): 15 personas + reloj arriendo Lima =
 * S/82,5 + S/81 = S/163,50 neto → S/192,93/mes con IGV; con 10 % en el plan
 * S/183,20 los primeros 6 meses.
 */

import { CATALOGO_MODULOS_PE, ESCALERA_DESCUENTO_PE, RELOJ_PE_USD, tarifaVisitaLimaPE } from "./catalogo.ts"
import { TC_USD_PEN_FALLBACK, usdASoles } from "./tc-sunat.ts"

// IGV peruano: 18% parejo en todos los conceptos. Solo lo escribe este motor.
const IGV_PE = 0.18

export type ZonaPE = "lima" | "provincias"

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
  /**
   * Escalón de descuento del PLAN (escalera chilena): 0 = sin descuento,
   * 1 = 10 %, 2 = 20 %. Solo ante objeción de precio.
   */
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

/**
 * Item en el contrato del endpoint create-from-vicky-pe del cotizador
 * (misma forma que CO/MX). El envío nunca viaja (S/0); la instalación
 * JAMÁS viaja como ítem — su tarifa (US$ + IGV por distrito) la factura
 * servicio técnico aparte y en la cotización va como nota. La fila de
 * ACTIVACIÓN (primer mes por adelantado) la agrega el endpoint, patrón CO.
 */
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
}

/** Tarifas del reloj EN SOLES para un tipo de cambio dado (soles enteros). */
export function tarifasRelojPE(tipoCambio: number) {
  const tc = Number.isFinite(tipoCambio) && tipoCambio > 0 ? tipoCambio : TC_USD_PEN_FALLBACK
  return {
    relojArriendoMes: usdASoles(RELOJ_PE_USD.arriendoMes, tc),
    relojVenta: usdASoles(RELOJ_PE_USD.venta, tc),
    tipoCambio: tc,
  }
}

/** % de descuento del plan para un escalón (0 → 0, 1 → 0,1, 2 → 0,2). */
export function pctDescuentoPE(escalonDescuento: number): number {
  const e = Math.max(0, Math.min(ESCALERA_DESCUENTO_PE.planMensual.length, Math.floor(Number(escalonDescuento) || 0)))
  return e === 0 ? 0 : ESCALERA_DESCUENTO_PE.planMensual[e - 1]
}

/** "S/318.60" · "S/270" — soles con 2 decimales solo si hay fracción. */
export function formatearPEN(monto: number): string {
  const r = Math.round(monto * 100) / 100
  return "S/" + (Number.isInteger(r) ? r.toLocaleString("es-PE") : r.toFixed(2))
}

/** Tier del plan aplicable a un userCount (para detalle e items). */
function tierPlanPE(userCount: number) {
  const asistencia = CATALOGO_MODULOS_PE.find((m) => m.id === "asistencia")
  if (!asistencia) throw new Error("Catálogo PE sin módulo asistencia")
  const tier = asistencia.tiers.find(
    (t) => userCount >= t.minUsuarios && userCount <= t.maxUsuarios,
  )
  if (!tier) {
    throw new Error(
      `El plan de Perú cubre de 1 a 50 usuarios (pedidos: ${userCount}). Sobre 50, derivar a un ejecutivo.`,
    )
  }
  return tier
}

/** Precio mensual del plan (PEN neto, sin IGV). Lanza fuera de 1-50. */
export function precioPlanPE(userCount: number): number {
  const tier = tierPlanPE(userCount)
  return tier.modalidad === "fijo" ? tier.precioUF : tier.precioUF * userCount
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
  /** true si algún punto necesita visita técnica coordinada por servicio
   *  técnico (Lima con tarifa, Lima no reconocido, o provincia): la capa de
   *  tools avisa a ssttperu@geovictoria.pro. */
  avisoSsttPeru: boolean
  mensajeParaProspecto: string
} {
  const { userCount, reloj, puntos = [] } = input
  if (!Number.isFinite(userCount) || userCount < 1) {
    throw new Error("userCount inválido")
  }
  const TARIFAS_PE = tarifasRelojPE(Number(input.tipoCambio))
  const escalonDescuento = Math.max(0, Math.min(ESCALERA_DESCUENTO_PE.planMensual.length, Math.floor(Number(input.escalonDescuento) || 0)))
  const pctDescuento = pctDescuentoPE(escalonDescuento)
  const conDescuento = pctDescuento > 0
  const tier = tierPlanPE(userCount)
  const plan = precioPlanPE(userCount)
  const lineas: LineaPE[] = []

  // ── Recurrente ──
  lineas.push({
    concepto: "Control de Asistencia",
    detalle:
      tier.modalidad === "fijo"
        ? `Plan mensual (tarifa fija hasta ${tier.maxUsuarios} usuarios)`
        : `Plan mensual: ${userCount} usuarios × ${formatearPEN(tier.precioUF)}`,
    neto: plan,
    igv: plan * IGV_PE,
    recurrente: true,
  })

  // ENVÍO SEGÚN ZONA REAL (21-sep, caso de prueba con el reloj en Piura): el
  // texto decía "envío sin costo en Lima Metropolitana" en TODA cotización,
  // así que a un cliente de provincia le llegaba junto a la nota que dice que
  // el envío lo asume él — contradicción en el mismo mensaje.
  const hayProvincia = puntos.some((p) => p.zona === "provincias")
  const envioIncluidoTxt = hayProvincia ? "" : " (envío incluido)"

  let arriendoNeto = 0
  if (reloj && reloj.modalidad === "arriendo" && reloj.cantidad > 0) {
    arriendoNeto = TARIFAS_PE.relojArriendoMes * reloj.cantidad
    lineas.push({
      concepto: "Arriendo de reloj de control",
      detalle: `${reloj.cantidad} × ${formatearPEN(TARIFAS_PE.relojArriendoMes)}/mes${envioIncluidoTxt}`,
      neto: arriendoNeto,
      igv: arriendoNeto * IGV_PE,
      recurrente: true,
    })
  }

  // ── Agrupación de puntos por ubicación/zona (patrón CO/MX heredado) ──
  const grupos = new Map<
    string,
    { ubicacion: string; zona: ZonaPE; instalaciones: number }
  >()
  for (const punto of puntos) {
    const key = `${punto.ubicacion}|${punto.zona}`
    const g = grupos.get(key) || { ubicacion: punto.ubicacion, zona: punto.zona, instalaciones: 0 }
    if (!punto.autoInstalada) g.instalaciones++
    grupos.set(key, g)
  }

  // Instalación: en LIMA rige el tarifario por distrito de servicio técnico
  // (doc "Políticas de cobro visitas e instalaciones", 11-ago — solo la zona
  // azul es sin costo; el resto US$ + IGV, se coordina y factura APARTE con
  // servicio técnico, jamás como línea del checkout en soles). FUERA de Lima
  // no se cotiza: se coordina con servicio técnico. La auto-instalación es
  // gratis siempre. Aviso interno a sstt en todo punto con visita técnica
  // que ellos deban coordinar (Lima con tarifa, Lima no reconocido, o
  // provincia).
  const notasEjecutivo: string[] = []
  let avisoSsttPeru = false
  if (reloj && reloj.cantidad > 0) {
    for (const g of grupos.values()) {
      if (g.zona === "provincias") {
        // Envío a provincia: lo asume el CLIENTE (VB Diego 05-ago; Lalo
        // 11-ago: "normalmente se los entregan en Lima y ellos los llevan").
        notasEjecutivo.push(
          `El envío del reloj a ${g.ubicacion} corre por cuenta del cliente (lo usual: te lo entregamos en Lima y tú lo llevas — también coordinamos el despacho si lo prefieres).`,
        )
        if (g.instalaciones > 0) {
          avisoSsttPeru = true
          notasEjecutivo.push(
            `La instalación en ${g.ubicacion} se coordina con nuestro servicio técnico y se cotiza aparte (te contactarán para agendarla). También puedes instalarlo tú sin costo — es sencillo y te guiamos.`,
          )
        }
      } else if (g.instalaciones > 0) {
        const tarifa = tarifaVisitaLimaPE(g.ubicacion)
        if (tarifa.reconocido && tarifa.usd === 0) {
          // Zona azul: instalación incluida — no necesita nota ni aviso.
        } else if (tarifa.reconocido) {
          avisoSsttPeru = true
          notasEjecutivo.push(
            `La instalación con visita técnica en ${g.ubicacion} tiene un costo de US$${tarifa.usd} + IGV según el tarifario oficial de servicio técnico — se coordina y factura aparte con ellos (te contactarán para agendarla). También puedes instalarlo tú sin costo — es sencillo y te guiamos.`,
          )
        } else {
          avisoSsttPeru = true
          notasEjecutivo.push(
            `La instalación en ${g.ubicacion} la coordina nuestro servicio técnico, que te confirmará si tiene costo según el distrito. También puedes instalarlo tú sin costo — es sencillo y te guiamos.`,
          )
        }
      }
    }
  }

  // ── Pago único ──
  // Envío: sin línea de cobro (Lima Metropolitana gratis; provincia lo asume
  // el cliente — queda en nota). Instalación Lima: S/0 (incluida) → sin
  // línea. Capacitación: no existe en Perú. Solo el reloj en VENTA genera
  // pago único de catálogo; la ACTIVACIÓN (primer mes adelantado) se suma
  // como concepto del pago inicial (patrón CL/CO).
  let ventaNeto = 0
  if (reloj && reloj.modalidad === "venta" && reloj.cantidad > 0) {
    ventaNeto = TARIFAS_PE.relojVenta * reloj.cantidad
    lineas.push({
      concepto: "Reloj de control (compra)",
      detalle: `${reloj.cantidad} × ${formatearPEN(TARIFAS_PE.relojVenta)} (envío sin costo en Lima Metropolitana)`,
      neto: ventaNeto,
      igv: ventaNeto * IGV_PE,
      recurrente: false,
    })
  }

  // ── Totales (mostrados CON IGV 18%) ──
  const mensualNeto = plan + arriendoNeto
  const mensualIgv = mensualNeto * IGV_PE
  const mensualTotal = mensualNeto + mensualIgv
  // Descuento = Chile: el % aplica SOLO al plan (el arriendo del reloj va a
  // lista), durante ESCALERA_DESCUENTO_PE.meses meses.
  const planConDescuento = plan * (1 - pctDescuento)
  const mensualNetoConDescuento = planConDescuento + arriendoNeto
  const mensualTotalConDescuento = conDescuento ? mensualNetoConDescuento * (1 + IGV_PE) : 0
  // Pago inicial = pagos únicos + PRIMER MES por adelantado (con el descuento
  // si el cliente lo aceptó: el primer mes es parte de los 6).
  const primerMesNeto = conDescuento ? mensualNetoConDescuento : mensualNeto
  const pagoInicialNeto = ventaNeto + primerMesNeto
  const pagoInicialIgv = pagoInicialNeto * IGV_PE
  const pagoInicialTotal = pagoInicialNeto + pagoInicialIgv

  // ── Mensaje canónico (peruano neutro, PEN) ──
  const filas: string[] = []
  // FORMA DEL BLOQUE DE PRECIO = LA DE CHILE (Lalo 21-sep: "la forma de mostrar
  // los precios es distinta en Chile"). Tres reglas que allá son duras:
  //   · la línea que hace la ARITMÉTICA del impuesto no va (Eduardo 14-ago):
  //     se muestra el total CON IGV, no "neto + IGV (18%) = total";
  //   · el subtotal sin impuesto aparece SOLO con dos o más líneas (con una
  //     sola repite el mismo número);
  //   · SIN PAGOS ÚNICOS NO SE HABLA DE "PAGO INICIAL": si todo es recurrente,
  //     el primer mes ES la mensualidad y repetirla hace parecer un cobro
  //     extra. El pago inicial solo aparece cuando hay compra de reloj.
  const lineasRec: string[] = [
    `- Control de Asistencia (${userCount} usuario${userCount === 1 ? "" : "s"}): ${formatearPEN(plan)}/mes`,
  ]
  if (arriendoNeto > 0) {
    lineasRec.push(`- Arriendo de reloj de control: ${formatearPEN(arriendoNeto)}/mes${envioIncluidoTxt}`)
  }
  filas.push("Resumen mensual recurrente:")
  filas.push("")
  filas.push(lineasRec.join("\n"))
  filas.push("")
  if (lineasRec.length >= 2) filas.push(`Subtotal sin IGV: ${formatearPEN(mensualNeto)}`)
  filas.push(`Total mensual con IGV: ${formatearPEN(mensualTotal)}`)
  if (conDescuento) {
    filas.push(
      `Con el ${Math.round(pctDescuento * 100)}% de descuento en el plan durante ${ESCALERA_DESCUENTO_PE.meses} meses: ${formatearPEN(mensualTotalConDescuento)}/mes (desde el mes ${ESCALERA_DESCUENTO_PE.meses + 1}, ${formatearPEN(mensualTotal)}/mes)`,
    )
  }

  if (ventaNeto > 0) {
    const ventaTotal = ventaNeto * (1 + IGV_PE)
    filas.push("")
    filas.push("Pago único:")
    filas.push("")
    filas.push(`- Reloj de control (compra): ${formatearPEN(ventaNeto)}`)
    filas.push("")
    filas.push(`Total único con IGV: ${formatearPEN(ventaTotal)}`)
    // Burbuja propia para el pago inicial (patrón chileno): el desglose
    // primero, lo que paga al aceptar como mensaje aparte.
    filas.push("")
    filas.push("[---]")
    filas.push("")
    filas.push(
      `Al aceptar pagas el pago inicial de ${formatearPEN(pagoInicialTotal)}: incluye el reloj + el primer mes del plan por adelantado.`,
    )
  }

  // Las notas (envío a provincia, instalación con visita técnica) van en su
  // propia burbuja, no pegadas al desglose.
  if (notasEjecutivo.length > 0) {
    filas.push("")
    filas.push("[---]")
    for (const nota of notasEjecutivo) {
      filas.push("")
      filas.push(`Nota: ${nota}`)
    }
  }

  // ── DOBLE VALOR: con reloj y solo con app (Lalo 21-sep: "lo de mostrar la
  // opción con app y luego la opción con reloj") ─────────────────────────────
  // Réplica de la regla chilena (Rodrigo 10-ago, formato compacto de Eduardo
  // 17-ago): CUALQUIER configuración con reloj muestra las DOS opciones en el
  // mismo turno, determinista desde la tool — el modelo no arma comparaciones
  // ni llama dos veces. La app va SIEMPRE incluida: lo que se paga es el
  // equipo. Si el reloj va en COMPRA el mensual es el MISMO en las dos
  // opciones, y entonces el encabezado no puede decir "más económica": lo que
  // cambia es que la app sola no tiene pago inicial (cicatriz CL 03-sep).
  let mensaje = filas.join("\n")
  if (reloj && reloj.cantidad > 0) {
    const planSoloNeto = conDescuento ? planConDescuento : plan
    const planSoloTotal = planSoloNeto * (1 + IGV_PE)
    const mensualElegido = conDescuento ? mensualTotalConDescuento : mensualTotal
    const modalidadLabel = reloj.modalidad === "arriendo" ? "Reloj en arriendo" : "Reloj en compra"
    const personas = `${userCount} persona${userCount === 1 ? "" : "s"}`
    const ahorraMensual = planSoloTotal < mensualElegido - 0.01
    const ahorraEntrada = ventaNeto > 0

    const op1: string[] = [
      `1 - Para ${personas} te recomiendo ${modalidadLabel} + App:`,
      `💰 ${formatearPEN(mensualElegido)} al mes, IGV incluido.`,
      ``,
      `Tus trabajadores pueden marcar desde el reloj o desde el celular, como les acomode.`,
    ]
    if (conDescuento) {
      op1.push(
        `Incluye el ${Math.round(pctDescuento * 100)}% de descuento en el plan durante ${ESCALERA_DESCUENTO_PE.meses} meses (desde el mes ${ESCALERA_DESCUENTO_PE.meses + 1}, ${formatearPEN(mensualTotal)}/mes).`,
      )
    }
    if (ventaNeto > 0) {
      op1.push(`Se suma un pago inicial único de ${formatearPEN(pagoInicialTotal)} (incluye el reloj y el primer mes del plan).`)
    }
    const encabezado2 = ahorraMensual
      ? `2.- Una alternativa más económica sería si marcan solo mediante nuestra app:`
      : ahorraEntrada
        ? `2.- Si prefieres partir sin desembolso inicial, marcando solo con nuestra app (misma mensualidad, sin el pago único):`
        : `2.- También puedes partir marcando solo con nuestra app:`
    const partes = [
      ...op1,
      "",
      "[---]",
      "",
      encabezado2,
      `💰 ${formatearPEN(planSoloTotal)} al mes, IGV incluido.`,
    ]
    // Las notas (envío a provincia, instalación con visita técnica) siguen
    // yendo en su propia burbuja, después de las dos opciones.
    for (const nota of notasEjecutivo) {
      partes.push("")
      partes.push("[---]")
      partes.push("")
      partes.push(`Nota: ${nota}`)
    }
    partes.push("")
    partes.push("[---]")
    partes.push("")
    partes.push("Qué opción prefieres? Con la que elijas te genero la cotización formal de inmediato.")
    mensaje = partes.join("\n")
  }

  // ── Items para la cotización FORMAL (contrato create-from-vicky-pe) ──
  // Misma matemática que las líneas, en formato del endpoint. El plan va a
  // precio de LISTA: el % viaja aparte como `escalonDescuento` y el cotizador
  // lo estampa en la cotización (Descuento_Recurrente_Pct), igual que Chile.
  // La Activación (primer mes adelantado, ya con descuento) la manda la tool.
  const itemsCotizador: ItemCotizadorPE[] = []
  itemsCotizador.push({
    tipo: "plan",
    id: "plan_asistencia",
    nombre: "Control de Asistencia",
    descripcion:
      "Marcaje web, app móvil con GPS y biometría. Gestión de turnos, vacaciones y horas extra. Reportería en línea.",
    modalidad: tier.modalidad === "fijo" ? "Fijo" : "Por usuario",
    cantidad: tier.modalidad === "fijo" ? 1 : userCount,
    precioUnitarioPEN: tier.modalidad === "fijo" ? plan : tier.precioUF,
    subtotalPEN: plan,
    esRecurrente: true,
    afectoIgv: true,
  })
  if (reloj && reloj.modalidad === "arriendo" && reloj.cantidad > 0) {
    itemsCotizador.push({
      tipo: "hardware",
      // Mismo id para arriendo y venta: la Modalidad distingue (convención
      // chilena `senseface_2a`); en Creator/Books es el artículo [PER] 304.
      id: "reloj_pe",
      nombre: "Arriendo de reloj de control",
      descripcion:
        `Reloj biométrico de control de asistencia (facial y huella), con conexión WiFi y Ethernet. Envío sin costo en Lima Metropolitana. Tarifa de lista US$${RELOJ_PE_USD.arriendoMes}/mes al tipo de cambio SUNAT del día (S/${TARIFAS_PE.tipoCambio}).`,
      modalidad: "Arriendo mensual",
      cantidad: reloj.cantidad,
      precioUnitarioPEN: TARIFAS_PE.relojArriendoMes,
      subtotalPEN: arriendoNeto,
      esRecurrente: true,
      afectoIgv: true,
    })
  }
  if (reloj && reloj.modalidad === "venta" && reloj.cantidad > 0) {
    itemsCotizador.push({
      tipo: "hardware",
      id: "reloj_pe",
      nombre: "Reloj de control (compra)",
      descripcion:
        `Reloj biométrico de control de asistencia (facial y huella), con conexión WiFi y Ethernet. Envío sin costo en Lima Metropolitana. Tarifa de lista US$${RELOJ_PE_USD.venta} al tipo de cambio SUNAT del día (S/${TARIFAS_PE.tipoCambio}).`,
      modalidad: "Venta única",
      cantidad: reloj.cantidad,
      precioUnitarioPEN: TARIFAS_PE.relojVenta,
      subtotalPEN: ventaNeto,
      esRecurrente: false,
      afectoIgv: true,
    })
  }
  // Envío S/0 e instalación Lima S/0: sin ítems. Fuera de Lima: sin ítem —
  // queda en la nota del mensaje + avisoSsttPeru para el correo interno.

  return {
    lineas,
    itemsCotizador,
    mensualNetoPlan: plan,
    mensualArriendoNeto: arriendoNeto,
    mensualNeto,
    mensualIgv,
    mensualTotal,
    descuentoPct: pctDescuento,
    escalonDescuento,
    mensualTotalConDescuento,
    tipoCambio: TARIFAS_PE.tipoCambio,
    pagoInicialNeto,
    pagoInicialIgv,
    pagoInicialTotal,
    avisoSsttPeru,
    mensajeParaProspecto: mensaje,
  }
}
