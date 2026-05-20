import { NextResponse } from "next/server"

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const BM_TOKEN    = (process.env.BOTMAKER_ACCESS_TOKEN || "").trim()
const BM_CHANNEL  = "GeoVictoriaEspaol-whatsapp-56967308227"

async function supa(path: string) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    cache: "no-store",
  })
  if (!res.ok) return null
  return res.json()
}

async function getBotmakerChatId(contact: string): Promise<string | null> {
  if (!BM_TOKEN) return null
  try {
    const res = await fetch(`https://api.botmaker.com/v2.0/chats?contactId=${contact}&limit=1`, {
      headers: { "access-token": BM_TOKEN, Accept: "application/json" },
      cache: "no-store",
    })
    if (!res.ok) return null
    const data = await res.json()
    return data?.items?.[0]?.chat?.chatId ?? null
  } catch { return null }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const date = searchParams.get("date") || new Date().toISOString().split("T")[0]
  const from = `${date}T00:00:00Z`
  const to   = `${date}T23:59:59Z`

  const rows = await supa(
    `vic_conversations?started_at=gte.${from}&started_at=lte.${to}&select=id,contact,lead,meeting_booked,is_support,zoho_lead_id,started_at,first_response_id&order=started_at.asc&limit=200`
  ) as Array<Record<string, unknown>> | null

  if (!rows) return NextResponse.json([])

  // Obtener primer mensaje de usuario para cada conversación
  const convIds = rows.map(r => r.id as string).filter(Boolean)
  let firstMsgs: Record<string, string> = {}
  if (convIds.length) {
    const msgs = await supa(
      `vic_messages?conversation_id=in.(${convIds.join(",")})&role=eq.user&select=conversation_id,content&order=at.asc`
    ) as Array<{ conversation_id: string; content: string }> | null
    for (const m of msgs || []) {
      if (!firstMsgs[m.conversation_id]) firstMsgs[m.conversation_id] = m.content
    }
  }

  // BotMaker links en paralelo (máx 10 a la vez)
  const bmLinks: Record<string, string> = {}
  const chunks = []
  for (let i = 0; i < rows.length; i += 10) chunks.push(rows.slice(i, i + 10))
  for (const chunk of chunks) {
    await Promise.all(chunk.map(async r => {
      const contact = r.contact as string
      const chatId = await getBotmakerChatId(contact)
      if (chatId) bmLinks[contact] = `https://go.botmaker.com/#/chats/${chatId}`
    }))
  }

  const result = rows.map(r => {
    const lead = r.lead as Record<string, string> | null
    const isSupport = Boolean(r.is_support)
    const hasLead = !!(lead?.nombre && lead?.email)
    const tipo = isSupport ? "soporte" : hasLead ? "lead" : "rebote"
    const horaUTC = new Date(r.started_at as string)
    const horaSantiago = new Date(horaUTC.getTime() - 4 * 60 * 60 * 1000).toISOString().substring(11, 16)

    return {
      contact: r.contact,
      hora: horaSantiago,
      tipo,
      nombre: lead?.nombre || null,
      empresa: lead?.empresa || null,
      necesidad: lead?.necesidad || null,
      meetingBooked: Boolean(r.meeting_booked),
      meetingSlot: lead?.meetingSlot || null,
      zohoLeadId: r.zoho_lead_id || null,
      firstMsg: firstMsgs[r.id as string] || null,
      bmLink: bmLinks[r.contact as string] || null,
    }
  })

  return NextResponse.json(result)
}
