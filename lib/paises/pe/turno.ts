/**
 * PERFIL DE TURNO DE PERÚ para el orquestador único (22-sep). Lo único que
 * Perú aporta: prompt núcleo + tools únicas, distrito/RUC, la línea +51, la
 * derivación del umbral y la tarjeta de soporte peruana. Todo lo demás
 * (cinturones, directivas, loop, hitos) es el turno chileno.
 */
import type { PerfilTurno } from "../../orquestador-turno"
import type { ConversationMessage } from "../../agent-loop"
import { PERFIL_PE } from "./index"
import { getSystemPromptPENucleo } from "./prompt-nucleo"
import { TOOL_SCHEMAS_PE_UNIFICADAS, buildDispatchPEUnificado } from "./tools-unificadas"
import { blindarSoporteInventadoPE } from "./tools"
import { derivacionDePais } from "../../umbral-autonomia"

// Marcadores PE: soles, RUC, mensualidad (sin UF ni NIT ni RFC).
const COTIZ_MSG_RE_PE =
  /cotiz|precio|cu[aá]nto|cuesta|\bvale\b|\bvalor\b|\bcaro\b|barat|descuento|rebaj|presupuesto|plan|oferta|pago inicial|mensualidad|\bsoles?\b|reloj|\bRUC\b|\d+\s*(trabajador|persona|emplead|colaborador|usuario)|somos\s+\d+/i
const COTIZ_HIST_RE_PE =
  /cotiz|\/mes|pago inicial|mensualidad|instalaci[oó]n|\bplan\b|\bpunto|marca|reloj|\bRUC\b|correo|cu[aá]nt[ao]s?\s+person|trabajador|usuario/i

export function esFlujoCotizacionPE(message: string, history: ConversationMessage[], prefEscalon: number, tieneCotizacion: boolean): boolean {
  if (tieneCotizacion || prefEscalon > 0) return true
  if (COTIZ_MSG_RE_PE.test(message)) return true
  const lastAssistant = [...history].reverse().find((m) => m.role === "assistant")?.content || ""
  return COTIZ_HIST_RE_PE.test(lastAssistant)
}

function fmtPen(n: number): string {
  return `S/${Number(n).toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export const PERFIL_TURNO_PE: PerfilTurno = {
  pais: "pe",
  zona: "distrito",
  documento: "RUC",
  channelId: PERFIL_PE.canal.channelId,
  systemPrompt: (contact, umbral) => getSystemPromptPENucleo(contact, umbral),
  tools: (contact) => ({ schemas: TOOL_SCHEMAS_PE_UNIFICADAS as unknown as unknown[], dispatch: buildDispatchPEUnificado(contact) }),
  // Perú agenda en Cal desde el 21-sep (evento de Mónica): el guion 21+ ofrece reunión.
  derivacion: (contact) => ({ ...derivacionDePais(contact), tool: "derivar_a_soporte", motivo: "fuera_de_rango_trabajadores", agendaEnLinea: true }),
  esFlujoCotizacion: esFlujoCotizacionPE,
  blindarSoporte: (reply, permitidos) => blindarSoporteInventadoPE(reply, permitidos),
  certificacionDT: false,
  hitoPorChat: true,
  // La cotización PE guarda soles en los campos del puntero: el contexto no habla de UF.
  contextoCotizacionExistente: (punteros) => {
    const p = punteros[0]
    if (!p?.quoteId) return ""
    const monto = typeof p.totalClp === "number" && p.totalClp > 0 ? ` (total ${fmtPen(p.totalClp)} con IGV)` : ""
    const link = p.acceptanceUrl ? `\nLink de aceptación de esa cotización (úsalo si te lo piden o para retomar): ${p.acceptanceUrl}` : ""
    const extra = punteros.length > 1 ? `\nEste contacto tiene ${punteros.length} cotizaciones formales vivas; la más reciente es la de arriba. No las mezcles.` : ""
    return (
      `ESTADO DE ESTE CONTACTO — LÉELO ANTES DE ACTUAR:\n` +
      `Este contacto YA tiene una cotización formal generada anteriormente${monto}.${link}${extra}\n` +
      `Por lo tanto NO partes de cero con este cliente: no le vuelvas a pedir datos que ya entregó (empresa, RUC, cantidad de trabajadores) ni rehagas el estimado desde el principio; ` +
      `si quiere cambiar algo, usa actualizar_cotizacion sobre ESA cotización.\n\n`
    )
  },
}
