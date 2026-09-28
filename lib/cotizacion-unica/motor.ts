/**
 * MOTOR ÚNICO DE COTIZACIÓN REFERENCIAL = EL CÓDIGO DE CHILE (28-sep).
 *
 * Regla del dueño: "el proceso es uno solo; los otros países se montan
 * sobre lo que funciona, que es Chile". Este archivo es la tool chilena
 * `cotizar_referencial` (lib/tools/cotizar-referencial.ts hasta el 28-sep)
 * con los datos del país sacados a `ReglasCotizacion`: catálogo (módulos,
 * equipos, servicios de envío e instalación con sus tarifas por zona),
 * clasificación de la ubicación, impuesto, moneda/presentación y vocabulario.
 * La lógica —qué se cobra, cuándo va el doble valor, cómo se arma el
 * mensaje— es UNA y es la de Chile.
 *
 * Chile se verifica contra la tool anterior congelada (mensaje byte a byte e
 * ítems idénticos en todo el grid, ver README). Perú, Colombia y México se
 * verifican contra el motor anterior (lib/cotizacion/motor.ts, retirado):
 * mismos números; el TEXTO cambió solo donde ahora tiene la forma de Chile.
 *
 * Lo que existe solo fuera de Chile y entra como dato opcional (en Chile va
 * vacío, así que su salida no cambia): escalón de descuento sobre el plan
 * (en Chile el descuento lo calcula el cotizador por consultar_descuento_referencial),
 * notas finales en su burbuja, "el envío va incluido", arriendo "fuera" con
 * precio propio (en Chile = base + recargo), impuesto solo del equipo
 * (Colombia) y la opción de NO mostrar el precio de la instalación técnica.
 *
 * PURO: sin red ni alias `@/` (lo cargan los tests con node --test).
 */

export type ZonaCot = "base" | "intermedia" | "resto"
export type ModalidadHw = "arriendo" | "venta"

export type TierCot = {
  minUsuarios: number
  maxUsuarios: number
  modalidad: "fijo" | "por_usuario"
  /** Precio en la UNIDAD del país (UF en Chile, moneda directa fuera). */
  precioUF: number
}

export type ModuloCot = {
  id: string
  nombre: string
  tiers: readonly TierCot[]
  minUsuariosTotal?: number
  disponibleParaVicky: boolean
}

export type HardwareCot = {
  id: string
  displayName: string
  ventaUF: number
  arriendoUF: number
  /** Arriendo fuera de la zona base con precio propio (fuera de Chile). Sin él: base + recargo. */
  arriendoFueraUF?: number
  modalidadesDisponibles: readonly ModalidadHw[]
  cantidadSugerida: number
  requiereInstalacionOnsite?: boolean
  esAccesorio?: boolean
  disponibleParaVicky: boolean
}

export type ServicioCot = {
  id: string
  nombre: string
  tarifa:
    | { modelo: "zona"; base: number; intermedia: number; resto: number }
    | { modelo: "modalidad_zona"; arriendo: { base: number; fuera: number }; venta: { base: number; fuera: number } }
  omitirSiAutoInstalada: boolean
  advertenciasAutoInstalacion: readonly string[]
}

export type PuntoCot = {
  ubicacion: string
  autoInstalada: boolean
  modalidad?: ModalidadHw
  /** Zona ya resuelta por el país (Perú/Colombia/México la traen del adaptador). */
  zona?: ZonaCot
}

export type ClasificacionCot =
  | { tipo: "zona"; zona: ZonaCot; reconocida: boolean }
  | { tipo: "no_clasificable"; razon: string }

/** Monto para presentar: neto, impuesto, total y su equivalente local (Chile: UF → CLP). */
export type MontoCot = { neto: number; impuesto: number; total: number; local: number | null }

export type ReglasCotizacion = {
  /** Tope de dotación de la tool (el umbral 20/10 lo aplica el agent-loop, no el motor). */
  scopeMaxUsuarios: number
  modulos: readonly ModuloCot[]
  hardware: readonly HardwareCot[]
  /** Servicios que se inyectan con equipo, EN ORDEN (envío, instalación). */
  servicios: readonly ServicioCot[]
  /** Accesorios (tarjetas, impresora) solo viajan con un reloj de pared. */
  esRelojDePared: (id: string) => boolean
  clasificar: (punto: PuntoCot) => ClasificacionCot
  /** Chile: el arriendo fuera de la RM = base + 0,05 UF (si el equipo no trae precio propio). */
  recargoArriendoFuera: number
  /** Instalación técnica sin costo (línea a lista con −100 %). Chile: arriendo en la RM. */
  instalacionBonificada: (modalidad: ModalidadHw, zona: ZonaCot) => boolean
  /** Chile exige los puntos con equipo; fuera de Chile la tool lo valida antes y el motor cotiza como base. */
  exigePuntosConHardware: boolean
  /**
   * soloEquipo: solo el equipo lleva impuesto (Colombia).
   * agregacion: "suma" = (Σ netos) × tasa (Chile) · "por_concepto" = plan,
   * equipos del mes y cada pago único por separado (como se facturan en
   * Perú/Colombia/México). Solo cambia el último decimal de la suma.
   */
  impuesto: { tasa: number; soloEquipo: boolean; agregacion: "suma" | "por_concepto" }
  /** Redondeo de los subtotales por línea (Chile: 3 decimales de UF). */
  redondeoLinea: (n: number) => number
  /** Escalera sobre el PLAN (fuera de Chile; en Chile la negocia el cotizador). */
  escalera: { planMensual: readonly number[]; meses: number } | null
  redondearPlanConDescuento: (n: number) => number
  /** Precio de la instalación técnica opcional en el doble valor (Chile lo muestra; PE/CO/MX no desde el 28-sep). */
  mostrarPrecioInstalacionOpcional: boolean
  presentacion: {
    /** "0,55 UF" · "S/100" · "$315.000" */
    monto: (n: number) => string
    /** Precio unitario (Chile: hasta 3 decimales). */
    unitario: (n: number) => string
    /** Línea de total del resumen sin equipo: "Total mensual con IVA: …" */
    lineaTotalMensual: (m: MontoCot) => string
    lineaSubtotal: (neto: number) => string
    /** Lo que sigue a "💰 " en cada opción del doble valor, sin el punto final. */
    opcionMensual: (m: MontoCot) => string
    /** Lo que sigue a "Se suma un pago inicial único de ", sin el punto final. */
    pagoUnico: (m: MontoCot) => string
    /** Monto corto neto + impuesto ("1 UF + IVA", "S/100 + IGV"): precio de la visita y "desde el mes 7". */
    montoCorto: (m: MontoCot) => string
    /** Chile: "El cobro se realiza en UF…" (bajo el precio de la opción 1). */
    notaUnidad: string | null
    postMensaje?: (texto: string) => string
  }
  textos: {
    /** "reloj" · "equipo" */
    equipo: string
    equipoPlural: string
    modalidadArriendo: string
    modalidadVenta: string
    modalidadMixta: string
    /** "(arriendo en la Región Metropolitana)" / "en Lima Metropolitana" */
    bonificadaEn: string
    /** "según la comuna" (precio genérico de la visita). */
    segunZona: string
    /** Sufijo del nombre de la línea de arriendo fuera de la base: " (regiones)". */
    sufijoArriendoFuera: string
    /** Se agrega a "Tus trabajadores pueden marcar…" cuando el envío no se cobra ("" en Chile). */
    envioIncluido: string
    /** Nota del micro-plan (Chile: 1 persona en tramo fijo). */
    notaMicroPlan: ((userCount: number, tier: TierCot) => string | null) | null
    /** Notas al final del mensaje, cada una en su burbuja ([] en Chile). */
    notasFinales: readonly string[]
    /** Frase de la visita técnica cuando NO se muestra su precio. */
    instalacionOpcionalSinPrecio: string
  }
}

export type ItemCot = {
  tipo: "modulo" | "hardware" | "servicio"
  id: string
  nombre: string
  modalidad: string
  cantidad: number
  precioUnitario: number
  subtotal: number
  tierAplicado?: string
  descuentoPct?: number
}

export type EntradaCot = {
  userCount: number
  modulos: string[]
  hardware?: Array<{ id: string; cantidad?: number; modalidad?: ModalidadHw }>
  puntosInstalacion?: PuntoCot[]
  escalonDescuento?: number
}

export type ResultadoCot =
  | {
      ok: true
      userCount: number
      /** Ítems SIN consolidar (como los devolvía la tool chilena). */
      items: ItemCot[]
      itemsConsolidados: ItemCot[]
      subtotal: number
      impuesto: number
      total: number
      totalLocal: number | null
      subtotalRecurrente: number
      impuestoRecurrente: number
      totalRecurrente: number
      totalRecurrenteLocal: number | null
      subtotalUnico: number
      impuestoUnico: number
      totalUnico: number
      totalUnicoLocal: number | null
      /** Plan (módulos) a lista y con el descuento del escalón. */
      planLista: number
      plan: number
      /** Recurrente con el descuento del escalón (= lista sin escalón). */
      mensualNeto: number
      mensualImpuesto: number
      /** Pago inicial = únicos + PRIMER MES con su descuento. */
      pagoInicialNeto: number
      pagoInicialImpuesto: number
      descuentoPct: number
      escalonDescuento: number
      /** Algún punto con equipo pidió la visita técnica. */
      visitaTecnicaPedida: boolean
      tier: TierCot | null
      mensajeParaProspecto: string
      advertencias: string[]
    }
  | { ok: false; error: string }

// ─── Helpers de catálogo (los de lib/catalogo, sobre las reglas del país) ───

function moduloDisponible(R: ReglasCotizacion, id: string): ModuloCot | null {
  const m = R.modulos.find((x) => x.id === id)
  return m && m.disponibleParaVicky ? m : null
}

function hardwareDisponible(R: ReglasCotizacion, id: string): HardwareCot | null {
  const h = R.hardware.find((x) => x.id === id)
  return h && h.disponibleParaVicky ? h : null
}

export function tierAplicable(modulo: ModuloCot, userCount: number): TierCot | null {
  if (modulo.minUsuariosTotal !== undefined && userCount < modulo.minUsuariosTotal) return null
  return modulo.tiers.find((t) => userCount >= t.minUsuarios && userCount <= t.maxUsuarios) ?? null
}

function validarRango(modulo: ModuloCot, userCount: number): string | null {
  if (modulo.minUsuariosTotal !== undefined && userCount < modulo.minUsuariosTotal) {
    return `${modulo.nombre} requiere mínimo ${modulo.minUsuariosTotal} trabajadores (la empresa tiene ${userCount}).`
  }
  const tier = tierAplicable(modulo, userCount)
  if (!tier) {
    const rangos = modulo.tiers.map((t) => `${t.minUsuarios}-${t.maxUsuarios}`).join(", ")
    return `${modulo.nombre} no tiene tier definido para ${userCount} trabajadores. Rangos cubiertos: ${rangos}.`
  }
  return null
}

export function precioServicio(s: ServicioCot, zona: ZonaCot, modalidad: ModalidadHw): number {
  const t = s.tarifa
  if (t.modelo === "zona") return t[zona]
  const porZona = t[modalidad]
  return zona === "base" ? porZona.base : porZona.fuera
}

export function escalonSaneado(R: ReglasCotizacion, escalon: unknown): number {
  const n = R.escalera ? R.escalera.planMensual.length : 0
  return Math.max(0, Math.min(n, Math.floor(Number(escalon) || 0)))
}

export function pctDelEscalon(R: ReglasCotizacion, escalon: unknown): number {
  const e = escalonSaneado(R, escalon)
  return e === 0 || !R.escalera ? 0 : R.escalera.planMensual[e - 1]
}

/** Líneas idénticas en una sola fila (misma regla de la cotización formal chilena). */
export function consolidarLineas(items: ItemCot[], redondeo: (n: number) => number): ItemCot[] {
  const porClave = new Map<string, ItemCot>()
  const orden: string[] = []
  for (const it of items) {
    const clave = [it.tipo, it.id, it.nombre, it.modalidad, it.precioUnitario, "", it.descuentoPct ?? 0].join("||")
    const existente = porClave.get(clave)
    if (existente) {
      existente.cantidad += it.cantidad
      existente.subtotal = redondeo(existente.subtotal + it.subtotal)
    } else {
      porClave.set(clave, { ...it })
      orden.push(clave)
    }
  }
  return orden.map((c) => porClave.get(c) as ItemCot)
}

type Seccion = "recurrente" | "unico"
function seccionDe(modalidad: string): Seccion {
  if (modalidad === "Fijo" || modalidad === "Por usuario" || modalidad === "Arriendo mensual") return "recurrente"
  return "unico"
}

function formatItem(R: ReglasCotizacion, i: ItemCot): string {
  const P = R.presentacion
  if (i.modalidad === "Fijo") return `- ${i.nombre}: ${P.monto(i.subtotal)}/mes`
  if (i.modalidad === "Por usuario") {
    return `- ${i.nombre}: ${i.cantidad} × ${P.unitario(i.precioUnitario)} = ${P.monto(i.subtotal)}/mes`
  }
  if (i.modalidad === "Arriendo mensual") {
    return `- ${i.nombre}: ${i.cantidad} unidad${i.cantidad > 1 ? "es" : ""} × ${P.unitario(i.precioUnitario)} = ${P.monto(i.subtotal)}/mes`
  }
  if (i.modalidad === "Venta única") {
    return `- ${i.nombre} (compra): ${i.cantidad} unidad${i.cantidad > 1 ? "es" : ""} × ${P.unitario(i.precioUnitario)} = ${P.monto(i.subtotal)}`
  }
  if (i.modalidad === "Cobro único") {
    if (i.cantidad > 1) return `- ${i.nombre} × ${i.cantidad}: ${i.cantidad} × ${P.unitario(i.precioUnitario)} = ${P.monto(i.subtotal)}`
    return `- ${i.nombre}: ${P.monto(i.subtotal)}`
  }
  return `- ${i.nombre}: ${i.cantidad} × ${P.unitario(i.precioUnitario)} = ${P.monto(i.subtotal)}`
}

/** Impuesto de un conjunto de líneas (ver ReglasCotizacion.impuesto). */
function impuestoDe(R: ReglasCotizacion, items: ItemCot[]): number {
  const t = R.impuesto.tasa
  const gravadas = R.impuesto.soloEquipo ? items.filter((i) => i.tipo === "hardware") : items
  if (R.impuesto.agregacion === "suma") return gravadas.reduce((s, i) => s + i.subtotal, 0) * t
  // Por concepto: los equipos del mes se facturan juntos; lo demás, línea a línea.
  const equiposMes = gravadas.filter((i) => i.tipo === "hardware" && i.modalidad === "Arriendo mensual")
  const resto = gravadas.filter((i) => !(i.tipo === "hardware" && i.modalidad === "Arriendo mensual"))
  const impEquipos = equiposMes.length ? equiposMes.reduce((s, i) => s + i.subtotal, 0) * t : 0
  return resto.reduce((s, i) => s + i.subtotal * t, 0) + impEquipos
}

// ─── Implementación (la de Chile) ────────────────────────────────────────

/**
 * @param conversion Unidad → moneda local para el "aprox." (Chile: la UF del
 *   día). null = el país cotiza directo en su moneda.
 */
export function cotizarReferencialConReglas(
  R: ReglasCotizacion,
  args: EntradaCot,
  conversion: number | null,
): ResultadoCot {
  const { userCount, modulos, hardware = [], puntosInstalacion = [] } = args
  const advertencias: string[] = []
  const P = R.presentacion
  const T = R.textos
  const rd = R.redondeoLinea

  // ── Validación de rango ──
  if (!Number.isFinite(userCount) || userCount < 1 || userCount > R.scopeMaxUsuarios) {
    return {
      ok: false,
      error: `userCount=${userCount} fuera de rango. Esta tool cubre empresas de 1 a ${R.scopeMaxUsuarios} trabajadores. Para empresas más grandes, deriva con derivar_a_soporte motivo "fuera_de_rango_trabajadores".`,
    }
  }

  // ── Módulos ──
  const items: ItemCot[] = []
  let tierBase: TierCot | null = null
  const modulosConBase = modulos.includes("asistencia") ? modulos : ["asistencia", ...modulos]
  for (const moduloId of modulosConBase) {
    const modulo = moduloDisponible(R, moduloId)
    if (!modulo) {
      const todos = R.modulos.filter((m) => m.disponibleParaVicky).map((m) => m.id)
      return {
        ok: false,
        error: `Módulo '${moduloId}' no está disponible para cotización por Vicky. Módulos habilitados: ${todos.join(", ")}.`,
      }
    }
    const rangoError = validarRango(modulo, userCount)
    if (rangoError) {
      advertencias.push(rangoError)
      continue
    }
    const tier = tierAplicable(modulo, userCount)
    if (!tier) {
      advertencias.push(`No se encontró tier aplicable para ${modulo.nombre} con ${userCount} trabajadores.`)
      continue
    }
    if (modulo.id === "asistencia") tierBase = tier
    const cantidad = tier.modalidad === "fijo" ? 1 : userCount
    const subtotal = tier.modalidad === "fijo" ? tier.precioUF : userCount * tier.precioUF
    items.push({
      tipo: "modulo",
      id: modulo.id,
      nombre: modulo.nombre,
      modalidad: tier.modalidad === "fijo" ? "Fijo" : "Por usuario",
      cantidad,
      precioUnitario: tier.precioUF,
      subtotal: rd(subtotal),
      tierAplicado: `${tier.minUsuarios}-${tier.maxUsuarios} usuarios`,
    })
  }

  // ── Equipos ── (los accesorios —tarjetas, impresora— viajan con el reloj)
  const esAccesorioId = (id: string) => hardwareDisponible(R, id)?.esAccesorio === true
  const hayAccesorios = hardware.some((hw) => esAccesorioId(hw.id))
  const hardwareEquipos = hardware.filter((hw) => !esAccesorioId(hw.id))
  if (hayAccesorios && !hardwareEquipos.some((hw) => R.esRelojDePared(hw.id))) {
    return {
      ok: false,
      error:
        "Los accesorios (tarjetas de proximidad, impresora térmica) solo acompañan a un reloj control físico de pared. " +
        "Cotízalos junto al reloj, o agrega el reloj a la configuración.",
    }
  }
  const relojEnArriendo = hardwareEquipos.some((hw) => (hw.modalidad ?? "arriendo") === "arriendo")
  let hayHardware = false
  for (const hw of hardware) {
    const dispositivo = hardwareDisponible(R, hw.id)
    if (!dispositivo) {
      const disponibles = R.hardware.filter((h) => h.disponibleParaVicky).map((h) => h.id)
      return {
        ok: false,
        error: `Hardware '${hw.id}' no está disponible para cotización por Vicky. ${disponibles.length > 0 ? `Hardware habilitado: ${disponibles.join(", ")}.` : "No hay hardware habilitado actualmente."}`,
      }
    }
    const esAccesorio = dispositivo.esAccesorio === true
    const cantidad = hw.cantidad ?? dispositivo.cantidadSugerida
    const modalidadAccesorio: ModalidadHw =
      relojEnArriendo && dispositivo.modalidadesDisponibles.includes("arriendo") ? "arriendo" : "venta"
    const modalidadElegida: ModalidadHw = hw.modalidad ?? (esAccesorio ? modalidadAccesorio : "arriendo")
    if (!dispositivo.modalidadesDisponibles.includes(modalidadElegida)) {
      return {
        ok: false,
        error: `El ${dispositivo.displayName} no está disponible en modalidad '${modalidadElegida}'. Modalidades disponibles: ${dispositivo.modalidadesDisponibles.join(", ")}.`,
      }
    }
    const precioUnitario = modalidadElegida === "arriendo" ? dispositivo.arriendoUF : dispositivo.ventaUF
    if (precioUnitario === 0) {
      return { ok: false, error: `${dispositivo.displayName} no tiene precio en modalidad '${modalidadElegida}' (valor 0).` }
    }
    items.push({
      tipo: "hardware",
      id: dispositivo.id,
      nombre: dispositivo.displayName,
      modalidad: modalidadElegida === "arriendo" ? "Arriendo mensual" : "Venta única",
      cantidad,
      precioUnitario,
      subtotal: rd(cantidad * precioUnitario),
    })
    if (!esAccesorio) hayHardware = true
    if (!esAccesorio && cantidad > dispositivo.cantidadSugerida) {
      advertencias.push(
        `Para ${dispositivo.displayName} se está cotizando ${cantidad} unidades. La cotizadora oficial puede aplicar precios distintos a las unidades adicionales (descuento promo aplica solo a las primeras unidades).`,
      )
    }
  }

  // ── Puntos: envío e instalación por punto + arriendo por zona ──
  const clasif = puntosInstalacion.map((p) => R.clasificar(p))
  if (hayHardware) {
    if (puntosInstalacion.length === 0 && R.exigePuntosConHardware) {
      return {
        ok: false,
        error:
          "La cotización incluye hardware pero no se entregó 'puntosInstalacion'. " +
          "Por cada punto físico donde se instalará un reloj, debes pasar { ubicacion, autoInstalada }. " +
          "Si el prospecto aún no ha entregado la ubicación, pregúntale la comuna o región antes de cotizar.",
      }
    }
    for (let k = 0; k < puntosInstalacion.length; k++) {
      const c = clasif[k]
      if (c.tipo === "no_clasificable") {
        return {
          ok: false,
          error:
            `No pude clasificar la ubicación '${puntosInstalacion[k].ubicacion}' (${c.razon}). ` +
            `Pregúntale al prospecto la comuna o región específica donde se instalará el reloj ` +
            `y vuelve a llamar la tool.`,
        }
      }
    }

    const modalidadesHw = new Set(hardwareEquipos.map((hw) => (hw.modalidad ?? "arriendo") as ModalidadHw))
    const modalidadUniforme: ModalidadHw | null = modalidadesHw.size === 1 ? [...modalidadesHw][0] : null
    // Equipo plug-and-play (huellero USB): sin visita técnica.
    const soloHardwareSinInstalacion =
      hardwareEquipos.length > 0 &&
      hardwareEquipos.every((hw) => hardwareDisponible(R, hw.id)?.requiereInstalacionOnsite === false)

    for (let k = 0; k < puntosInstalacion.length; k++) {
      const punto = puntosInstalacion[k]
      const clasificacion = clasif[k]
      if (clasificacion.tipo === "no_clasificable") continue
      if (!clasificacion.reconocida) {
        advertencias.push(
          `Ubicación '${punto.ubicacion}' no reconocida en la lista oficial. ` +
            `Se aplicó tarifa de regiones por defecto. El ejecutivo confirmará la ubicación exacta al revisar la cotización.`,
        )
      }
      const modalidadPunto = punto.modalidad ?? modalidadUniforme
      if (!modalidadPunto) {
        return {
          ok: false,
          error:
            "La cotización tiene relojes en arriendo Y en compra, así que necesito la modalidad de cada punto. " +
            "Vuelve a llamar la tool indicando `modalidad` ('arriendo' o 'venta') en cada entrada de puntosInstalacion.",
        }
      }
      const zonaPunto = clasificacion.zona
      for (const servicio of R.servicios) {
        if ((punto.autoInstalada || soloHardwareSinInstalacion) && servicio.omitirSiAutoInstalada) {
          if (punto.autoInstalada) {
            for (const adv of servicio.advertenciasAutoInstalacion) advertencias.push(`Auto-instalación en ${punto.ubicacion}: ${adv}`)
          }
          continue
        }
        const precio = precioServicio(servicio, zonaPunto, modalidadPunto)
        if (precio <= 0) continue
        const bonificada = servicio.id === "instalacion_reloj" && R.instalacionBonificada(modalidadPunto, zonaPunto)
        items.push({
          tipo: "servicio",
          id: servicio.id,
          nombre: `${servicio.nombre} (${punto.ubicacion})`,
          modalidad: "Cobro único",
          cantidad: 1,
          precioUnitario: precio,
          subtotal: bonificada ? 0 : rd(precio),
          ...(bonificada ? { descuentoPct: 100 } : {}),
        })
      }
    }

    // ARRIENDO POR ZONA: los equipos que van fuera de la base llevan su tarifa
    // "fuera" (Chile: base + recargo). Zonas mixtas dividen la línea.
    const puntosFuera = clasif.filter((c) => c.tipo !== "no_clasificable" && c.zona !== "base").length
    if (puntosFuera > 0) {
      for (let ix = items.length - 1; ix >= 0; ix--) {
        const it = items[ix]
        if (it.tipo !== "hardware" || it.modalidad !== "Arriendo mensual") continue
        const disp = hardwareDisponible(R, it.id)
        if (disp?.esAccesorio === true) continue
        const enFuera = Math.min(it.cantidad, puntosFuera)
        const enBase = it.cantidad - enFuera
        const precioFuera =
          disp?.arriendoFueraUF !== undefined ? disp.arriendoFueraUF : rd(it.precioUnitario + R.recargoArriendoFuera)
        if (enBase <= 0) {
          it.precioUnitario = precioFuera
          it.subtotal = rd(it.cantidad * precioFuera)
        } else {
          it.cantidad = enBase
          it.subtotal = rd(enBase * it.precioUnitario)
          items.splice(ix + 1, 0, {
            ...it,
            cantidad: enFuera,
            precioUnitario: precioFuera,
            subtotal: rd(enFuera * precioFuera),
            nombre: `${it.nombre}${T.sufijoArriendoFuera}`,
          })
        }
      }
    }
  }

  if (items.length === 0) {
    return { ok: false, error: "No hay items válidos para cotizar. Verificá que los IDs sean correctos y estén habilitados." }
  }

  // ── Totales ──
  const tasa = R.impuesto.tasa
  const local = (total: number) => (conversion !== null ? Math.round(total * conversion) : null)
  const subtotal = items.reduce((s, i) => s + i.subtotal, 0)
  const impuesto = impuestoDe(R, items)
  const total = subtotal + impuesto

  const itemsConsolidados = consolidarLineas(items, rd)
  const itemsRecurrentes = itemsConsolidados.filter((i) => seccionDe(i.modalidad) === "recurrente")
  const itemsUnicos = itemsConsolidados.filter((i) => seccionDe(i.modalidad) === "unico")

  const subtotalRecurrente = itemsRecurrentes.reduce((s, i) => s + i.subtotal, 0)
  const impuestoRecurrente = impuestoDe(R, itemsRecurrentes)
  const totalRecurrente = subtotalRecurrente + impuestoRecurrente
  const totalRecurrenteLocal = local(totalRecurrente)

  const subtotalUnico = itemsUnicos.reduce((s, i) => s + i.subtotal, 0)
  const impuestoUnico = impuestoDe(R, itemsUnicos)
  const totalUnico = subtotalUnico + impuestoUnico
  const totalUnicoLocal = local(totalUnico)

  // Escalón de descuento sobre el PLAN (módulos). En Chile no hay escalera
  // local (la negocia el cotizador) y todo esto queda en cero.
  const escalon = escalonSaneado(R, args.escalonDescuento)
  const pct = pctDelEscalon(R, escalon)
  const conDescuento = pct > 0
  const itemsPlan = itemsRecurrentes.filter((i) => i.tipo === "modulo")
  const itemsResto = itemsRecurrentes.filter((i) => i.tipo !== "modulo")
  const planLista = itemsPlan.reduce((s, i) => s + i.subtotal, 0)
  const plan = conDescuento ? R.redondearPlanConDescuento(planLista * (1 - pct)) : planLista
  const restoRecurrente = itemsResto.reduce((s, i) => s + i.subtotal, 0)
  const mensualNeto = conDescuento ? plan + restoRecurrente : subtotalRecurrente
  const mensualImpuesto = conDescuento
    ? R.impuesto.soloEquipo
      ? impuestoRecurrente
      : R.impuesto.agregacion === "suma"
        ? mensualNeto * tasa
        : plan * tasa + impuestoDe(R, itemsResto)
    : impuestoRecurrente
  const meses = R.escalera?.meses ?? 0
  const monto = (neto: number, imp: number): MontoCot => ({ neto, impuesto: imp, total: neto + imp, local: local(neto + imp) })
  const mListaRec: MontoCot = { neto: subtotalRecurrente, impuesto: impuestoRecurrente, total: totalRecurrente, local: totalRecurrenteLocal }
  const mRec: MontoCot = conDescuento ? monto(mensualNeto, mensualImpuesto) : mListaRec
  const dctoDesde = `desde el mes ${meses + 1}, ${P.montoCorto(mListaRec)}/mes`

  // ── Mensaje canónico ──
  const partes: string[] = []
  const esMicroPlan = userCount === 1 && items.some((i) => i.id === "asistencia" && i.modalidad === "Fijo")
  if (itemsRecurrentes.length > 0) {
    partes.push("Resumen mensual recurrente:")
    partes.push("")
    partes.push(itemsRecurrentes.map((i) => formatItem(R, i)).join("\n"))
    partes.push("")
    if (itemsRecurrentes.length >= 2) partes.push(P.lineaSubtotal(subtotalRecurrente))
    partes.push(P.lineaTotalMensual(mListaRec))
    if (conDescuento) {
      partes.push(
        `Con el ${Math.round(pct * 100)}% de descuento en el plan durante ${meses} meses: ${P.montoCorto(mRec)}/mes (${dctoDesde})`,
      )
    }
    const nota = esMicroPlan && T.notaMicroPlan && tierBase ? T.notaMicroPlan(userCount, tierBase) : null
    if (nota) {
      partes.push("")
      partes.push(nota)
    }
  }
  // Sin equipo no hay pagos únicos (los servicios y accesorios viajan con el
  // reloj), y con equipo el mensaje es el doble valor de abajo: la tool
  // chilena armaba aquí "Pago único", "Al aceptar pagas…", el aviso de
  // instalación 📌 y las alternativas 💡, pero el doble valor los pisaba
  // siempre (código inalcanzable, verificado contra la tool congelada).
  for (const nota of T.notasFinales) partes.push("", "[---]", "", nota)
  let mensajeParaProspecto = partes.join("\n")

  // ── Instalación: la frase del doble valor ──
  const hayReloj = itemsConsolidados.some((i) => i.tipo === "hardware")
  const esInstalacion = (i: ItemCot) => i.tipo === "servicio" && i.id === "instalacion_reloj"
  const instalacionCotizada = itemsConsolidados.some(esInstalacion)
  const todoPlugAndPlay =
    hardware.length > 0 && hardware.every((hw) => hardwareDisponible(R, hw.id)?.requiereInstalacionOnsite === false)
  // La modalidad "de la cotización" para la frase se mira sobre TODO el hardware
  // (accesorios incluidos, sin modalidad = arriendo), como siempre en Chile.
  const modsFrase = new Set(hardware.map((hw) => (hw.modalidad ?? "arriendo") as ModalidadHw))
  let instalacionTecnico = 0
  let puntosInstalacionGratis = 0
  const instalacionPorPunto: Array<{ ubicacion: string; valor: number }> = []
  if (hayReloj && !instalacionCotizada && !todoPlugAndPlay) {
    const modU: ModalidadHw = modsFrase.size === 1 ? [...modsFrase][0] : "arriendo"
    const serviciosInstalacion = R.servicios.filter((s) => s.omitirSiAutoInstalada)
    for (let k = 0; k < puntosInstalacion.length; k++) {
      const c = clasif[k]
      if (c.tipo === "no_clasificable") continue
      const modP = puntosInstalacion[k].modalidad ?? modU
      if (R.instalacionBonificada(modP, c.zona)) {
        puntosInstalacionGratis += 1
        continue
      }
      let valorPunto = 0
      for (const s of serviciosInstalacion) valorPunto += precioServicio(s, c.zona, modP)
      instalacionTecnico += valorPunto
      if (valorPunto > 0) instalacionPorPunto.push({ ubicacion: puntosInstalacion[k].ubicacion, valor: valorPunto })
    }
  }
  const instalacionGratisTotal = puntosInstalacionGratis > 0 && puntosInstalacionGratis >= puntosInstalacion.length
  const instalacionCotizadaBonificada = itemsConsolidados.some((i) => esInstalacion(i) && Number(i.descuentoPct) >= 100)

  // ── DOBLE VALOR: con reloj, la tool compone las dos opciones y la pregunta ──
  if (hayReloj) {
    const alternativa = cotizarReferencialConReglas(R, { userCount, modulos, escalonDescuento: args.escalonDescuento }, conversion)
    if (alternativa.ok) {
      const modalidadLabel =
        modsFrase.size === 1 ? (modsFrase.has("venta") ? T.modalidadVenta : T.modalidadArriendo) : T.modalidadMixta
      const personas = userCount === 1 ? "1 persona" : `${userCount} personas`
      let fraseInstalacion = ""
      if (instalacionCotizada) {
        fraseInstalacion = instalacionCotizadaBonificada
          ? `La instalación por nuestro equipo técnico va incluida sin costo ${T.bonificadaEn}.`
          : "En este caso la instalación por nuestro equipo técnico va incluida en el pago inicial."
      } else if (instalacionGratisTotal) {
        fraseInstalacion = `La instalación por nuestro equipo técnico va incluida sin costo ${T.bonificadaEn}; si prefieres, el ${T.equipo} también es autoinstalable.`
      } else if (!todoPlugAndPlay) {
        if (!R.mostrarPrecioInstalacionOpcional) {
          fraseInstalacion = T.instalacionOpcionalSinPrecio
        } else if (instalacionTecnico > 0 && instalacionPorPunto.length >= 2) {
          const partesInst = instalacionPorPunto.map(
            (pp, i) => `${P.montoCorto(monto(pp.valor, 0))} ${i === 0 ? "por la" : "la"} de ${pp.ubicacion}`,
          )
          fraseInstalacion = `Los ${T.equipoPlural} son autoinstalables. Si prefieres que nosotros los instalemos, tiene un costo único adicional de ${partesInst.join(" y ")}.`
        } else {
          fraseInstalacion =
            instalacionTecnico > 0
              ? `El ${T.equipo} es autoinstalable. Si prefieres que nosotros lo instalemos, tiene un costo único adicional de ${P.montoCorto(monto(instalacionTecnico, 0))}.`
              : `El ${T.equipo} es autoinstalable. Si prefieres que nosotros lo instalemos, tiene un costo único adicional ${T.segunZona}.`
        }
      }

      const todasArriendo = !modsFrase.has("venta")
      const envioCobrado = itemsUnicos.filter((i) => i.id === "envio_reloj").reduce((s, i) => s + i.subtotal, 0)
      const envio = R.servicios.find((s) => s.id === "envio_reloj")
      const envioBaseVentaCero = !envio || precioServicio(envio, "base", "venta") === 0
      const envioIncluido = todasArriendo || (envioCobrado === 0 && envioBaseVentaCero)

      const lineasOpcion1 = [`1 - Para ${personas} te recomiendo ${modalidadLabel} + App:`, `💰 ${P.opcionMensual(mRec)}.`, ``]
      if (P.notaUnidad) lineasOpcion1.push(P.notaUnidad, ``)
      lineasOpcion1.push(
        `Tus trabajadores pueden marcar desde el ${T.equipo} o desde el celular, como les acomode.${envioIncluido ? T.envioIncluido : ""}`,
      )
      if (fraseInstalacion) lineasOpcion1.push(fraseInstalacion)
      if (conDescuento) {
        lineasOpcion1.push(`Incluye el ${Math.round(pct * 100)}% de descuento en el plan durante ${meses} meses (${dctoDesde}).`)
      }
      const unicoPositivo = totalUnicoLocal !== null ? totalUnicoLocal > 0 : subtotalUnico > 0
      if (unicoPositivo) {
        lineasOpcion1.push(
          `Se suma un pago inicial único de ${P.pagoUnico({ neto: subtotalUnico, impuesto: impuestoUnico, total: totalUnico, local: totalUnicoLocal })}.`,
        )
      }
      // La alternativa dice en qué es mejor (mensualidad, entrada o ambas).
      // La alternativa se lee como la devuelve la tool (subtotal redondeado por
      // línea: 3 decimales de UF en Chile), igual que siempre.
      const altNeto = rd(alternativa.mensualNeto)
      const ahorraMensual = altNeto < mRec.neto - 0.001
      const ahorraEntrada = unicoPositivo
      const encabezadoAlternativa = ahorraMensual
        ? "2.- Una alternativa más económica sería si marcan solo mediante nuestra app:"
        : ahorraEntrada
          ? "2.- Si prefieres partir sin desembolso inicial, marcando solo con nuestra app (misma mensualidad, sin el pago único):"
          : "2.- También puedes partir marcando solo con nuestra app:"
      const mAlt: MontoCot =
        alternativa.escalonDescuento > 0
          ? monto(alternativa.mensualNeto, alternativa.mensualImpuesto)
          : { neto: rd(alternativa.subtotalRecurrente), impuesto: alternativa.impuestoRecurrente, total: alternativa.totalRecurrente, local: alternativa.totalRecurrenteLocal }
      const cierre = [...lineasOpcion1, "", "[---]", "", encabezadoAlternativa, `💰 ${P.opcionMensual(mAlt)}.`]
      for (const nota of T.notasFinales) cierre.push("", "[---]", "", nota)
      cierre.push("", "[---]", "", "Qué opción prefieres? Con la que elijas te genero la cotización formal de inmediato.")
      mensajeParaProspecto = cierre.join("\n")
    }
  }
  if (P.postMensaje) mensajeParaProspecto = P.postMensaje(mensajeParaProspecto)

  const pagoInicialNeto = subtotalUnico + mensualNeto
  const pagoInicialImpuesto = impuestoUnico + mensualImpuesto
  return {
    ok: true,
    userCount,
    items,
    itemsConsolidados,
    subtotal,
    impuesto,
    total,
    totalLocal: local(total),
    subtotalRecurrente,
    impuestoRecurrente,
    totalRecurrente,
    totalRecurrenteLocal,
    subtotalUnico,
    impuestoUnico,
    totalUnico,
    totalUnicoLocal,
    planLista,
    plan,
    mensualNeto,
    mensualImpuesto,
    pagoInicialNeto,
    pagoInicialImpuesto,
    descuentoPct: pct,
    escalonDescuento: escalon,
    visitaTecnicaPedida: hayHardware && puntosInstalacion.some((p) => !p.autoInstalada),
    tier: tierBase,
    mensajeParaProspecto,
    advertencias,
  }
}
