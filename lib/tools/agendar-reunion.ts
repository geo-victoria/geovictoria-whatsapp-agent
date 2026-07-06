/**
 * Tool: agendar_reunion
 *
 * Orquesta 3 acciones en orden:
 *   1. Cal.com bookMeeting → crea el booking + devuelve organizerEmail (KAM del Round Robin)
 *   2. createZohoLead con ownerEmail = organizerEmail → Lead asignado directo al KAM (NO tómbola)
 *   3. createZohoEvent asociado al Lead, con Owner = KAM
 *
 * Si Cal.com falla → ok: false (no se crea nada en Zoho).
 * Si Cal.com OK pero Lead falla → ok: false con bookingId para registro manual.
 * Si Cal.com + Lead OK pero Event falla → ok: true con warning (el booking ya existe).
 */

import { bookMeeting, getTimezone } from "@/lib/calendar"
import { createZohoLead, updateZohoLeadOwner } from "@/lib/zoho-leads"
import { createZohoEvent } from "@/lib/zoho-events"

export const agendarReunionSchema = {
  name: "agendar_reunion",
  description:
    "Agenda una reunión en Cal.com para el slot que el cliente confirmó. Crea el booking en Cal.com (asigna automáticamente un KAM por Round Robin), luego registra un Lead en Zoho con Owner = ese KAM específico (NO entra a tómbola porque ya tiene reunión asignada), y crea un Event en Zoho asociado al Lead. Llamar SOLO cuando el cliente haya confirmado explícitamente un horario específico (idealmente tras consultar_disponibilidad_horario que devolvió 'disponible_exacto'). Antes de invocarla captura nombre, email y empresa del cliente — son obligatorios para Cal.com y Zoho.",
  input_schema: {
    type: "object" as const,
    properties: {
      slotIso: {
        type: "string" as const,
        description:
          "Slot ISO 8601 que el cliente confirmó. Si vino de consultar_disponibilidad_horario con estado 'disponible_exacto', usar el slotIso que devolvió esa tool (no el original propuesto por el cliente, que podía diferir hasta ±15 min).",
      },
      prospectName: {
        type: "string" as const,
        description: "Nombre completo del cliente. Obligatorio para Cal.com.",
        minLength: 1,
        maxLength: 200,
      },
      prospectEmail: {
        type: "string" as const,
        description: "Email del cliente. Obligatorio para Cal.com (le envían la confirmación e invitación).",
        minLength: 5,
        maxLength: 200,
      },
      empresa: {
        type: "string" as const,
        description: "Nombre de la empresa del cliente.",
      },
      telefono: {
        type: "string" as const,
        description: "Teléfono del cliente. Se guarda en el Lead.",
      },
      trabajadores: {
        type: "string" as const,
        description: "Cantidad de trabajadores. Se mapea a Rango_de_Empleados del Lead.",
      },
      necesidad: {
        type: "string" as const,
        description: "Descripción libre de lo que busca el cliente.",
      },
      cargo: {
        type: "string" as const,
        description: "Cargo del contacto.",
      },
      country: {
        type: "string" as const,
        description: "País del cliente. Default Chile.",
      },
      zohoLeadId: {
        type: "string" as const,
        description:
          "ID del Lead que YA existe en Zoho (viene en el bloque '[Datos del formulario web: ... zohoLeadId ...]' cuando la conversación la inició Vicky). Si lo pasas, NO se crea un lead nuevo: se REASIGNA ese mismo lead al KAM de la reunión y el evento se asocia a él (evita duplicados). Omítelo cuando el prospecto llegó solo por WhatsApp.",
      },
    },
    required: ["slotIso", "prospectName", "prospectEmail"],
  },
}

export type AgendarReunionInput = {
  slotIso: string
  prospectName: string
  prospectEmail: string
  empresa?: string
  telefono?: string
  trabajadores?: string
  necesidad?: string
  cargo?: string
  country?: string
  zohoLeadId?: string
}

export type AgendarReunionResultado =
  | {
      ok: true
      bookingId: string
      meetingUrl?: string
      organizerEmail?: string
      leadId?: string
      eventId?: string
      slotIso: string
      mensajeParaProspecto: string
      warning?: string
    }
  | {
      ok: false
      error: string
      reunionAgendada?: boolean
      bookingId?: string
    }

export async function agendarReunion(
  args: AgendarReunionInput,
): Promise<AgendarReunionResultado> {
  const {
    slotIso, prospectName, prospectEmail,
    empresa, telefono, trabajadores, necesidad, cargo,
    country = "Chile",
  } = args

  const timeZone = getTimezone(country)

  const booking = await bookMeeting({
    slotIso, prospectName, prospectEmail, timeZone, language: "es",
  })

  if (!booking.success) {
    console.error("[agendar_reunion] bookMeeting falló:", booking.error)
    return {
      ok: false,
      error: `No se pudo agendar la reunión en el calendario: ${booking.error}`,
      reunionAgendada: false,
    }
  }

  const { bookingId, meetingUrl, organizerEmail } = booking

  // Lead PRE-EXISTENTE en Zoho (outbound del formulario): reasignar el MISMO
  // lead al KAM de la reunión en vez de crear un duplicado.
  const existingLeadId = (args.zohoLeadId || "").trim()
  let effectiveLeadId: string
  if (existingLeadId) {
    if (organizerEmail) {
      const upd = await updateZohoLeadOwner(existingLeadId, organizerEmail)
      if (!upd.success) {
        console.error("[agendar_reunion] reasignación del lead existente falló:", upd.error)
      }
    }
    effectiveLeadId = existingLeadId
  } else {
    const leadResult = await createZohoLead({
      nombre: prospectName,
      empresa: empresa || "Prospecto WhatsApp",
      email: prospectEmail,
      telefono,
      cargo,
      pais: country,
      trabajadores,
      necesidad,
      reunionAgendada: true,
      preferenciaHorario: slotIso,
      contactoWA: telefono,
      ownerEmail: organizerEmail,
    })

    if (!leadResult.success) {
      console.error("[agendar_reunion] createZohoLead falló:", leadResult.error)
      return {
        ok: false,
        error:
          `La reunión se agendó en el calendario (bookingId ${bookingId}) pero falló el ` +
          `registro en el CRM: ${leadResult.error}. Avisa al cliente que la reunión está ` +
          `confirmada y comunica internamente al equipo para registro manual.`,
        reunionAgendada: true,
        bookingId,
      }
    }
    effectiveLeadId = leadResult.leadId
  }

  let eventId: string | undefined
  let warning: string | undefined
  if (organizerEmail) {
    const eventResult = await createZohoEvent({
      leadId: effectiveLeadId,
      slotIso,
      meetingUrl,
      prospectName,
      prospectEmail,
      prospectTimezone: timeZone,
      hostEmail: organizerEmail,
      empresa,
      trabajadores,
      necesidad,
    })

    if (eventResult.success) {
      eventId = eventResult.eventId
    } else {
      warning =
        `La reunión y el Lead se crearon correctamente pero falló la creación del Event ` +
        `en Zoho: ${eventResult.error}. El KAM puede registrar manualmente la reunión.`
      console.error("[agendar_reunion] createZohoEvent falló:", eventResult.error)
    }
  } else {
    warning =
      "Cal.com no devolvió organizerEmail; el Event en Zoho se omitió para evitar asignación incorrecta."
  }

  const fechaLegible = new Date(slotIso).toLocaleString("es-CL", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  })

  const mensajeParaProspecto =
    `¡Listo! Tu reunión quedó agendada para el ${fechaLegible}` +
    (organizerEmail ? `, con ${organizerEmail.split("@")[0]}` : "") +
    (meetingUrl ? `. Te llegará el link de la reunión por email a ${prospectEmail}` : ` (te enviaremos el link por email)`) +
    `. ¿Hay algo más en lo que pueda ayudarte?`

  return {
    ok: true,
    bookingId,
    meetingUrl,
    organizerEmail,
    leadId: effectiveLeadId,
    eventId,
    slotIso,
    mensajeParaProspecto,
    warning,
  }
}
