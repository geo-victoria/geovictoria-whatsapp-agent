/**
 * Catálogo central de tools para Vicky V3.
 *
 * Cada tool exporta su schema (para Claude API) y su implementación.
 * El agent-loop usa ALL_TOOLS para invocar la tool correcta según el
 * tool_use block que devuelva el modelo.
 *
 * V3 inicial (chat de prueba):
 *   - cotizar_referencial: cálculo interno para 1-10 trabajadores
 *   - generar_link_cotizadora: URL con prefill base64
 *   - derivar_a_soporte: handoff explícito
 *
 * V3 producción (futuro, cuando se conecte a Botmaker):
 *   - agendar_reunion: Cal.com + Zoho lead
 *   - buscar_contacto_zoho: lookup por teléfono
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

export const TOOL_SCHEMAS = [
  cotizarReferencialSchema,
  generarLinkCotizadoraSchema,
  derivarASoporteSchema,
] as const

export type ToolResult =
  | CotizacionResultado
  | LinkCotizadoraResultado
  | DerivarASoporteResultado
  | { ok: false; error: string }

/**
 * Despacha la invocación de tool según el name que envíe el modelo.
 * Devuelve un objeto que se serializa y se le pasa al modelo como tool_result.
 */
export async function dispatchTool(name: string, input: Record<string, unknown>): Promise<ToolResult> {
  try {
    switch (name) {
      case "cotizar_referencial":
        return await cotizarReferencial(input as never)

      case "generar_link_cotizadora":
        return await generarLinkCotizadora(input as never)

      case "derivar_a_soporte":
        return derivarASoporte(input as never)

      default:
        return {
          ok: false,
          error: `Tool '${name}' no reconocida. Tools disponibles: cotizar_referencial, generar_link_cotizadora, derivar_a_soporte.`,
        }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[vicky-v3] Error ejecutando tool '${name}':`, err)
    return { ok: false, error: `Error interno al ejecutar tool '${name}': ${message}` }
  }
}
