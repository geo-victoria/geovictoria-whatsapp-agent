/**
 * Tool: cotizar_referencial
 *
 * Calcula un estimado mensual referencial para empresas de 1 a 50 trabajadores.
 *
 * Para cada módulo y cantidad de usuarios, busca el tier correcto en el
 * catálogo (vía obtenerTierAplicable). Si un módulo no tiene tier para
 * ese rango (ej. Reporte para 3 personas), la cotización emite advertencia
 * y omite ese módulo sin fallar la respuesta entera.
 *
 * Si un producto no existe en el catálogo o no tiene disponibleParaVicky=true,
 * la tool falla con error legible. Eso garantiza la premisa rectora:
 *   "Solo se cotiza lo que existe en el catálogo Y está habilitado."
 */

import {
  getModuloDisponibleParaVicky,
  getModulosDisponiblesParaVicky,
  getHardwareDisponibleParaVicky,
  getHardwareDisponiblesParaVicky,
  obtenerTierAplicable,
  validarRangoModulo,
} from "@/lib/catalogo"

const IVA_RATE = 0.19
const SCOPE_MAX_USUARIOS = 50

// ─── Schema de la tool ───────────────────────────────────────────────────
export const cotizarReferencialSchema = {
  name: "cotizar_referencial",
  description:
    "Calcula un estimado mensual referencial en UF y CLP para una empresa de 1 a 50 trabajadores, según los módulos de software y el hardware de marcaje que el prospecto haya elegido. Úsalo cuando ya tengas userCount confirmado y al menos un módulo o hardware definido. Si el prospecto tiene más de 50 trabajadores, NO uses esta tool — derivá a soporte con derivar_a_soporte.",
  input_schema: {
    type: "object" as const,
    properties: {
      userCount: {
        type: "number" as const,
        description: "Cantidad de trabajadores (debe estar entre 1 y 50 inclusive).",
        minimum: 1,
        maximum: SCOPE_MAX_USUARIOS,
      },
      modulos: {
        type: "array" as const,
        items: { type: "string" as const },
        description:
          "Lista de IDs de módulos de software a incluir. El catálogo disponible se le pasa en el system prompt. Siempre debe incluirse 'asistencia' como base.",
        minItems: 1,
      },
      hardware: {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: {
            id: {
              type: "string" as const,
              description:
                "ID del hardware del catálogo (ej. 'senseface_2a'). Solo se aceptan productos habilitados para Vicky.",
            },
            cantidad: {
              type: "number" as const,
              description: "Cantidad de unidades. Default 1 si no se especifica.",
              minimum: 1,
              maximum: 10,
            },
            modalidad: {
              type: "string" as const,
              enum: ["arriendo", "venta"],
              description:
                "Modalidad. Si el hardware no tiene precio de venta (ej. SF2A tiene venta=0), solo 'arriendo' aplica.",
            },
          },
          required: ["id"],
        },
        description:
          "Lista opcional de hardware de marcaje a incluir. Si el prospecto no menciona necesidad de dispositivo físico, dejar vacío.",
      },
    },
    required: ["userCount", "modulos"],
  },
}

// ─── Tipos de resultado ──────────────────────────────────────────────────
export type ItemCotizacion = {
  tipo: "modulo" | "hardware"
  id: string
  nombre: string
  modalidad: string
  cantidad: number
  precioUnitarioUF: number
  subtotalUF: number
  tierAplicado?: string // ej. "11-20 usuarios"
}

export type CotizacionResultado =
  | {
      ok: true
      userCount: number
      items: ItemCotizacion[]
      subtotalUF: number
      ivaUF: number
      totalUF: number
      ufActual: number
      totalCLP: number
      resumenLegible: string
      advertencias: string[]
    }
  | { ok: false; error: string }

// ─── UF actual desde mindicador.cl ───────────────────────────────────────
async function getUFActual(): Promise<number> {
  try {
    const res = await fetch("https://mindicador.cl/api/uf", {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    })
    const data = await res.json()
    const valor = data?.serie?.[0]?.valor
    if (typeof valor === "number" && valor > 0) return valor
  } catch {
    /* fall back */
  }
  return 39000 // fallback aproximado mayo 2026
}

// ─── Implementación ──────────────────────────────────────────────────────
export async function cotizarReferencial(args: {
  userCount: number
  modulos: string[]
  hardware?: Array<{ id: string; cantidad?: number; modalidad?: "arriendo" | "venta" }>
}): Promise<CotizacionResultado> {
  const { userCount, modulos, hardware = [] } = args
  const advertencias: string[] = []

  // ── Validación de rango ──
  if (!Number.isFinite(userCount) || userCount < 1 || userCount > SCOPE_MAX_USUARIOS) {
    return {
      ok: false,
      error: `userCount=${userCount} fuera de rango. Esta tool cubre empresas de 1 a ${SCOPE_MAX_USUARIOS} trabajadores. Para empresas más grandes, derivá con derivar_a_soporte motivo "fuera_de_rango_trabajadores".`,
    }
  }

  // ── Procesar módulos ──
  const items: ItemCotizacion[] = []

  // Forzar inclusión de 'asistencia' como base
  const modulosConBase = modulos.includes("asistencia") ? modulos : ["asistencia", ...modulos]

  for (const moduloId of modulosConBase) {
    const modulo = getModuloDisponibleParaVicky(moduloId)
    if (!modulo) {
      const todosDisponibles = getModulosDisponiblesParaVicky().map((m) => m.id)
      return {
        ok: false,
        error: `Módulo '${moduloId}' no está disponible para cotización por Vicky. Módulos habilitados: ${todosDisponibles.join(", ")}.`,
      }
    }

    // Validar rango (mínimos globales + cobertura de tiers)
    const rangoError = validarRangoModulo(modulo, userCount)
    if (rangoError) {
      advertencias.push(rangoError)
      continue // saltar este módulo pero no fallar la cotización entera
    }

    // Obtener tier aplicable
    const tier = obtenerTierAplicable(modulo, userCount)
    if (!tier) {
      // Defensa redundante con validarRangoModulo, pero por las dudas
      advertencias.push(`No se encontró tier aplicable para ${modulo.nombre} con ${userCount} trabajadores.`)
      continue
    }

    const cantidad = tier.modalidad === "fijo" ? 1 : userCount
    const subtotalUF =
      tier.modalidad === "fijo" ? tier.precioUF : userCount * tier.precioUF

    items.push({
      tipo: "modulo",
      id: modulo.id,
      nombre: modulo.nombre,
      modalidad: tier.modalidad === "fijo" ? "Fijo" : "Por usuario",
      cantidad,
      precioUnitarioUF: tier.precioUF,
      subtotalUF: Number(subtotalUF.toFixed(3)),
      tierAplicado: `${tier.minUsuarios}-${tier.maxUsuarios} usuarios`,
    })
  }

  // ── Procesar hardware ──
  for (const hw of hardware) {
    const dispositivo = getHardwareDisponibleParaVicky(hw.id)
    if (!dispositivo) {
      const disponibles = getHardwareDisponiblesParaVicky().map((h) => h.id)
      return {
        ok: false,
        error: `Hardware '${hw.id}' no está disponible para cotización por Vicky. ${disponibles.length > 0 ? `Hardware habilitado: ${disponibles.join(", ")}.` : "No hay hardware habilitado actualmente."}`,
      }
    }

    const cantidad = hw.cantidad ?? dispositivo.cantidadSugerida
    const modalidadElegida: "arriendo" | "venta" = hw.modalidad ?? "arriendo"

    if (!dispositivo.modalidadesDisponibles.includes(modalidadElegida)) {
      return {
        ok: false,
        error: `El ${dispositivo.displayName} no está disponible en modalidad '${modalidadElegida}'. Modalidades disponibles: ${dispositivo.modalidadesDisponibles.join(", ")}.`,
      }
    }

    const precioUnitario =
      modalidadElegida === "arriendo" ? dispositivo.arriendoUF : dispositivo.ventaUF

    if (precioUnitario === 0) {
      return {
        ok: false,
        error: `${dispositivo.displayName} no tiene precio en modalidad '${modalidadElegida}' (valor 0).`,
      }
    }

    items.push({
      tipo: "hardware",
      id: dispositivo.id,
      nombre: dispositivo.displayName,
      modalidad: modalidadElegida === "arriendo" ? "Arriendo mensual" : "Venta única",
      cantidad,
      precioUnitarioUF: precioUnitario,
      subtotalUF: Number((cantidad * precioUnitario).toFixed(3)),
    })

    // Aviso si pidió más de la cantidad sugerida (heads-up para Vicky)
    if (cantidad > dispositivo.cantidadSugerida) {
      advertencias.push(
        `Para ${dispositivo.displayName} se está cotizando ${cantidad} unidades. La cotizadora oficial puede aplicar precios distintos a las unidades adicionales (descuento promo aplica solo a las primeras unidades).`
      )
    }
  }

  if (items.length === 0) {
    return {
      ok: false,
      error: "No hay items válidos para cotizar. Verificá que los IDs sean correctos y estén habilitados.",
    }
  }

  // ── Totales ──
  const subtotalUF = items.reduce((sum, i) => sum + i.subtotalUF, 0)
  const ivaUF = subtotalUF * IVA_RATE
  const totalUF = subtotalUF + ivaUF
  const ufActual = await getUFActual()
  const totalCLP = Math.round(totalUF * ufActual)

  // ── Resumen legible para el modelo ──
  const lineas = items.map((i) => {
    const sufijoTier = i.tierAplicado ? ` [tier ${i.tierAplicado}]` : ""
    if (i.modalidad === "Fijo") {
      return `- ${i.nombre}: ${i.subtotalUF.toFixed(3)} UF (fijo mensual)${sufijoTier}`
    }
    if (i.modalidad === "Por usuario") {
      return `- ${i.nombre}: ${i.cantidad} × ${i.precioUnitarioUF.toFixed(3)} UF = ${i.subtotalUF.toFixed(3)} UF${sufijoTier}`
    }
    if (i.modalidad === "Arriendo mensual") {
      return `- ${i.nombre}: ${i.cantidad} unidad${i.cantidad > 1 ? "es" : ""} × ${i.precioUnitarioUF.toFixed(3)} UF = ${i.subtotalUF.toFixed(3)} UF/mes`
    }
    return `- ${i.nombre}: ${i.cantidad} × ${i.precioUnitarioUF.toFixed(3)} UF = ${i.subtotalUF.toFixed(3)} UF`
  })
  const resumenLegible = lineas.join("\n")

  return {
    ok: true,
    userCount,
    items,
    subtotalUF: Number(subtotalUF.toFixed(3)),
    ivaUF: Number(ivaUF.toFixed(3)),
    totalUF: Number(totalUF.toFixed(3)),
    ufActual: Number(ufActual.toFixed(2)),
    totalCLP,
    resumenLegible,
    advertencias,
  }
}
