/**
 * Catálogo central de tools para Vicky V3 — versión final con 8 capacidades.
 *
 * Cada tool exporta su schema (para Claude API) y su implementación.
 * El agent-loop usa ALL_TOOLS para invocar la tool correcta según el
 * tool_use block que devuelva el modelo.
 *
 * V3 final (chat + Botmaker):
 *   - buscar_prospect_en_zoho: identificación progresiva del prospect via RUT/email/teléfono
 *   - cotizar_referencial: cálculo interno para 1-50 trabajadores
 *   - generar_link_cotizadora: crea registros en Zoho, genera PDF + acceptanceUrl
 *   - consultar_agente_soporte: consulta operativa al agente IA de soporte (Foundry/Azure AI)
 *   - registrar_solicitud_callback: Lead en Zoho con owner default → entra a tómbola
 *   - consultar_disponibilidad_horario: verifica disponibilidad en Cal.com para slot propuesto por el cliente
 *   - agendar_reunion: agenda en Cal.com + Lead Zoho con KAM + Event Zoho
 *   - derivar_a_soporte: handoff explícito (red de seguridad)
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
import {
  consultarAgenteSoporteSchema,
  consultarAgenteSoporte,
  type ConsultarAgenteSoporteResultado,
} from "./consultar-agente-soporte"
import {
  registrarSolicitudCallbackSchema,
  registrarSolicitudCallback,
  type RegistrarSolicitudCallbackResultado,
} from "./registrar-solicitud-callback"
import {
  consultarDisponibilidadHorarioSchema,
  consultarDisponibilidadHorario,
  type ConsultarDisponibilidadHorarioResultado,
} from "./consultar-disponibilidad-horario"
import {
  agendarReunionSchema,
  agendarReunion,
  type AgendarReunionResultado,
} from "./agendar-reunion"
import {
  consultarDescuentoReferencialSchema,
  consultarDescuentoReferencial,
  type ConsultarDescuentoReferencialResultado,
} from "./consultar-descuento-referencial"
import {
  consultarSiguienteDescuentoSchema,
  consultarSiguienteDescuento,
  type ConsultarSiguienteDescuentoResultado,
} from "./consultar-siguiente-descuento"
import {
  aplicarSiguienteDescuentoSchema,
  aplicarSiguienteDescuento,
  type AplicarSiguienteDescuentoResultado,
} from "./aplicar-siguiente-descuento"
import {
  enviarCertificacionSchema,
  enviarCertificacion,
  type EnviarCertificacionResultado,
} from "./enviar-certificacion"

export const TOOL_SCHEMAS = [
  buscarProspectEnZohoSchema,
  cotizarReferencialSchema,
  generarLinkCotizadoraSchema,
  consultarAgenteSoporteSchema,
  registrarSolicitudCallbackSchema,
  consultarDisponibilidadHorarioSchema,
  agendarReunionSchema,
  derivarASoporteSchema,
  // consultar_descuento_referencial (preform): negociación de descuento ANTES de
  // la cotización formal (Modelo B). Es 100% read-only — NO crea ni toca ningún
  // registro en Zoho (la creación del Borrador con identidad placeholder, vieja
  // causa del bug "Pendiente", ya se eliminó). El prompt instruye usarla cuando el
  // cliente pide rebaja sobre el preform, así que DEBE estar en el set: si se omite,
  // el modelo no puede llamarla y la negociación preform se traba en loop.
  consultarDescuentoReferencialSchema,
  consultarSiguienteDescuentoSchema,
  aplicarSiguienteDescuentoSchema,
  enviarCertificacionSchema,
] as const

export type ToolResult =
  | CotizacionResultado
  | LinkCotizadoraResultado
  | DerivarASoporteResultado
  | BuscarProspectResultado
  | ConsultarAgenteSoporteResultado
  | RegistrarSolicitudCallbackResultado
  | ConsultarDisponibilidadHorarioResultado
  | AgendarReunionResultado
  | ConsultarDescuentoReferencialResultado
  | ConsultarSiguienteDescuentoResultado
  | AplicarSiguienteDescuentoResultado
  | EnviarCertificacionResultado
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

      case "consultar_agente_soporte":
        return await consultarAgenteSoporte(input as never)

      case "registrar_solicitud_callback":
        return await registrarSolicitudCallback(input as never)

      case "consultar_disponibilidad_horario":
        return await consultarDisponibilidadHorario(input as never)

      case "agendar_reunion":
        return await agendarReunion(input as never)

      case "derivar_a_soporte":
        return derivarASoporte(input as never)

      case "consultar_descuento_referencial":
        return await consultarDescuentoReferencial(input as never)

      case "consultar_siguiente_descuento":
        return await consultarSiguienteDescuento(input as never)

      case "aplicar_siguiente_descuento":
        return await aplicarSiguienteDescuento(input as never)

      case "enviar_certificacion":
        return await enviarCertificacion()

      default:
        return {
          ok: false,
          error: `Tool '${name}' no reconocida. Tools disponibles: buscar_prospect_en_zoho, cotizar_referencial, generar_link_cotizadora, consultar_agente_soporte, registrar_solicitud_callback, consultar_disponibilidad_horario, agendar_reunion, derivar_a_soporte, consultar_descuento_referencial, consultar_siguiente_descuento, aplicar_siguiente_descuento, enviar_certificacion.`,
        }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[vicky-v3] Error ejecutando tool '${name}':`, err)
    return { ok: false, error: `Error interno al ejecutar tool '${name}': ${message}` }
  }
}
