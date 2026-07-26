/**
 * Schemas de las tools de la fase onboarding. Solo definición (datos puros):
 * la ejecución —que toca vic_kv y avisa al equipo— vive en el canal
 * (lib/onboarding-canal.ts), del otro lado de la frontera.
 */

const CAMPO_TEXTO = (descripcion: string) =>
  ({ type: "string" as const, description: descripcion })

export const TOOL_GUARDAR_DATOS_ONBOARDING = {
  name: "guardar_datos_onboarding",
  description:
    "Guarda los datos del alta que el cliente acaba de entregar o corregir. Todos los campos son " +
    "opcionales: pasa SOLO lo que dijo en este mensaje, TAL CUAL lo escribió (sin normalizar ni " +
    "adivinar). La tool valida, persiste el avance y devuelve qué falta, qué vino inválido y, si " +
    "el borrador quedó completo, el resumen exacto para pedir confirmación. Llámala CADA vez que " +
    "el cliente entregue un dato — el avance no puede quedar solo en la conversación.",
  input_schema: {
    type: "object" as const,
    properties: {
      empresa: {
        type: "object" as const,
        properties: {
          nombre: CAMPO_TEXTO("Razón social de la empresa, tal cual la dio el cliente."),
          identificador: CAMPO_TEXTO(
            "RUT de la empresa, tal cual lo escribió el cliente (con o sin puntos y guion).",
          ),
        },
      },
      admin: {
        type: "object" as const,
        properties: {
          nombre: CAMPO_TEXTO("Nombre(s) de pila del administrador de la cuenta."),
          apellido: CAMPO_TEXTO(
            "Apellido(s) del administrador. Campo SEPARADO del nombre: si el cliente dio el " +
              "nombre completo junto y no queda claro dónde parte el apellido, pregunta en vez de adivinar.",
          ),
          identificador: CAMPO_TEXTO("RUT personal del administrador, tal cual lo escribió."),
          email: CAMPO_TEXTO("Correo del administrador (será su acceso a la plataforma)."),
          idInterno: CAMPO_TEXTO(
            "Código interno de trabajador (SAP u otro) SOLO si el cliente lo mencionó espontáneamente. Nunca se pide.",
          ),
        },
      },
    },
  },
} as const

export const TOOL_CONFIRMAR_ALTA_EMPRESA = {
  name: "confirmar_alta_empresa",
  description:
    "Solicita el alta DEFINITIVA de la empresa y su administrador. Paso irreversible: llamar SOLO " +
    "después de mostrar el resumen completo al cliente y recibir su confirmación explícita en el " +
    "último mensaje. Si el borrador no está completo la tool lo rechaza.",
  input_schema: {
    type: "object" as const,
    properties: {
      confirmacion_explicita: {
        type: "boolean" as const,
        description:
          "true SOLO si el ÚLTIMO mensaje del cliente confirma explícitamente el resumen mostrado " +
          "(un sí claro). Ante cualquier ambigüedad: false y se vuelve a preguntar.",
      },
    },
    required: ["confirmacion_explicita"],
  },
} as const
