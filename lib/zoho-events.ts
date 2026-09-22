/**
 * Helper para crear Events en Zoho CRM (módulo Events / "Reuniones") asociados
 * a un Lead, desde Vicky V3 cuando agenda una reunión vía Cal.com.
 *
 * Diferencia clave vs createZohoLead:
 *   - createZohoLead: crea el LEAD (registro principal del prospecto)
 *   - createZohoEvent: crea la REUNIÓN (entidad agendada que aparece en calendario CRM)
 *
 * El Event se asocia al Lead (What_Id) y al KAM (Owner = KAM del Round Robin de Cal.com).
 * Si Cal.com no devolvió organizer (raro pero posible), se cae a Vicky default — en ese
 * caso la tool wrapper agrega una advertencia para que el equipo lo reasigne manualmente.
 */

import { getZohoAccessToken } from "./zoho-token"

function getEnv(name: string): string {
  return (process.env[name] || "").trim()
}

export type CreateZohoEventInput = {
  leadId: string
  slotIso: string
  slotEndIso?: string
  meetingUrl?: string
  prospectName?: string
  prospectEmail?: string
  prospectTimezone?: string
  hostEmail?: string
  hostName?: string
  hostTimezone?: string
  empresa?: string
  trabajadores?: string | number
  necesidad?: string
}

export type CreateZohoEventResult =
  | {
      success: true
      eventId: string
      ownerId: string
    }
  | {
      success: false
      error: string
    }

export async function createZohoEvent(
  input: CreateZohoEventInput,
): Promise<CreateZohoEventResult> {
  try {
    const {
      leadId, slotIso, slotEndIso, meetingUrl,
      prospectName, prospectEmail, prospectTimezone,
      hostName, hostEmail, hostTimezone,
      empresa, trabajadores, necesidad,
    } = input

    if (!leadId || !slotIso) {
      return { success: false, error: "leadId y slotIso son requeridos" }
    }

    const startDate = new Date(slotIso)
    const endDate = slotEndIso ? new Date(slotEndIso) : new Date(startDate.getTime() + 45 * 60 * 1000)
    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      return { success: false, error: "slotIso o slotEndIso no son fechas ISO válidas" }
    }
    const tz = prospectTimezone || "America/Santiago"

    const fmt = (d: Date) =>
      d.toLocaleString("es-CL", {
        timeZone: tz,
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })

    const description = [
      "Reunión agendada automáticamente vía WhatsApp por Vicky (GeoVictoria)\n",
      "═══ HOST ═══",
      hostName || "Ejecutivo GeoVictoria",
      hostEmail || "",
      hostTimezone ? `Zona horaria: ${hostTimezone}` : "",
      "",
      "═══ ASISTENTE (PROSPECTO) ═══",
      prospectName || "Prospecto",
      prospectEmail || "",
      empresa ? `Empresa: ${empresa}` : "",
      trabajadores ? `Trabajadores: ${trabajadores}` : "",
      necesidad ? `Necesidad: ${necesidad}` : "",
      `Zona horaria: ${tz}`,
      "",
      "═══ FECHA Y HORA ═══",
      `Inicio: ${fmt(startDate)}`,
      `Fin:    ${fmt(endDate)}`,
      "",
      "═══ LINK REUNIÓN ═══",
      meetingUrl || "(sin link)",
    ]
      .filter((l) => l !== undefined)
      .join("\n")

    const accessToken = await getZohoAccessToken()
    const apiDomain = getEnv("ZOHO_API_DOMAIN") || "https://www.zohoapis.com"
    const vickyOwnerId = getEnv("ZOHO_CRM_OWNER_ID") || "3525045000484500876"
    const attendeeEmail =
      getEnv("ZOHO_MEETING_ATTENDEE_EMAIL") || "egomez@geovictoria.com"

    let ownerId = vickyOwnerId
    let attendeeId: string | null = null
    try {
      const usersRes = await fetch(`${apiDomain}/crm/v2/users?type=AllUsers`, {
        headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
        cache: "no-store",
      })
      const usersData = (await usersRes.json()) as {
        users?: Array<{ id: string; email: string }>
      }
      const users = usersData?.users || []
      if (hostEmail) {
        const hostMatch = users.find((u) => u.email?.toLowerCase() === hostEmail.toLowerCase())
        if (hostMatch?.id) ownerId = hostMatch.id
      }
      const attendeeMatch = users.find((u) => u.email?.toLowerCase() === attendeeEmail.toLowerCase())
      if (attendeeMatch?.id) attendeeId = attendeeMatch.id
    } catch {
      /* usar Vicky default como fallback */
    }

    const participants: Array<{ participant: string; type: string }> = [
      { participant: ownerId, type: "user" },
    ]
    if (attendeeId && attendeeId !== ownerId) {
      participants.push({ participant: attendeeId, type: "user" })
    }
    participants.push({ participant: leadId, type: "lead" })

    const record = {
      Owner: { id: ownerId },
      Event_Title: `Demo GeoVictoria — ${prospectName || "Prospecto"}${empresa ? ` (${empresa})` : ""}`,
      Start_DateTime: startDate.toISOString().replace("Z", "+00:00"),
      End_DateTime: endDate.toISOString().replace("Z", "+00:00"),
      Description: description,
      What_Id: leadId,
      $se_module: "Leads",
      Status: "Not Started",
      Venue: meetingUrl ? "Microsoft Teams" : "",
      Participants: participants,
    }

    const res = await fetch(`${apiDomain}/crm/v2/Events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Zoho-oauthtoken ${accessToken}`,
      },
      body: JSON.stringify({ data: [record] }),
      cache: "no-store",
    })

    const data = (await res.json()) as {
      data?: Array<{
        code?: string
        status?: string
        details?: { id?: string }
        message?: string
      }>
    }
    const status = data?.data?.[0]?.code || data?.data?.[0]?.status || ""
    const eventId = data?.data?.[0]?.details?.id || null

    if ((status !== "SUCCESS" && status !== "success") || !eventId) {
      const errMsg =
        data?.data?.[0]?.message || `Zoho Events devolvió status ${status || "vacío"}`
      console.error("[zoho-events] Error creando Event:", JSON.stringify(data).slice(0, 500))
      return { success: false, error: errMsg }
    }

    return { success: true, eventId, ownerId }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error inesperado en createZohoEvent"
    console.error("[zoho-events] Exception:", error)
    return { success: false, error: message }
  }
}
