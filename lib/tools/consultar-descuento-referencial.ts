/**
 * Tool: consultar_descuento_referencial
 *
 * NEGOCIACIÓN EN EL PREFORM (read-only). Cuando el prospecto objeta el precio
 * en el preform (la primera vez que ve precios, ANTES de generar la cotización
 * formal), esta tool consulta al servidor qué descuento se puede ofrecer y
 * devuelve el PRECIO RECALCULADO para comunicarlo en la conversación. NO genera
 * ninguna cotización ni PDF.
 *
 * Flujo:
 *   1. El prospecto objeta el precio del preform → Vicky llama esta tool con los
 *      mismos parámetros de la cotización (userCount, modulos, hardware,
 *      puntosInstalacion) y escalonActual=0, y ofrece el descuento + precio
 *      copiando `mensajeParaProspecto`.
 *   2. Si insiste en más rebaja → Vicky vuelve a llamarla pasando el
 *      `escalonActual` que devolvió la consulta anterior (avanza un escalón).
 *   3. Cuando ACEPTA → Vicky llama generar_link_cotizadora pasando
 *      `escalonDescuento` = el `escalonActual` devuelto por la consulta aceptada.
 *      La cotización formal se genera UNA sola vez, ya con el descuento.
 *
 * SEGURIDAD (anti-alucinación): NO recibe porcentajes; el servidor decide el
 * escalón y calcula el precio. Vicky solo comunica el `mensajeParaProspecto`.
 */

import {
  construirItemsCotizacion,
  getUFActualSafe,
  type ConstruirItemsArgs,
} from "./generar-link-cotizadora"

const COTIZADORA_API_BASE =
  process.env.COTIZADORA_API_BASE || "https://cotizacion.geovictoria.com"
const VICKY_COTIZADORA_SECRET = process.env.VICKY_COTIZADORA_SECRET || ""
const SCOPE_MAX_USUARIOS = 50

export const consultarDescuentoReferencialSchema = {
  name: "consultar_descuento_referencial",
  description:
    "Negociación de descuento EN EL PREFORM (solo lectura), antes de generar la cotización formal. Úsala cuando el prospecto objeta el precio del preform o pide rebaja. Devuelve el siguiente descuento y el precio recalculado (pago inicial y mensual) para ofrecerlo EN LA CONVERSACIÓN. NO crea cotización ni PDF. Pasá los MISMOS parámetros de la cotización que ibas a usar en generar_link_cotizadora (userCount, modulos, hardware, puntosInstalacion) más `escalonActual` (0 la primera vez). NO recibe porcentaje: el servidor decide el escalón (instalación primero — RM antes que regiones —, luego plan mensual 10 → 15 → 20 → 25 → 30%). Copiá el `mensajeParaProspecto` TAL CUAL. Si el prospecto insiste en más rebaja, volvé a llamarla pasando el `escalonActual` que devolvió la consulta anterior. Cuando el prospecto ACEPTE, llamá generar_link_cotizadora con `escalonDescuento` = el `escalonActual` que devolvió la consulta aceptada (así la cotización nace con ese descuento). Si `topeAlcanzado=true`, es el último escalón posible.",
  input_schema: {
    type: "object" as const,
    properties: {
      userCount: {
        type: "number" as const,
        minimum: 1,
        maximum: SCOPE_MAX_USUARIOS,
        description: "Cantidad de trabajadores (1-50), igual que en el preform.",
      },
      modulos: {
        type: "array" as const,
        items: { type: "string" as const },
        description: "IDs de módulos confirmados. Siempre incluir 'asistencia'.",
        minItems: 1,
      },
      hardware: {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: {
            id: { type: "string" as const },
            cantidad: { type: "number" as const, minimum: 1 },
            modalidad: { type: "string" as const, enum: ["arriendo", "venta"] },
          },
          required: ["id"],
        },
      },
      puntosInstalacion: {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: {
            ubicacion: { type: "string" as const },
            autoInstalada: { type: "boolean" as const },
          },
          required: ["ubicacion", "autoInstalada"],
        },
        description: "Puntos de instalación (igual que el preform). Obligatorio si hay hardware.",
      },
      escalonActual: {
        type: "number" as const,
        minimum: 0,
        description:
          "Cuántos escalones ya ofreciste en esta negociación. 0 la primera vez. En las siguientes, pasá el `escalonActual` que devolvió la consulta anterior.",
      },
    },
    required: ["userCount", "modulos"],
  },
}

export type ConsultarDescuentoReferencialInput = ConstruirItemsArgs & {
  escalonActual?: number
}

export type ConsultarDescuentoReferencialResultado =
  | {
      ok: true
      escalon: { tipo: string; pct: number; condicionDiscursiva: string | null }
      preview: { pagoInicialClp: number; mensualClp: number }
      escalonActual: number
      topeAlcanzado: boolean
      mensajeParaProspecto: string
    }
  | {
      ok: false
      error: string
      topeAlcanzado?: boolean
    }

export async function consultarDescuentoReferencial(
  args: ConsultarDescuentoReferencialInput,
): Promise<ConsultarDescuentoReferencialResultado> {
  // Armar los ítems con el MISMO builder que usa generar_link_cotizadora.
  const construccion = construirItemsCotizacion({
    userCount: args.userCount,
    modulos: args.modulos,
    hardware: args.hardware,
    puntosInstalacion: args.puntosInstalacion,
  })
  if (!construccion.ok) {
    return { ok: false, error: construccion.error }
  }

  const ufActual = await getUFActualSafe()
  const escalonActual = Math.max(0, Number(args.escalonActual || 0))

  try {
    const response = await fetch(
      `${COTIZADORA_API_BASE}/api/quote-acceptance/consultar-descuento-referencial`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(VICKY_COTIZADORA_SECRET
            ? { "x-vicky-secret": VICKY_COTIZADORA_SECRET }
            : {}),
        },
        body: JSON.stringify({
          cotizacion: { items: construccion.items, ufActual },
          escalonActual,
        }),
        cache: "no-store",
      },
    )

    if (!response.ok) {
      const errBody = await response.text().catch(() => "")
      console.error(
        `[consultar_descuento_referencial] cotizadora respondió ${response.status}:`,
        errBody.slice(0, 200),
      )
      return { ok: false, error: `La cotizadora respondió ${response.status}.` }
    }

    const data = (await response.json()) as {
      ok?: boolean
      escalon?: { tipo?: string; pct?: number; condicion_discursiva?: string | null }
      preview?: { pago_inicial_clp?: number; mensual_clp?: number }
      escalon_actual?: number
      tope_alcanzado?: boolean
      mensaje_para_prospecto?: string
      error?: string
    }

    if (data.ok === false) {
      return {
        ok: false,
        error: data.error || "No se pudo consultar el descuento.",
        topeAlcanzado: Boolean(data.tope_alcanzado),
      }
    }

    if (
      !data.escalon ||
      typeof data.escalon.pct !== "number" ||
      typeof data.escalon.tipo !== "string" ||
      typeof data.mensaje_para_prospecto !== "string"
    ) {
      return { ok: false, error: "Respuesta inválida de la cotizadora." }
    }

    return {
      ok: true,
      escalon: {
        tipo: data.escalon.tipo,
        pct: data.escalon.pct,
        condicionDiscursiva: data.escalon.condicion_discursiva ?? null,
      },
      preview: {
        pagoInicialClp: Number(data.preview?.pago_inicial_clp || 0),
        mensualClp: Number(data.preview?.mensual_clp || 0),
      },
      escalonActual: Number(data.escalon_actual || escalonActual + 1),
      topeAlcanzado: Boolean(data.tope_alcanzado),
      mensajeParaProspecto: data.mensaje_para_prospecto,
    }
  } catch (err) {
    console.error("[consultar_descuento_referencial] excepción:", err)
    return {
      ok: false,
      error: "No se pudo consultar el descuento en este momento.",
    }
  }
}
