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

// ── F2: CONFIGURACIÓN (nómina / turnos / planificaciones) — 25-ago ─────────
// Opcionales por regla de Lalo: la nómina sola basta; turnos y planificaciones
// solo si el cliente quiere dejarlos listos — pero lo que se comparte se
// completa ENTERO (el candado determinista pendientesConfiguracion decide).

export const TOOL_GUARDAR_NOMINA = {
  name: "guardar_nomina",
  description:
    "Guarda trabajadores de la nómina. Acepta las filas TAL CUAL las entregó el cliente (texto " +
    "pegado, o transcritas por ti desde una foto/planilla/PDF que haya mandado): una línea por " +
    "trabajador con columnas separadas por | en este orden: RUT|Correo personal|Nombres|" +
    "Apellidos|Grupo|Tel1|Tel2|Tel3 (los teléfonos pueden ir vacíos). La tool valida fila por " +
    "fila (el correo PERSONAL es obligatorio) y devuelve qué filas quedaron cojas para pedir " +
    "SOLO lo que falta. Las llamadas FUSIONAN por RUT: un trabajador repetido se actualiza, no " +
    "se duplica, y lo ya completado no se pierde. reemplazar=true SOLO si el cliente pide " +
    "explícitamente botar la nómina y partir de cero — jamás porque re-envió un archivo.",
  input_schema: {
    type: "object" as const,
    properties: {
      filas: CAMPO_TEXTO(
        "Trabajadores, una línea por persona: RUT|Correo|Nombres|Apellidos|Grupo|Tel1|Tel2|Tel3.",
      ),
      reemplazar: {
        type: "boolean" as const,
        description:
          "true = descarta TODA la nómina guardada. Solo ante una orden explícita del cliente de " +
          "partir de cero; un archivo re-enviado o corregido NUNCA es motivo (la fusión por RUT lo resuelve).",
      },
    },
    required: ["filas"],
  },
} as const

export const TOOL_DEFINIR_TURNO = {
  name: "definir_turno",
  description:
    "Crea o actualiza UN turno de trabajo (por nombre). Ejemplos: Mañana 09:00-18:30 sin " +
    "colación; Noche 22:00-06:00 colación libre de 45 min. Los días de descanso NO son un " +
    "turno: en la planificación se marcan Libre.",
  input_schema: {
    type: "object" as const,
    properties: {
      nombre: CAMPO_TEXTO("Nombre del turno (Mañana, Tarde, Administrativo…)."),
      horaInicio: CAMPO_TEXTO("Hora de entrada, formato HH:MM."),
      horaFin: CAMPO_TEXTO("Hora de salida, formato HH:MM."),
      tipoColacion: {
        type: "string" as const,
        enum: ["sin", "libre", "fija"],
        description: "sin = sin colación · libre = N minutos donde quieran · fija = bloque horario.",
      },
      colacionMinutos: { type: "number" as const, description: "Minutos de colación (solo tipo libre)." },
      colacionInicio: CAMPO_TEXTO("Inicio de colación fija, HH:MM."),
      colacionFin: CAMPO_TEXTO("Fin de colación fija, HH:MM."),
    },
    required: ["nombre"],
  },
} as const

export const TOOL_ARMAR_PLANIFICACION = {
  name: "armar_planificacion",
  description:
    "Crea o actualiza UNA planificación semanal (por nombre): qué turno corresponde a cada día " +
    "lunes→domingo, referenciando turnos por su NOMBRE. Días de descanso = \"Libre\". Ejemplo: " +
    "Semana Normal = [Mañana, Mañana, Mañana, Mañana, Mañana, Libre, Libre].",
  input_schema: {
    type: "object" as const,
    properties: {
      nombre: CAMPO_TEXTO("Nombre de la planificación (Semana Normal, Rotativo A…)."),
      diasTurnos: {
        type: "array" as const,
        items: { type: "string" as const },
        description:
          "7 nombres de turno, lunes→domingo. \"Libre\" para descanso; \"\" si el cliente aún no lo decide.",
      },
    },
    required: ["nombre", "diasTurnos"],
  },
} as const

export const TOOL_ASIGNAR_PLANIFICACION = {
  name: "asignar_planificacion",
  description:
    "Asigna una planificación a trabajadores de la nómina (por RUT), con fecha de inicio y " +
    "término. Usa todos=true para asignársela a toda la nómina de una vez.",
  input_schema: {
    type: "object" as const,
    properties: {
      planificacion: CAMPO_TEXTO("Nombre de la planificación ya creada."),
      rutsTrabajadores: {
        type: "array" as const,
        items: { type: "string" as const },
        description: "RUTs de los trabajadores que la usan (omitir si todos=true).",
      },
      todos: { type: "boolean" as const, description: "true = toda la nómina con esta planificación." },
      desde: CAMPO_TEXTO("Desde cuándo rige, YYYY-MM-DD."),
      hasta: CAMPO_TEXTO('Hasta cuándo: YYYY-MM-DD o "permanente".'),
    },
    required: ["planificacion", "desde", "hasta"],
  },
} as const

export const TOOL_CONFIRMAR_CONFIGURACION = {
  name: "confirmar_configuracion",
  description:
    "Cierra la configuración y la deja corriendo (planillas + implementación). Llamar SOLO tras " +
    "mostrar el resumen y recibir el sí explícito del cliente. SE NIEGA en código si hay " +
    "pendientes — la lista que devuelve es lo que falta conversar.",
  input_schema: {
    type: "object" as const,
    properties: {
      confirmacion_explicita: {
        type: "boolean" as const,
        description: "true SOLO si el último mensaje del cliente confirma el resumen mostrado.",
      },
    },
    required: ["confirmacion_explicita"],
  },
} as const

export const TOOL_ELIMINAR_TRABAJADOR = {
  name: "eliminar_trabajador",
  description:
    "Elimina UN trabajador de la nómina por su RUT (también borra sus asignaciones). Úsala para " +
    "duplicados (ej: se corrigió un RUT y quedó el registro viejo) o cuando el cliente pida " +
    "sacar a alguien. Llamar SOLO tras confirmar con el cliente a QUIÉN se borra, nombrándolo " +
    "con su RUT exacto.",
  input_schema: {
    type: "object" as const,
    properties: {
      rut: CAMPO_TEXTO("RUT exacto del trabajador a eliminar, tal como figura en la nómina."),
    },
    required: ["rut"],
  },
} as const
