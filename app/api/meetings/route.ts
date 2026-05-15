import { NextResponse } from "next/server"

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()

async function supabase(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
    cache: "no-store",
  })
  if (!res.ok) return null
  const ct = res.headers.get("content-type") || ""
  return ct.includes("application/json") ? res.json() : null
}

const CAL_KEY = (process.env.CAL_API_KEY || "").trim()
const CAL_EVENT_ID = (process.env.CAL_EVENT_TYPE_ID || "3188650").trim()

async function syncTodayFromCal(date: string) {
  if (!CAL_KEY) return
  try {
    const from = `${date}T00:00:00Z`
    const to   = `${date}T23:59:59Z`
    const res = await fetch(
      `https://api.cal.com/v2/bookings?eventTypeId=${CAL_EVENT_ID}&afterStart=${from}&beforeEnd=${to}&limit=50`,
      { headers: { Authorization: `Bearer ${CAL_KEY}`, "cal-api-version": "2024-08-13" }, cache: "no-store" }
    )
    if (!res.ok) return
    const data = await res.json()
    const bookings = data?.data?.bookings || data?.data || []
    if (!bookings.length) return

    // Buscar contactos vinculados
    const convRes = await supabase(
      `vic_conversations?meeting_booking_id=not.is.null&select=contact,zoho_lead_id,meeting_booking_id`
    ) as Array<{ contact: string; zoho_lead_id: string | null; meeting_booking_id: string }> | null
    const convByUid: Record<string, { contact: string; zoho_lead_id: string | null }> = {}
    for (const c of convRes || []) if (c.meeting_booking_id) convByUid[c.meeting_booking_id] = c

    const rows = bookings.map((b: Record<string, unknown>) => ({
      id: b.id,
      uid: b.uid,
      title: b.title || null,
      status: b.status || null,
      start_time: b.start || null,
      end_time: b.end || null,
      duration: b.duration || null,
      event_type_id: b.eventTypeId || null,
      host_name: (b.hosts as Array<{ name: string; email: string }>)?.[0]?.name || null,
      host_email: (b.hosts as Array<{ name: string; email: string }>)?.[0]?.email || null,
      attendee_name: (b.attendees as Array<{ name: string; email: string; absent?: boolean }>)?.[0]?.name || null,
      attendee_email: (b.attendees as Array<{ name: string; email: string; absent?: boolean }>)?.[0]?.email || null,
      meeting_url: b.meetingUrl || null,
      cal_created_at: b.createdAt || null,
      cal_updated_at: b.updatedAt || null,
      contact: convByUid[b.uid as string]?.contact || null,
      zoho_lead_id: convByUid[b.uid as string]?.zoho_lead_id || null,
      synced_at: new Date().toISOString(),
    }))

    await supabase("vic_cal_bookings", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify(rows),
    })
  } catch { /* fallo silencioso */ }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const date = searchParams.get("date") || new Date().toISOString().split("T")[0]
  const today = new Date().toISOString().split("T")[0]

  // Sync en tiempo real solo para hoy
  if (date === today) await syncTodayFromCal(date)

  const from = `${date}T00:00:00Z`
  const to   = `${date}T23:59:59Z`

  const rows = await supabase(
    `vic_cal_bookings?start_time=gte.${from}&start_time=lte.${to}&order=start_time.asc&select=id,uid,status,start_time,end_time,attendee_name,attendee_email,host_name,host_email,meeting_url,contact,zoho_lead_id,attendee_absent,host_absent&limit=50`
  ) as Array<{
    id: number; uid: string; status: string; start_time: string; end_time: string
    attendee_name: string | null; attendee_email: string | null
    host_name: string | null; host_email: string | null; meeting_url: string | null
    contact: string | null; zoho_lead_id: string | null
    attendee_absent: boolean; host_absent: boolean
  }> | null

  if (!rows?.length) return NextResponse.json([])

  // Enriquecer con empresa desde vic_conversations
  const contacts = [...new Set(rows.filter(r => r.contact).map(r => r.contact!))]
  let empresaByContact: Record<string, string> = {}
  if (contacts.length) {
    const convs = await supabase(
      `vic_conversations?contact=in.(${contacts.join(",")})&select=contact,lead`
    ) as Array<{ contact: string; lead: Record<string, string> | null }> | null
    for (const c of convs || []) {
      if (c.lead?.empresa) empresaByContact[c.contact] = c.lead.empresa
    }
  }

  const result = rows.map(r => ({
    id: r.id,
    uid: r.uid,
    status: r.status,
    start_time: r.start_time,
    end_time: r.end_time,
    attendee_name: r.attendee_name,
    attendee_email: r.attendee_email,
    empresa: r.contact ? empresaByContact[r.contact] || null : null,
    host_name: r.host_name,
    host_email: r.host_email,
    meeting_url: r.meeting_url,
    contact: r.contact,
    zoho_lead_id: r.zoho_lead_id,
    attendee_absent: r.attendee_absent,
    host_absent: r.host_absent,
  }))

  return NextResponse.json(result)
}

export async function PATCH(request: Request) {
  const { uid, attendee_absent, host_absent } = await request.json() as {
    uid: string; attendee_absent?: boolean; host_absent?: boolean
  }
  if (!uid) return NextResponse.json({ error: "uid requerido" }, { status: 400 })

  const patch: Record<string, boolean> = {}
  if (attendee_absent !== undefined) patch.attendee_absent = attendee_absent
  if (host_absent !== undefined) patch.host_absent = host_absent

  await supabase(`vic_cal_bookings?uid=eq.${uid}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(patch),
  })

  return NextResponse.json({ ok: true })
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { Allow: "GET, PATCH, OPTIONS" } })
}
