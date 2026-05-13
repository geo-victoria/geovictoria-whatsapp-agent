import crypto from "node:crypto"

import { NextResponse } from "next/server"
import { fetchConversationByContact, saveEvaluation, saveLead, upsertConversationSnapshot } from "@/lib/supabase-persistence"
import { bookMeeting, formatSlotsForProspect, getAvailableSlots, getTimezone, matchSlotFromMessage } from "@/lib/calendar"

type MetaWebhookMessage = {
  id?: string
  from?: string
  type?: string
  text?: {
    body?: string
  }
}

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

type CustomerProfile = {
  dolores: string[]
  objeciones: string[]
  tono: string
  historial: string
}

type ConversationState = {
  contact: string
  startedAt: string
  updatedAt: string
  lastUserAt?: string
  messages: ConversationMessage[]
  lead?: LeadData
  lastEvaluationAt?: string
  lastEvaluation?: EvaluationResult
  customerProfile?: CustomerProfile
  pendingSlots?: string[]
  meetingBooked?: boolean
  meetingBookingId?: string
  zohoLeadId?: string
  zohoSessionId?: string
  sessionStartedAt?: string
  sessionNumber?: number
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

const globalStore = globalThis as unknown as {
  __vicConversations?: Map<string, ConversationState>
  __vicProcessedMsgIds?: Map<string, number>
}
if (!globalStore.__vicConversations) globalStore.__vicConversations = new Map()
if (!globalStore.__vicProcessedMsgIds) globalStore.__vicProcessedMsgIds = new Map()
const conversations = globalStore.__vicConversations
const processedMsgIds = globalStore.__vicProcessedMsgIds

const INACTIVITY_MINUTES = Number((process.env.CONVERSATION_INACTIVITY_MINUTES || "20").trim() || "20")
const MAX_INPUT_CHARS = 2000

function isDuplicate(msgId: string): boolean {
  if (!msgId) return false
  if (processedMsgIds.has(msgId)) return true
  processedMsgIds.set(msgId, Date.now())
  if (processedMsgIds.size > 5000) {
    const cutoff = Date.now() - 3600_000
    for (const [id, ts] of processedMsgIds) if (ts < cutoff) processedMsgIds.delete(id)
  }
  return false
}

const EMAIL_RE = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/
const INJECT_RE = /###|IGNORE|DUMP|INSTRUC|SYSTEM PROMPT|\bPROMPT\b|\\u202|<script|DROP\s+TABLE|DELETE\s+FROM|UNION\s+SELECT|INSERT\s+INTO|UPDATE\s+SET|;--|\/\*/i

function sanitizeText(text: string, maxLen = 200): string {
  return text.replace(/[^\x20-\x7EÀ-ɏ -ÿ]/g, " ").slice(0, maxLen).trim()
}

function validateAndSanitizeLead(lead: LeadData): LeadData {
  const email = (lead.email || lead.correo || "").trim()
  return {
    ...lead,
    nombre: lead.nombre ? sanitizeText(lead.nombre, 100) : lead.nombre,
    empresa: lead.empresa ? sanitizeText(lead.empresa, 150) : lead.empresa,
    trabajadores: lead.trabajadores ? String(lead.trabajadores).replace(/\D/g, "").slice(0, 7) : lead.trabajadores,
    email: EMAIL_RE.test(email) ? email : "",
    correo: EMAIL_RE.test(email) ? email : "",
    necesidad: lead.necesidad ? sanitizeText(lead.necesidad, 200) : lead.necesidad,
    preferencia_horario: lead.preferencia_horario ? sanitizeText(lead.preferencia_horario, 100) : lead.preferencia_horario,
  }
}

function containsInjection(text: string): boolean {
  return INJECT_RE.test(text) || text.length > MAX_INPUT_CHARS
}

function getEnv(name: string) {
  return (process.env[name] || "").trim()
}

function formatPhone(from: string): string {
  const digits = from.replace(/\D/g, "")
  return `+${digits}`
}

function inferCountry(from: string): string {
  const digits = from.replace(/\D/g, "")
  const prefixes: [string, string][] = [
    ["593", "Ecuador"], ["595", "Paraguay"], ["598", "Uruguay"],
    ["591", "Bolivia"], ["502", "Guatemala"], ["503", "El Salvador"],
    ["504", "Honduras"], ["505", "Nicaragua"], ["506", "Costa Rica"],
    ["507", "Panamá"], ["509", "Haití"], ["569", "Chile"], ["56", "Chile"],
    ["54", "Argentina"], ["55", "Brasil"], ["57", "Colombia"],
    ["51", "Perú"], ["52", "México"], ["58", "Venezuela"],
    ["34", "España"], ["44", "Reino Unido"], ["49", "Alemania"],
    ["33", "Francia"], ["39", "Italia"], ["1", "Estados Unidos"],
  ]
  for (const [prefix, country] of prefixes) {
    if (digits.startsWith(prefix)) return country
  }
  return ""
}

function isoNow() {
  return new Date().toISOString()
}

function slotChoicePrompt(count: number): string {
  if (count === 1) return "¿Te viene bien? Responde *1* para confirmar 😊"
  if (count === 2) return "¿Cuál te viene mejor? Responde *1* o *2* 😊"
  return "¿Cuál te viene mejor? Responde *1*, *2* o *3* 😊"
}

function safeCompare(a: string, b: string) {
  const aa = Buffer.from(a)
  const bb = Buffer.from(b)
  if (aa.length !== bb.length) return false
  return crypto.timingSafeEqual(aa, bb)
}

function verifyMetaSignature(rawBody: string, signatureHeader: string | null, appSecret: string) {
  if (!signatureHeader) return false
  const parts = signatureHeader.split("=")
  if (parts.length !== 2 || parts[0] !== "sha256") return false
  const expected = crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex")
  return safeCompare(parts[1], expected)
}

// Maps quick reply payloads to natural language Vicky understands
const BUTTON_PAYLOAD_MAP: Record<string, string> = {
  REENGAGEMENT_YES:   "Sí, me interesa coordinar una reunión",
  REENGAGEMENT_NO:    "No me interesa por ahora, gracias",
  NOSHOW_RESCHEDULE:  "Sí, quiero reagendar la reunión",
  NOSHOW_NO:          "No, gracias",
  REACTIVATION_YES:   "Sí, me gustaría retomar",
  REACTIVATION_NO:    "No gracias",
}

function extractInboundMessages(payload: any): (MetaWebhookMessage & { receiverPhoneId?: string })[] {
  const entries = Array.isArray(payload?.entry) ? payload.entry : []
  const result: (MetaWebhookMessage & { receiverPhoneId?: string })[] = []

  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : []
    for (const change of changes) {
      const value = change?.value
      const receiverPhoneId = value?.metadata?.phone_number_id as string | undefined
      const messages = Array.isArray(value?.messages) ? value.messages : []
      for (const message of messages) {
        const from = typeof message?.from === "string" ? message.from : ""
        if (!from) continue

        // Quick reply button tap (template buttons)
        let bodyText = typeof message?.text?.body === "string" ? message.text.body : ""
        let msgType = message?.type || "unknown"

        if (message?.type === "button") {
          const payload = message?.button?.payload as string | undefined
          const mapped = payload ? BUTTON_PAYLOAD_MAP[payload] : undefined
          bodyText = mapped || message?.button?.text || ""
          msgType = "text"
        } else if (message?.type === "interactive") {
          const btnPayload = message?.interactive?.button_reply?.id as string | undefined
          const mapped = btnPayload ? BUTTON_PAYLOAD_MAP[btnPayload] : undefined
          bodyText = mapped || message?.interactive?.button_reply?.title || ""
          msgType = "text"
        }

        result.push({
          id: typeof message?.id === "string" ? message.id : "",
          from,
          type: msgType,
          text: { body: bodyText },
          receiverPhoneId,
        })
      }
    }
  }

  return result
}

function getConversation(contact: string) {
  const current = conversations.get(contact)
  if (current) return current

  const created: ConversationState = {
    contact,
    startedAt: isoNow(),
    updatedAt: isoNow(),
    messages: [],
  }
  conversations.set(contact, created)
  return created
}

function appendMessage(contact: string, role: "user" | "assistant", content: string) {
  const state = getConversation(contact)
  const at = isoNow()
  state.messages.push({ role, content, at })
  state.updatedAt = at
  if (role === "user") {
    state.lastUserAt = at
  }

  if (state.messages.length > 120) {
    state.messages = state.messages.slice(-120)
  }

  return state
}

function extractSlotMarker(raw: string): {
  cleanReply: string
  slotConfirmed: number | null
  slotCustom: string | null
} {
  const confirmedMatch = raw.match(/SLOT_CONFIRMED:(\d)/m)
  const customMatch = raw.match(/SLOT_CUSTOM:([^\n]+)/m)
  let cleanReply = raw
    .replace(/SLOT_CONFIRMED:\d/gm, "")
    .replace(/SLOT_CUSTOM:[^\n]+/gm, "")
    .trim()
  return {
    cleanReply,
    slotConfirmed: confirmedMatch ? parseInt(confirmedMatch[1]) : null,
    slotCustom: customMatch ? customMatch[1].trim() : null,
  }
}

function extractLead(raw: string): { cleanReply: string; lead: LeadData | null } {
  const marker = /LEAD_CAPTURED:(\{[\s\S]*?\})/m
  const match = raw.match(marker)
  if (!match) {
    return { cleanReply: raw.trim(), lead: null }
  }

  let lead: LeadData | null = null
  try {
    lead = JSON.parse(match[1]) as LeadData
  } catch {
    lead = null
  }

  const cleanReply = raw.replace(marker, "").trim()
  return { cleanReply, lead }
}

function minutesSince(isoDate?: string) {
  if (!isoDate) return Number.MAX_SAFE_INTEGER
  const ms = Date.now() - new Date(isoDate).getTime()
  return Math.max(0, Math.floor(ms / 60000))
}

const EVALUATION_SYSTEM_PROMPT = `Eres un evaluador de calidad de conversaciones de ventas para GeoVictoria.

Analiza la conversación y devuelve ÚNICAMENTE un JSON válido con esta estructura exacta (sin texto adicional, sin backticks):
{
  "score_total": <número 0-100>,
  "dimensiones": {
    "conversion": <0-40, ¿se agendó reunión o se capturaron datos completos?>,
    "engagement": <0-30, ¿cuántos intercambios hubo? ¿fluidez?>,
    "calidad_info": <0-20, ¿qué tan completo quedó el lead (nombre, empresa, trabajadores, email)?>,
    "tono_experiencia": <0-10, ¿el cliente se fue bien o frustrado?>
  },
  "lead_capturado": <true/false>,
  "reunion_agendada": <true/false>,
  "punto_de_quiebre": "<en qué paso o mensaje bajó el interés, null si fue exitosa>",
  "resumen": "<2-3 oraciones describiendo cómo fue la conversación y qué mejorar>",
  "customer_profile": {
    "dolores": ["<necesidad o problema que mencionó>"],
    "objeciones": ["<objeción, duda o barrera que expresó>"],
    "tono": "<receptivo|neutral|desconfiado|frustrado>",
    "historial_sesion": "<1-2 oraciones: qué pasó en esta sesión, qué quedó pendiente>"
  }
}

Referencia de scores:
- 80-100: Excelente, lead completo y/o reunión agendada
- 50-79: Parcial, algunos datos capturados
- 20-49: Incompleto, cliente perdió interés
- 0-19: Cliente se aburrió, casi sin engagement`

async function evaluateConversation(state: ConversationState): Promise<{ evaluation: EvaluationResult; customerProfile: CustomerProfile | null }> {
  const turns = state.messages.slice(-20)
  const conversationText = turns
    .map((m) => `${m.role === "user" ? "PROSPECTO" : "VICKY"}: ${m.content}`)
    .join("\n\n")

  const apiKey = (process.env.ANTHROPIC_API_KEY || "").trim()
  const model = (process.env.ANTHROPIC_SALES_AGENT_MODEL || "").trim() || "claude-haiku-4-5-20251001"

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1200,
        system: EVALUATION_SYSTEM_PROMPT,
        messages: [{ role: "user", content: `Evalúa esta conversación:\n\n${conversationText}` }],
      }),
      cache: "no-store",
    })

    if (!response.ok) throw new Error(`Anthropic eval error (${response.status})`)

    const data = await response.json()
    const raw = (data?.content as Array<{ type: string; text: string }>)
      ?.filter((b) => b?.type === "text")
      .map((b) => b.text)
      .join("")
      .trim()

    const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim()) as EvaluationResult & { customer_profile?: { dolores: string[]; objeciones: string[]; tono: string; historial_sesion: string } }

    const newProfile = parsed.customer_profile
    let mergedProfile: CustomerProfile | null = null
    if (newProfile) {
      const prev = state.customerProfile
      const prevHistorial = prev?.historial ? `${prev.historial} | ` : ""
      const sessionDate = new Date().toLocaleDateString("es-CL", { day: "numeric", month: "short" })
      mergedProfile = {
        dolores: [...new Set([...(prev?.dolores || []), ...newProfile.dolores])],
        objeciones: [...new Set([...(prev?.objeciones || []), ...newProfile.objeciones])],
        tono: newProfile.tono,
        historial: `${prevHistorial}Sesión ${state.sessionNumber || 1} (${sessionDate}): ${newProfile.historial_sesion}`,
      }
    }

    const { customer_profile: _, ...evaluation } = parsed
    return { evaluation: evaluation as EvaluationResult, customerProfile: mergedProfile }
  } catch {
    const lead = state.lead || {}
    const hasEmail = Boolean(lead.email || lead.correo)
    const hasMeeting = lead.reunion_agendada === true || lead.agendar_reunion === "si"
    return {
      evaluation: {
        score_total: hasEmail && hasMeeting ? 80 : hasEmail ? 50 : 20,
        dimensiones: { conversion: hasEmail ? 25 : 10, engagement: 15, calidad_info: hasEmail ? 15 : 5, tono_experiencia: 7 },
        lead_capturado: hasEmail,
        reunion_agendada: Boolean(hasMeeting),
        punto_de_quiebre: null,
        resumen: "Evaluación automática (fallback por error en Claude).",
      },
      customerProfile: null,
    }
  }
}

async function postJsonIfConfigured(url: string, payload: unknown) {
  if (!url) return
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    cache: "no-store",
  })

  if (!response.ok) {
    const body = await response.text()
    console.error(
      `[vic] webhook upstream error (${response.status}) ${url}: ${body.slice(0, 500)}`,
    )
  }
}

async function persistConversationSnapshot(state: ConversationState) {
  await upsertConversationSnapshot(state)
  await postJsonIfConfigured(getEnv("CONVERSATION_WEBHOOK_URL"), {
    type: "conversation_snapshot",
    contact: state.contact,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    lead: state.lead || null,
    messages: state.messages,
  })
}

async function pushLeadToCrm(state: ConversationState, ownerEmail?: string): Promise<string | null> {
  if (!state.lead) return null
  await saveLead(state)
  const url = getEnv("CRM_LEAD_WEBHOOK_URL")
  if (!url) return null
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "lead_captured",
        contact: state.contact,
        lead: state.lead,
        conversation: state.messages,
        source: "whatsapp_agent_vic",
        ...(ownerEmail ? { ownerEmail } : {}),
      }),
      cache: "no-store",
    })
    if (res.ok) {
      const data = await res.json() as { leadId?: string }
      return data.leadId || null
    }
  } catch (err) {
    console.error("[vic] CRM push error:", err)
  }
  return null
}

async function pushEvaluation(state: ConversationState, evaluation: EvaluationResult) {
  await saveEvaluation(state, evaluation)
  await postJsonIfConfigured(getEnv("EVALUATION_WEBHOOK_URL"), {
    type: "conversation_evaluation",
    contact: state.contact,
    evaluation,
    recent_messages: state.messages.slice(-10),
    lead: state.lead || null,
  })
}

async function callVicSalesAgent(request: Request, messages: ConversationMessage[], lead?: LeadData, extraContext?: string, contact?: string, customerProfile?: CustomerProfile) {
  const endpoint = new URL("/api/vic-sales-agent", request.url)

  const leadFields = lead ? Object.entries({
    nombre: lead.nombre, empresa: lead.empresa, trabajadores: lead.trabajadores,
    email: lead.email || lead.correo, necesidad: lead.necesidad,
    reunion_agendada: lead.reunion_agendada, preferencia_horario: lead.preferencia_horario,
  }).filter(([, v]) => v !== undefined && v !== "" && v !== null).map(([k, v]) => `${k}: ${v}`).join(", ") : ""

  const contextParts: Array<{ role: "user" | "assistant"; content: string }> = []

  if (leadFields) {
    contextParts.push({ role: "user", content: `[CONTEXTO INTERNO — NO MENCIONAR AL USUARIO] Datos ya capturados: ${leadFields}. NO volver a pedir estos datos.` })
    contextParts.push({ role: "assistant", content: "Entendido, tengo esos datos registrados." })
  }

  if (lead?.meetingSlot) {
    let slotFormatted = lead.meetingSlot
    try {
      const d = new Date(lead.meetingSlot)
      const pad = (n: number) => String(n).padStart(2, "0")
      slotFormatted = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
    } catch { /* mantener el ISO original si falla */ }
    contextParts.push({ role: "user", content: `[REUNION_CONFIRMADA] Este prospecto ya tiene una reunión agendada para el ${slotFormatted}. Si pregunta por su reunión, confirmar la fecha. Si pide reagendar o pide horarios disponibles, mostrar nuevas opciones de disponibilidad.` })
    contextParts.push({ role: "assistant", content: "Entendido, la reunión ya está confirmada." })
  } else if (leadFields) {
    contextParts.push({ role: "user", content: `[LEAD_PREVIO] Este prospecto ya nos había contactado. Salúdalo por nombre, confirma sus datos antes de continuar.` })
    contextParts.push({ role: "assistant", content: "Entendido." })
  }

  if (customerProfile) {
    const profileLines = [
      `[PERFIL_CLIENTE]`,
      customerProfile.dolores.length ? `Dolores: ${customerProfile.dolores.join(", ")}` : "",
      customerProfile.objeciones.length ? `Objeciones previas: ${customerProfile.objeciones.join(", ")}` : "",
      `Tono habitual: ${customerProfile.tono}`,
      `Historial: ${customerProfile.historial}`,
    ].filter(Boolean).join("\n")
    contextParts.push({ role: "user", content: profileLines })
    contextParts.push({ role: "assistant", content: "Entendido, tengo el historial de este cliente." })
  }
  if (extraContext) {
    contextParts.push({ role: "user", content: extraContext })
    contextParts.push({ role: "assistant", content: "Entendido." })
  }

  const messagesWithContext = [
    ...contextParts,
    ...messages.map((m) => ({ role: m.role, content: m.content })),
  ]

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ messages: messagesWithContext, contact, lead }),
    cache: "no-store",
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Error agente Vic (${response.status}): ${body.slice(0, 500)}`)
  }

  const payload = await response.json()
  return typeof payload?.message === "string" ? payload.message.trim() : ""
}

// Zoho session creation removida del webhook — se hace en el cron de conciliación
// para no bloquear la respuesta al usuario

async function markAsRead(messageId: string) {
  if (!messageId) return
  const accessToken = getEnv("WHATSAPP_ACCESS_TOKEN")
  const phoneNumberId = getEnv("WHATSAPP_PHONE_NUMBER_ID")
  if (!accessToken || !phoneNumberId) return
  await fetch(`https://graph.facebook.com/v22.0/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: messageId }),
    cache: "no-store",
  }).catch(() => {})
}

async function sendTypingIndicator(to: string, delayMs = 0) {
  const accessToken = getEnv("WHATSAPP_ACCESS_TOKEN")
  const phoneNumberId = getEnv("WHATSAPP_PHONE_NUMBER_ID")
  if (!accessToken || !phoneNumberId) return
  await fetch(`https://graph.facebook.com/v22.0/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "typing_indicator",
      typing_indicator: { type: "text" },
    }),
    cache: "no-store",
  }).catch(() => {})
  if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs))
}

async function sendWhatsAppText(to: string, text: string) {
  const accessToken = getEnv("WHATSAPP_ACCESS_TOKEN")
  const phoneNumberId = getEnv("WHATSAPP_PHONE_NUMBER_ID")

  if (!accessToken || !phoneNumberId) {
    throw new Error("Faltan WHATSAPP_ACCESS_TOKEN o WHATSAPP_PHONE_NUMBER_ID")
  }

  const response = await fetch(`https://graph.facebook.com/v22.0/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: {
        body: text.slice(0, 4096),
      },
    }),
    cache: "no-store",
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Error WhatsApp API (${response.status}): ${body.slice(0, 500)}`)
  }
}

function scheduleInactivityEvaluation(contact: string) {
  setTimeout(async () => {
    const state = conversations.get(contact)
    if (!state) return

    const minutes = minutesSince(state.lastUserAt)
    if (minutes < INACTIVITY_MINUTES) return

    const lastEvalMinutes = minutesSince(state.lastEvaluationAt)
    if (lastEvalMinutes < INACTIVITY_MINUTES) return

    const { evaluation, customerProfile } = await evaluateConversation(state)
    state.lastEvaluationAt = isoNow()
    state.lastEvaluation = evaluation
    if (customerProfile) state.customerProfile = customerProfile
    await pushEvaluation(state, evaluation)
    await persistConversationSnapshot(state)

    const baseUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "https://geovictoria-whatsapp-agent.vercel.app"

    // Actualizar sesión en Zoho con score y transcripción al cierre
    if (state.zohoSessionId) {
      const transcript = state.messages
        .map(m => `[${m.role === "user" ? "Usuario" : "Vicky"}] ${m.content}`)
        .join("\n")
      const durationMs = state.lastUserAt
        ? new Date(state.lastUserAt).getTime() - new Date(state.sessionStartedAt || state.startedAt).getTime()
        : 0
      fetch(`${baseUrl}/api/crm/zoho-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update",
          sessionId: state.zohoSessionId,
          score: evaluation.score_total,
          transcript,
          durationSeconds: Math.round(durationMs / 1000),
          etapa: state.meetingBooked ? "reunion_agendada"
            : state.zohoLeadId ? "lead_capturado"
            : "sin_conversion",
        }),
        cache: "no-store",
      }).catch(() => {})
    }

  }, INACTIVITY_MINUTES * 60 * 1000)
}

export async function GET(request: Request) {
  const verifyToken = getEnv("WHATSAPP_VERIFY_TOKEN")
  const { searchParams } = new URL(request.url)
  const mode = searchParams.get("hub.mode") || ""
  const token = searchParams.get("hub.verify_token") || ""
  const challenge = searchParams.get("hub.challenge") || ""

  if (mode === "subscribe" && verifyToken && token === verifyToken) {
    return new NextResponse(challenge, { status: 200 })
  }

  return NextResponse.json({ success: false, error: "Verificacion fallida" }, { status: 403 })
}

async function processInboundMessages(payload: any, request: Request) {
  const inboundMessages = extractInboundMessages(payload)

  for (const incoming of inboundMessages) {
    const from = (incoming.from || "").trim()
    if (!from) continue

    // Deduplicación por message ID — previene doble procesamiento por retries de Meta
    const msgId = incoming.id || ""
    if (isDuplicate(msgId)) continue

    // Marcar mensaje como leído inmediatamente (muestra ticks azules)
    markAsRead(msgId).catch(() => {})

    if (incoming.type !== "text") {
      await sendTypingIndicator(from, 400)
      await sendWhatsAppText(from, "Solo proceso mensajes de texto. ¿En qué puedo ayudarte con GeoVictoria?")
      continue
    }

    const prompt = (incoming.text?.body || "").trim()
    if (!prompt) continue

    if (prompt.length > MAX_INPUT_CHARS) {
      await sendTypingIndicator(from, 500)
      await sendWhatsAppText(from, "Veo que tienes una operación compleja. Todo eso lo analiza el ejecutivo en una reunión personalizada. Dame tu nombre y email y te conecto.")
      continue
    }

    if (containsInjection(prompt)) {
      await sendTypingIndicator(from, 400)
      await sendWhatsAppText(from, "El formato del mensaje no es válido. ¿Me envías tus datos uno por uno?")
      continue
    }

    if (!conversations.has(from)) {
      try {
        const saved = await Promise.race([
          fetchConversationByContact(from),
          new Promise<null>((_, reject) => setTimeout(() => reject(new Error("supabase_timeout")), 4000)),
        ])
        if (saved) conversations.set(from, saved)
      } catch {
        // continuar sin historial si Supabase no responde
      }
    }

    // ── Detección de nueva sesión (6h de inactividad o primer contacto) ──
    const SESSION_GAP_MS = 6 * 60 * 60 * 1000
    const currentState = conversations.get(from)
    const lastActivity = currentState?.lastUserAt ? new Date(currentState.lastUserAt).getTime() : 0
    const isNewSession = !currentState?.sessionStartedAt || (Date.now() - lastActivity > SESSION_GAP_MS)
    let activeSessionStartedAt: string | undefined
    if (isNewSession) {
      activeSessionStartedAt = isoNow()
      const sessionNum = (currentState?.sessionNumber || 0) + 1
      if (currentState) {
        currentState.sessionStartedAt = activeSessionStartedAt
        currentState.sessionNumber = sessionNum
        currentState.zohoSessionId = undefined
      } else {
        const newState: ConversationState = {
          contact: from, startedAt: activeSessionStartedAt, updatedAt: activeSessionStartedAt,
          messages: [], sessionStartedAt: activeSessionStartedAt, sessionNumber: sessionNum,
        }
        conversations.set(from, newState)
      }
    } else {
      activeSessionStartedAt = currentState?.sessionStartedAt
    }

    const stateAfterUser = appendMessage(from, "user", prompt)

    // Persistir session_started_at directamente en Supabase si es sesión nueva
    if (isNewSession && activeSessionStartedAt) {
      const supabaseUrl = (process.env.SUPABASE_URL || "").trim()
      const supabaseKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
      if (supabaseUrl && supabaseKey) {
        const sessionNum = stateAfterUser.sessionNumber || 1
        try {
          await fetch(`${supabaseUrl}/rest/v1/vic_conversations?on_conflict=contact`, {
            method: "POST",
            headers: {
              apikey: supabaseKey,
              Authorization: `Bearer ${supabaseKey}`,
              "Content-Type": "application/json",
              Prefer: "resolution=merge-duplicates",
            },
            body: JSON.stringify([{
              contact: from,
              started_at: activeSessionStartedAt,
              updated_at: activeSessionStartedAt,
              session_started_at: activeSessionStartedAt,
              session_number: sessionNum,
              zoho_session_id: null,
              meeting_booked: false,
            }]),
            cache: "no-store",
          })
        } catch { /* fallo silencioso */ }
      }
    }

    // Si hay lead con reunion_agendada y piden horarios → mostrar slots directamente sin LLM
    const existingLead = stateAfterUser.lead
    const wantsSlots = /horario|agenda|agendar|slot|reuni[oó]n|disponib|fecha|cu[aá]ndo|opcion|opción|reagend|otro d[ií]a|otra fecha|otro horario|lunes|martes|mi[eé]rcoles|jueves|viernes|mañana|tarde/i.test(prompt)

    const hasLeadData = !!(existingLead?.email || existingLead?.correo)
    const alreadyHasSlots = (stateAfterUser.pendingSlots?.length ?? 0) > 0
    // Si el lead ya está completo (nombre + empresa + email) y el mensaje es afirmativo,
    // ir directo a slots sin pasar por el LLM — esto es el happy path del re-engagement
    const hasCompleteData = hasLeadData && !!existingLead?.nombre && !!existingLead?.empresa
    const isAffirmative = /\bsi+\b|sí|ok\b|dale|claro|perfecto|quiero|agend|interesa|disponib/i.test(prompt)
    if (existingLead && hasLeadData && (wantsSlots || (hasCompleteData && isAffirmative)) && !alreadyHasSlots && !stateAfterUser.meetingBooked && !existingLead.meetingSlot) {
      const country = existingLead.pais || inferCountry(from)
      // Siempre refrescar slots para evitar datos desactualizados
      const slots = await getAvailableSlots(country)
      stateAfterUser.pendingSlots = slots

      if (slots.length > 0) {
        const slotsText = formatSlotsForProspect(slots, country)
        const lead = stateAfterUser.lead
        const name = lead?.nombre?.split(" ")[0] || ""
        const greeting = name ? `${name}, r` : "R"
        const slotReply = `${greeting}evisé la agenda y tengo estas opciones disponibles:\n\n${slotsText}\n\n${slotChoicePrompt(slots.length)}`
        const stateWithSlots = appendMessage(from, "assistant", slotReply)
        await persistConversationSnapshot(stateWithSlots)
        scheduleInactivityEvaluation(from)
        await sendTypingIndicator(from, 700)
        await sendWhatsAppText(from, slotReply)
        continue
      }
    }

    // Detectar selección directa de slot desde el mensaje del usuario
    const pendingSlots = stateAfterUser.pendingSlots || []
    if (pendingSlots.length > 0) {
      // Permitir reagendamiento si ya tenía reunión
      if (stateAfterUser.meetingBooked) stateAfterUser.meetingBooked = false
    }
    if (pendingSlots.length > 0 && !stateAfterUser.meetingBooked) {
      const slotIndex = matchSlotFromMessage(prompt, pendingSlots, getTimezone(existingLead?.pais || inferCountry(from)))

      if (slotIndex) {
        const slot = pendingSlots[slotIndex - 1]
        const leadData = stateAfterUser.lead || {}
        const country = leadData.pais || inferCountry(from)
        const result = await bookMeeting({
          slotIso: slot,
          prospectName: leadData.nombre || "Prospecto",
          prospectEmail: leadData.email || leadData.correo || "",
          timeZone: getTimezone(country),
        })

        const slotLabel = formatSlotsForProspect([slot], leadData.pais || inferCountry(from))
        const meetingLine = result.meetingUrl
          ? `\n\n🔗 Enlace: ${result.meetingUrl}`
          : `\n\nRecibirás la confirmación en ${leadData.email || leadData.correo} con el enlace.`
        const confirmMsg = result.success
          ? `¡Perfecto! ✅ Reunión confirmada para el ${slotLabel}.${meetingLine}\n\n¡Nos vemos pronto! 😊`
          : `Tuve un problema al agendar. Un ejecutivo te contactará a ${leadData.email || leadData.correo} para confirmar el horario.`

        if (result.success) {
          stateAfterUser.meetingBooked = true
          stateAfterUser.meetingBookingId = result.bookingId
          stateAfterUser.pendingSlots = []
          if (stateAfterUser.lead) {
            stateAfterUser.lead.meetingSlot = slot
            stateAfterUser.lead.reunion_agendada = true
          }

          const organizerEmail = result.organizerEmail

          if (!stateAfterUser.zohoLeadId && stateAfterUser.lead) {
            // Re-engagement lead: create with correct owner immediately
            const newLeadId = await pushLeadToCrm(stateAfterUser, organizerEmail || undefined)
            if (newLeadId) stateAfterUser.zohoLeadId = newLeadId
          } else if (organizerEmail && stateAfterUser.zohoLeadId) {
            // Lead already exists: update owner to assigned host (fire-and-forget)
            const crmUrl = getEnv("CRM_LEAD_WEBHOOK_URL")
            fetch(crmUrl.replace("/zoho-lead", "/zoho-owner"), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                leadId: stateAfterUser.zohoLeadId,
                ownerEmail: organizerEmail,
              }),
              cache: "no-store",
            }).catch(() => {})
          }

          // Crear Meeting en Zoho CRM vinculado al lead
          const zohoMeetingUrl = getEnv("CRM_LEAD_WEBHOOK_URL").replace("/zoho-lead", "/zoho-meeting")
          const zohoLeadId = stateAfterUser.zohoLeadId
          if (zohoMeetingUrl && zohoLeadId) {
            const country = leadData.pais || inferCountry(from)
            fetch(zohoMeetingUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                leadId: zohoLeadId,
                slot,
                slotEnd: new Date(new Date(slot).getTime() + 45 * 60 * 1000).toISOString(),
                meetingUrl: result.meetingUrl,
                prospectName: leadData.nombre,
                prospectEmail: leadData.email || leadData.correo,
                prospectTimezone: getTimezone(country),
                hostEmail: organizerEmail || "onboarding@geovictoria.com",
                hostTimezone: "America/Santiago",
                empresa: leadData.empresa,
                trabajadores: leadData.trabajadores,
                necesidad: leadData.necesidad,
              }),
              cache: "no-store",
            }).catch(() => {})
          }
        }

        const stateConfirmed = appendMessage(from, "assistant", confirmMsg)
        await persistConversationSnapshot(stateConfirmed)
        scheduleInactivityEvaluation(from)
        await sendTypingIndicator(from, 600)
        await sendWhatsAppText(from, confirmMsg)
        continue
      }
    }

    // Inyectar slots pendientes como contexto si el usuario no seleccionó aún
    let extraContext: string | undefined
    if (pendingSlots.length > 0 && !stateAfterUser.meetingBooked) {
      const country = stateAfterUser.lead?.pais || inferCountry(from)
      const slotsText = formatSlotsForProspect(pendingSlots, country)
      extraContext = `[SLOTS_DISPONIBLES — ya presentados al prospecto]\n${slotsText}\n[/SLOTS_DISPONIBLES]`
    }

    await sendTypingIndicator(from)
    let rawReply = "Tuve un problema técnico momentáneo. ¿Podrías repetir tu mensaje?"
    try {
      rawReply = await callVicSalesAgent(request, stateAfterUser.messages.slice(-40), stateAfterUser.lead, extraContext, from, stateAfterUser.customerProfile)
    } catch {
      // error interno — no exponer al usuario
    }

    // Extraer marcadores de lead y de slot
    const { cleanReply: afterLead, lead } = extractLead(rawReply)
    const { cleanReply, slotConfirmed, slotCustom } = extractSlotMarker(afterLead)
    const finalReply = cleanReply || "Gracias por escribir."

    const stateAfterAssistant = appendMessage(from, "assistant", finalReply)

    // Procesar LEAD_CAPTURED
    if (lead) {
      const sanitized = validateAndSanitizeLead(lead)
      sanitized.telefono = formatPhone(from)
      sanitized.pais = inferCountry(from)
      stateAfterAssistant.lead = sanitized
      const country = sanitized.pais || inferCountry(from)

      // Crear lead inmediatamente con owner=Vicky
      // reunion_agendada indica la intención del usuario → el workflow de tómbola lo usa
      const [zohoLeadId, slots] = await Promise.all([
        pushLeadToCrm(stateAfterAssistant),
        getAvailableSlots(country),
      ])
      if (zohoLeadId) stateAfterAssistant.zohoLeadId = zohoLeadId
      stateAfterAssistant.pendingSlots = slots

      // Mostrar slots proactivamente
      if (slots.length > 0) {
        const name = sanitized.nombre?.split(" ")[0] || ""
        const empresa = sanitized.empresa ? ` en ${sanitized.empresa}` : ""
        const workers = sanitized.trabajadores ? ` (${sanitized.trabajadores} trabajadores)` : ""
        const slotsText = formatSlotsForProspect(slots, country)
        const slotMsg = `¡Perfecto${name ? `, ${name}` : ""}! Registré tu información${empresa}${workers}.\n\nRevisé la agenda y tengo estas opciones para tu reunión de 45 min:\n\n${slotsText}\n\n${slotChoicePrompt(slots.length)}`
        const stateWithSlots = appendMessage(from, "assistant", slotMsg)
        await persistConversationSnapshot(stateWithSlots)
        await sendTypingIndicator(from, 700)
        await sendWhatsAppText(from, slotMsg)
        scheduleInactivityEvaluation(from)
        return NextResponse.json({ success: true })
      }
    }

    // Procesar confirmación de slot
    if (slotConfirmed && pendingSlots.length >= slotConfirmed && !stateAfterUser.meetingBooked) {
      const slot = pendingSlots[slotConfirmed - 1]
      const leadData = stateAfterAssistant.lead || {}
      const country = leadData.pais || inferCountry(from)
      const result = await bookMeeting({
        slotIso: slot,
        prospectName: leadData.nombre || "Prospecto",
        prospectEmail: leadData.email || leadData.correo || "",
        timeZone: getTimezone(country),
      })
      if (result.success) {
        stateAfterAssistant.meetingBooked = true
        stateAfterAssistant.meetingBookingId = result.bookingId
        stateAfterAssistant.pendingSlots = []
        if (stateAfterAssistant.lead) {
          stateAfterAssistant.lead.meetingSlot = slot
          stateAfterAssistant.lead.reunion_agendada = true
        }

        const slotOrganizerEmail = result.organizerEmail

        if (!stateAfterAssistant.zohoLeadId && stateAfterAssistant.lead) {
          const newLeadId = await pushLeadToCrm(stateAfterAssistant, slotOrganizerEmail || undefined)
          if (newLeadId) stateAfterAssistant.zohoLeadId = newLeadId
        } else if (slotOrganizerEmail && stateAfterAssistant.zohoLeadId) {
          const crmUrl = getEnv("CRM_LEAD_WEBHOOK_URL")
          fetch(crmUrl.replace("/zoho-lead", "/zoho-owner"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ leadId: stateAfterAssistant.zohoLeadId, ownerEmail: slotOrganizerEmail }),
            cache: "no-store",
          }).catch(() => {})
        }

        // Crear Event en Zoho vinculado al lead
        const zohoLeadIdForEvent = stateAfterAssistant.zohoLeadId
        if (zohoLeadIdForEvent) {
          const crmUrl = getEnv("CRM_LEAD_WEBHOOK_URL")
          const leadData = stateAfterAssistant.lead || {}
          const country = leadData.pais || inferCountry(from)
          fetch(crmUrl.replace("/zoho-lead", "/zoho-meeting"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              leadId: zohoLeadIdForEvent,
              slot,
              slotEnd: new Date(new Date(slot).getTime() + 45 * 60 * 1000).toISOString(),
              meetingUrl: result.meetingUrl,
              prospectName: leadData.nombre,
              prospectEmail: leadData.email || leadData.correo,
              prospectTimezone: getTimezone(country),
              hostEmail: slotOrganizerEmail || "onboarding@geovictoria.com",
              hostTimezone: "America/Santiago",
              empresa: leadData.empresa,
              trabajadores: leadData.trabajadores,
              necesidad: leadData.necesidad,
            }),
            cache: "no-store",
          }).catch(() => {})
        }
      }
    }

    // Procesar horario propuesto por el prospecto (revisión manual)
    if (slotCustom && stateAfterAssistant.lead) {
      stateAfterAssistant.lead.preferencia_horario = slotCustom
    }

    await persistConversationSnapshot(stateAfterAssistant)

    scheduleInactivityEvaluation(from)
    try {
      await sendWhatsAppText(from, finalReply)
    } catch {
      // fallo silencioso — Meta reintentará
    }
  }
}

export async function POST(request: Request) {
  try {
    const rawBody = await request.text()
    const appSecret = getEnv("WHATSAPP_APP_SECRET")
    if (appSecret) {
      const signatureHeader = request.headers.get("x-hub-signature-256")
      const validSignature = verifyMetaSignature(rawBody, signatureHeader, appSecret)
      if (!validSignature) {
        return NextResponse.json({ success: false, error: "Firma invalida" }, { status: 401 })
      }
    }

    const payload = rawBody ? JSON.parse(rawBody) : {}

    // Procesamiento síncrono — fire-and-forget se termina en Vercel al retornar
    // El dedup por message ID previene doble procesamiento si Meta reintenta
    await processInboundMessages(payload, request)
    return NextResponse.json({ success: true })
  } catch {
    // H10/H14 — nunca exponer errores internos al usuario ni a Meta
    return NextResponse.json({ success: true })
  }
}
