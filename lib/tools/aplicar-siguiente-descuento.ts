/**
 * Tool: aplicar_siguiente_descuento
 *
 * Avanza la cotización al siguiente escalón de descuento según el orden de
 * negocio (instalación RM → instalación regiones → 10% → 20% → 30% → 35% → 40%
 * sobre el plan mensual). El servidor regenera el PDF con número idéntico,
 * fecha/hora actualizada y versión incrementada (v2, v3, ...), lo sube a
 * storage y devuelve el link nuevo para que Vicky lo reenvíe por WhatsApp.
 *
 * SEGURIDAD (anti-alucinación):
 *   - Esta tool NO recibe porcentajes ni tipo de descuento. El servidor
 *     decide qué escalón aplicar según el estado vigente de la cotización
 *     (si ya tiene instalación, si es RM, qué descuentos previos hay).
 *   - Vicky solo puede comunicar el contenido del `mensajeParaProspecto` que
 *     devuelve esta tool. NUNCA enuncia precios ni totales con descuento.
 *   - La página de aceptación online refleja el último estado del servidor.
 *
 * Reemplaza a `escalar_descuento` (versión anterior, que solo subía un % sin
 * regenerar el PDF y sin contemplar descuentos de instalación).
 */

const COTIZADORA_API_BASE =
  process.env.COTIZADORA_API_BASE || "https://cotizacion.geovictoria.com"
const VICKY_COTIZADORA_SECRET = process.env.VICKY_COTIZADORA_SECRET || ""

export const aplicarSiguienteDescuentoSchema = {
  name: "aplicar_siguiente_descuento",
  description:
    "Avanza la cotización al siguiente escalón de descuento y devuelve un PDF nuevo (mismo número, fecha/hora actualizada, versión incrementada) para reenviar al cliente. Úsala SOLO cuando el prospecto objeta el precio de forma EXPLÍCITA (dice que es 'muy caro', que 'está fuera de presupuesto', pide rebaja, insiste en bajar el precio después de conocerlo). NUNCA la ofrezcas tú de forma proactiva. El servidor decide qué escalón corresponde según el orden de negocio (descuento de instalación primero — RM antes que regiones —, luego descuentos sobre el plan mensual de 10 → 20 → 30 → 35 → 40%). Pasa el `quote_id` que devolvió generar_link_cotizadora en esta conversación. IMPORTANTE: pasa también `pct_ofrecido` = el porcentaje EXACTO sobre el plan mensual que la última tool de descuento te devolvió y que ya le comunicaste al cliente (por ejemplo 35 si le ofreciste 35%): así el servidor garantiza que lo que se aplica en el PDF coincide con lo que prometiste. Comunica al prospecto SOLO el contenido textual del `mensajeParaProspecto` que devuelve esta tool — incluye el link al PDF nuevo y la condición discursiva si aplica. NUNCA enuncies precios ni totales con descuento. Si la respuesta trae `topeAlcanzado=true`, ya se aplicó el último escalón y no hay más rebajas por ofrecer.",
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
      pct_ofrecido: {
        type: "number" as const,
        description:
          "Porcentaje EXACTO de descuento sobre el plan mensual que ya le ofreciste al cliente y que vino de una tool de descuento previa (ej. 35). NO lo inventes: debe ser el % de la última oferta que comunicaste. El servidor garantiza comitear al menos ese nivel, acotado por el tope (40%). Si no negociaste un % de plan, omítelo.",
        minimum: 0,
        maximum: 40,
      },
    },
    required: ["quote_id"],
  },
}

export type AplicarSiguienteDescuentoInput = {
  quote_id: string
  pct_ofrecido?: number
}

export type AplicarSiguienteDescuentoResultado =
  | {
      ok: true
      version: number
      linkPdf: string
      ultimoEscalon: {
        tipo: string
        pct: number
        condicionDiscursiva: string | null
      }
      topeAlcanzado: boolean
      mensajeParaProspecto: string
    }
  | {
      ok: false
      error: string
      topeAlcanzado?: boolean
    }

export async function aplicarSiguienteDescuento(
  args: AplicarSiguienteDescuentoInput,
): Promise<AplicarSiguienteDescuentoResultado> {
  const quoteId = String(args?.quote_id || "").trim()
  if (!quoteId) {
    return { ok: false, error: "Falta quote_id." }
  }
  // % que Vicky ya le comunicó al cliente; el servidor lo usa como piso para que
  // lo aplicado nunca quede por debajo de lo ofrecido. Acotado a 0..40.
  const pctOfrecidoNum = Number(args?.pct_ofrecido)
  const pctOfrecido =
    Number.isFinite(pctOfrecidoNum) && pctOfrecidoNum > 0
      ? Math.min(40, pctOfrecidoNum)
      : 0

  try {
    const response = await fetch(
      `${COTIZADORA_API_BASE}/api/quote-acceptance/aplicar-siguiente-descuento`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(VICKY_COTIZADORA_SECRET
            ? { "x-vicky-secret": VICKY_COTIZADORA_SECRET }
            : {}),
        },
        body: JSON.stringify(
          pctOfrecido > 0 ? { quoteId, pctOfrecido } : { quoteId },
        ),
        cache: "no-store",
      },
    )

    if (!response.ok) {
      const errBody = await response.text().catch(() => "")
      console.error(
        `[aplicar_siguiente_descuento] cotizadora respondió ${response.status}:`,
        errBody.slice(0, 200),
      )
      return { ok: false, error: `La cotizadora respondió ${response.status}.` }
    }

    const data = (await response.json()) as {
      ok?: boolean
      version?: number
      link_pdf?: string
      ultimo_escalon?: {
        tipo?: string
        pct?: number
        condicion_discursiva?: string | null
      }
      tope_alcanzado?: boolean
      mensaje_para_prospecto?: string
      error?: string
    }

    if (data.ok === false) {
      return {
        ok: false,
        error: data.error || "No se pudo aplicar el siguiente descuento.",
        topeAlcanzado: Boolean(data.tope_alcanzado),
      }
    }

    if (
      typeof data.version !== "number" ||
      typeof data.link_pdf !== "string" ||
      !data.link_pdf ||
      !data.ultimo_escalon ||
      typeof data.ultimo_escalon.pct !== "number" ||
      typeof data.ultimo_escalon.tipo !== "string" ||
      typeof data.mensaje_para_prospecto !== "string"
    ) {
      return { ok: false, error: "Respuesta inválida de la cotizadora." }
    }

    return {
      ok: true,
      version: data.version,
      linkPdf: data.link_pdf,
      ultimoEscalon: {
        tipo: data.ultimo_escalon.tipo,
        pct: data.ultimo_escalon.pct,
        condicionDiscursiva: data.ultimo_escalon.condicion_discursiva ?? null,
      },
      topeAlcanzado: Boolean(data.tope_alcanzado),
      mensajeParaProspecto: data.mensaje_para_prospecto,
    }
  } catch (err) {
    console.error("[aplicar_siguiente_descuento] excepción:", err)
    return {
      ok: false,
      error: "No se pudo aplicar el siguiente descuento en este momento.",
    }
  }
}
