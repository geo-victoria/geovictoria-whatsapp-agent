/**
 * Tool: marcar_no_contactar
 *
 * Vicky la invoca cuando el usuario pide EXPLÍCITAMENTE que no lo contacten más
 * (opt-out), en cualquier forma o idioma: "no me hables más", "déjame en paz",
 * "no quiero recibir más mensajes", "bórrenme", etc. La decisión de qué es un
 * opt-out la toma el MODELO (no un regex sobre el texto).
 *
 * Es una SEÑAL: no llama a ningún servicio externo. El route, al ver que esta
 * tool se ejecutó con éxito, cierra el ciclo de seguimiento (re-engagement)
 * para no volver a contactar al usuario.
 */

export const marcarNoContactarSchema = {
  name: "marcar_no_contactar",
  description:
    "Detiene TODO el contacto automático (seguimientos y reactivaciones). Úsala en DOS casos: (1) tipo='opt_out' — el usuario pide EXPLÍCITAMENTE que no lo contactes más ('no me hables más', 'déjame en paz', 'no me escriban', 'stop'). (2) tipo='perdido' — el usuario declara una pérdida DEFINITIVA: ya contrató/pagó a otro proveedor, o rechaza de forma terminante ('ya firmé con X', 'ya pagué otro sistema', 'no hay retracto', 'definitivamente no'). En ambos casos: despídete con cordialidad UNA sola vez y llama esta tool — no insistas ni contra-ofertas de nuevo (si hubo una declaración de pérdida, tienes UNA oportunidad de retención ANTES de que la confirme; confirmada la decisión, cierras con elegancia y llamas la tool). Además, con tipo='perdido' su cotización pendiente se marca Rechazada en el CRM. NO la uses por una despedida normal ('gracias', 'chao') ni por silencio: solo ante opt-out explícito o pérdida declarada.",
  input_schema: {
    type: "object" as const,
    properties: {
      tipo: {
        type: "string" as const,
        enum: ["opt_out", "perdido"],
        description:
          "'opt_out' = pidió no ser contactado. 'perdido' = declaró pérdida definitiva (se fue con la competencia / ya pagó otro / rechazo terminante). Default: 'opt_out'.",
      },
      motivo: {
        type: "string" as const,
        description:
          "Nota breve (opcional), ej. 'pidió no recibir más mensajes' o 'contrató a la competencia por precio'.",
        maxLength: 200,
      },
    },
  },
}

export type MarcarNoContactarInput = { tipo?: "opt_out" | "perdido"; motivo?: string }

export type MarcarNoContactarResultado = {
  ok: true
  optOut: true
  tipo: "opt_out" | "perdido"
}

export function marcarNoContactar(
  args: MarcarNoContactarInput,
): MarcarNoContactarResultado {
  const tipo = args?.tipo === "perdido" ? "perdido" : "opt_out"
  console.log(
    `[vicky-v3] No-contactar marcado por el modelo. tipo=${tipo} motivo: ${args?.motivo || "(sin nota)"}`,
  )
  return { ok: true, optOut: true, tipo }
}
