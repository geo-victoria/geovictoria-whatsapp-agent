import { NextResponse } from "next/server"

type MeetingPayload = {
  leadId?: string
  slot?: string
  slotEnd?: string
  meetingUrl?: string
  prospectName?: string
  prospectEmail?: string
  prospectTimezone?: string
  hostName?: string
  hostEmail?: string
  hostTimezone?: string
  empresa?: string
  trabajadores?: string
  necesidad?: string
}

function getEnv(name: string) {
  return (process.env[name] || "").trim()
}

async function getZohoAccessToken() {
  const accountsDomain = getEnv("ZOHO_ACCOUNTS_DOMAIN") || "https://accounts.zoho.com"
  const res = await fetch(`${accountsDomain}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: getEnv("ZOHO_REFRESH_TOKEN"),
      client_id: getEnv("ZOHO_CLIENT_ID"),
      client_secret: getEnv("ZOHO_CLIENT_SECRET"),
      grant_type: "refresh_token",
    }),
    cache: "no-store",
  })
  const data = await res.json()
  if (!data?.access_token) throw new Error("No Zoho token")
  return String(data.access_token)
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as MeetingPayload
    const {
      leadId, slot, slotEnd, meetingUrl,
      prospectName, prospectEmail, prospectTimezone,
      hostName, hostEmail, hostTimezone,
      empresa, trabajadores, necesidad,
    } = body

    if (!leadId || !slot) {
      return NextResponse.json({ success: false, error: "leadId y slot requeridos" }, { status: 400 })
    }

    const startDate = new Date(slot)
    const endDate = slotEnd ? new Date(slotEnd) : new Date(startDate.getTime() + 45 * 60 * 1000)
    const tz = prospectTimezone || "America/Santiago"

    const fmt = (d: Date) => d.toLocaleString("es-CL", {
      timeZone: tz, weekday: "long", day: "numeric",
      month: "long", year: "numeric", hour: "2-digit", minute: "2-digit",
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
    ].filter((l) => l !== undefined).join("\n")

    const accessToken = await getZohoAccessToken()
    const apiDomain = getEnv("ZOHO_API_DOMAIN") || "https://www.zohoapis.com"
    const vickyOwnerId = getEnv("ZOHO_CRM_OWNER_ID") || "3525045000484500876"

    // Resolver hostEmail → Zoho user ID para asignar el Event al host correcto
    let ownerId = vickyOwnerId
    if (hostEmail) {
      try {
        const usersRes = await fetch(`${apiDomain}/crm/v2/users?type=AllUsers`, {
          headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
          cache: "no-store",
        })
        const usersData = await usersRes.json()
        const match = (usersData?.users || []).find(
          (u: { id: string; email: string }) => u.email?.toLowerCase() === hostEmail.toLowerCase()
        )
        if (match?.id) ownerId = match.id
      } catch { /* usar Vicky como fallback */ }
    }

    const participants: { participant: string; type: string }[] = [
      { participant: ownerId, type: "user" },
    ]
    if (leadId) {
      participants.push({ participant: leadId, type: "lead" })
    }

    const record = {
      Owner: { id: ownerId },
      Event_Title: `Demo GeoVictoria — ${prospectName || "Prospecto"}${empresa ? ` (${empresa})` : ""}`,
      Start_DateTime: startDate.toISOString().replace("Z", "+00:00"),
      End_DateTime: endDate.toISOString().replace("Z", "+00:00"),
      Description: description,
      What_Id: leadId,
      "$se_module": "Leads",
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

    const data = await res.json()
    const status = data?.data?.[0]?.code || data?.data?.[0]?.status || ""
    const eventId = data?.data?.[0]?.details?.id || null

    return NextResponse.json({
      success: status === "SUCCESS" || status === "success",
      eventId,
      zohoStatus: status,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error inesperado"
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { Allow: "OPTIONS, POST" } })
}
