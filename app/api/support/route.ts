import { NextResponse } from "next/server"

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const BM_TOKEN = (process.env.BOTMAKER_ACCESS_TOKEN || "").trim()

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

async function getBotmakerUrl(phone: string): Promise<string | null> {
  if (!BM_TOKEN || !phone) return null
  const normalized = phone.replace(/\D/g, "")
  try {
    const res = await fetch(`https://api.botmaker.com/v2.0/chats?contactId=${normalized}&limit=1`, {
      headers: { "access-token": BM_TOKEN, Accept: "application/json" },
      cache: "no-store",
    })
    if (!res.ok) return null
    const data = await res.json()
    const chatId = (data?.items as Array<{ chat: { chatId: string } }>)?.[0]?.chat?.chatId
    return chatId ? `https://go.botmaker.com/#/chats/${chatId}` : null
  } catch { return null }
}

async function fetchInBatches<T, R>(items: T[], batchSize: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize)
    results.push(...await Promise.all(batch.map(fn)))
  }
  return results
}

export async function GET() {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  const rows = await supabase(
    `vic_conversations?is_support=eq.true&last_user_at=gte.${since}&select=id,contact,started_at,last_user_at,lead,support_attended_at&order=last_user_at.desc&limit=200`
  ) as Array<{
    id: string; contact: string; started_at: string; last_user_at: string
    lead: Record<string, string> | null; support_attended_at: string | null
  }> | null

  if (!rows?.length) return NextResponse.json([])

  // Mensajes de todas las conversaciones
  const ids = rows.map(r => r.id).join(",")
  const msgs = await supabase(
    `vic_messages?conversation_id=in.(${ids})&select=conversation_id,role,content,at&order=at.asc`
  ) as Array<{ conversation_id: string; role: string; content: string; at: string }> | null

  const msgsByConv: Record<string, Array<{ role: string; content: string; at: string }>> = {}
  for (const m of msgs || []) {
    if (!msgsByConv[m.conversation_id]) msgsByConv[m.conversation_id] = []
    msgsByConv[m.conversation_id].push({ role: m.role, content: m.content, at: m.at })
  }

  // Botmaker URLs en paralelo (lotes de 5)
  const botmakerUrls = await fetchInBatches(rows, 5, r => getBotmakerUrl(r.contact))

  const result = rows.map((r, i) => {
    const convMsgs = msgsByConv[r.id] || []
    const userMsgs = convMsgs.filter(m => m.role === "user")
    const lastUserMsg = userMsgs[userMsgs.length - 1]?.content || null

    // Resumen: necesidad del lead o primeros mensajes del usuario
    const necesidad = r.lead?.necesidad || null
    const resumen = necesidad || userMsgs.slice(0, 3).map(m => m.content).join(" · ") || null

    return {
      id: r.id,
      contact: r.contact,
      nombre: r.lead?.nombre || null,
      empresa: r.lead?.empresa || null,
      email: r.lead?.email || r.lead?.correo || null,
      telefono: r.lead?.telefono || `+${r.contact}`,
      necesidad,
      resumen,
      started_at: r.started_at,
      last_user_at: r.last_user_at,
      ultimo_mensaje: lastUserMsg,
      mensajes: convMsgs,
      attended: !!r.support_attended_at,
      attended_at: r.support_attended_at || null,
      botmaker_url: botmakerUrls[i],
    }
  })

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
