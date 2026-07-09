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
 *
 * Instalación de hardware:
 *   Cuando la cotización incluye hardware, las tools requieren el array
 *   `puntosInstalacion`. Cada punto se clasifica vía `clasificarUbicacion`
 *   (RM vs regiones) y se inyecta como línea adicional con la tarifa
 *   correspondiente. Si el prospecto declina la instalación (autoInstalada=true),
 *   no se cobra pero se agregan las advertencias declaradas en el catálogo
 *   de servicios.
 *
 * Formato del mensajeParaProspecto:
 *   - Se separa en dos secciones: "Resumen mensual recurrente" (módulos +
 *     hardware en arriendo) y "Pago único" (hardware en compra + instalaciones).
 *   - Cada sección tiene su propio subtotal, IVA, total y equivalente CLP.
 *   - Si solo hay items recurrentes (ej. solo app móvil), la sección "Pago
 *     único" se omite por completo.
 *   - Decimales: subtotales/totales redondean a 1 decimal (sin .0 si queda
 *     entero). Precios unitarios mantienen precisión natural sin ceros
 *     trailing innecesarios.
 *   - NO incluye el sufijo "[tier X-Y usuarios]" — esa info queda solo en
 *     items[].tierAplicado del objeto retornado, para uso interno/debug.
 */

import {
  getModuloDisponibleParaVicky,
  getModulosDisponiblesParaVicky,
  getHardwareDisponibleParaVicky,
  getHardwareDisponiblesParaVicky,
  getServiciosAplicablesConHardware,
  obtenerPrecioServicio,
  obtenerTierAplicable,
  validarRangoModulo,
} from "@/lib/catalogo"
import { clasificarUbicacion } from "@/lib/geografia"
import { getUFActual } from "@/lib/uf"

const IVA_RATE = 0.19
const SCOPE_MAX_USUARIOS = 50

// ─── Schema de la tool ───────────────────────────────────────────────────
export const cotizarReferencialSchema = {
  name: "cotizar_referencial",
  description:
    "Calcula un estimado mensual referencial en UF y CLP para una empresa de 1 a 50 trabajadores, según los módulos de software y el hardware de marcaje que el prospecto haya elegido. Úsalo cuando ya tengas userCount confirmado y al menos un módulo o hardware definido. Si la cotización incluye hardware, también requiere el array 'puntosInstalacion' (uno por punto físico donde se instalará un reloj). Si el prospecto tiene más de 50 trabajadores, NO uses esta tool — deriva a soporte con derivar_a_soporte.",
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
      puntosInstalacion: {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: {
            ubicacion: {
              type: "string" as const,
              description:
                "Ubicación del punto donde se instalará el reloj, tal como la entregó el prospecto. Puede ser una comuna ('Las Condes', 'Concepción'), una región ('Metropolitana', 'Biobío'), un ordinal ('novena región', 'IX'), un número ('región 13'), o un alias ('RM', 'Santiago'). La tool clasifica internamente si es RM o regiones para aplicar la tarifa correcta. Pregunta esto al prospecto, no lo asumas por contexto.",
            },
            autoInstalada: {
              type: "boolean" as const,
              description:
                "true si el prospecto decidió instalar el reloj por su cuenta (no se cobra la instalación, pero el envío se cobra igual; se incluyen advertencias). false si la instalación la realiza GeoVictoria (recomendado).",
            },
            modalidad: {
              type: "string" as const,
              enum: ["arriendo", "venta"],
              description:
                "Modalidad del reloj de ESTE punto ('arriendo' o 'venta'). Define la tarifa de envío e instalación del punto. Si toda la cotización es de una sola modalidad, puedes omitirlo (se infiere del hardware); si hay relojes en arriendo Y compra en distintos puntos, indícalo por punto.",
            },
          },
          required: ["ubicacion", "autoInstalada"],
        },
        description:
          "Lista de puntos físicos donde se instalará hardware. OBLIGATORIO si la cotización incluye al menos un hardware. El envío y la instalación se cobran por punto (un punto con 2 relojes tiene un solo envío y una sola instalación). Si la cotización no incluye hardware, omitir.",
      },
    },
    required: ["userCount", "modulos"],
  },
}

// ─── Tipos de resultado ──────────────────────────────────────────────────
export type ItemCotizacion = {
  tipo: "modulo" | "hardware" | "servicio"
  id: string
  nombre: string
  modalidad: string
  cantidad: number
  precioUnitarioUF: number
  subtotalUF: number
  tierAplicado?: string // ej. "11-20 usuarios" — uso interno, NO se muestra al prospecto
}

export type PuntoInstalacionInput = {
  ubicacion: string
  autoInstalada: boolean
  /** Modalidad del reloj del punto. Si se omite, se infiere del hardware. */
  modalidad?: "arriendo" | "venta"
}

export type CotizacionResultado =
  | {
      ok: true
      userCount: number
      items: ItemCotizacion[]
      // Totales globales (suma de recurrente + único). Se mantienen por
      // compatibilidad con consumidores externos que ya leen estos campos.
      subtotalUF: number
      ivaUF: number
      totalUF: number
      ufActual: number
      totalCLP: number
      // Totales separados por sección (nuevos)
      subtotalRecurrenteUF: number
      ivaRecurrenteUF: number
      totalRecurrenteUF: number
      totalRecurrenteCLP: number
      subtotalUnicoUF: number
      ivaUnicoUF: number
      totalUnicoUF: number
      totalUnicoCLP: number
      resumenLegible: string
      mensajeParaProspecto: string
      advertencias: string[]
    }
  | { ok: false; error: string }

// ─── UF actual: fuente única compartida (lib/uf.ts) ──────────────────────
// getUFActual se importa de @/lib/uf para que estimado, negociación y
// cotización formal usen el MISMO valor (con caché) en una conversación.

// ─── Helpers de formato ─────────────────────────────────────────────────
// Formato chileno: "." separador de miles, "," separador decimal.
// Ej: 40522.38 → "40.522,38"; 3.5 con 1 decimal → "3,5".
function fmtNumCL(n: number, decimals: number): string {
  const [entero, dec] = n.toFixed(decimals).split(".")
  const conMiles = entero.replace(/\B(?=(\d{3})+(?!\d))/g, ".")
  return dec ? `${conMiles},${dec}` : conMiles
}

// Formato para UF (regla unificada acordada con Rodrigo):
//   - Hasta 2 decimales (redondeo).
//   - Si queda entero, sin decimales.
//   - Sin ceros trailing innecesarios.
//   - Coma decimal (formato chileno).
// Ej: 5 → "5"; 0.07 → "0,07"; 0.35 → "0,35"; 3.5 → "3,5";
//     3.85 → "3,85"; 0.7315 → "0,73"; 4.5815 → "4,58"; 7.0 → "7"; 6.961 → "6,96".
function fmtUF(n: number): string {
  const rounded = Math.round(n * 100) / 100
  if (Number.isInteger(rounded)) return fmtNumCL(rounded, 0)
  const s = fmtNumCL(rounded, 2)
  return s.replace(/0+$/, "").replace(/,$/, "")
}

// Precio UNITARIO: hasta 3 decimales para que "cantidad × unitario = subtotal"
// calce a la vista. Los tramos de asistencia 0,055 / 0,065 se redondeaban a
// 0,06 / 0,07 con fmtUF y la multiplicación no cuadraba con el subtotal real
// (ej: 46 × 0,06 = 2,76 ≠ 2,53). Mismo formato chileno, sin ceros trailing.
function fmtUFUnit(n: number): string {
  const rounded = Math.round(n * 1000) / 1000
  if (Number.isInteger(rounded)) return fmtNumCL(rounded, 0)
  const s = fmtNumCL(rounded, 3)
  return s.replace(/0+$/, "").replace(/,$/, "")
}

// ─── Clasificación de modalidad → sección del preform ────────────────────
type Seccion = "recurrente" | "unico"

function seccionDe(modalidad: string): Seccion {
  if (modalidad === "Fijo" || modalidad === "Por usuario" || modalidad === "Arriendo mensual") {
    return "recurrente"
  }
  // "Venta única", "Cobro único"
  return "unico"
}

// ─── Formato de cada item según su modalidad ─────────────────────────────
function formatItem(i: ItemCotizacion): string {
  if (i.modalidad === "Fijo") {
    return `- ${i.nombre}: ${fmtUF(i.subtotalUF)} UF/mes`
  }
  if (i.modalidad === "Por usuario") {
    return `- ${i.nombre}: ${i.cantidad} × ${fmtUFUnit(i.precioUnitarioUF)} UF = ${fmtUF(i.subtotalUF)} UF/mes`
  }
  if (i.modalidad === "Arriendo mensual") {
    return `- ${i.nombre}: ${i.cantidad} unidad${i.cantidad > 1 ? "es" : ""} × ${fmtUFUnit(i.precioUnitarioUF)} UF = ${fmtUF(i.subtotalUF)} UF/mes`
  }
  if (i.modalidad === "Venta única") {
    return `- ${i.nombre} (compra): ${i.cantidad} unidad${i.cantidad > 1 ? "es" : ""} × ${fmtUFUnit(i.precioUnitarioUF)} UF = ${fmtUF(i.subtotalUF)} UF`
  }
  if (i.modalidad === "Cobro único") {
    return `- ${i.nombre}: ${fmtUF(i.subtotalUF)} UF`
  }
  return `- ${i.nombre}: ${i.cantidad} × ${fmtUFUnit(i.precioUnitarioUF)} UF = ${fmtUF(i.subtotalUF)} UF`
}

// ─── Implementación ──────────────────────────────────────────────────────
export async function cotizarReferencial(args: {
  userCount: number
  modulos: string[]
  hardware?: Array<{ id: string; cantidad?: number; modalidad?: "arriendo" | "venta" }>
  puntosInstalacion?: PuntoInstalacionInput[]
}): Promise<CotizacionResultado> {
  const { userCount, modulos, hardware = [], puntosInstalacion = [] } = args
  const advertencias: string[] = []

  // ── Validación de rango ──
  if (!Number.isFinite(userCount) || userCount < 1 || userCount > SCOPE_MAX_USUARIOS) {
    return {
      ok: false,
      error: `userCount=${userCount} fuera de rango. Esta tool cubre empresas de 1 a ${SCOPE_MAX_USUARIOS} trabajadores. Para empresas más grandes, deriva con derivar_a_soporte motivo "fuera_de_rango_trabajadores".`,
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
      continue
    }

    // Obtener tier aplicable
    const tier = obtenerTierAplicable(modulo, userCount)
    if (!tier) {
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
  let hayHardware = false
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
    hayHardware = true

    if (cantidad > dispositivo.cantidadSugerida) {
      advertencias.push(
        `Para ${dispositivo.displayName} se está cotizando ${cantidad} unidades. La cotizadora oficial puede aplicar precios distintos a las unidades adicionales (descuento promo aplica solo a las primeras unidades).`
      )
    }
  }

  // ── Procesar puntos de instalación ──
  if (hayHardware) {
    if (puntosInstalacion.length === 0) {
      return {
        ok: false,
        error:
          "La cotización incluye hardware pero no se entregó 'puntosInstalacion'. " +
          "Por cada punto físico donde se instalará un reloj, debes pasar { ubicacion, autoInstalada }. " +
          "Si el prospecto aún no ha entregado la ubicación, pregúntale la comuna o región antes de cotizar.",
      }
    }

    for (const punto of puntosInstalacion) {
      const c = clasificarUbicacion(punto.ubicacion)
      if (c.tipo === "no_clasificable") {
        return {
          ok: false,
          error:
            `No pude clasificar la ubicación '${punto.ubicacion}' (${c.razon}). ` +
            `Pregúntale al prospecto la comuna o región específica donde se instalará el reloj ` +
            `y vuelve a llamar la tool.`,
        }
      }
    }

    const modalidadesHw = new Set(
      hardware.map((hw) => (hw.modalidad ?? "arriendo") as "arriendo" | "venta"),
    )
    const modalidadUniforme: "arriendo" | "venta" | null =
      modalidadesHw.size === 1 ? [...modalidadesHw][0] : null

    const serviciosAplicables = getServiciosAplicablesConHardware()
    for (const punto of puntosInstalacion) {
      const clasificacion = clasificarUbicacion(punto.ubicacion)
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

      const zonaPunto = clasificacion.zonaInstalacion
      for (const servicio of serviciosAplicables) {
        if (punto.autoInstalada && servicio.omitirSiAutoInstalada) {
          for (const adv of servicio.advertenciasAutoInstalacion) {
            advertencias.push(`Auto-instalación en ${punto.ubicacion}: ${adv}`)
          }
          continue
        }
        const precioUF = obtenerPrecioServicio(servicio, zonaPunto, modalidadPunto)
        if (precioUF <= 0) continue
        items.push({
          tipo: "servicio",
          id: servicio.id,
          nombre: `${servicio.nombre} (${punto.ubicacion})`,
          modalidad: "Cobro único",
          cantidad: 1,
          precioUnitarioUF: precioUF,
          subtotalUF: Number(precioUF.toFixed(3)),
        })
      }
    }
  }

  if (items.length === 0) {
    return {
      ok: false,
      error: "No hay items válidos para cotizar. Verificá que los IDs sean correctos y estén habilitados.",
    }
  }

  // ── Totales globales (compatibilidad) ──
  const subtotalUF = items.reduce((sum, i) => sum + i.subtotalUF, 0)
  const ivaUF = subtotalUF * IVA_RATE
  const totalUF = subtotalUF + ivaUF
  const ufActual = await getUFActual()
  const totalCLP = Math.round(totalUF * ufActual)

  // ── Totales separados por sección ──
  const itemsRecurrentes = items.filter((i) => seccionDe(i.modalidad) === "recurrente")
  const itemsUnicos = items.filter((i) => seccionDe(i.modalidad) === "unico")

  const subtotalRecurrenteUF = itemsRecurrentes.reduce((sum, i) => sum + i.subtotalUF, 0)
  const ivaRecurrenteUF = subtotalRecurrenteUF * IVA_RATE
  const totalRecurrenteUF = subtotalRecurrenteUF + ivaRecurrenteUF
  const totalRecurrenteCLP = Math.round(totalRecurrenteUF * ufActual)

  const subtotalUnicoUF = itemsUnicos.reduce((sum, i) => sum + i.subtotalUF, 0)
  const ivaUnicoUF = subtotalUnicoUF * IVA_RATE
  const totalUnicoUF = subtotalUnicoUF + ivaUnicoUF
  const totalUnicoCLP = Math.round(totalUnicoUF * ufActual)

  // ── Construir mensaje canónico en secciones ──
  // Este string es la ÚNICA fuente de verdad para comunicar precios al usuario.
  // Vicky copia este bloque tal cual al prospecto. Si cambia el formato
  // (descuentos, planes anuales, etc.), se modifica acá y se propaga a todas
  // las superficies que consuman esta tool.
  const partes: string[] = []

  // Micro-plan: 1 trabajador que marca. El plan base cubre 2 usuarios (el que
  // marca + 1 administrador). Se aclara en el mensaje para que el prospecto
  // entienda el alcance de la tarifa especial.
  const esMicroPlan =
    userCount === 1 && items.some((i) => i.id === "asistencia" && i.modalidad === "Fijo")

  if (itemsRecurrentes.length > 0) {
    partes.push("Resumen mensual recurrente:")
    partes.push("")
    partes.push(itemsRecurrentes.map(formatItem).join("\n"))
    partes.push("")
    partes.push(`Subtotal mensual: ${fmtUF(subtotalRecurrenteUF)} UF`)
    partes.push(`IVA (19%): ${fmtUF(ivaRecurrenteUF)} UF`)
    partes.push(`Total mensual con IVA: ${fmtUF(totalRecurrenteUF)} UF`)
    partes.push(
      `Equivalente: $${fmtNumCL(totalRecurrenteCLP, 0)} CLP/mes (UF del día: $${fmtNumCL(ufActual, 2)})`,
    )
    if (esMicroPlan) {
      partes.push("")
      partes.push(
        "Este plan base cubre 2 usuarios: el trabajador que marca + 1 administrador para gestionar la plataforma.",
      )
    }
  }

  if (itemsUnicos.length > 0) {
    if (partes.length > 0) partes.push("")
    partes.push("Pago único:")
    partes.push("")
    partes.push(itemsUnicos.map(formatItem).join("\n"))
    partes.push("")
    partes.push(`Subtotal único: ${fmtUF(subtotalUnicoUF)} UF`)
    partes.push(`IVA (19%): ${fmtUF(ivaUnicoUF)} UF`)
    partes.push(`Total único con IVA: ${fmtUF(totalUnicoUF)} UF`)
    partes.push(`Equivalente único: $${fmtNumCL(totalUnicoCLP, 0)} CLP`)
  }

  // Aclaración de base: dejar SIN AMBIGÜEDAD (1) qué se paga al aceptar —el
  // pago inicial = pago único + primer mes por adelantado— y (2) cómo sigue el
  // cobro desde el segundo mes: un plan mensual recurrente. Cubrimos los dos
  // casos: con pago único (hardware/instalación) y sin él (solo plan, ej. app).
  if (itemsUnicos.length > 0 && itemsRecurrentes.length > 0) {
    partes.push("")
    partes.push(
      `Al aceptar pagas el pago inicial de $${fmtNumCL(
        totalUnicoCLP + totalRecurrenteCLP,
        0,
      )} CLP: incluye el pago único (equipos e instalación) + el primer mes del plan por adelantado.`,
    )
  } else if (itemsRecurrentes.length > 0) {
    partes.push("")
    partes.push(
      `Al aceptar pagas el primer mes del plan por adelantado: $${fmtNumCL(
        totalRecurrenteCLP,
        0,
      )} CLP.`,
    )
  }

  const mensajeParaProspecto = partes.join("\n")

  // resumenLegible (uso interno del modelo) usa el mismo formato — una sola
  // fuente de verdad para que no haya inconsistencias entre lo que ve el
  // modelo internamente y lo que comunica al prospecto.
  const resumenLegible = mensajeParaProspecto

  return {
    ok: true,
    userCount,
    items,
    subtotalUF: Number(subtotalUF.toFixed(3)),
    ivaUF: Number(ivaUF.toFixed(3)),
    totalUF: Number(totalUF.toFixed(3)),
    ufActual: Number(ufActual.toFixed(2)),
    totalCLP,
    subtotalRecurrenteUF: Number(subtotalRecurrenteUF.toFixed(3)),
    ivaRecurrenteUF: Number(ivaRecurrenteUF.toFixed(3)),
    totalRecurrenteUF: Number(totalRecurrenteUF.toFixed(3)),
    totalRecurrenteCLP,
    subtotalUnicoUF: Number(subtotalUnicoUF.toFixed(3)),
    ivaUnicoUF: Number(ivaUnicoUF.toFixed(3)),
    totalUnicoUF: Number(totalUnicoUF.toFixed(3)),
    totalUnicoCLP,
    resumenLegible,
    mensajeParaProspecto,
    advertencias,
  }
}
