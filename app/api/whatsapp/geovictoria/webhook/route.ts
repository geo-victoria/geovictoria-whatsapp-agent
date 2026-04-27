import crypto from "node:crypto"

import { NextResponse } from "next/server"
import { saveEvaluation, saveLead, upsertConversationSnapshot } from "@/lib/supabase-persistence"

type MetaWebhookMessage = {
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
  correo?: string
  telefono?: string
  pais?: string
  trabajadores?: string
  necesidad?: string
  idioma?: string
  agendar_reunion?: string
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

const globalStore = globalThis as unknown as { __vicConversations?: Map<string, ConversationState> }
if (!globalStore.__vicConversations) {
  globalStore.__vicConversations = new Map<string, ConversationState>()
}
const conversations = globalStore.__vicConversations

const INACTIVITY_MINUTES = Number((process.env.CONVERSATION_INACTIVITY_MINUTES || "20").trim() || "20")

function getEnv(name: string) {
  return (process.env[name] || "").trim()
}

function isoNow() {
  return new Date().toISOString()
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

function extractInboundTextMessages(payload: any): MetaWebhookMessage[] {
  const entries = Array.isArray(payload?.entry) ? payload.entry : []
  const result: MetaWebhookMessage[] = []

  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : []
    for (const change of changes) {
      const value = change?.value
      const messages = Array.isArray(value?.messages) ? value.messages : []
      for (const message of messages) {
        if (message?.type !== "text") continue
        result.push({
          from: typeof message?.from === "string" ? message.from : "",
          type: message.type,
          text: {
            body: typeof message?.text?.body === "string" ? message.text.body : "",
          },
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

function evaluateConversation(state: ConversationState): EvaluationResult {
  // PDF rule: evaluate last 10 interactions.
  const turns = state.messages.slice(-10)
  const userTurns = turns.filter((m) => m.role === "user")
  const assistantTurns = turns.filter((m) => m.role === "assistant")

  const lead = state.lead || {}
  const required = [lead.nombre, lead.empresa, lead.cargo, lead.correo, lead.telefono].filter(Boolean).length
  const completeLead = required === 5
  const meetingSignal = /agendar|reunion|meeting/i.test(turns.map((t) => t.content).join(" "))

  // 0-40: objective achievement (lead + meeting).
  const conversion = Math.min(40, (completeLead ? 25 : required * 5) + (meetingSignal ? 15 : 0))

  // 0-30: message exchange + fluidity.
  const alternation = Math.min(userTurns.length, assistantTurns.length)
  const engagement = Math.min(30, alternation * 4 + Math.min(10, userTurns.length * 2))

  // 0-20: PDF mentions quality by name/company/role/email.
  const qualityFields = [lead.nombre, lead.empresa, lead.cargo, lead.correo].filter(Boolean).length
  const calidadInfo = Math.min(20, qualityFields * 5)

  const joined = turns.map((t) => t.content.toLowerCase()).join(" ")
  const frustration = /no sirve|malo|molesto|frustr|chao|adios/i.test(joined)
  const tono = frustration ? 3 : 10

  const score = Math.max(0, Math.min(100, conversion + engagement + calidadInfo + tono))

  let diagnostico = "Conversacion activa o parcial sin abandono claro."
  if (score < 50) {
    if (!lead.correo) diagnostico = "El usuario dejo de responder al pedir el correo electronico."
    else if (!lead.telefono) diagnostico = "El usuario dejo de responder al pedir el telefono."
    else if (/precio|cost/i.test(joined)) diagnostico = "El cliente pregunto por precio y se enfrio antes de agendar."
    else if (turns.length <= 2) diagnostico = "Solo hubo 2 mensajes antes del abandono."
    else diagnostico = "Hubo bajo intercambio y el lead quedo incompleto."
  }

  const tramo: EvaluationResult["tramo"] =
    score >= 80 ? "80-100" : score >= 50 ? "50-79" : score >= 20 ? "20-49" : "0-19"

  return {
    score_total: score,
    conversion,
    engagement,
    calidad_info: calidadInfo,
    tono_experiencia: tono,
    diagnostico_abandono: diagnostico,
    tramo,
    analizadas: turns.length,
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

async function pushLeadToCrm(state: ConversationState) {
  if (!state.lead) return
  await saveLead(state)
  await postJsonIfConfigured(getEnv("CRM_LEAD_WEBHOOK_URL"), {
    type: "lead_captured",
    contact: state.contact,
    lead: state.lead,
    conversation: state.messages,
    source: "whatsapp_agent_vic",
  })
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

async function callVicSalesAgent(request: Request, messages: ConversationMessage[]) {
  const endpoint = new URL("/api/vic-sales-agent", request.url)
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    }),
    cache: "no-store",
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Error agente Vic (${response.status}): ${body.slice(0, 500)}`)
  }

  const payload = await response.json()
  return typeof payload?.message === "string" ? payload.message.trim() : ""
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

    const evaluation = evaluateConversation(state)
    state.lastEvaluationAt = isoNow()
    state.lastEvaluation = evaluation
    await pushEvaluation(state, evaluation)
    await persistConversationSnapshot(state)
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
    const inboundMessages = extractInboundTextMessages(payload)

    for (const incoming of inboundMessages) {
      const from = (incoming.from || "").trim()
      const prompt = (incoming.text?.body || "").trim()
      if (!from || !prompt) continue

      const stateBefore = getConversation(from)
      if (minutesSince(stateBefore.lastUserAt) >= INACTIVITY_MINUTES && stateBefore.messages.length > 0) {
        const evalBefore = evaluateConversation(stateBefore)
        stateBefore.lastEvaluationAt = isoNow()
        stateBefore.lastEvaluation = evalBefore
        await pushEvaluation(stateBefore, evalBefore)
      }

      const stateAfterUser = appendMessage(from, "user", prompt)

      let rawReply = "Recibi tu mensaje. En breve te ayudo."
      try {
        rawReply = await callVicSalesAgent(request, stateAfterUser.messages.slice(-40))
      } catch (error) {
        const messageText = error instanceof Error ? error.message : "Error inesperado"
        rawReply = `No pude procesar tu solicitud ahora (${messageText}).`
      }

      const { cleanReply, lead } = extractLead(rawReply)
      const finalReply = cleanReply || "Gracias por escribir."

      const stateAfterAssistant = appendMessage(from, "assistant", finalReply)
      if (lead) {
        stateAfterAssistant.lead = lead
        await pushLeadToCrm(stateAfterAssistant)
      }

      await persistConversationSnapshot(stateAfterAssistant)
      scheduleInactivityEvaluation(from)
      await sendWhatsAppText(from, finalReply)
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error inesperado"
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
