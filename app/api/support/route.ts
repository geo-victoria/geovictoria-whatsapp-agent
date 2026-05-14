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

export async function GET() {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  const rows = await supabase(
    `vic_conversations?is_support=eq.true&last_user_at=gte.${since}&select=id,contact,last_user_at,lead,support_attended_at&order=last_user_at.desc&limit=200`
  ) as Array<{
    id: string
    contact: string
    last_user_at: string
    lead: Record<string, string> | null
    support_attended_at: string | null
  }> | null

  if (!rows?.length) return NextResponse.json([])

  // Último mensaje de usuario por conversación
  const ids = rows.map(r => r.id).join(",")
  const msgs = await supabase(
    `vic_messages?conversation_id=in.(${ids})&role=eq.user&select=conversation_id,content,at&order=at.desc`
  ) as Array<{ conversation_id: string; content: string; at: string }> | null

  const lastMsg: Record<string, string> = {}
  for (const m of msgs || []) {
    if (!lastMsg[m.conversation_id]) lastMsg[m.conversation_id] = m.content
  }

  const result = rows.map(r => ({
    id: r.id,
    contact: r.contact,
    nombre: r.lead?.nombre || null,
    empresa: r.lead?.empresa || null,
    necesidad: r.lead?.necesidad || null,
    last_user_at: r.last_user_at,
    ultimo_mensaje: lastMsg[r.id] || null,
    attended: !!r.support_attended_at,
    attended_at: r.support_attended_at || null,
  }))

  return NextResponse.json(result)
}

export async function PATCH(request: Request) {
  const { id } = await request.json() as { id: string }
  if (!id) return NextResponse.json({ error: "id requerido" }, { status: 400 })

  await supabase(`vic_conversations?id=eq.${id}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ support_attended_at: new Date().toISOString() }),
  })

  return NextResponse.json({ ok: true })
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { Allow: "GET, PATCH, OPTIONS" } })
}
