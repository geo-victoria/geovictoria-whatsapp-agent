/**
 * Tool INTERNA: definir_descuento (panel de oportunidades, Lalo 10-ago).
 *
 * La escalera oficial (10 → 20%, solo sube, vigencia fija de 6 meses) es una
 * herramienta de cierre de cara al CLIENTE. Cuando quien edita es un
 * EJECUTIVO, esa rigidez se convirtió en un problema real (caso Cigpa /
 * Anderson, cotización 3525045000646859011): pidió 10% y el sistema le
 * comiteó 20% —la escalera solo avanza al escalón siguiente— y no pudo tocar
 * los 6 meses de vigencia porque eran una constante del código.
 *
 * Esta tool NO usa la escalera: fija el porcentaje EXACTO (puede bajarlo o
 * dejarlo en 0) y la VIGENCIA en meses (1..N, o 0 = indefinido). Es solo para
 * el panel interno — Vicky, de cara al cliente, sigue con la escalera.
 */

const COTIZADORA_API_BASE =
  process.env.COTIZADORA_API_BASE || "https://cotizacion.geovictoria.com"
const VICKY_COTIZADORA_SECRET = process.env.VICKY_COTIZADORA_SECRET || ""

export type DefinirDescuentoInput = {
  quote_id: string
  /** % exacto sobre el plan mensual (0 = quitar el descuento). Omitir = no tocar. */
  pct?: number
  /** Meses de vigencia: 0 = indefinido, null = política por defecto (6). Omitir = no tocar. */
  meses?: number | null
  /** false = no generar versión de PDF todavía (flujo confirmar-una-vez del editor). */
  regenerar_pdf?: boolean
}

export type DefinirDescuentoResultado =
  | {
      ok: true
      pct: number
      meses: number
      indefinido: boolean
      version: number
      resumen: string
      linkPdf?: string
      acceptanceUrl?: string
      pdfPendiente?: boolean
    }
  | { ok: false; error: string; cotizacionCerrada?: boolean }

export async function definirDescuentoEjecutivo(
  args: DefinirDescuentoInput,
): Promise<DefinirDescuentoResultado> {
  const quoteId = String(args?.quote_id || "").trim()
  if (!quoteId) return { ok: false, error: "Falta quote_id." }

  const body: Record<string, unknown> = { quoteId }
  if (typeof args?.pct === "number" && Number.isFinite(args.pct)) body.pct = args.pct
  // `meses` viaja incluso cuando es null: null significa "vuelve a la política
  // por defecto", que es distinto de "no tocar la vigencia" (omitirlo).
  if (args && Object.prototype.hasOwnProperty.call(args, "meses")) body.meses = args.meses ?? null
  if (args?.regenerar_pdf === false) body.regenerarPdf = false

  if (body.pct === undefined && body.meses === undefined) {
    return { ok: false, error: "Nada que cambiar: indica el % o la vigencia." }
  }

  try {
    const response = await fetch(`${COTIZADORA_API_BASE}/api/quote-acceptance/descuento-ejecutivo`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(VICKY_COTIZADORA_SECRET ? { "x-vicky-secret": VICKY_COTIZADORA_SECRET } : {}),
      },
      body: JSON.stringify(body),
      cache: "no-store",
    })
    const data = (await response.json().catch(() => ({}))) as {
      ok?: boolean
      pct_aplicado?: number
      meses_descuento?: number
      meses_indefinido?: boolean
      version?: number
      link_pdf?: string
      acceptance_url?: string
      pdf_pendiente?: boolean
      resumen?: string
      error?: string
      cotizacionCerrada?: boolean
    }
    if (!response.ok || data.ok === false) {
      return {
        ok: false,
        error: data.error || `La cotizadora respondió ${response.status}.`,
        cotizacionCerrada: Boolean(data.cotizacionCerrada),
      }
    }
    return {
      ok: true,
      pct: Number(data.pct_aplicado || 0),
      meses: Number(data.meses_descuento || 0),
      indefinido: Boolean(data.meses_indefinido),
      version: Number(data.version || 0),
      resumen: String(data.resumen || ""),
      linkPdf: data.link_pdf,
      acceptanceUrl: data.acceptance_url,
      pdfPendiente: Boolean(data.pdf_pendiente),
    }
  } catch (e) {
    console.error("[definir_descuento] error:", e instanceof Error ? e.message : e)
    return { ok: false, error: "No se pudo contactar a la cotizadora." }
  }
}
