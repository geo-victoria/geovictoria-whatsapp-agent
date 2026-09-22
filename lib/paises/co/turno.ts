/**
 * PERFIL DE TURNO DE COLOMBIA para el orquestador único (22-sep): prompt
 * núcleo + tools únicas, ciudad/NIT, la línea +57 y la agenda solo si existe
 * el evento de Cal. Sin tarjeta de soporte propia todavía (no se blinda con
 * números chilenos: identidad).
 */
import type { PerfilTurno } from "../../orquestador-turno"
import type { ConversationMessage } from "../../agent-loop"
import { PERFIL_CO } from "./index"
import { getSystemPromptCONucleo } from "./prompt-nucleo"
import { TOOL_SCHEMAS_CO_UNIFICADAS, buildDispatchCOUnificado } from "./tools-unificadas"
import { REUNIONES_CO_HABILITADAS } from "./tools"
import { derivacionDePais } from "../../umbral-autonomia"

const COTIZ_MSG_RE_CO =
  /cotiz|precio|cu[aá]nto|cuesta|\bvale\b|\bvalor\b|\bcaro\b|barat|descuento|rebaj|presupuesto|plan|oferta|pago inicial|mensualidad|\bpesos?\b|equipo|biom[eé]tric|\bNIT\b|\d+\s*(trabajador|persona|emplead|colaborador|usuario)|somos\s+\d+/i
const COTIZ_HIST_RE_CO =
  /cotiz|\/mes|pago inicial|mensualidad|instalaci[oó]n|\bplan\b|\bpunto|marca|equipo|\bNIT\b|correo|cu[aá]nt[ao]s?\s+person|trabajador|usuario/i

export function esFlujoCotizacionCO(message: string, history: ConversationMessage[], prefEscalon: number, tieneCotizacion: boolean): boolean {
  if (tieneCotizacion || prefEscalon > 0) return true
  if (COTIZ_MSG_RE_CO.test(message)) return true
  const lastAssistant = [...history].reverse().find((m) => m.role === "assistant")?.content || ""
  return COTIZ_HIST_RE_CO.test(lastAssistant)
}

function fmtCop(n: number): string {
  return `$${Math.round(Number(n)).toLocaleString("es-CO")}`
}

export const PERFIL_TURNO_CO: PerfilTurno = {
  pais: "co",
  zona: "ciudad",
  documento: "NIT",
  channelId: PERFIL_CO.canal.channelId,
  systemPrompt: (contact, umbral) => getSystemPromptCONucleo(contact, umbral),
  tools: (contact) => ({ schemas: TOOL_SCHEMAS_CO_UNIFICADAS as unknown as unknown[], dispatch: buildDispatchCOUnificado(contact) }),
  derivacion: (contact) => ({ ...derivacionDePais(contact), tool: "derivar_a_soporte", motivo: "fuera_de_rango_trabajadores", agendaEnLinea: REUNIONES_CO_HABILITADAS }),
  esFlujoCotizacion: esFlujoCotizacionCO,
  blindarSoporte: (reply) => reply,
  certificacionDT: false,
  hitoPorChat: false,
  contextoCotizacionExistente: (punteros) => {
    const p = punteros[0]
    if (!p?.quoteId) return ""
    const monto = typeof p.totalClp === "number" && p.totalClp > 0 ? ` (total ${fmtCop(p.totalClp)} COP)` : ""
    const link = p.acceptanceUrl ? `\nLink de aceptación de esa cotización (úsalo si te lo piden o para retomar): ${p.acceptanceUrl}` : ""
    const extra = punteros.length > 1 ? `\nEste contacto tiene ${punteros.length} cotizaciones formales vivas; la más reciente es la de arriba. No las mezcles.` : ""
    return (
      `ESTADO DE ESTE CONTACTO — LÉELO ANTES DE ACTUAR:\n` +
      `Este contacto YA tiene una cotización formal generada anteriormente${monto}.${link}${extra}\n` +
      `Por lo tanto NO partes de cero con este cliente: no le vuelvas a pedir datos que ya entregó (empresa, NIT, cantidad de trabajadores) ni rehagas el estimado desde el principio; ` +
      `si quiere cambiar algo, usa actualizar_cotizacion sobre ESA cotización.\n\n`
    )
  },
}
