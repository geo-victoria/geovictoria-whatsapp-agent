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
import { fichaOperativa } from "@/lib/paises/ficha-operativa"

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
  /** Contacto (lo inyecta el agent-loop): decide si es cliente de GV Avanzado. */
  _contact?: string
  previousResponseId?: string
  /** País del contacto (lo inyecta el despacho, no el modelo). Sin él = Chile. */
  _pais?: string
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

/**
 * TARJETA DE LA MESA DEL PAÍS (27-sep, orden de Lalo "todas las tools deben ser
 * UNA implementación global: la de Chile"). Esta es la ÚNICA tool de soporte:
 * fuera de Chile cambian solo los DATOS de la tarjeta, que salen de la ficha
 * operativa del país (correo, teléfono, horario y cómo se nombra la mesa) —
 * antes cada país envolvía esta tool con su propia copia del mensaje y de su
 * saneador. Chile no la usa: su tarjeta (con el WhatsApp de la mesa) es la
 * constante de arriba. Env `VICKY_SOPORTE_{EMAIL,TELEFONO,HORARIO}_<CC>` la
 * pisan sin deploy (herencia de Perú).
 */
export function tarjetaSoportePais(
  pais?: string,
): { mensaje: string; email: string; telefono: string } | null {
  const cc = String(pais || "").trim().toLowerCase()
  if (!cc || cc === "cl") return null
  const sop = fichaOperativa(cc).soporte
  if (!sop) return null
  const up = cc.toUpperCase()
  const email = (process.env[`VICKY_SOPORTE_EMAIL_${up}`] || sop.email).trim()
  const telefono = (process.env[`VICKY_SOPORTE_TELEFONO_${up}`] || sop.telefono).trim()
  const horario = (process.env[`VICKY_SOPORTE_HORARIO_${up}`] || sop.horario).trim()
  const mensaje =
    `Para esta consulta te recomiendo contactar directamente a nuestra Mesa de Ayuda ${sop.mesa || ""}:\n` +
    `📧 Email: *${email}* (horario continuado)\n` +
    `📞 Teléfono: *${telefono}* (${horario})\n\n` +
    "Un dato importante: si eres colaborador, el primer paso es contactar al administrador de tu empresa — solo los administradores tienen soporte directo de GeoVictoria 🙌"
  return { mensaje, email, telefono }
}

/** El agente de soporte se entrenó con la base CHILENA: fuera de Chile se
 * reemplazan sus canales (celular +56 9, 600 914 3819, soporte@) por los del
 * país antes de que el texto llegue al cliente. */
export function sanearCanalesChilenos(texto: string, t: { email: string; telefono: string }): string {
  return String(texto || "")
    .replace(/\+?\s*56\s*9[\s.\-]*\d{4}[\s.\-]*\d{4}/g, t.telefono)
    .replace(/600[\s.\-]*914[\s.\-]*3819/g, t.telefono)
    .replace(/\bsoporte@geovictoria\.com\b/g, t.email)
}

export async function consultarAgenteSoporte(
  args: ConsultarAgenteSoporteInput,
): Promise<ConsultarAgenteSoporteResultado> {
  try {
    const { mensajeProspecto, previousResponseId } = args
    // CLIENTE DE GV AVANZADO (02-oct, Lalo): el agente de Foundry conoce GV
    // Portal y la Mesa de Ayuda no atiende GV Avanzado. A quien tiene su
    // empresa creada por el alta por chat se le responde con el manual de GV
    // Avanzado; si el manual no lo cubre, se avisa al equipo (sin tarjeta).
    if (args._contact) {
      const { esClienteGvAvanzado, consultarGuiaGva } = await import("@/lib/guia-gva")
      if (await esClienteGvAvanzado(args._contact)) {
        const g = await consultarGuiaGva(mensajeProspecto, { pais: args._pais })
        if (g.ok && g.encontrado) {
          return { ok: true, accion: "continuar", respuestaAgente: g.respuesta, previousResponseId: "" }
        }
        const { escalarAImplementador } = await import("@/lib/onboarding-escalamiento")
        const esc = (await escalarAImplementador(args._contact, {
          motivo: "problema_plataforma",
          detalle: mensajeProspecto.slice(0, 500),
        }).catch(() => null)) as { mensajeParaProspecto?: string } | null
        return {
          ok: true,
          accion: "escalar_humano",
          respuestaAgente: g.ok ? g.respuesta : "",
          mensajeParaProspecto:
            esc?.mensajeParaProspecto ||
            "Eso no lo puedo resolver desde aquí: ya le avisé al equipo para que te contacte 🙌",
          previousResponseId: "",
        }
      }
    }
    const result = await callFirstResponseAgent(mensajeProspecto, previousResponseId)
    // Fuera de Chile: tarjeta y canales del país (datos de la ficha). Chile: null.
    const tarjeta = tarjetaSoportePais(args._pais)
    const respuestaAgente = tarjeta ? sanearCanalesChilenos(result.reply, tarjeta) : result.reply

    if (result.marker === "ESCALAR") {
      return {
        ok: true,
        accion: "escalar_humano",
        respuestaAgente,
        mensajeParaProspecto: tarjeta ? tarjeta.mensaje : MENSAJE_ESCALAMIENTO_HUMANO,
        previousResponseId: result.responseId,
      }
    }

    if (result.marker === "END") {
      return {
        ok: true,
        accion: "cerrar",
        respuestaAgente,
        previousResponseId: result.responseId,
      }
    }

    return {
      ok: true,
      accion: "continuar",
      respuestaAgente,
      previousResponseId: result.responseId,
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Error inesperado consultando agente Foundry"
    console.error("[consultar_agente_soporte] Exception:", error)
    return { ok: false, error: message }
  }
}
