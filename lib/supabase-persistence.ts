type ConversationMessage = {
  role: "user" | "assistant"
  content: string
  at: string
}

type LeadData = {
  nombre?: string
  empresa?: string
  cargo?: string
  email?: string
  correo?: string
  telefono?: string
  pais?: string
  trabajadores?: string
  necesidad?: string
  idioma?: string
  reunion_agendada?: boolean | string
  agendar_reunion?: string
  preferencia_horario?: string
  meetingSlot?: string
}

type EvaluationResult = {
  score_total: number
  dimensiones: {
    conversion: number
    engagement: number
    calidad_info: number
    tono_experiencia: number
  }
  lead_capturado: boolean
  reunion_agendada: boolean
  punto_de_quiebre: string | null
  resumen: string
}

type CustomerProfile = {
  dolores: string[]
  objeciones: string[]
  tono: string
  historial: string
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
  customerProfile?: CustomerProfile
  zohoLeadId?: string
  meetingBooked?: boolean
  meetingBookingId?: string
  organizerEmail?: string
  pendingSlots?: string[]
  isSupport?: boolean
  firstResponseId?: string
  // Session tracking
  zohoSessionId?: string
  sessionStartedAt?: string
  sessionNumber?: number
}

function getEnv(name: string) {
  return (process.env[name] || "").trim()
}

function inferCountryFromPhone(contact: string): string {
  const d = contact.replace(/\D/g, "")
  const prefixes: [string, string][] = [
    ["569", "Chile"], ["56", "Chile"], ["54", "Argentina"], ["57", "Colombia"],
    ["51", "Perú"], ["52", "México"], ["55", "Brasil"], ["593", "Ecuador"],
    ["591", "Bolivia"], ["595", "Paraguay"], ["598", "Uruguay"], ["58", "Venezuela"],
  ]
  for (const [p, c] of prefixes) if (d.startsWith(p)) return c
  return "Chile"
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
    customer_profile: state.customerProfile || null,
    pending_slots: state.pendingSlots?.length ? state.pendingSlots : null,
    is_support: state.isSupport || false,
    first_response_id: state.firstResponseId || null,
    zoho_lead_id: state.zohoLeadId || null,
    meeting_booked: state.meetingBooked || false,
    meeting_booking_id: state.meetingBookingId || null,
    organizer_email: state.organizerEmail || null,
    zoho_session_id: state.zohoSessionId || null,
    session_started_at: state.sessionStartedAt || state.startedAt || null,
    session_number: state.sessionNumber || 1,
    pais: inferCountryFromPhone(state.contact),
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

export async function saveLead(state: ConversationState, zohoLeadId?: string) {
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
        ...(zohoLeadId ? { zoho_lead_id: zohoLeadId } : {}),
      },
    ]),
  })
}

export async function updateLeadZohoId(contact: string, zohoLeadId: string) {
  if (!isSupabaseConfigured()) return
  await supabaseRequest(
    `vic_leads?contact=eq.${encodeURIComponent(contact)}&zoho_lead_id=is.null&order=created_at.desc&limit=1`,
    {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ zoho_lead_id: zohoLeadId }),
    }
  )
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

export async function fetchConversationByContact(contact: string): Promise<ConversationState | null> {
  if (!isSupabaseConfigured()) return null

  const rows = (await supabaseRequest(
    `vic_conversations?select=id,contact,started_at,updated_at,last_user_at,lead,last_evaluation_at,last_evaluation,customer_profile,pending_slots,zoho_lead_id,meeting_booked,meeting_booking_id,organizer_email,zoho_session_id,session_started_at,session_number,is_support,first_response_id&contact=eq.${encodeURIComponent(contact)}&limit=1`,
    { method: "GET" },
  )) as Array<{
    id: string
    contact: string
    started_at: string
    updated_at: string
    last_user_at: string | null
    lead: LeadData | null
    last_evaluation_at: string | null
    last_evaluation: EvaluationResult | null
    customer_profile: CustomerProfile | null
    pending_slots: string[] | null
    zoho_lead_id: string | null
    meeting_booked: boolean | null
    meeting_booking_id: string | null
    organizer_email: string | null
    zoho_session_id: string | null
    session_started_at: string | null
    session_number: number | null
    is_support: boolean | null
    first_response_id: string | null
  }> | null

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
    customerProfile: one.customer_profile || undefined,
    pendingSlots: one.pending_slots?.length ? one.pending_slots : undefined,
    zohoLeadId: one.zoho_lead_id || undefined,
    meetingBooked: one.meeting_booked || undefined,
    meetingBookingId: one.meeting_booking_id || undefined,
    organizerEmail: one.organizer_email || undefined,
    zohoSessionId: one.zoho_session_id || undefined,
    sessionStartedAt: one.session_started_at || undefined,
    sessionNumber: one.session_number || undefined,
    isSupport: one.is_support || undefined,
    firstResponseId: one.first_response_id || undefined,
  }
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

    const one = rows?.[0] as any
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
      zohoLeadId: one.zoho_lead_id || undefined,
      meetingBooked: one.meeting_booked || undefined,
      meetingBookingId: one.meeting_booking_id || undefined,
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
