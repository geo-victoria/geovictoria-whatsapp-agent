/**
 * Tool: registrar_solicitud_callback
 *
 * Crea Lead en Zoho SIN ownerEmail → Owner = vicky default → entra a TÓMBOLA
 * del equipo comercial. Para callback explícito del prospecto.
 */

import { createZohoLead } from "@/lib/zoho-leads"

export const registrarSolicitudCallbackSchema = {
  name: "registrar_solicitud_callback",
  description:
    "Registra una solicitud de callback en Zoho CRM. Úsala cuando el prospecto pide explícitamente que lo llamen (ej. 'que me llamen', 'prefiero que me contacten', 'mejor por teléfono'). El Lead se crea con Owner = vicky default y entra a la tómbola del equipo comercial, que lo redistribuye según las reglas habituales. NO usar esta tool para reuniones agendadas — para eso existe agendar_reunion. Antes de invocarla, captura nombre, empresa y teléfono como mínimo. Email, necesidad, cantidad de trabajadores y preferencia de horario son recomendados.",
  input_schema: {
    type: "object" as const,
    properties: {
      nombre: {
        type: "string" as const,
        description: "Nombre completo del prospecto.",
        minLength: 1,
        maxLength: 200,
      },
      empresa: {
        type: "string" as const,
        description: "Nombre de la empresa del prospecto.",
        minLength: 1,
        maxLength: 200,
      },
      telefono: {
        type: "string" as const,
        description: "Teléfono al que el prospecto quiere ser llamado.",
        minLength: 6,
        maxLength: 30,
      },
      email: {
        type: "string" as const,
        description: "Email del prospecto. Opcional pero recomendado.",
      },
      necesidad: {
        type: "string" as const,
        description: "Descripción libre de lo que busca. Si menciona 'acceso', 'comedor' o 'asistencia', el CRM la mapea al picklist.",
      },
      trabajadores: {
        type: "string" as const,
        description: "Cantidad de trabajadores reportada como string.",
      },
      cargo: {
        type: "string" as const,
        description: "Cargo del contacto en la empresa, si lo mencionó.",
      },
      pais: {
        type: "string" as const,
        description: "País del prospecto. Default Chile.",
      },
      ciudad: {
        type: "string" as const,
        description: "Ciudad del prospecto.",
      },
      preferenciaHorario: {
        type: "string" as const,
        description: "Franja horaria preferida para el callback (texto libre).",
      },
    },
    required: ["nombre", "empresa", "telefono"],
  },
}

export type RegistrarSolicitudCallbackInput = {
  nombre: string
  empresa: string
  telefono: string
  email?: string
  necesidad?: string
  trabajadores?: string
  cargo?: string
  pais?: string
  ciudad?: string
  preferenciaHorario?: string
}

export type RegistrarSolicitudCallbackResultado =
  | {
      ok: true
      leadId: string
      entraATombola: boolean
      ownerEmail: string
      mensajeParaProspecto: string
    }
  | {
      ok: false
      error: string
    }

export async function registrarSolicitudCallback(
  args: RegistrarSolicitudCallbackInput,
): Promise<RegistrarSolicitudCallbackResultado> {
  const result = await createZohoLead({
    nombre: args.nombre,
    empresa: args.empresa,
    email: args.email,
    telefono: args.telefono,
    cargo: args.cargo,
    pais: args.pais || "Chile",
    ciudad: args.ciudad,
    trabajadores: args.trabajadores,
    necesidad: args.necesidad,
    reunionAgendada: false,
    preferenciaHorario: args.preferenciaHorario,
    contactoWA: args.telefono,
  })

  if (!result.success) {
    console.error("[registrar_solicitud_callback] createZohoLead falló:", result.error)
    return { ok: false, error: result.error }
  }

  const mensajeParaProspecto =
    `¡Listo! Tomé tus datos y un ejecutivo del equipo te contactará al ${args.telefono}` +
    (args.preferenciaHorario ? ` (te llamaremos en el horario que pediste: ${args.preferenciaHorario})` : "") +
    `. ¿Hay algo más en lo que pueda ayudarte mientras tanto?`

  return {
    ok: true,
    leadId: result.leadId,
    entraATombola: result.entraATombola,
    ownerEmail: result.ownerEmail,
    mensajeParaProspecto,
  }
}
