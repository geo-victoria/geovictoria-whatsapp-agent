/**
 * Tool: programar_seguimiento
 *
 * Vicky la invoca cuando el cliente da una señal EXPLÍCITA de decisión diferida
 * — la decisión depende de otra persona o de otro factor y hay que esperar
 * ("lo veo con mi jefe", "lo consulto con mi socio", "espero la aprobación",
 * "escríbeme el lunes") — Y acordaron un momento para retomar.
 *
 * NO se usa por silencio/abandono normal: para eso está la cadencia automática.
 *
 * Es una SEÑAL: no llama a ningún servicio externo. El route, al verla con éxito,
 * programa UN solo toque a la fecha acordada (followup_status='consensuado') y
 * APAGA los re-engagement automáticos de esa conversación (ni el follow-up de
 * 1h/23h ni la reactivación 47h/7d/15d la tocan).
 */

export const programarSeguimientoSchema = {
  name: "programar_seguimiento",
  description:
    "Úsala SOLO cuando el cliente da una señal EXPLÍCITA de que la decisión depende de otra persona o de otro factor y hay que esperar (ej. 'lo tengo que ver con mi jefe', 'lo consulto con mi socio', 'espero la aprobación del directorio', 'estoy cerrando el presupuesto', 'escríbeme el lunes'), Y acordaron CUÁNDO retomar. ANTES de llamarla, pregúntale al cliente cuándo sería un buen momento para que le escribas. Con esto se programa UN solo seguimiento a esa fecha y se apagan los recordatorios automáticos de esta conversación. NO la uses si el cliente solo se quedó en silencio o se despidió sin dar un motivo de espera: ahí va la cadencia automática normal.",
  input_schema: {
    type: "object" as const,
    properties: {
      cuandoIso: {
        type: "string" as const,
        description:
          "Fecha y hora acordada para retomar, en formato ISO 8601 con zona horaria (ej. '2026-06-29T10:00:00-04:00'). Interpreta lo que dijo el cliente ('el lunes', 'en dos semanas', 'después del 15') en SU zona horaria (default Chile/America/Santiago) y conviértelo a este formato. Debe ser una fecha futura.",
      },
      motivo: {
        type: "string" as const,
        description:
          "Nota breve del factor de decisión (opcional), ej. 'lo consulta con su jefe', 'espera aprobación de presupuesto'.",
        maxLength: 200,
      },
    },
    required: ["cuandoIso"],
  },
}

export type ProgramarSeguimientoInput = { cuandoIso: string; motivo?: string }

export type ProgramarSeguimientoResultado =
  | { ok: true; cuandoIso: string; mensajeParaProspecto: string }
  | { ok: false; error: string }

export function programarSeguimiento(
  args: ProgramarSeguimientoInput,
): ProgramarSeguimientoResultado {
  const raw = (args?.cuandoIso || "").trim()
  const when = new Date(raw)
  if (!raw || isNaN(when.getTime())) {
    return {
      ok: false,
      error: "cuandoIso inválido: debe ser una fecha ISO 8601 válida (ej. '2026-06-29T10:00:00-04:00').",
    }
  }
  if (when.getTime() <= Date.now()) {
    return { ok: false, error: "La fecha acordada debe ser en el futuro." }
  }
  console.log(
    `[vicky-v3] Seguimiento consensuado programado para ${raw}. Motivo: ${args?.motivo || "(sin nota)"}`,
  )
  return {
    ok: true,
    cuandoIso: raw,
    // Genérico a propósito (sin re-formatear la fecha aquí, para no enredar zonas
    // horarias): Vicky confirma el día puntual con sus palabras en el mismo turno.
    mensajeParaProspecto:
      "Perfecto, lo dejamos así. Te escribo cuando quedamos para retomar, sin presionarte. Si necesitas algo antes, aquí estoy 🙌",
  }
}
