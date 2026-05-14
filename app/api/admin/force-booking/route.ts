import { NextResponse } from "next/server"
import { bookMeeting, getTimezone } from "@/lib/calendar"
import { getZohoAccessToken } from "@/lib/zoho-token"

export async function POST(request: Request) {
  const secret = request.headers.get("x-admin-secret")
  if (secret !== (process.env.ADMIN_API_SECRET || "").trim()) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const { slotIso, prospectName, prospectEmail, timeZone, leadId, contact } = await request.json()

    // 1. Reservar en Cal.com
    const result = await bookMeeting({ slotIso, prospectName, prospectEmail, timeZone })
    if (!result.success) return NextResponse.json({ error: result.error }, { status: 400 })

    const { bookingId, meetingUrl, organizerEmail } = result
    const token = await getZohoAccessToken()
    const apiDomain = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()

    // 2. Resolver owner ID en Zoho
    let ownerId = (process.env.ZOHO_CRM_OWNER_ID || "3525045000484500876").trim()
    if (organizerEmail) {
      const usersRes = await fetch(`${apiDomain}/crm/v2/users?type=AllUsers`, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` }, cache: "no-store",
      })
      const users = (await usersRes.json())?.users || []
      const match = users.find((u: { id: string; email: string }) => u.email?.toLowerCase() === organizerEmail.toLowerCase())
      if (match?.id) ownerId = match.id
    }

    // 3. Actualizar owner del lead
    await fetch(`${apiDomain}/crm/v2/Leads`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Zoho-oauthtoken ${token}` },
      body: JSON.stringify({ data: [{ id: leadId, Owner: { id: ownerId } }] }),
      cache: "no-store",
    })

    // 4. Crear Event en Zoho
    const start = new Date(slotIso)
    const end = new Date(start.getTime() + 45 * 60 * 1000)
    await fetch(`${apiDomain}/crm/v2/Events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Zoho-oauthtoken ${token}` },
      body: JSON.stringify({ data: [{ Owner: { id: ownerId }, Event_Title: `Demo GeoVictoria — ${prospectName}`, Start_DateTime: start.toISOString().replace("Z", "+00:00"), End_DateTime: end.toISOString().replace("Z", "+00:00"), What_Id: leadId, "$se_module": "Leads", Venue: meetingUrl || "", Status: "Not Started" }] }),
      cache: "no-store",
    })

    // 5. Actualizar Supabase
    const sUrl = (process.env.SUPABASE_URL || "").trim()
    const sKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
    if (sUrl && sKey && contact) {
      await fetch(`${sUrl}/rest/v1/vic_conversations?contact=eq.${contact}`, {
        method: "PATCH",
        headers: { apikey: sKey, Authorization: `Bearer ${sKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ meeting_booked: true, meeting_booking_id: bookingId, organizer_email: organizerEmail }),
        cache: "no-store",
      })
    }

    return NextResponse.json({ success: true, bookingId, meetingUrl, organizerEmail, ownerId })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Error" }, { status: 500 })
  }
}
