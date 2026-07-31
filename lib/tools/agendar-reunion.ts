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

/** Dueño resuelto para una reunión: del deal (prioridad) o de la cotización. */
export type DuenoReunion = { email: string; nombre: string; quoteId?: string; dealId?: string }

const VICKY_ROBOT_EMAIL = "vicky@geovictoria.com"

/**
 * Dueño (Owner) del DEAL del contacto en Zoho, si existe y es humano.
 *
 * REGLA DE ASIGNACIÓN (Lalo, 31-jul): con la regla de tómbola de Zoho
 * ("Tómbola Deals 2026 Chile") asignando los deals que Vicky entrega, el
 * Owner del deal es LA verdad de asignación: cuando se pide reunión, la
 * disponibilidad se busca en la agenda de ESE ejecutivo y el lead/evento
 * quedan a su nombre. Best-effort: cualquier fallo devuelve null y el flujo
 * cae al dueño de la cotización o al round-robin, como siempre.
 */
export async function duenoDealVigente(telefono: string): Promise<DuenoReunion | null> {
  try {
    const contact = (telefono || "").replace(/\D/g, "")
    if (!contact) return null
    const token = await getZohoAccessToken()
    const H = { Authorization: `Zoho-oauthtoken ${token}` }
    const res = await fetch(
      `${ZOHO_API_DOMAIN_REU}/crm/v3/Leads/search?phone=${contact}&converted=both&per_page=3`,
      { headers: H, cache: "no-store" },
    )
    if (!res.ok || res.status === 204) return null
    const leads = ((await res.json().catch(() => ({}))) as {
      data?: Array<{ Converted_Deal?: { id?: string } | null }>
    }).data
    const dealId = leads?.find((l) => l.Converted_Deal?.id)?.Converted_Deal?.id
    if (!dealId) return null
    const get = await fetch(`${ZOHO_API_DOMAIN_REU}/crm/v3/Deals/${dealId}?fields=Owner`, {
      headers: H,
      cache: "no-store",
    })
    if (!get.ok) return null
    const owner = ((await get.json().catch(() => ({}))) as {
      data?: Array<{ Owner?: { name?: string; email?: string } }>
    }).data?.[0]?.Owner
    const email = (owner?.email || "").trim().toLowerCase()
    if (!email || email === VICKY_ROBOT_EMAIL) return null
    return { email, nombre: (owner?.name || email.split("@")[0]).trim(), dealId }
  } catch {
    return null
  }
}

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
export async function duenoCotizacionVigente(
  telefono: string,
): Promise<DuenoReunion | null> {
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

/**
 * Directorio del equipo comercial CL por email (Zoho, verificado 27-jul).
 *
 * Observación de Rodrigo (27-jul): al confirmar una reunión, Vicky decía
 * "con asepulveda" — el PREFIJO DEL EMAIL crudo. La confirmación debe dar el
 * NOMBRE de la persona y su WhatsApp, para que el cliente sepa con quién se
 * junta y tenga cómo escribirle. Un email fuera del directorio cae a
 * "un ejecutivo de nuestro equipo": nunca más un prefijo de correo.
 */
const DIRECTORIO: Record<string, { nombre: string; whatsapp?: string }> = {
  "asepulveda@geovictoria.com": { nombre: "Aracelli Sepúlveda", whatsapp: "+56 9 3212 5672" },
  "aaraque@geovictoria.com": { nombre: "Aleydis Araque", whatsapp: "+56 9 8291 6868" },
  "emujica@geovictoria.com": { nombre: "Eddyluz Mujica", whatsapp: "+56 9 3932 1687" },
  "adiazg@geovictoria.com": { nombre: "Anderson Díaz", whatsapp: "+56 9 3937 2058" },
  // Símiles por país (Lalo 27-jul): Gordillo toma los deals de Colombia y
  // Yahel los de México — sus reuniones con cotización se confirman con
  // nombre y WhatsApp igual que en Chile.
  "agordillo@geovictoria.com": { nombre: "Alejandro Gordillo", whatsapp: "+57 314 267 7765" },
  "ysegura@geovictoria.com": { nombre: "Yahel Segura", whatsapp: "+52 55 3763 6604" },
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
      /** Quién atiende: nombre real + correo (y WhatsApp si está en el directorio). */
      atiende?: { nombre: string; email?: string; whatsapp?: string }
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

  // REGLA (Lalo 27-jul): con cotización vigente, la reunión es del DUEÑO del
  // deal en el CRM, y el aviso interno pide traspasar la invitación de Cal.
  // NO se puede forzar el host por API en el evento round-robin: probado
  // 28-jul con la key real — `teamMemberEmail` de primer nivel devuelve 400
  // "property teamMemberEmail should not exist". El plan para que el booking
  // NAZCA con el dueño es agendar en su event type personal/managed
  // (pendiente de que existan esos eventos en Cal).
  const dueno = await duenoCotizacionVigente(telefono || "")

  // DECISIÓN FINAL (Lalo 31-jul, reemplaza el redirect de agenda del mismo
  // día): la reunión se agenda COMO SIEMPRE (round-robin SDR inbound / evento
  // del dueño de cotización si aplica), pero si el contacto tiene DEAL con
  // dueño humano, ese propietario entra como ASISTENTE invitado del booking
  // de Cal y se le notifica. El deal NO cambia de dueño por la reunión.
  const duenoDeal = await duenoDealVigente(telefono || "")

  const booking = await bookMeeting({
    slotIso, prospectName, prospectEmail, timeZone, language: "es",
    eventTypeId: args.eventTypeId,
    guestEmails: duenoDeal ? [duenoDeal.email] : [],
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

  const responsableEmail = dueno?.email || organizerEmail

  // Notificación al PROPIETARIO del deal (Lalo 31-jul): quedó invitado como
  // asistente en Cal; se le avisa también por el canal interno. La reunión
  // sigue siendo del SDR que la tomó — el deal no cambia de dueño.
  if (duenoDeal && (organizerEmail || "").trim().toLowerCase() !== duenoDeal.email) {
    await avisarEquipoInterno(
      `📅 Reunión agendada con un cliente que tiene DEAL asignado\n` +
        `Cliente: ${prospectName}${empresa ? ` — ${empresa}` : ""}\n` +
        `Cuándo: ${slotIso}\n` +
        `La toma (round-robin): ${organizerEmail || "por confirmar"}\n` +
        `Propietario del deal: ${duenoDeal.nombre} (${duenoDeal.email}) — deal ${duenoDeal.dealId}\n` +
        `El propietario quedó como ASISTENTE invitado en Cal (invitación en su correo). El deal NO cambia de dueño.`,
    ).catch(() => false)
  }

  if (dueno && organizerEmail && dueno.email !== organizerEmail) {
    await avisarEquipoInterno(
      `\u26a0\ufe0f Reunión de un cliente CON COTIZACIÓN vigente\n` +
        `Cliente: ${prospectName}${empresa ? ` — ${empresa}` : ""}\n` +
        `Cuándo: ${slotIso}\n` +
        `Cal.com la asignó a: ${organizerEmail}\n` +
        `Dueño asignado: ${dueno.nombre} (${dueno.email}) — ${dueno.dealId ? `deal ${dueno.dealId}` : `quote ${dueno.quoteId}`}\n` +
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

  // La persona que atiende: el dueño de la cotización si existe; si no, el
  // organizador de Cal — SIEMPRE con nombre real desde el directorio, jamás
  // el prefijo del email (observación de Rodrigo, 27-jul). Y desde el 28-jul
  // (Lalo) la confirmación comparte sus TRES datos —nombre, correo y
  // teléfono— tanto en round-robin como con dueño directo.
  const atiende = dueno
    ? { ...(DIRECTORIO[dueno.email] || { nombre: dueno.nombre }), email: dueno.email }
    : organizerEmail && DIRECTORIO[organizerEmail]
      ? { ...DIRECTORIO[organizerEmail], email: organizerEmail }
      : undefined
  const datosAtiende = atiende
    ? `\n\nSi necesitas algo antes de la reunión, puedes escribirle a ${atiende.nombre.split(" ")[0]}: 📧 ${atiende.email}${atiende.whatsapp ? ` · 📱 ${atiende.whatsapp}` : ""}`
    : organizerEmail
      ? `\n\nSi necesitas algo antes de la reunión, puedes escribir a 📧 ${organizerEmail}`
      : ""
  const mensajeParaProspecto =
    `¡Listo! Tu reunión quedó agendada para el ${fechaLegible}` +
    (atiende ? `, con ${atiende.nombre}` : organizerEmail ? `, con un ejecutivo de nuestro equipo` : "") +
    (meetingUrl ? `. Te llegará el link de la reunión por email a ${prospectEmail}` : ` (te enviaremos el link por email)`) +
    datosAtiende +
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
    atiende,
  }
}
