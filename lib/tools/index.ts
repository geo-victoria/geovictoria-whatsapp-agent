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
  registrarComprobanteTransferenciaSchema,
  registrarComprobanteTransferencia,
} from "./registrar-comprobante-transferencia"
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
  reagendarReunionSchema,
  reagendarReunion,
  type ReagendarReunionResultado,
} from "./reagendar-reunion"
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
import {
  enviarFichaRelojSchema,
  enviarFichaReloj,
  type EnviarFichaRelojResultado,
} from "./enviar-ficha-reloj"
import {
  actualizarCotizacionSchema,
  actualizarCotizacion,
  type ActualizarCotizacionInput,
  type ActualizarCotizacionResultado,
} from "./actualizar-cotizacion"
import {
  marcarNoContactarSchema,
  marcarNoContactar,
  type MarcarNoContactarResultado,
} from "./marcar-no-contactar"
import {
  programarSeguimientoSchema,
  programarSeguimiento,
  type ProgramarSeguimientoResultado,
} from "./programar-seguimiento"
import {
  reenviarCotizacionCorreoSchema,
  reenviarCotizacionCorreo,
  type ReenviarCotizacionCorreoResultado,
} from "./reenviar-cotizacion-correo"
import {
  enviarCotizacionWhatsappSchema,
  enviarCotizacionWhatsapp,
  type EnviarCotizacionWhatsappResult,
} from "./enviar-cotizacion-whatsapp"

export const TOOL_SCHEMAS = [
  cotizarReferencialSchema,
  generarLinkCotizadoraSchema,
  consultarAgenteSoporteSchema,
  registrarSolicitudCallbackSchema,
  registrarComprobanteTransferenciaSchema,
  consultarDisponibilidadHorarioSchema,
  agendarReunionSchema,
  reagendarReunionSchema,
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
  enviarFichaRelojSchema,
  actualizarCotizacionSchema,
  marcarNoContactarSchema,
  programarSeguimientoSchema,
  // Reenvío de la cotización formal a un tercero designado por el cliente —
  // SOLO por correo (regla Lalo 20-jul: no invadir por WhatsApp a quien no
  // pidió ser contactado).
  reenviarCotizacionCorreoSchema,
  // El PDF por el MISMO WhatsApp: el correo se entrega pero cae en
  // Promociones/Otros y el cliente reporta "no me llegó" (26-jul).
  enviarCotizacionWhatsappSchema,
] as const

export type ToolResult =
  | CotizacionResultado
  | LinkCotizadoraResultado
  | DerivarASoporteResultado
  | ConsultarAgenteSoporteResultado
  | RegistrarSolicitudCallbackResultado
  | ConsultarDisponibilidadHorarioResultado
  | AgendarReunionResultado
  | ReagendarReunionResultado
  | ConsultarDescuentoReferencialResultado
  | ConsultarSiguienteDescuentoResultado
  | AplicarSiguienteDescuentoResultado
  | EnviarCertificacionResultado
  | EnviarFichaRelojResultado
  | ActualizarCotizacionResultado
  | MarcarNoContactarResultado
  | ProgramarSeguimientoResultado
  | ReenviarCotizacionCorreoResultado
  | EnviarCotizacionWhatsappResult
  | Awaited<ReturnType<typeof registrarComprobanteTransferencia>>
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

      case "consultar_agente_soporte":
        return await consultarAgenteSoporte(input as never)

      case "registrar_solicitud_callback":
        return await registrarSolicitudCallback(input as never)

      case "registrar_comprobante_transferencia":
        // El contacto lo inyecta el agent-loop (_contact); el modelo no lo conoce.
        return await registrarComprobanteTransferencia(
          String((input as { _contact?: string })._contact || ""),
          input as never,
        )

      case "consultar_disponibilidad_horario":
        return await consultarDisponibilidadHorario(input as never)

      case "agendar_reunion":
        return await agendarReunion(input as never)

      case "reagendar_reunion":
        return await reagendarReunion(input as never)

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
      case "enviar_ficha_reloj":
        return await enviarFichaReloj()
      case "actualizar_cotizacion":
        return await actualizarCotizacion(input as ActualizarCotizacionInput)

      case "marcar_no_contactar":
        return marcarNoContactar(input as never)

      case "programar_seguimiento":
        return programarSeguimiento(input as never)

      case "reenviar_cotizacion_correo":
        return await reenviarCotizacionCorreo(input as never)

      case "enviar_cotizacion_whatsapp":
        // El contacto lo inyecta el agent-loop (_contact); el modelo no lo conoce.
        return await enviarCotizacionWhatsapp(input as never)

      default:
        return {
          ok: false,
          error: `Tool '${name}' no reconocida. Tools disponibles: cotizar_referencial, generar_link_cotizadora, consultar_agente_soporte, registrar_solicitud_callback, consultar_disponibilidad_horario, agendar_reunion, derivar_a_soporte, consultar_descuento_referencial, consultar_siguiente_descuento, aplicar_siguiente_descuento, enviar_certificacion, enviar_ficha_reloj, actualizar_cotizacion.`,
        }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[vicky-v3] Error ejecutando tool '${name}':`, err)
    return { ok: false, error: `Error interno al ejecutar tool '${name}': ${message}` }
  }
}
