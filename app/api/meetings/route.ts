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

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const date = searchParams.get("date") || new Date().toISOString().split("T")[0]

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
