/**
 * Tool: consultar_disponibilidad_horario
 *
 * El cliente propone la fecha. Vicky verifica. NUNCA propone primero.
 *
 * Estados devueltos:
 *   - disponible_exacto: hay slot a ±15 min de la propuesta → pasar slotIso a agendar_reunion.
 *   - alternativas_mismo_dia: no exacto pero hay otros en el mismo día → comunicar al cliente.
 *   - alternativas_dias_cercanos: nada ese día, sí en los próximos 5 días → comunicar.
 *   - sin_disponibilidad: nada en la ventana → cliente debe proponer otra fecha.
 */

import { checkSlotAvailability } from "@/lib/calendar"

export const consultarDisponibilidadHorarioSchema = {
  name: "consultar_disponibilidad_horario",
  description:
    "Verifica si una fecha y hora propuesta POR EL CLIENTE está disponible en el calendario del equipo. Úsala cuando el cliente proponga un horario específico para reunión (ej. 'el jueves a las 11'). Tú NUNCA propones horarios primero — esta tool solo se invoca después de que el cliente expresó una fecha/hora preferida. Si Cal.com tiene un slot a menos de 15 min de la propuesta del cliente, devuelve 'disponible_exacto'. Si no, devuelve alternativas del mismo día o de días cercanos. Tras recibir alternativas, presenta las opciones al cliente en prosa natural (no como menú numerado) y espera que él elija; cuando elija, vuelves a invocar esta tool con su nueva propuesta, o pasas a agendar_reunion si ya hubo match exacto.",
  input_schema: {
    type: "object" as const,
    properties: {
      fechaPropuesta: {
        type: "string" as const,
        description:
          "Fecha y hora propuesta por el cliente, en formato ISO 8601 con timezone (ej. '2026-05-28T15:00:00.000Z'). Interpreta la propuesta del cliente teniendo en cuenta la zona horaria de su país (default Chile/America/Santiago) y conviértela a este formato.",
      },
      country: {
        type: "string" as const,
        description:
          "País del prospecto, para definir timezone y feriados. Valores aceptados: Chile (default), Argentina, Colombia, México, Perú, Brasil, etc.",
      },
    },
    required: ["fechaPropuesta"],
  },
}

export type ConsultarDisponibilidadHorarioInput = {
  fechaPropuesta: string
  country?: string
}

export type ConsultarDisponibilidadHorarioResultado =
  | { ok: true; estado: "disponible_exacto"; slotIso: string }
  | { ok: true; estado: "alternativas_mismo_dia"; alternativas: string[] }
  | { ok: true; estado: "alternativas_dias_cercanos"; alternativas: string[] }
  | { ok: true; estado: "sin_disponibilidad" }
  | { ok: false; error: string }

export async function consultarDisponibilidadHorario(
  args: ConsultarDisponibilidadHorarioInput,
): Promise<ConsultarDisponibilidadHorarioResultado> {
  const { fechaPropuesta, country = "Chile" } = args

  const result = await checkSlotAvailability({ slotIso: fechaPropuesta, country })

  if (!result.ok) {
    console.error("[consultar_disponibilidad_horario] checkSlotAvailability falló:", result.error)
    return { ok: false, error: result.error }
  }

  return result
}
