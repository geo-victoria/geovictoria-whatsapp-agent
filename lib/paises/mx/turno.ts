/**
 * PERFIL DE TURNO DE MÉXICO para el orquestador único (22-sep). México NO
 * está sobre el prompt núcleo todavía: entra con su prompt y sus tools
 * clásicas (derivar_a_ejecutivo), y recibe igual todos los cinturones y la
 * maquinaria de seguimiento del turno chileno.
 */
import type { PerfilTurno } from "../../orquestador-turno"
import type { ConversationMessage } from "../../agent-loop"
import { PERFIL_MX } from "./index"
import { getSystemPromptMX } from "./prompt"
import { TOOL_SCHEMAS_MX, buildDispatchMX } from "./tools"
import { derivacionDePais } from "../../umbral-autonomia"

const COTIZ_MSG_RE_MX =
  /cotiz|precio|cu[aá]nto|cuesta|\bvale\b|\bvalor\b|\bcaro\b|barat|descuento|rebaj|presupuesto|plan|oferta|pago inicial|mensualidad|\bpesos?\b|reloj|checador|\bRFC\b|\d+\s*(trabajador|persona|emplead|colaborador|usuario)|somos\s+\d+/i
const COTIZ_HIST_RE_MX =
  /cotiz|\/mes|pago inicial|mensualidad|instalaci[oó]n|\bplan\b|\bpunto|marca|reloj|checador|\bRFC\b|correo|cu[aá]nt[ao]s?\s+person|trabajador|usuario/i

export function esFlujoCotizacionMX(message: string, history: ConversationMessage[], prefEscalon: number, tieneCotizacion: boolean): boolean {
  if (tieneCotizacion || prefEscalon > 0) return true
  if (COTIZ_MSG_RE_MX.test(message)) return true
  const lastAssistant = [...history].reverse().find((m) => m.role === "assistant")?.content || ""
  return COTIZ_HIST_RE_MX.test(lastAssistant)
}

export const PERFIL_TURNO_MX: PerfilTurno = {
  pais: "mx",
  zona: "ciudad",
  documento: "RFC",
  channelId: PERFIL_MX.canal.channelId,
  systemPrompt: (contact, umbral) => getSystemPromptMX(contact, umbral),
  tools: (contact) => ({ schemas: TOOL_SCHEMAS_MX as unknown as unknown[], dispatch: buildDispatchMX(contact) }),
  derivacion: (contact) => derivacionDePais(contact),
  esFlujoCotizacion: esFlujoCotizacionMX,
  blindarSoporte: (reply) => reply,
  certificacionDT: false,
  hitoPorChat: false,
  contextoCotizacionExistente: (punteros) => {
    const p = punteros[0]
    if (!p?.quoteId) return ""
    const monto = typeof p.totalClp === "number" && p.totalClp > 0 ? ` (total $${Math.round(p.totalClp).toLocaleString("es-MX")} MXN)` : ""
    const link = p.acceptanceUrl ? `\nLink de aceptación de esa cotización (úsalo si te lo piden o para retomar): ${p.acceptanceUrl}` : ""
    return (
      `ESTADO DE ESTE CONTACTO — LÉELO ANTES DE ACTUAR:\n` +
      `Este contacto YA tiene una cotización formal generada anteriormente${monto}.${link}\n` +
      `Por lo tanto NO partes de cero con este cliente: no le vuelvas a pedir datos que ya entregó ni rehagas el estimado desde el principio.\n\n`
    )
  },
}
