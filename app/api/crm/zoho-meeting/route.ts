import { NextResponse } from "next/server"

type MeetingPayload = {
  leadId?: string
  slot?: string
  meetingUrl?: string
  prospectName?: string
  prospectEmail?: string
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
    const { leadId, slot, meetingUrl, prospectName, prospectEmail } = body

    if (!leadId || !slot) {
      return NextResponse.json({ success: false, error: "leadId y slot requeridos" }, { status: 400 })
    }

    const startDate = new Date(slot)
    const endDate = new Date(startDate.getTime() + 45 * 60 * 1000)

    const accessToken = await getZohoAccessToken()
    const apiDomain = getEnv("ZOHO_API_DOMAIN") || "https://www.zohoapis.com"

    const record = {
      Event_Title: `Demo GeoVictoria — ${prospectName || "Prospecto"}`,
      Start_DateTime: startDate.toISOString().replace("Z", "+00:00"),
      End_DateTime: endDate.toISOString().replace("Z", "+00:00"),
      Description: [
        `Reunión agendada automáticamente vía WhatsApp por Vicky.`,
        meetingUrl ? `Link videollamada: ${meetingUrl}` : "",
        prospectEmail ? `Email prospecto: ${prospectEmail}` : "",
      ].filter(Boolean).join("\n"),
      What_Id: leadId,
      Status: "Not Started",
      Venue: meetingUrl || "",
    }

    const res = await fetch(`${apiDomain}/crm/v2/Events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Zoho-oauthtoken ${accessToken}`,
      },
      body: JSON.stringify({ data: [record], trigger: ["workflow"] }),
      cache: "no-store",
    })

    const data = await res.json()
    const status = data?.data?.[0]?.status || ""
    const eventId = data?.data?.[0]?.details?.id || null

    return NextResponse.json({
      success: res.ok && status === "success",
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
