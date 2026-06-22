import { NextResponse } from "next/server"

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const BM_TOKEN = (process.env.BOTMAKER_ACCESS_TOKEN || "").trim()
// Clave opcional para compartir el dashboard. Si está seteada (env DASHBOARD_SECRET),
// /api/report exige ?key=... que coincida; si no está seteada, queda abierto (como antes).
const DASHBOARD_SECRET = (process.env.DASHBOARD_SECRET || "").trim()

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

// Clasificación de la conversación → tipo del dashboard. El `grupo` lo computa el
// análisis (vic_v3_conversation_analysis): "soporte" | "comercial" | "no_identificado".
function tipoDesdeGrupo(grupo: unknown, tieneFormal: boolean): "lead" | "soporte" | "rebote" {
  const g = String(grupo || "").toLowerCase()
  if (g === "soporte") return "soporte"
  if (g === "comercial") return "lead"
  if (g === "no_identificado") return "rebote"
  // Sin análisis todavía: si ya tiene cotización formal, es lead; si no, rebote.
  return tieneFormal ? "lead" : "rebote"
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  // Gate opcional por clave (para compartir el link sin dejarlo 100% abierto).
  if (DASHBOARD_SECRET && (searchParams.get("key") || "").trim() !== DASHBOARD_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const date = searchParams.get("date") || new Date().toISOString().split("T")[0]
  const from = `${date}T00:00:00Z`
  const to = `${date}T23:59:59Z`

  // Conversaciones V3 del día.
  const rows = await supa(
    `vic_v3_conversations?started_at=gte.${from}&started_at=lte.${to}` +
    `&select=id,contact,started_at,formal_quote_id,followup_status,followup_closed_reason` +
    `&order=started_at.asc&limit=300`
  ) as Array<Record<string, unknown>> | null

  if (!rows) return NextResponse.json([])

  const convIds = rows.map(r => r.id as string).filter(Boolean)
  const contacts = Array.from(new Set(rows.map(r => r.contact as string).filter(Boolean)))

  // Análisis (clasificación + resumen) por conversación.
  const analisis: Record<string, Record<string, unknown>> = {}
  if (convIds.length) {
    const a = await supa(
      `vic_v3_conversation_analysis?conversation_id=in.(${convIds.join(",")})` +
      `&select=conversation_id,grupo,sub_bucket,resumen,cotizacion_outcome,motivo_no_cierre`
    ) as Array<Record<string, unknown>> | null
    for (const x of a || []) analisis[x.conversation_id as string] = x
  }

  // Primer mensaje de usuario por conversación.
  const firstMsgs: Record<string, string> = {}
  if (convIds.length) {
    const msgs = await supa(
      `vic_v3_messages?conversation_id=in.(${convIds.join(",")})&role=eq.user` +
      `&select=conversation_id,content,at&order=at.asc`
    ) as Array<{ conversation_id: string; content: string }> | null
    for (const m of msgs || []) {
      if (!firstMsgs[m.conversation_id]) firstMsgs[m.conversation_id] = m.content
    }
  }

  // Reuniones agendadas por contacto.
  const meetings: Record<string, Record<string, unknown>> = {}
  if (contacts.length) {
    const ms = await supa(
      `vic_v3_meetings?contact=in.(${contacts.join(",")})` +
      `&select=contact,prospect_name,start_at,zoho_lead_id&order=start_at.asc`
    ) as Array<Record<string, unknown>> | null
    for (const m of ms || []) {
      const c = m.contact as string
      if (!meetings[c]) meetings[c] = m
    }
  }

  // BotMaker links en paralelo (máx 10 a la vez).
  const bmLinks: Record<string, string> = {}
  const chunks: Array<Array<Record<string, unknown>>> = []
  for (let i = 0; i < rows.length; i += 10) chunks.push(rows.slice(i, i + 10))
  for (const chunk of chunks) {
    await Promise.all(chunk.map(async r => {
      const contact = r.contact as string
      const chatId = await getBotmakerChatId(contact)
      if (chatId) bmLinks[contact] = `https://go.botmaker.com/#/chats/${chatId}`
    }))
  }

  const result = rows.map(r => {
    const id = r.id as string
    const contact = r.contact as string
    const an = analisis[id] || {}
    const mt = meetings[contact] || null
    const tieneFormal = !!r.formal_quote_id
    const tipo = tipoDesdeGrupo(an.grupo, tieneFormal)
    const hora = new Date(r.started_at as string).toLocaleTimeString("es-CL", {
      timeZone: "America/Santiago", hour: "2-digit", minute: "2-digit", hour12: false,
    })
    const necesidad =
      (an.resumen as string) ||
      (an.sub_bucket as string) ||
      (tieneFormal ? "Cotización formal emitida" : null)

    return {
      contact,
      hora,
      tipo,
      nombre: (mt?.prospect_name as string) || null,
      empresa: null,
      necesidad,
      meetingBooked: !!mt,
      meetingSlot: (mt?.start_at as string) || null,
      zohoLeadId: (mt?.zoho_lead_id as string) || (tieneFormal ? (r.formal_quote_id as string) : null),
      firstMsg: firstMsgs[id] || null,
      bmLink: bmLinks[contact] || null,
    }
  })

  return NextResponse.json(result)
}
