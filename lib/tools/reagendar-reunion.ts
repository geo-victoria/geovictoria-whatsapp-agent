/**
 * Tool: reagendar_reunion
 *
 * Mueve la reunión YA agendada del cliente a un nuevo horario MANTENIENDO el
 * mismo ejecutivo (host). Usa el endpoint de reschedule de Cal.com (que conserva
 * el host y cancela la vieja), NO crea una reunión nueva como agendar_reunion.
 *
 * No requiere el id de la reunión: ubica automáticamente la reunión futura del
 * contacto (el agent-loop inyecta `_contact`). Tras reagendar, actualiza
 * vic_v3_meetings con la nueva fecha y reprograma el recordatorio.
 */

import { rescheduleMeeting, getTimezone, computeMeetingReminderAt } from "@/lib/calendar"
import { getUpcomingMeeting, updateMeetingByUid } from "@/lib/supabase-persistence-v3"
import { updateZohoLeadOwner } from "@/lib/zoho-leads"

export const reagendarReunionSchema = {
  name: "reagendar_reunion",
  description:
    "Reagenda la reunión que el cliente YA tiene agendada a un nuevo horario, manteniendo el MISMO ejecutivo (host). Úsala cuando un cliente con reunión existente pide cambiarla de día/hora. Llama SOLO con un slot que el cliente confirmó (idealmente tras consultar_disponibilidad_horario con estado 'disponible_exacto', usando el slotIso que devolvió). NO uses agendar_reunion para reagendar: esa crea una reunión nueva y puede asignar otro ejecutivo, además de duplicar el registro. No necesitas ningún identificador de la reunión: se ubica automáticamente la reunión futura del cliente.",
  input_schema: {
    type: "object" as const,
    properties: {
      newSlotIso: {
        type: "string" as const,
        description:
          "Nuevo slot ISO 8601 confirmado por el cliente. Si vino de consultar_disponibilidad_horario con estado 'disponible_exacto', usar el slotIso que devolvió esa tool.",
      },
      country: {
        type: "string" as const,
        description: "País del cliente (para zona horaria). Default Chile.",
      },
    },
    required: ["newSlotIso"],
  },
}

export type ReagendarReunionInput = {
  newSlotIso: string
  country?: string
  // Inyectado por el agent-loop; el modelo no lo provee.
  _contact?: string
}

export type ReagendarReunionResultado =
  | {
      ok: true
      bookingId: string
      slotIso: string
      organizerEmail?: string
      meetingUrl?: string
      mensajeParaProspecto: string
    }
  | { ok: false; error: string; sinReunion?: boolean }

export async function reagendarReunion(
  args: ReagendarReunionInput,
): Promise<ReagendarReunionResultado> {
  const { newSlotIso, country = "Chile", _contact } = args

  if (!_contact) {
    return { ok: false, error: "No se pudo identificar el contacto para reagendar la reunión." }
  }

  const meeting = await getUpcomingMeeting(_contact).catch(() => null)
  if (!meeting) {
    return {
      ok: false,
      error: "El cliente no tiene una reunión futura agendada que reagendar.",
      sinReunion: true,
    }
  }

  const result = await rescheduleMeeting({ bookingUid: meeting.booking_uid, newSlotIso })
  if (!result.success) {
    return { ok: false, error: `No se pudo reagendar la reunión: ${result.error}` }
  }

  // Cal.com re-corre el round-robin al reagendar por API: el ejecutivo PUEDE
  // cambiar. Si cambió y existe el Lead en Zoho, actualizamos su Owner al nuevo
  // host para que el ejecutivo que tomará la reunión sea el dueño real del lead.
  const oldHost = (meeting.organizer_email || "").toLowerCase()
  const newHost = (result.organizerEmail || "").toLowerCase()
  if (newHost && newHost !== oldHost && meeting.zoho_lead_id) {
    const upd = await updateZohoLeadOwner(meeting.zoho_lead_id, result.organizerEmail!).catch(
      (e) => ({ success: false, error: String(e) }),
    )
    if (!upd.success) {
      console.error(
        `[reagendar_reunion] No se pudo actualizar Owner del lead ${meeting.zoho_lead_id} → ${newHost}: ${upd.error}`,
      )
    } else {
      console.log(`[reagendar_reunion] Owner del lead ${meeting.zoho_lead_id} actualizado a ${newHost}`)
    }
  }

  // Actualiza el registro local con la nueva fecha, el nuevo host y reprograma
  // el recordatorio.
  const tz = meeting.timezone || getTimezone(country)
  const reminderAt = computeMeetingReminderAt(result.startIso, tz)
  await updateMeetingByUid(meeting.booking_uid, {
    booking_uid: result.bookingId,
    start_at: result.startIso,
    organizer_email: result.organizerEmail || meeting.organizer_email,
    reminder_at: reminderAt ? reminderAt.toISOString() : null,
    reminder_sent_at: null,
    attendance_confirmed_at: null,
  }).catch(() => {})

  const fechaLegible = new Date(result.startIso).toLocaleString("es-CL", {
    timeZone: tz,
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
  const mensajeParaProspecto =
    `¡Listo! Reagendé tu reunión para el ${fechaLegible} hrs. ` +
    `Te llegará la nueva invitación por correo con los datos del ejecutivo. ` +
    `¿Hay algo más en lo que pueda ayudarte?`

  return {
    ok: true,
    bookingId: result.bookingId,
    slotIso: result.startIso,
    organizerEmail: result.organizerEmail,
    meetingUrl: result.meetingUrl,
    mensajeParaProspecto,
  }
}
