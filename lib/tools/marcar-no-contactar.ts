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
    "Úsala cuando el usuario pida EXPLÍCITAMENTE que no lo contactes más / que dejes de escribirle / que no quiere recibir más mensajes (en cualquier forma o idioma: 'no me hables más', 'déjame en paz', 'no me escriban', 'bórrenme', 'stop', etc.). Despídete con cordialidad UNA vez y llama a esta tool para registrar el opt-out: con esto se detiene el seguimiento automático y no se le vuelve a contactar. NO la uses por una despedida normal ('gracias', 'chao', 'nos vemos') ni porque la conversación quedó en pausa o sin respuesta: solo ante un opt-out claro y explícito.",
  input_schema: {
    type: "object" as const,
    properties: {
      motivo: {
        type: "string" as const,
        description:
          "Nota breve de por qué el usuario no quiere ser contactado (opcional), ej. 'pidió no recibir más mensajes'.",
        maxLength: 200,
      },
    },
  },
}

export type MarcarNoContactarInput = { motivo?: string }

export type MarcarNoContactarResultado = {
  ok: true
  optOut: true
}

export function marcarNoContactar(
  args: MarcarNoContactarInput,
): MarcarNoContactarResultado {
  console.log(
    `[vicky-v3] Opt-out marcado por el modelo. Motivo: ${args?.motivo || "(sin nota)"}`,
  )
  return { ok: true, optOut: true }
}
