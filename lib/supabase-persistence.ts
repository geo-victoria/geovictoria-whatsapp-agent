type ConversationMessage = {
  role: "user" | "assistant"
  content: string
  at: string
}

type LeadData = {
  nombre?: string
  empresa?: string
  cargo?: string
  correo?: string
  telefono?: string
  pais?: string
  trabajadores?: string
  necesidad?: string
  idioma?: string
  agendar_reunion?: string
}

type EvaluationResult = {
  score_total: number
  conversion: number
  engagement: number
  calidad_info: number
  tono_experiencia: number
  diagnostico_abandono: string
  tramo: "80-100" | "50-79" | "20-49" | "0-19"
  analizadas: number
}

export type ConversationState = {
  contact: string
  startedAt: string
  updatedAt: string
  lastUserAt?: string
  messages: ConversationMessage[]
  lead?: LeadData
  lastEvaluationAt?: string
  lastEvaluation?: EvaluationResult
}

function getEnv(name: string) {
  return (process.env[name] || "").trim()
}

function getSupabaseConfig() {
  const url = getEnv("SUPABASE_URL")
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY")
  return { url, key }
}

export function isSupabaseConfigured() {
  const { url, key } = getSupabaseConfig()
  return Boolean(url && key)
}

async function supabaseRequest(path: string, init: RequestInit) {
  const { url, key } = getSupabaseConfig()
  if (!url || !key) throw new Error("Supabase no configurado")

  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
    cache: "no-store",
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Supabase REST error (${response.status}): ${text.slice(0, 500)}`)
  }

  const contentType = response.headers.get("content-type") || ""
  if (!contentType.includes("application/json")) return null
  return response.json()
}

async function getConversationIdByContact(contact: string): Promise<string | null> {
  const result = (await supabaseRequest(
    `vic_conversations?select=id&contact=eq.${encodeURIComponent(contact)}&limit=1`,
    { method: "GET" },
  )) as Array<{ id: string }> | null

  return result?.[0]?.id || null
}

export async function upsertConversationSnapshot(state: ConversationState) {
  if (!isSupabaseConfigured()) return

  const upsertData = {
    contact: state.contact,
    started_at: state.startedAt,
    updated_at: state.updatedAt,
    last_user_at: state.lastUserAt || null,
    lead: state.lead || null,
    last_evaluation_at: state.lastEvaluationAt || null,
    last_evaluation: state.lastEvaluation || null,
  }

  const upsertResult = (await supabaseRequest("vic_conversations?on_conflict=contact", {
    method: "POST",
    headers: {
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify([upsertData]),
  })) as Array<{ id: string }> | null

  const conversationId = upsertResult?.[0]?.id || (await getConversationIdByContact(state.contact))
  if (!conversationId) return

  await supabaseRequest(`vic_messages?conversation_id=eq.${conversationId}`, {
    method: "DELETE",
  })

  if (state.messages.length === 0) return

  const rows = state.messages.map((m) => ({
    conversation_id: conversationId,
    role: m.role,
    content: m.content,
    at: m.at,
  }))

  await supabaseRequest("vic_messages", {
    method: "POST",
    body: JSON.stringify(rows),
  })
}

export async function saveLead(state: ConversationState) {
  if (!isSupabaseConfigured() || !state.lead) return
  const conversationId = await getConversationIdByContact(state.contact)
  if (!conversationId) return

  await supabaseRequest("vic_leads", {
    method: "POST",
    body: JSON.stringify([
      {
        conversation_id: conversationId,
        contact: state.contact,
        lead: state.lead,
      },
    ]),
  })
}

export async function saveEvaluation(state: ConversationState, evaluation: EvaluationResult) {
  if (!isSupabaseConfigured()) return
  const conversationId = await getConversationIdByContact(state.contact)
  if (!conversationId) return

  await supabaseRequest("vic_evaluations", {
    method: "POST",
    body: JSON.stringify([
      {
        conversation_id: conversationId,
        contact: state.contact,
        evaluation,
      },
    ]),
  })
}

export async function fetchConversations(contact?: string): Promise<ConversationState[] | ConversationState | null> {
  if (!isSupabaseConfigured()) return null

  if (contact) {
    const rows = (await supabaseRequest(
      `vic_conversations?select=id,contact,started_at,updated_at,last_user_at,lead,last_evaluation_at,last_evaluation&contact=eq.${encodeURIComponent(contact)}&limit=1`,
      { method: "GET" },
    )) as
      | Array<{
          id: string
          contact: string
          started_at: string
          updated_at: string
          last_user_at: string | null
          lead: LeadData | null
          last_evaluation_at: string | null
          last_evaluation: EvaluationResult | null
        }>
      | null

    const one = rows?.[0]
    if (!one) return null

    const msgRows = (await supabaseRequest(
      `vic_messages?select=role,content,at&conversation_id=eq.${one.id}&order=at.asc`,
      { method: "GET" },
    )) as Array<{ role: "user" | "assistant"; content: string; at: string }> | null

    return {
      contact: one.contact,
      startedAt: one.started_at,
      updatedAt: one.updated_at,
      lastUserAt: one.last_user_at || undefined,
      messages: msgRows || [],
      lead: one.lead || undefined,
      lastEvaluationAt: one.last_evaluation_at || undefined,
      lastEvaluation: one.last_evaluation || undefined,
    }
  }

  const rows = (await supabaseRequest(
    "vic_conversations?select=contact,started_at,updated_at,last_user_at,lead,last_evaluation_at,last_evaluation&order=updated_at.desc&limit=100",
    { method: "GET" },
  )) as
    | Array<{
        contact: string
        started_at: string
        updated_at: string
        last_user_at: string | null
        lead: LeadData | null
        last_evaluation_at: string | null
        last_evaluation: EvaluationResult | null
      }>
    | null

  return (rows || []).map((row) => ({
    contact: row.contact,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    lastUserAt: row.last_user_at || undefined,
    messages: [],
    lead: row.lead || undefined,
    lastEvaluationAt: row.last_evaluation_at || undefined,
    lastEvaluation: row.last_evaluation || undefined,
  }))
}
