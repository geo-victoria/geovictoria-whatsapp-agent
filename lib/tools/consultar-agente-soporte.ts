/**
 * Tool: consultar_agente_soporte
 *
 * Vicky la invoca cuando el prospecto tiene una duda funcional/operativa
 * sobre la plataforma GeoVictoria (configurar usuarios, generar reportes,
 * problemas técnicos, manejo de feriados, etc.).
 *
 * La tool consulta al agente Foundry "first-response-zoho" v14 que tiene
 * conocimiento entrenado sobre la plataforma. Devuelve la respuesta del
 * agente y una acción que Vicky debe ejecutar:
 *
 *   - "continuar": Vicky pega la respuesta del agente al prospecto y
 *     queda lista para recibir más preguntas. Si el prospecto sigue
 *     en el mismo tema, Vicky vuelve a invocar la tool pasando
 *     previousResponseId para mantener contexto.
 *
 *   - "escalar_humano": el agente determinó que la consulta requiere
 *     intervención humana. Vicky pega el mensajeParaProspecto con los
 *     canales de soporte (WhatsApp, email, teléfono).
 *
 *   - "cerrar": el agente considera la consulta resuelta. Vicky pega
 *     la respuesta y despide al prospecto.
 */

import { callFirstResponseAgent } from "@/lib/foundry"

export const consultarAgenteSoporteSchema = {
  name: "consultar_agente_soporte",
  description:
    "Consulta al agente IA especializado en soporte operativo de la plataforma GeoVictoria. Úsala SOLO cuando el prospecto tiene una duda funcional sobre cómo USAR la plataforma (configurar usuarios, generar reportes, manejar feriados, problemas técnicos, errores). NO uses esta tool para consultas comerciales (precios, productos, condiciones), para callback, para agendar reunión, o solo porque el prospecto esté en el CRM. El agente puede preguntar el rol del usuario (administrador o colaborador) antes de responder — si lo hace, comunica la pregunta al prospecto literal y espera la respuesta para volver a invocar la tool. Si la conversación continúa con el mismo tema, vuelve a invocar la tool pasando previousResponseId para que el agente mantenga contexto. La tool devuelve uno de tres estados: 'continuar' (pegar respuesta y seguir disponible), 'escalar_humano' (pegar mensajeParaProspecto con canales de soporte), 'cerrar' (pegar respuesta y despedir).",
  input_schema: {
    type: "object" as const,
    properties: {
      mensajeProspecto: {
        type: "string" as const,
        description:
          "El mensaje literal del prospecto que contiene la consulta operativa. Pásalo tal cual lo escribió, sin reformular ni resumir.",
        minLength: 1,
        maxLength: 2000,
      },
      previousResponseId: {
        type: "string" as const,
        description:
          "ID de la respuesta anterior del agente, devuelto en una invocación previa. Pasarlo cuando el prospecto sigue preguntando sobre el mismo tema para que el agente mantenga contexto. Omitirlo cuando arranca un tema nuevo.",
      },
    },
    required: ["mensajeProspecto"],
  },
}

export type ConsultarAgenteSoporteInput = {
  mensajeProspecto: string
  previousResponseId?: string
}

export type ConsultarAgenteSoporteResultado =
  | {
      ok: true
      accion: "continuar" | "cerrar"
      respuestaAgente: string
      previousResponseId: string
    }
  | {
      ok: true
      accion: "escalar_humano"
      respuestaAgente: string
      mensajeParaProspecto: string
      previousResponseId: string
    }
  | {
      ok: false
      error: string
    }

// Mesa de Ayuda GeoVictoria CHILE (tarjeta oficial, Lalo 27-jul): canal
// exclusivo para ADMINISTRADORES de la plataforma; L-V 08:30-18:00; fuera de
// horario, el correo retoma el caso a primera hora del día hábil siguiente.
// OJO: el WhatsApp de acá es la fuente de verdad del reemplazo anti-fuga de
// lib/voseo-v3.ts (SOPORTE_WHATSAPP) — si cambia, actualizar allá también.
const MENSAJE_ESCALAMIENTO_HUMANO =
  "Para esta consulta puedes contactar directamente a nuestra Mesa de Ayuda:\n" +
  "📲 WhatsApp: *+56 9 4401 3873*\n" +
  "📞 Teléfono: *600 914 3819*\n" +
  "📧 Email: *soporte@geovictoria.com*\n" +
  "Atienden de lunes a viernes de 08:30 a 18:00 — y fuera de horario les escribes al correo y retoman tu caso a primera hora del día hábil siguiente 🙌\n\n" +
  "Un dato importante: si eres colaborador, el primer paso es contactar al administrador de tu empresa — solo los administradores tienen soporte directo de GeoVictoria."

export async function consultarAgenteSoporte(
  args: ConsultarAgenteSoporteInput,
): Promise<ConsultarAgenteSoporteResultado> {
  try {
    const { mensajeProspecto, previousResponseId } = args
    const result = await callFirstResponseAgent(mensajeProspecto, previousResponseId)

    if (result.marker === "ESCALAR") {
      return {
        ok: true,
        accion: "escalar_humano",
        respuestaAgente: result.reply,
        mensajeParaProspecto: MENSAJE_ESCALAMIENTO_HUMANO,
        previousResponseId: result.responseId,
      }
    }

    if (result.marker === "END") {
      return {
        ok: true,
        accion: "cerrar",
        respuestaAgente: result.reply,
        previousResponseId: result.responseId,
      }
    }

    return {
      ok: true,
      accion: "continuar",
      respuestaAgente: result.reply,
      previousResponseId: result.responseId,
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Error inesperado consultando agente Foundry"
    console.error("[consultar_agente_soporte] Exception:", error)
    return { ok: false, error: message }
  }
}
