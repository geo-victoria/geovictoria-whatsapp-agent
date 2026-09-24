/**
 * PERFIL DE TURNO DE MÉXICO para el orquestador único (22-sep; desde el
 * 24-sep sobre el prompt núcleo + tools únicas, como Perú y Colombia). Se
 * enciende con vic_kv `orquestador_mx`="on"; apagado, el webhook MX sigue con
 * su procesador y su prompt propios. Tarjeta de soporte propia (Mesa de Ayuda
 * MX): el blindaje reemplaza los canales chilenos por los mexicanos.
 */
import type { PerfilTurno } from "../../orquestador-turno"
import type { ConversationMessage } from "../../agent-loop"
import { PERFIL_MX } from "./index"
import { getSystemPromptMXNucleo } from "./prompt-nucleo"
import { TOOL_SCHEMAS_MX_UNIFICADAS, buildDispatchMXUnificado } from "./tools-unificadas"
import { derivacionDePais } from "../../umbral-autonomia"
import { blindarSoporteInventadoPais } from "../blindaje-soporte"

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
  systemPrompt: (contact, umbral) => getSystemPromptMXNucleo(contact, umbral),
  tools: (contact) => ({ schemas: TOOL_SCHEMAS_MX_UNIFICADAS as unknown as unknown[], dispatch: buildDispatchMXUnificado(contact) }),
  derivacion: (contact) => ({ ...derivacionDePais(contact), tool: "derivar_a_soporte", motivo: "fuera_de_rango_trabajadores", agendaEnLinea: Boolean((process.env.CAL_EVENT_TYPE_ID_MX ?? "6101466").trim()) }),
  esFlujoCotizacion: esFlujoCotizacionMX,
  blindarSoporte: (reply, permitidos) => blindarSoporteInventadoPais("mx", reply, permitidos),
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
      `Por lo tanto NO partes de cero con este cliente: no le vuelvas a pedir datos que ya entregó (razón social, RFC, cantidad de trabajadores) ni rehagas el estimado desde el principio; ` +
      `si quiere cambiar algo, usa actualizar_cotizacion sobre ESA cotización.\n\n`
    )
  },
}
