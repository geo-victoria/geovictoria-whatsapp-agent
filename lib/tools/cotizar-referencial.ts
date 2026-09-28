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

import { getUFActual } from "@/lib/uf"
import { cotizarReferencialConReglas } from "@/lib/cotizacion-unica/motor"
import { REGLAS_CL, resultadoChile } from "@/lib/cotizacion-unica/reglas-cl"

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
                "POR DEFECTO 'arriendo'. El reloj se cotiza SIEMPRE arrendado; usa 'venta' ÚNICAMENTE si el cliente pidió COMPRARLO de forma explícita en la conversación. Nunca elijas 'venta' por tu cuenta, ni para comparar, ni porque el cliente pregunte cuánto vale el reloj. Ante la duda, omite el campo.",
            },
          },
          required: ["id"],
        },
        description:
          "Lista opcional de hardware de marcaje a incluir. Si el prospecto no menciona necesidad de dispositivo físico, dejar vacío.",
      },
      evidenciaEleccionReloj: {
        type: "string",
        description:
          "OBLIGATORIO si la cotización incluye hardware: la frase TEXTUAL del cliente (copiada literal de su mensaje, sin parafrasear ni corregir) donde eligió el reloj o el mixto — ej: 'me interesa con ambos', 'quiero el reloj', 'la primera opción'. El sistema verifica que exista palabra por palabra en la conversación; sin esa cita la cotización con hardware se rechaza. Si el cliente aún no ha elegido, NO cotices con hardware: pregúntale el marcaje.",
      },
      evidenciaUbicacion: {
        type: "string",
        description:
          "OBLIGATORIO si la cotización incluye hardware: la frase TEXTUAL del cliente (literal) donde dijo la comuna/ubicación del punto — ej: 'no disculpa es para olmué', 'estamos en Renca'. Sin esa cita (o sin que la comuna aparezca en sus mensajes) la cotización con hardware se rechaza.",
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
  /** Bonificación por línea (100 = sin costo, se muestra tachada). */
  descuentoPct?: number
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

// ─── Implementación: el MOTOR ÚNICO con los datos de Chile ──────────────
// La lógica que vivía acá (módulos, equipos, envío/instalación por punto,
// arriendo por zona, doble valor) es ahora lib/cotizacion-unica/motor.ts, la
// misma para los cuatro países. Este archivo conserva el contrato de la tool
// chilena (schema, nombres de campos en UF, UF del día).
export async function cotizarReferencial(args: {
  userCount: number
  modulos: string[]
  hardware?: Array<{ id: string; cantidad?: number; modalidad?: "arriendo" | "venta" }>
  puntosInstalacion?: PuntoInstalacionInput[]
}): Promise<CotizacionResultado> {
  const { userCount, modulos, hardware = [], puntosInstalacion = [] } = args
  // UF del día (fuente única compartida con la negociación y la formal).
  const ufActual = await getUFActual()
  const r = cotizarReferencialConReglas(REGLAS_CL, { userCount, modulos, hardware, puntosInstalacion }, ufActual)
  return resultadoChile(r, ufActual) as CotizacionResultado
}
