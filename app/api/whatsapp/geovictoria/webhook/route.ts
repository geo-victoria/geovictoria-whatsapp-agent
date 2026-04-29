import crypto from "node:crypto"

import { NextResponse } from "next/server"
import { fetchConversationByContact, saveEvaluation, saveLead, upsertConversationSnapshot } from "@/lib/supabase-persistence"

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
const INJECT_RE = /###|IGNORE|DUMP|INSTRUC|SYSTEM PROMPT|\bPROMPT\b|\\u202|<script/i

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

function extractInboundMessages(payload: any): MetaWebhookMessage[] {
  const entries = Array.isArray(payload?.entry) ? payload.entry : []
  const result: MetaWebhookMessage[] = []

  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : []
    for (const change of changes) {
      const value = change?.value
      const messages = Array.isArray(value?.messages) ? value.messages : []
      for (const message of messages) {
        const from = typeof message?.from === "string" ? message.from : ""
        if (!from) continue
        result.push({
          id: typeof message?.id === "string" ? message.id : "",
          from,
          type: message?.type || "unknown",
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
  "resumen": "<2-3 oraciones describiendo cómo fue la conversación y qué mejorar>"
}

Referencia de scores:
- 80-100: Excelente, lead completo y/o reunión agendada
- 50-79: Parcial, algunos datos capturados
- 20-49: Incompleto, cliente perdió interés
- 0-19: Cliente se aburrió, casi sin engagement`

async function evaluateConversation(state: ConversationState): Promise<EvaluationResult> {
  const turns = state.messages.slice(-10)
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
        max_tokens: 800,
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

    const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim()) as EvaluationResult
    return parsed
  } catch {
    const lead = state.lead || {}
    const hasEmail = Boolean(lead.email || lead.correo)
    const hasMeeting = lead.reunion_agendada === true || lead.agendar_reunion === "si"
    return {
      score_total: hasEmail && hasMeeting ? 80 : hasEmail ? 50 : 20,
      dimensiones: { conversion: hasEmail ? 25 : 10, engagement: 15, calidad_info: hasEmail ? 15 : 5, tono_experiencia: 7 },
      lead_capturado: hasEmail,
      reunion_agendada: Boolean(hasMeeting),
      punto_de_quiebre: null,
      resumen: "Evaluación automática (fallback por error en Claude).",
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

async function pushLeadToCrm(state: ConversationState) {
  if (!state.lead) return
  await saveLead(state)
  const url = getEnv("CRM_LEAD_WEBHOOK_URL")
  if (!url) return
  // Fire-and-forget: don't block the WhatsApp response waiting for Zoho
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "lead_captured",
      contact: state.contact,
      lead: state.lead,
      conversation: state.messages,
      source: "whatsapp_agent_vic",
    }),
    cache: "no-store",
  }).catch((err) => console.error("[vic] CRM push error:", err))
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

async function callVicSalesAgent(request: Request, messages: ConversationMessage[], lead?: LeadData) {
  const endpoint = new URL("/api/vic-sales-agent", request.url)

  const leadFields = lead ? Object.entries({
    nombre: lead.nombre, empresa: lead.empresa, trabajadores: lead.trabajadores,
    email: lead.email || lead.correo, necesidad: lead.necesidad,
    reunion_agendada: lead.reunion_agendada, preferencia_horario: lead.preferencia_horario,
  }).filter(([, v]) => v !== undefined && v !== "" && v !== null).map(([k, v]) => `${k}: ${v}`).join(", ") : ""

  const contextMessage = leadFields
    ? `[CONTEXTO INTERNO — NO MENCIONAR AL USUARIO] Datos ya capturados en esta conversación: ${leadFields}. NO volver a pedir estos datos.`
    : ""

  const messagesWithContext = contextMessage
    ? [{ role: "user" as const, content: contextMessage }, { role: "assistant" as const, content: "Entendido, tengo esos datos registrados." }, ...messages.map((m) => ({ role: m.role, content: m.content }))]
    : messages.map((m) => ({ role: m.role, content: m.content }))

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ messages: messagesWithContext }),
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

    const evaluation = await evaluateConversation(state)
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
    const inboundMessages = extractInboundMessages(payload)

    for (const incoming of inboundMessages) {
      const from = (incoming.from || "").trim()
      if (!from) continue

      // H11 — deduplicación por message ID
      const msgId = (incoming as any).id || ""
      if (isDuplicate(msgId)) continue

      if (incoming.type !== "text") {
        await sendWhatsAppText(from, "Solo proceso mensajes de texto. ¿En qué puedo ayudarte con GeoVictoria?")
        continue
      }

      const prompt = (incoming.text?.body || "").trim()
      if (!prompt) continue

      // H11/H14 — límite de longitud de input
      if (prompt.length > MAX_INPUT_CHARS) {
        await sendWhatsAppText(from, "Veo que tienes una operación compleja. Todo eso lo analiza el ejecutivo en una reunión personalizada. Dame tu nombre y email y te conecto.")
        continue
      }

      // H07/H08 — detección de inyección: respuesta neutra sin detallar qué se detectó
      if (containsInjection(prompt)) {
        await sendWhatsAppText(from, "El formato del mensaje no es válido. ¿Me envías tus datos uno por uno?")
        continue
      }

      if (!conversations.has(from)) {
        const saved = await fetchConversationByContact(from)
        if (saved) conversations.set(from, saved)
      }

      const stateBefore = getConversation(from)
      if (minutesSince(stateBefore.lastUserAt) >= INACTIVITY_MINUTES && stateBefore.messages.length > 0) {
        const evalBefore = await evaluateConversation(stateBefore)
        stateBefore.lastEvaluationAt = isoNow()
        stateBefore.lastEvaluation = evalBefore
        await pushEvaluation(stateBefore, evalBefore)
      }

      const stateAfterUser = appendMessage(from, "user", prompt)

      // H10/H14 — error handling genérico: nunca exponer detalles técnicos al usuario
      let rawReply = "Tuve un problema técnico momentáneo. ¿Podrías repetir tu mensaje?"
      try {
        rawReply = await callVicSalesAgent(request, stateAfterUser.messages.slice(-40), stateAfterUser.lead)
      } catch {
        // error interno — no exponer al usuario
      }

      const { cleanReply, lead } = extractLead(rawReply)
      const finalReply = cleanReply || "Gracias por escribir."

      const stateAfterAssistant = appendMessage(from, "assistant", finalReply)
      if (lead) {
        // H07 — sanitizar y validar datos antes de persistir en CRM
        const sanitized = validateAndSanitizeLead(lead)
        sanitized.telefono = formatPhone(from)
        sanitized.pais = inferCountry(from)
        stateAfterAssistant.lead = sanitized
        await pushLeadToCrm(stateAfterAssistant)
      }

      await persistConversationSnapshot(stateAfterAssistant)
      scheduleInactivityEvaluation(from)
      await sendWhatsAppText(from, finalReply)
    }

    return NextResponse.json({ success: true })
  } catch {
    // H10/H14 — nunca exponer errores internos al usuario ni a Meta
    return NextResponse.json({ success: true })
  }
}
