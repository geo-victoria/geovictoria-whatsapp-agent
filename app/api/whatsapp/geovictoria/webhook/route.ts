import crypto from "node:crypto"

import { NextResponse } from "next/server"
import { fetchConversationByContact, saveEvaluation, saveLead, upsertConversationSnapshot } from "@/lib/supabase-persistence"
import { bookMeeting, formatSlotsForProspect, getAvailableSlots, getTimezone } from "@/lib/calendar"

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
  pendingSlots?: string[]
  meetingBooked?: boolean
  meetingBookingId?: string
  zohoLeadId?: string
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

async function pushLeadToCrm(state: ConversationState): Promise<string | null> {
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

async function callVicSalesAgent(request: Request, messages: ConversationMessage[], lead?: LeadData, extraContext?: string) {
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

async function processInboundMessages(payload: any, request: Request) {
  const inboundMessages = extractInboundMessages(payload)

  for (const incoming of inboundMessages) {
    const from = (incoming.from || "").trim()
    if (!from) continue

    // Deduplicación por message ID — previene doble procesamiento por retries de Meta
    const msgId = incoming.id || ""
    if (isDuplicate(msgId)) continue

    if (incoming.type !== "text") {
      await sendWhatsAppText(from, "Solo proceso mensajes de texto. ¿En qué puedo ayudarte con GeoVictoria?")
      continue
    }

    const prompt = (incoming.text?.body || "").trim()
    if (!prompt) continue

    if (prompt.length > MAX_INPUT_CHARS) {
      await sendWhatsAppText(from, "Veo que tienes una operación compleja. Todo eso lo analiza el ejecutivo en una reunión personalizada. Dame tu nombre y email y te conecto.")
      continue
    }

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

    // Si hay lead con reunion_agendada y piden horarios → mostrar slots directamente sin LLM
    const existingLead = stateAfterUser.lead
    const wantsSlots = /horario|agenda|agendar|slot|reuni[oó]n|disponib|fecha|cu[aá]ndo/i.test(prompt)

    const hasLeadData = !!(existingLead?.email || existingLead?.correo)
    if (
      existingLead &&
      hasLeadData &&
      !stateAfterUser.meetingBooked &&
      wantsSlots
    ) {
      const country = existingLead.pais || inferCountry(from)
      // Siempre refrescar slots para evitar datos desactualizados
      const slots = await getAvailableSlots(country)
      stateAfterUser.pendingSlots = slots

      if (slots.length > 0) {
        const slotsText = formatSlotsForProspect(slots, country)
        const lead = stateAfterUser.lead
        const name = lead?.nombre?.split(" ")[0] || ""
        const greeting = name ? `${name}, r` : "R"
        const slotReply = `${greeting}evisé la agenda y tengo estas opciones disponibles:\n\n${slotsText}\n\n¿Cuál te viene mejor? Responde 1, 2 o 3 😊`
        const stateWithSlots = appendMessage(from, "assistant", slotReply)
        await persistConversationSnapshot(stateWithSlots)
        scheduleInactivityEvaluation(from)
        await sendWhatsAppText(from, slotReply)
        continue
      }
    }

    // Detectar selección directa de slot desde el mensaje del usuario
    const pendingSlots = stateAfterUser.pendingSlots || []
    if (pendingSlots.length > 0 && !stateAfterUser.meetingBooked) {
      const slotIndex =
        /\b1\b|primer[ao]|jueves|lunes|martes|miércoles|mi[eé]rcoles|viernes/.test(prompt) && pendingSlots[0] ? 1 :
        /\b2\b|segund[ao]/.test(prompt) && pendingSlots[1] ? 2 :
        /\b3\b|tercer[ao]/.test(prompt) && pendingSlots[2] ? 3 : null

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

        const confirmMsg = result.success
          ? `¡Perfecto! ✅ Reunión confirmada.\n\nRecibirás un email de confirmación en ${leadData.email || leadData.correo} con el enlace y todos los detalles.\n\n¡Nos vemos pronto! 😊`
          : `Tuve un problema al agendar. Un ejecutivo te contactará a ${leadData.email || leadData.correo} para confirmar el horario.`

        if (result.success) {
          stateAfterUser.meetingBooked = true
          stateAfterUser.meetingBookingId = result.bookingId
          stateAfterUser.pendingSlots = []

          // Crear Meeting en Zoho CRM vinculado al lead
          const zohoMeetingUrl = getEnv("CRM_LEAD_WEBHOOK_URL").replace("/zoho-lead", "/zoho-meeting")
          if (zohoMeetingUrl && stateAfterUser.zohoLeadId) {
            fetch(zohoMeetingUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                leadId: stateAfterUser.zohoLeadId,
                slot: slot,
                meetingUrl: result.meetingUrl,
                prospectName: leadData.nombre,
                prospectEmail: leadData.email || leadData.correo,
              }),
              cache: "no-store",
            }).catch(() => {})
          }
        }

        const stateConfirmed = appendMessage(from, "assistant", confirmMsg)
        await persistConversationSnapshot(stateConfirmed)
        scheduleInactivityEvaluation(from)
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

    let rawReply = "Tuve un problema técnico momentáneo. ¿Podrías repetir tu mensaje?"
    try {
      rawReply = await callVicSalesAgent(request, stateAfterUser.messages.slice(-40), stateAfterUser.lead, extraContext)
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
      const zohoLeadId = await pushLeadToCrm(stateAfterAssistant)
      if (zohoLeadId) stateAfterAssistant.zohoLeadId = zohoLeadId

      // Siempre buscar slots al capturar lead — mostrarlos proactivamente
      const country = sanitized.pais || inferCountry(from)
      const slots = await getAvailableSlots(country)
      stateAfterAssistant.pendingSlots = slots

      // Enviar slots proactivamente en mensaje separado
      if (slots.length > 0) {
        const name = sanitized.nombre?.split(" ")[0] || ""
        const greeting = name ? `${name}, r` : "R"
        const slotsText = formatSlotsForProspect(slots, country)
        const slotMsg = `${greeting}evisé la agenda y tengo estas opciones disponibles:\n\n${slotsText}\n\n¿Cuál te viene mejor? Responde 1, 2 o 3 😊`
        const stateWithSlots = appendMessage(from, "assistant", slotMsg)
        await persistConversationSnapshot(stateWithSlots)
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
      }
    }

    // Procesar horario propuesto por el prospecto (revisión manual)
    if (slotCustom && stateAfterAssistant.lead) {
      stateAfterAssistant.lead.preferencia_horario = slotCustom
    }

    await persistConversationSnapshot(stateAfterAssistant)
    scheduleInactivityEvaluation(from)
    await sendWhatsAppText(from, finalReply)
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
