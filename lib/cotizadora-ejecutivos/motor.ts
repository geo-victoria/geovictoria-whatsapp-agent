/**
 * MOTOR DETERMINISTA de la Cotizadora de Ejecutivos.
 *
 * Los 4 principios de Lalo (10-ago), en código:
 *   1. El precio es una FUNCIÓN del catálogo — el agente jamás pasa un precio
 *      libre: solo configuración (y overrides validados contra mínimos).
 *   2. El espacio de acciones = la UI de la calculadora de Nacho: descuento
 *      por línea 0-25 (se CLAMPEA, con advertencia), overrides con mínimos,
 *      venta/arriendo, RM/región, promos SOLO cuando son elegibles.
 *   3. Cero cabos sueltos: `validarPropuesta` lista los pendientes y quien
 *      emita debe negarse mientras haya alguno.
 *   4. Este módulo NO envía nada a nadie: es puro (sin red, sin Supabase) —
 *      la frontera la vigila el test de paridad.
 *
 * Todo en UF; los CLP se congelan al emitir con la UF del día (pipeline).
 */

import {
  ADDONS,
  ACCESORIOS,
  type AddonId,
  EQUIPOS,
  IN01_BUNDLE_UF,
  KIT_QR_ARRIENDO_UF,
  MAX_DESCUENTO_PCT,
  MAX_USUARIOS,
  OTROS_SERVICIOS,
  type OtroServicioId,
  PROMO_ADDON_EXCLUIDO,
  PROMO_ASISTENCIA_ADDON_MAX_USUARIOS,
  PROMO_ASISTENCIA_ADDON_UF,
  PROMO_SF2A_UF,
  SERVICIOS_ASOCIADOS,
  type ServicioAsociadoId,
  SF2A_TOPE_PROMO,
  TRAMOS_ASISTENCIA,
  tramoDe,
} from "./catalogo.ts"

export type LineaPropuesta = {
  tipo: "asistencia" | "addon" | "otro_servicio" | "equipo" | "accesorio" | "servicio_asociado" | "promo"
  id: string
  nombre: string
  detalle: string
  cantidad: number
  precioUnitarioUF: number
  descuentoPct: number
  subtotalUF: number
  recurrencia: "mensual" | "pago_unico"
}

export type ConfigPropuesta = {
  usuarios: number
  /** Descuento % sobre la línea de asistencia (0-25, se clampa). */
  descuentoAsistenciaPct?: number
  addons?: Array<{ id: AddonId; usuarios?: number; descuentoPct?: number }>
  otrosServicios?: Array<{ id: OtroServicioId; usuarios?: number; descuentoPct?: number }>
  equipos?: Array<{
    id: string
    modalidad: "venta" | "arriendo"
    cantidad: number
    descuentoPct?: number
    /** Override de precio unitario UF (UI de Nacho lo permite). Piso: lista × 0,75. */
    precioUF?: number
  }>
  accesorios?: Array<{ id: string; modalidad: "venta" | "arriendo"; cantidad: number; descuentoPct?: number; precioUF?: number }>
  serviciosAsociados?: Array<{
    id: ServicioAsociadoId
    zona: "rm" | "region"
    modalidad: "venta" | "arriendo"
    cantidad?: number
    /** Override UF — validado contra el MÍNIMO de tabla por zona/modalidad. */
    precioUF?: number
  }>
  /** Declaraciones de cierre (principio 3): con hardware, envío e instalación
   * deben quedar resueltos — cotizados o excluidos EXPLÍCITAMENTE. */
  envioExcluido?: boolean
  instalacionPorCliente?: boolean
  /** Promo Asistencia+Addon 1 UF: el add-on elegido (null/ausente = sin promo). */
  promoAsistenciaAddon?: AddonId
  /** Promo SF2A: cuántas unidades van a precio promocional (se capa por tramo). */
  promoSf2aUnidades?: number
  kitQrCantidad?: number
  bundleIn01?: { modalidad: "venta" | "arriendo"; cantidad: number }
  firmante?: string
}

export type ResultadoPropuesta = {
  lineas: LineaPropuesta[]
  totalMensualUF: number
  totalPagoUnicoUF: number
  advertencias: string[]
}

const r3 = (n: number) => Number(n.toFixed(3))

function clampDescuento(pct: number | undefined, etiqueta: string, advertencias: string[]): number {
  const p = Number(pct || 0)
  if (!Number.isFinite(p) || p <= 0) return 0
  if (p > MAX_DESCUENTO_PCT) {
    advertencias.push(`Descuento ${p}% en ${etiqueta} excede el tope ${MAX_DESCUENTO_PCT}% — se aplicó ${MAX_DESCUENTO_PCT}%.`)
    return MAX_DESCUENTO_PCT
  }
  return p
}

/** Piso de override para equipos/accesorios: lista × (1 - tope de descuento).
 * Supuesto alineado con el tope 25% de la UI — validar con Nacho. */
function validarOverride(lista: number, override: number | undefined, etiqueta: string, advertencias: string[]): number {
  if (override === undefined || !Number.isFinite(override)) return lista
  const piso = r3(lista * (1 - MAX_DESCUENTO_PCT / 100))
  if (override < piso) {
    advertencias.push(`Precio ${override} UF en ${etiqueta} bajo el piso ${piso} UF (lista ${lista} × 75%) — se usó el piso.`)
    return piso
  }
  return r3(override)
}

export function elegibilidadPromoAsistenciaAddon(usuarios: number, addon: AddonId | undefined): { elegible: boolean; motivo?: string } {
  if (!addon) return { elegible: false, motivo: "sin add-on elegido" }
  if (addon === PROMO_ADDON_EXCLUIDO) return { elegible: false, motivo: "Banco de Horas nunca es elegible para la promo" }
  if (usuarios < 1 || usuarios > PROMO_ASISTENCIA_ADDON_MAX_USUARIOS) {
    return { elegible: false, motivo: `la promo aplica solo de 1 a ${PROMO_ASISTENCIA_ADDON_MAX_USUARIOS} usuarios` }
  }
  return { elegible: true }
}

export function topePromoSf2a(usuarios: number): number {
  const t = SF2A_TOPE_PROMO.find((x) => usuarios >= x.min && usuarios <= x.max)
  return t ? t.unidades : 0
}

export function cotizarPropuesta(config: ConfigPropuesta): ResultadoPropuesta {
  const advertencias: string[] = []
  const lineas: LineaPropuesta[] = []
  const usuarios = Math.trunc(Number(config.usuarios || 0))

  if (usuarios < 1 || usuarios > MAX_USUARIOS) {
    return { lineas: [], totalMensualUF: 0, totalPagoUnicoUF: 0, advertencias: [`Dotación ${config.usuarios} fuera de rango 1-${MAX_USUARIOS}.`] }
  }

  // ── Asistencia (+ promo 1 UF si corresponde) ──
  const promo = elegibilidadPromoAsistenciaAddon(usuarios, config.promoAsistenciaAddon)
  const tramo = tramoDe(TRAMOS_ASISTENCIA, usuarios)
  if (!tramo) {
    return { lineas: [], totalMensualUF: 0, totalPagoUnicoUF: 0, advertencias: [`Sin tramo de asistencia para ${usuarios} usuarios.`] }
  }
  if (config.promoAsistenciaAddon && !promo.elegible) {
    advertencias.push(`Promo Asistencia+Add-on NO aplicada: ${promo.motivo}.`)
  }
  if (promo.elegible && config.promoAsistenciaAddon) {
    lineas.push({
      tipo: "promo",
      id: `promo_asistencia_${config.promoAsistenciaAddon}`,
      nombre: `Asistencia + ${ADDONS[config.promoAsistenciaAddon].nombre}`,
      detalle: `1-${PROMO_ASISTENCIA_ADDON_MAX_USUARIOS} (Promo)`,
      cantidad: 1,
      precioUnitarioUF: PROMO_ASISTENCIA_ADDON_UF,
      descuentoPct: 0,
      subtotalUF: PROMO_ASISTENCIA_ADDON_UF,
      recurrencia: "mensual",
    })
  } else {
    const d = clampDescuento(config.descuentoAsistenciaPct, "Asistencia", advertencias)
    const bruto = tramo.tipo === "fijo" ? tramo.uf : usuarios * tramo.uf
    lineas.push({
      tipo: "asistencia",
      id: "asistencia",
      nombre: "Control de Asistencia",
      detalle: `Tramo ${tramo.min}-${tramo.max}${tramo.tipo === "fijo" ? " (plan fijo)" : ` × ${tramo.uf} UF/usuario`}`,
      cantidad: tramo.tipo === "fijo" ? 1 : usuarios,
      precioUnitarioUF: tramo.uf,
      descuentoPct: d,
      subtotalUF: r3(bruto * (1 - d / 100)),
      recurrencia: "mensual",
    })
  }

  // ── Add-ons ──
  for (const a of config.addons || []) {
    if (!ADDONS[a.id]) {
      advertencias.push(`Add-on desconocido: ${String(a.id)} — omitido.`)
      continue
    }
    if (promo.elegible && config.promoAsistenciaAddon === a.id) continue // incluido en la promo
    const uAddon = Math.trunc(Number(a.usuarios || usuarios))
    const d = clampDescuento(a.descuentoPct, ADDONS[a.id].nombre, advertencias)
    lineas.push({
      tipo: "addon",
      id: a.id,
      nombre: ADDONS[a.id].nombre,
      detalle: `${uAddon} usuarios × ${ADDONS[a.id].uf} UF`,
      cantidad: uAddon,
      precioUnitarioUF: ADDONS[a.id].uf,
      descuentoPct: d,
      subtotalUF: r3(uAddon * ADDONS[a.id].uf * (1 - d / 100)),
      recurrencia: "mensual",
    })
  }

  // ── Otros servicios ──
  for (const o of config.otrosServicios || []) {
    const def = OTROS_SERVICIOS[o.id]
    if (!def) {
      advertencias.push(`Servicio desconocido: ${String(o.id)} — omitido.`)
      continue
    }
    const uServ = Math.trunc(Number(o.usuarios || usuarios))
    if (uServ < def.minUsuarios) {
      advertencias.push(`${def.nombre} requiere mínimo ${def.minUsuarios} usuarios (pediste ${uServ}) — omitido.`)
      continue
    }
    const t = tramoDe(def.tramos, uServ)
    if (!t) {
      advertencias.push(`${def.nombre}: sin tramo para ${uServ} usuarios — omitido.`)
      continue
    }
    const d = clampDescuento(o.descuentoPct, def.nombre, advertencias)
    const bruto = t.tipo === "fijo" ? t.uf : uServ * t.uf
    lineas.push({
      tipo: "otro_servicio",
      id: o.id,
      nombre: def.nombre,
      detalle: t.tipo === "fijo" ? `Tramo ${t.min}-${t.max} (fijo)` : `${uServ} usuarios × ${t.uf} UF`,
      cantidad: t.tipo === "fijo" ? 1 : uServ,
      precioUnitarioUF: t.uf,
      descuentoPct: d,
      subtotalUF: r3(bruto * (1 - d / 100)),
      recurrencia: "mensual",
    })
  }

  // ── Equipos y accesorios ──
  const catalogos: Array<["equipo" | "accesorio", typeof EQUIPOS, NonNullable<ConfigPropuesta["equipos"]>]> = [
    ["equipo", EQUIPOS, config.equipos || []],
    ["accesorio", ACCESORIOS, config.accesorios || []],
  ]
  for (const [tipo, catalogo, pedidos] of catalogos) {
    for (const e of pedidos) {
      const item = catalogo.find((x) => x.id === e.id)
      if (!item) {
        advertencias.push(`${tipo} desconocido: ${e.id} — omitido.`)
        continue
      }
      const lista = e.modalidad === "venta" ? item.venta : item.arriendo
      if (lista <= 0) {
        advertencias.push(`${item.nombre} no tiene modalidad '${e.modalidad}' en el catálogo — omitido.`)
        continue
      }
      const cantidad = Math.max(1, Math.trunc(Number(e.cantidad || 1)))
      const d = clampDescuento(e.descuentoPct, item.nombre, advertencias)

      // Promo SF2A: parte de las unidades a 0,30, capadas por tramo.
      if (tipo === "equipo" && e.id === "senseface_2a" && e.modalidad === "arriendo" && (config.promoSf2aUnidades || 0) > 0) {
        const tope = topePromoSf2a(usuarios)
        const promoQ = Math.min(cantidad, Math.trunc(Number(config.promoSf2aUnidades || 0)), tope)
        if ((config.promoSf2aUnidades || 0) > promoQ) {
          advertencias.push(`Promo SF2A: tope ${tope} unidades para ${usuarios} usuarios — ${promoQ} quedaron promocionadas.`)
        }
        if (promoQ > 0) {
          lineas.push({
            tipo: "promo",
            id: "senseface_2a_promo",
            nombre: "Senseface 2A (promo)",
            detalle: `${promoQ} × ${PROMO_SF2A_UF} UF arriendo promocional`,
            cantidad: promoQ,
            precioUnitarioUF: PROMO_SF2A_UF,
            descuentoPct: 0,
            subtotalUF: r3(promoQ * PROMO_SF2A_UF),
            recurrencia: "mensual",
          })
        }
        const resto = cantidad - promoQ
        if (resto > 0) {
          lineas.push({
            tipo, id: e.id, nombre: item.nombre,
            detalle: `${resto} × ${lista} UF arriendo`,
            cantidad: resto, precioUnitarioUF: lista, descuentoPct: d,
            subtotalUF: r3(resto * lista * (1 - d / 100)),
            recurrencia: "mensual",
          })
        }
        continue
      }

      const unit = validarOverride(lista, e.precioUF, item.nombre, advertencias)
      lineas.push({
        tipo, id: e.id, nombre: item.nombre,
        detalle: `${cantidad} × ${unit} UF ${e.modalidad}`,
        cantidad, precioUnitarioUF: unit, descuentoPct: d,
        subtotalUF: r3(cantidad * unit * (1 - d / 100)),
        recurrencia: e.modalidad === "arriendo" ? "mensual" : "pago_unico",
      })
    }
  }

  // ── Kits/bundles con precio propio ──
  if ((config.kitQrCantidad || 0) > 0) {
    const q = Math.trunc(Number(config.kitQrCantidad || 0))
    lineas.push({
      tipo: "promo", id: "kit_qr", nombre: "Kit con lector QR (SF3A + gabinete + Vuquest)",
      detalle: `${q} × ${KIT_QR_ARRIENDO_UF} UF arriendo mensual`,
      cantidad: q, precioUnitarioUF: KIT_QR_ARRIENDO_UF, descuentoPct: 0,
      subtotalUF: r3(q * KIT_QR_ARRIENDO_UF), recurrencia: "mensual",
    })
  }
  if (config.bundleIn01 && config.bundleIn01.cantidad > 0) {
    const b = config.bundleIn01
    const unit = IN01_BUNDLE_UF[b.modalidad]
    lineas.push({
      tipo: "promo", id: "bundle_in01", nombre: "Reloj IN01 4G/LAN + Impresora + Gabinetes",
      detalle: `${b.cantidad} × ${unit} UF ${b.modalidad}`,
      cantidad: b.cantidad, precioUnitarioUF: unit, descuentoPct: 0,
      subtotalUF: r3(b.cantidad * unit),
      recurrencia: b.modalidad === "arriendo" ? "mensual" : "pago_unico",
    })
  }

  // ── Servicios asociados (SIEMPRE pago único) ──
  for (const s of config.serviciosAsociados || []) {
    const def = SERVICIOS_ASOCIADOS[s.id]
    if (!def) {
      advertencias.push(`Servicio asociado desconocido: ${String(s.id)} — omitido.`)
      continue
    }
    const lista = def.def[s.modalidad][s.zona]
    const minimo = def.min[s.modalidad][s.zona]
    let unit = lista
    if (s.precioUF !== undefined && Number.isFinite(s.precioUF)) {
      if (s.precioUF < minimo) {
        advertencias.push(`${def.nombre} (${s.zona}/${s.modalidad}): ${s.precioUF} UF bajo el mínimo ${minimo} UF — se usó el mínimo.`)
        unit = minimo
      } else {
        unit = r3(s.precioUF)
      }
    }
    const cantidad = Math.max(1, Math.trunc(Number(s.cantidad || 1)))
    if (unit <= 0) continue // p. ej. envío arriendo rebajado a 0: sin línea, como en la UI
    lineas.push({
      tipo: "servicio_asociado", id: s.id, nombre: `${def.nombre} (${s.zona === "rm" ? "RM" : "Regiones"})`,
      detalle: `${cantidad} × ${unit} UF — pago único`,
      cantidad, precioUnitarioUF: unit, descuentoPct: 0,
      subtotalUF: r3(cantidad * unit), recurrencia: "pago_unico",
    })
  }

  const totalMensualUF = r3(lineas.filter((l) => l.recurrencia === "mensual").reduce((a, l) => a + l.subtotalUF, 0))
  const totalPagoUnicoUF = r3(lineas.filter((l) => l.recurrencia === "pago_unico").reduce((a, l) => a + l.subtotalUF, 0))
  return { lineas, totalMensualUF, totalPagoUnicoUF, advertencias }
}

/** PRINCIPIO 3: lista de cabos sueltos. Emisión prohibida mientras haya alguno. */
export function validarPropuesta(config: ConfigPropuesta): string[] {
  const pendientes: string[] = []
  const usuarios = Math.trunc(Number(config.usuarios || 0))
  if (usuarios < 1 || usuarios > MAX_USUARIOS) pendientes.push(`Dotación: falta o fuera de rango (1-${MAX_USUARIOS}).`)

  const hardware = [...(config.equipos || []), ...(config.accesorios || [])]
  const hayFisico = hardware.length > 0 || (config.kitQrCantidad || 0) > 0 || Boolean(config.bundleIn01?.cantidad)
  const servicios = config.serviciosAsociados || []

  for (const e of hardware) {
    if (e.modalidad !== "venta" && e.modalidad !== "arriendo") {
      pendientes.push(`${e.id}: falta la modalidad (venta o arriendo).`)
    }
    if (e.id === "senseface_2a" && e.modalidad === "venta") {
      pendientes.push("Senseface 2A solo existe en arriendo — cambia la modalidad o el equipo.")
    }
  }
  if (hayFisico) {
    const hayEnvio = servicios.some((s) => s.id === "envio")
    if (!hayEnvio && config.envioExcluido !== true) {
      pendientes.push("Hardware sin ENVÍO resuelto: cotízalo o exclúyelo explícitamente (envioExcluido).")
    }
    const hayInstalacion = servicios.some((s) => s.id === "instalacion")
    if (!hayInstalacion && config.instalacionPorCliente !== true) {
      pendientes.push("Hardware sin INSTALACIÓN resuelta: cotízala o declara instalacionPorCliente.")
    }
  }
  if (config.promoAsistenciaAddon) {
    const p = elegibilidadPromoAsistenciaAddon(usuarios, config.promoAsistenciaAddon)
    if (!p.elegible) pendientes.push(`Promo Asistencia+Add-on no elegible: ${p.motivo}.`)
  }
  if (!String(config.firmante || "").trim()) pendientes.push("Falta el ejecutivo firmante de la propuesta.")
  return pendientes
}
