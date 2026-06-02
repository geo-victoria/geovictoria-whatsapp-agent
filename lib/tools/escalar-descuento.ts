/**
 * Tool: escalar_descuento
 *
 * Sube el descuento de una cotización en UN escalón, llamando al endpoint
 * server-side de la cotizadora (/api/quote-acceptance/escalar-descuento).
 *
 * SEGURIDAD (anti-alucinación de precios/descuentos):
 *   - Esta tool NO recibe ningún porcentaje. El servidor mantiene el nivel por
 *     cotización y lo sube de 5 en 5 hasta 30% máximo. Vicky no puede fijar ni
 *     calcular el monto: solo puede pedir "sube un escalón".
 *   - Vicky solo puede mencionar el porcentaje que ESTA tool devuelve.
 *   - Vicky NUNCA enuncia precios ni totales con descuento: el total rebajado
 *     se calcula 100% server-side y se ve únicamente en la aceptación online.
 *   - El descuento aplica solo al plan MENSUAL (recurrente) y vive atado al
 *     quote_id; expira con la cotización.
 */

const COTIZADORA_API_BASE =
  process.env.COTIZADORA_API_BASE || "https://cotizacion.geovictoria.com"
const VICKY_COTIZADORA_SECRET = process.env.VICKY_COTIZADORA_SECRET || ""

export const escalarDescuentoSchema = {
  name: "escalar_descuento",
  description:
    "Sube en UN escalón el descuento sobre el plan MENSUAL de una cotización ya generada. Úsala SOLO cuando el prospecto objeta el precio de forma explícita (dice que es 'muy caro', que 'está fuera de presupuesto', pide rebaja, o insiste en el precio después de conocerlo). NO la ofrezcas tú de forma proactiva ni la menciones si el prospecto no objetó el precio. IMPORTANTE: esta tool NO recibe ningún porcentaje — el servidor decide y sube el descuento de 5 en 5 hasta un máximo de 30%. Tú NO calculas ni inventas montos: solo puedes comunicar el porcentaje que esta tool DEVUELVE en 'descuentoPct', y NUNCA enuncias precios ni totales con descuento (el cliente ve el total ya rebajado únicamente en la página de aceptación en línea). Requiere el quote_id de la cotización (el mismo que devolvió generar_link_cotizadora en esta conversación). Si la respuesta trae topeAlcanzado=true, ya se llegó al 30% y no hay más descuento por ofrecer.",
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

export type EscalarDescuentoInput = {
  quote_id: string
}

export type EscalarDescuentoResultado =
  | {
      ok: true
      descuentoPct: number
      topeAlcanzado: boolean
      subeDesde: number
      mensajeParaProspecto: string
    }
  | {
      ok: false
      error: string
    }

export async function escalarDescuento(
  args: EscalarDescuentoInput,
): Promise<EscalarDescuentoResultado> {
  const quoteId = String(args?.quote_id || "").trim()
  if (!quoteId) {
    return { ok: false, error: "Falta quote_id." }
  }

  try {
    const response = await fetch(
      `${COTIZADORA_API_BASE}/api/quote-acceptance/escalar-descuento`,
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
        `[escalar_descuento] cotizadora respondió ${response.status}:`,
        errBody.slice(0, 200),
      )
      return { ok: false, error: `La cotizadora respondió ${response.status}.` }
    }

    const data = (await response.json()) as {
      ok?: boolean
      descuento_pct?: number
      tope_alcanzado?: boolean
      sube_desde?: number
      error?: string
    }

    if (!data.ok || typeof data.descuento_pct !== "number") {
      return {
        ok: false,
        error: data.error || "Respuesta inválida de la cotizadora.",
      }
    }

    const pct = data.descuento_pct
    const tope = Boolean(data.tope_alcanzado)
    const mensajeParaProspecto =
      `Puedo aplicarte un ${pct}% de descuento sobre el plan mensual, ` +
      `que queda reflejado automáticamente al aceptar tu cotización en línea` +
      (tope ? ` (es el máximo que puedo ofrecerte).` : `.`)

    return {
      ok: true,
      descuentoPct: pct,
      topeAlcanzado: tope,
      subeDesde: typeof data.sube_desde === "number" ? data.sube_desde : 0,
      mensajeParaProspecto,
    }
  } catch (err) {
    console.error("[escalar_descuento] excepción:", err)
    return {
      ok: false,
      error: "No se pudo aplicar el descuento en este momento.",
    }
  }
}
