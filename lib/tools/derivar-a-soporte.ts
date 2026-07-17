/**
 * Tool: derivar_a_soporte
 *
 * Vicky la invoca cuando detecta uno de los siguientes casos:
 *   - El prospecto tiene MÁS de 50 trabajadores (fuera del scope V3).
 *   - El prospecto es cliente existente con problema operativo.
 *   - El prospecto pide explícitamente hablar con un humano.
 *   - Una tool falló y no se puede continuar.
 *   - El prospecto pide algo fuera de scope (producto no habilitado).
 *
 * Motivos puente (V3 transicional):
 *   Mientras no existan las tools dedicadas, las tres capacidades pares
 *   a "cotizar" se encauzan también por aquí, con motivos diferenciados
 *   para preservar la categoría estructurada:
 *     - agendar_reunion: el prospecto quiere coordinar reunión con un
 *       ejecutivo comercial (futuro: tool de Cal.com).
 *     - callback: el prospecto pide que un ejecutivo lo llame de vuelta
 *       (futuro: tool de creación/actualización de Lead en Zoho).
 *     - transferir_soporte_operativo: cliente o usuario con consulta
 *       operativa de plataforma (futuro: tool al agente de Foundry).
 */

export const derivarASoporteSchema = {
  name: "derivar_a_soporte",
  description:
    "Deriva la conversación a un humano (ejecutivo comercial o soporte). Úsala cuando: (a) el prospecto tiene más de 50 trabajadores, (b) es cliente existente con problema operativo, (c) pide hablar con persona, (d) una tool falló y no se puede continuar, (e) pide un producto fuera del catálogo, (f) el prospecto quiere agendar una reunión, (g) el prospecto prefiere que lo llamen de vuelta, o (h) la consulta es operativa y debe ir al equipo de soporte.",
  input_schema: {
    type: "object" as const,
    properties: {
      motivo: {
        type: "string" as const,
        enum: [
          "fuera_de_rango_trabajadores",
          "cliente_existente_problema",
          "solicitud_explicita_persona",
          "tool_fallo",
          "fuera_de_scope",
          "agendar_reunion",
          "callback",
          "transferir_soporte_operativo",
        ],
        description: "Categoría del motivo de la derivación.",
      },
      contexto: {
        type: "string" as const,
        description:
          "Breve descripción del caso para que el humano entienda al tomarlo (1-2 oraciones).",
        minLength: 5,
        maxLength: 300,
      },
    },
    required: ["motivo", "contexto"],
  },
}

export type DerivarASoporteInput = {
  motivo:
    | "fuera_de_rango_trabajadores"
    | "cliente_existente_problema"
    | "solicitud_explicita_persona"
    | "tool_fallo"
    | "fuera_de_scope"
    | "agendar_reunion"
    | "callback"
    | "transferir_soporte_operativo"
  contexto: string
}

export type DerivarASoporteResultado = {
  ok: true
  handoff: true
  motivo: string
  mensajeSugeridoUsuario: string
}

const MENSAJES_POR_MOTIVO: Record<DerivarASoporteInput["motivo"], string> = {
  fuera_de_rango_trabajadores:
    "Para empresas de tu tamaño te conviene una propuesta personalizada con uno de nuestros ejecutivos, que considera descuentos por volumen y necesidades específicas. Te derivo con uno de nuestros ejecutivos, que se va a contactar contigo en las próximas horas.",
  cliente_existente_problema:
    "Veo que ya eres cliente. Para problemas operativos te conviene hablar directo con soporte. Te derivo para que te atiendan lo antes posible.",
  solicitud_explicita_persona:
    "Por supuesto, te derivo con un ejecutivo humano. Se va a contactar contigo en las próximas horas.",
  tool_fallo:
    "Tuve un problema técnico para procesar tu solicitud. Te derivo con un ejecutivo para que te atienda directamente.",
  fuera_de_scope:
    "Para esa consulta es mejor que te atienda un ejecutivo directamente. Te derivo y se va a contactar contigo en las próximas horas.",
  agendar_reunion:
    "Perfecto, te coordino una reunión con un ejecutivo comercial. Se va a contactar contigo en las próximas horas para acordar fecha y hora.",
  callback:
    "Listo, le aviso a un ejecutivo para que te llame de vuelta. Se va a contactar contigo en las próximas horas.",
  transferir_soporte_operativo:
    "Para esa consulta operativa te conviene hablar con el equipo de soporte. Te derivo para que te atiendan lo antes posible.",
}

export function derivarASoporte(args: DerivarASoporteInput): DerivarASoporteResultado {
  const { motivo, contexto } = args

  console.log(`[vicky-v3] Handoff a soporte. Motivo: ${motivo}. Contexto: ${contexto}`)

  return {
    ok: true,
    handoff: true,
    motivo,
    mensajeSugeridoUsuario: MENSAJES_POR_MOTIVO[motivo],
  }
}
