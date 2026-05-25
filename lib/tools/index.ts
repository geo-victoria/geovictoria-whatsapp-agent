/**
 * Catálogo central de tools para Vicky V3.
 *
 * Cada tool exporta su schema (para Claude API) y su implementación.
 * El agent-loop usa ALL_TOOLS para invocar la tool correcta según el
 * tool_use block que devuelva el modelo.
 *
 * V3 actual (chat + Botmaker):
 *   - buscar_prospect_en_zoho: identificación progresiva del prospect via RUT/email/teléfono
 *   - cotizar_referencial: cálculo interno para 1-50 trabajadores
 *   - generar_link_cotizadora: crea registros en Zoho, genera PDF + acceptanceUrl
 *   - derivar_a_soporte: handoff explícito
 */

import {
  cotizarReferencialSchema,
  cotizarReferencial,
  type CotizacionResultado,
} from "./cotizar-referencial"
import {
  generarLinkCotizadoraSchema,
  generarLinkCotizadora,
  type LinkCotizadoraResultado,
} from "./generar-link-cotizadora"
import {
  derivarASoporteSchema,
  derivarASoporte,
  type DerivarASoporteResultado,
} from "./derivar-a-soporte"
import {
  buscarProspectEnZohoSchema,
  buscarProspectEnZoho,
  type BuscarProspectResultado,
} from "./buscar-prospect-en-zoho"

export const TOOL_SCHEMAS = [
  buscarProspectEnZohoSchema,
  cotizarReferencialSchema,
  generarLinkCotizadoraSchema,
  derivarASoporteSchema,
] as const

export type ToolResult =
  | CotizacionResultado
  | LinkCotizadoraResultado
  | DerivarASoporteResultado
  | BuscarProspectResultado
  | { ok: false; error: string }

/**
 * Despacha la invocación de tool según el name que envíe el modelo.
 * Devuelve un objeto que se serializa y se le pasa al modelo como tool_result.
 */
export async function dispatchTool(name: string, input: Record<string, unknown>): Promise<ToolResult> {
  try {
    switch (name) {
      case "buscar_prospect_en_zoho":
        return await buscarProspectEnZoho(input as never)

      case "cotizar_referencial":
        return await cotizarReferencial(input as never)

      case "generar_link_cotizadora":
        return await generarLinkCotizadora(input as never)

      case "derivar_a_soporte":
        return derivarASoporte(input as never)

      default:
        return {
          ok: false,
          error: `Tool '${name}' no reconocida. Tools disponibles: buscar_prospect_en_zoho, cotizar_referencial, generar_link_cotizadora, derivar_a_soporte.`,
        }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[vicky-v3] Error ejecutando tool '${name}':`, err)
    return { ok: false, error: `Error interno al ejecutar tool '${name}': ${message}` }
  }
}
