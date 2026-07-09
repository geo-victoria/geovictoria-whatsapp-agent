/**
 * Tool: consultar_siguiente_descuento
 *
 * NEGOCIACIÓN (read-only). Pregunta al servidor qué descuento puede ofrecer
 * Vicky en el siguiente escalón y devuelve el PRECIO RECALCULADO (pago inicial
 * y plan mensual) para comunicarlo en la conversación, SIN regenerar la
 * cotización formal ni comprometer el descuento.
 *
 * Flujo de negociación:
 *   1. El prospecto objeta el precio → Vicky llama esta tool y ofrece el
 *      descuento + el precio nuevo (textual), copiando `mensajeParaProspecto`.
 *   2. Si el prospecto insiste en más rebaja → Vicky vuelve a llamar esta tool
 *      (el servidor avanza al siguiente escalón) y ofrece de nuevo.
 *   3. Cuando el prospecto ACEPTA → Vicky llama aplicar_siguiente_descuento,
 *      que recién ahí regenera la cotización formal con el descuento acordado.
 *
 * SEGURIDAD (anti-alucinación):
 *   - NO recibe porcentajes ni tipo de descuento; el servidor decide el escalón.
 *   - Vicky solo comunica el `mensajeParaProspecto` que devuelve esta tool.
 *     NUNCA inventa porcentajes ni totales.
 *   - Esta tool NO genera ni envía ningún PDF: es solo para negociar.
 */

const COTIZADORA_API_BASE =
  process.env.COTIZADORA_API_BASE || "https://cotizacion.geovictoria.com"
const VICKY_COTIZADORA_SECRET = process.env.VICKY_COTIZADORA_SECRET || ""

export const consultarSiguienteDescuentoSchema = {
  name: "consultar_siguiente_descuento",
  description:
    "Consulta (solo lectura) qué descuento podés ofrecer en la conversación cuando el prospecto objeta el precio, y devuelve el precio recalculado (pago inicial y mensual) para comunicarlo. NO regenera ni envía ninguna cotización: es para NEGOCIAR. Úsala cuando el prospecto objeta el precio de forma explícita ('muy caro', 'fuera de presupuesto', pide rebaja) o insiste en más descuento. NUNCA la ofrezcas de forma proactiva. NO recibe porcentaje ni tipo: el servidor decide el escalón según el orden de negocio (plan mensual 10 → 20%; la instalación y el envío no tienen descuento). Pasa el `quote_id` que devolvió generar_link_cotizadora. Comunica al prospecto SOLO el contenido textual del `mensajeParaProspecto` (incluye el precio nuevo y, si aplica, la condición discursiva). NUNCA inventes porcentajes ni totales. Si el prospecto ACEPTA el descuento ofrecido, recién ahí llamá aplicar_siguiente_descuento para generar la cotización formal nueva. Si `topeAlcanzado=true`, este es el último escalón posible: no ofrezcas más rebaja.",
  input_schema: {
    type: "object" as const,
    properties: {
      quote_id: {
        type: "string" as const,
        description:
          "ID de la cotización en Zoho: el quoteId que devolvió generar_link_cotizadora para esta misma conversación.",
        minLength: 1,
        maxLength: 80,
      },
    },
    required: ["quote_id"],
  },
}

export type ConsultarSiguienteDescuentoInput = {
  quote_id: string
}

export type ConsultarSiguienteDescuentoResultado =
  | {
      ok: true
      escalon: {
        tipo: string
        pct: number
        condicionDiscursiva: string | null
      }
      preview: {
        pagoInicialClp: number
        mensualClp: number
      }
      topeAlcanzado: boolean
      mensajeParaProspecto: string
    }
  | {
      ok: false
      error: string
      topeAlcanzado?: boolean
      yaAceptada?: boolean
    }

export async function consultarSiguienteDescuento(
  args: ConsultarSiguienteDescuentoInput,
): Promise<ConsultarSiguienteDescuentoResultado> {
  const quoteId = String(args?.quote_id || "").trim()
  if (!quoteId) {
    return { ok: false, error: "Falta quote_id." }
  }

  try {
    const response = await fetch(
      `${COTIZADORA_API_BASE}/api/quote-acceptance/consultar-siguiente-descuento`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(VICKY_COTIZADORA_SECRET
            ? { "x-vicky-secret": VICKY_COTIZADORA_SECRET }
            : {}),
        },
        body: JSON.stringify({ quoteId }),
        cache: "no-store",
      },
    )

    if (!response.ok) {
      const errBody = await response.text().catch(() => "")
      console.error(
        `[consultar_siguiente_descuento] cotizadora respondió ${response.status}:`,
        errBody.slice(0, 200),
      )
      return { ok: false, error: `La cotizadora respondió ${response.status}.` }
    }

    const data = (await response.json()) as {
      ok?: boolean
      escalon?: {
        tipo?: string
        pct?: number
        condicion_discursiva?: string | null
      }
      preview?: {
        pago_inicial_clp?: number
        mensual_clp?: number
      }
      tope_alcanzado?: boolean
      ya_aceptada?: boolean
      mensaje_para_prospecto?: string
      error?: string
    }

    if (data.ok === false) {
      return {
        ok: false,
        error: data.error || "No se pudo consultar el siguiente descuento.",
        topeAlcanzado: Boolean(data.tope_alcanzado),
        yaAceptada: Boolean(data.ya_aceptada),
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
      topeAlcanzado: Boolean(data.tope_alcanzado),
      mensajeParaProspecto: data.mensaje_para_prospecto,
    }
  } catch (err) {
    console.error("[consultar_siguiente_descuento] excepción:", err)
    return {
      ok: false,
      error: "No se pudo consultar el siguiente descuento en este momento.",
    }
  }
}
