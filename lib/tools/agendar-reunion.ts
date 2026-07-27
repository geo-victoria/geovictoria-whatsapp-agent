/**
 * Tool: agendar_reunion
 *
 * Orquesta 3 acciones en orden:
 *   1. Cal.com bookMeeting → crea el booking + devuelve organizerEmail (KAM del Round Robin)
 *   2. createZohoLead con ownerEmail = organizerEmail → Lead asignado directo al KAM (NO tómbola)
 *   3. createZohoEvent asociado al Lead, con Owner = KAM
 *
 * REGLA: si el booking de Cal.com existe, la tool devuelve ok:true. Siempre.
 * Lo que le importa al cliente es la reunión; el Lead y el Event son papeleo
 * nuestro. Un fallo del CRM no puede reportarse como que no hay reunión.
 *
 * Si Cal.com falla → ok: false (no se crea nada en Zoho, no hay reunión).
 * Si Cal.com OK pero Lead falla → ok: true con crmPendiente + aviso al equipo.
 * Si Cal.com + Lead OK pero Event falla → ok: true con warning.
 */

import { bookMeeting, getTimezone } from "@/lib/calendar"
import { createZohoLead, updateZohoLeadOwner } from "@/lib/zoho-leads"
import { createZohoEvent } from "@/lib/zoho-events"
import { sendBotmakerMessage } from "@/lib/botmaker-push-v3"
import { avisarEquipoInterno } from "@/lib/alerta-interna"
import { getQuotePointers } from "@/lib/supabase-persistence-v3"
import { getZohoAccessToken } from "@/lib/zoho-token"

const ZOHO_API_DOMAIN_REU = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
const QUOTE_MODULE_REU = (process.env.ZOHO_QUOTE_MODULE || "Cotizaciones_GeoVictoria").trim()

/**
 * Dueño (Owner) de la cotización formal VIGENTE del contacto, si existe.
 *
 * REGLA DE ASIGNACIÓN (Lalo, 27-jul): si el cliente ya tiene cotización, la
 * reunión es del dueño del deal/cotización; solo sin cotización asigna el
 * round-robin de Cal.com. Antes cada tool asignaba por su lado y un mismo
 * cliente terminaba repartido entre 2-4 personas (casos Siman Trio, SIMPRO,
 * Litueche, 27-jul). Best-effort: cualquier fallo devuelve null y el flujo
 * sigue con el organizador de Cal, como siempre.
 */
async function duenoCotizacionVigente(
  telefono: string,
): Promise<{ email: string; nombre: string; quoteId: string } | null> {
  try {
    const contact = (telefono || "").replace(/\D/g, "")
    if (!contact) return null
    const pointers = await getQuotePointers(contact)
    const quoteId = pointers[0]?.quoteId
    if (!quoteId) return null
    const token = await getZohoAccessToken()
    const res = await fetch(`${ZOHO_API_DOMAIN_REU}/crm/v3/coql`, {
      method: "POST",
      headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        select_query: `select Owner.email, Owner.full_name from ${QUOTE_MODULE_REU} where id = '${quoteId}'`,
      }),
      cache: "no-store",
    })
    if (!res.ok) return null
    const rows = ((await res.json().catch(() => null))?.data || []) as Array<Record<string, string>>
    const email = (rows[0]?.["Owner.email"] || "").trim()
    if (!email) return null
    return { email, nombre: (rows[0]?.["Owner.full_name"] || email.split("@")[0]).trim(), quoteId }
  } catch {
    return null
  }
}

// Mismo destinatario interno que el resto de los avisos operativos.
const NOTIFY_TO = (process.env.QUOTE_NOTIFY_TO || process.env.VICKY_REPORT_PHONE || "56944668823")
  .trim()
  .replace(/\D/g, "")

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
  /** Event type de Cal.com (multi-país). Lo inyecta el dispatch, no el modelo. */
  eventTypeId?: string
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
      /** true si la reunión existe pero NO quedó registrada en el CRM. */
      crmPendiente?: boolean
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
    eventTypeId: args.eventTypeId,
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

  // REGLA (Lalo 27-jul): con cotización vigente, el lead y el evento van al
  // DUEÑO del deal, no al KAM del round-robin. Cal.com no permite mover el
  // host por API, así que la invitación nace con el KAM y el aviso interno
  // pide traspasarla — pero el CRM queda coherente desde el primer segundo.
  const dueno = await duenoCotizacionVigente(telefono || "")
  const responsableEmail = dueno?.email || organizerEmail
  if (dueno && organizerEmail && dueno.email !== organizerEmail) {
    await avisarEquipoInterno(
      `\u26a0\ufe0f Reunión de un cliente CON COTIZACIÓN vigente\n` +
        `Cliente: ${prospectName}${empresa ? ` — ${empresa}` : ""}\n` +
        `Cuándo: ${slotIso}\n` +
        `Cal.com la asignó a: ${organizerEmail}\n` +
        `Dueño de la cotización: ${dueno.nombre} (${dueno.email}) — quote ${dueno.quoteId}\n` +
        `El lead y el evento quedaron a nombre de ${dueno.nombre}. Falta mover la invitación en Cal.com (o acordar quién la toma).`,
    ).catch(() => false)
  }

  // Lead PRE-EXISTENTE en Zoho (outbound del formulario): reasignar el MISMO
  // lead al KAM de la reunión en vez de crear un duplicado.
  const existingLeadId = (args.zohoLeadId || "").trim()
  let effectiveLeadId: string | undefined
  // El CRM puede quedar atrás sin que eso invalide la reunión. Ver el bloque
  // de createZohoLead más abajo.
  let crmPendiente = false
  let warningCrm: string | undefined
  if (existingLeadId) {
    if (responsableEmail) {
      const upd = await updateZohoLeadOwner(existingLeadId, responsableEmail)
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
      ownerEmail: responsableEmail,
    })

    if (!leadResult.success) {
      // NO se devuelve ok:false. El paso que le importa al cliente —el booking
      // en Cal.com— ya está hecho: la reunión EXISTE y le va a llegar la
      // invitación. Lo que falló es papeleo nuestro en el CRM.
      //
      // CASO QUE ORIGINA ESTE CAMBIO (27-jul, Andirent +573112895086): el
      // booking se creó (nUt9coHsuFkyxVU5gg7ETV, accepted), createZohoLead
      // devolvió 401, la tool devolvía ok:false, y el guardrail
      // anti-alucinación —que solo mira ese flag— pisaba la respuesta correcta
      // de Vicky ("tu reunión está confirmada para mañana a las 10:00") con un
      // "tuve un problema técnico y tu reunión quedó pendiente de registro".
      // El cliente quedó creyendo que no tenía reunión. Es la mentira más cara
      // posible: no se conecta, y el KAM se queda esperando.
      //
      // La ironía es que el propio texto del error decía "Avisa al cliente que
      // la reunión está confirmada" — la instrucción correcta se perdía porque
      // nadie más que el flag `ok` llegaba al guardrail.
      console.error("[agendar_reunion] createZohoLead falló:", leadResult.error)
      crmPendiente = true
      warningCrm =
        `La reunión quedó agendada en el calendario (bookingId ${bookingId}) pero NO se ` +
        `registró en el CRM: ${leadResult.error}. Confirma la reunión al cliente con ` +
        `normalidad — ya está hecha. El registro en Zoho lo hace el equipo a mano.`
      await sendBotmakerMessage(
        NOTIFY_TO,
        `⚠️ Reunión agendada SIN registro en el CRM\n` +
          `Booking: ${bookingId}\n` +
          `Cliente: ${prospectName} — ${empresa || "sin empresa"}\n` +
          `Email: ${prospectEmail}\n` +
          `Cuándo: ${slotIso}\n` +
          `KAM: ${organizerEmail || "sin asignar"}\n` +
          `Motivo: ${leadResult.error}\n` +
          `La reunión EXISTE y el cliente ya fue confirmado. Falta crear el Lead a mano.`,
      ).catch(() => false)
    } else {
      effectiveLeadId = leadResult.leadId
    }
  }

  let eventId: string | undefined
  let warning: string | undefined
  // Sin Lead no hay a qué asociar el Event: se salta y queda en el warning.
  if (responsableEmail && effectiveLeadId) {
    const eventResult = await createZohoEvent({
      leadId: effectiveLeadId,
      slotIso,
      meetingUrl,
      prospectName,
      prospectEmail,
      prospectTimezone: timeZone,
      hostEmail: responsableEmail,
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
    (dueno ? `, con ${dueno.nombre.split(" ")[0]}` : organizerEmail ? `, con ${organizerEmail.split("@")[0]}` : "") +
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
    warning: warningCrm || warning,
    crmPendiente,
  }
}
