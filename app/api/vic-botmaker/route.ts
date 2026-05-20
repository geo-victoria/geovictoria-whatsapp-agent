import { NextResponse } from "next/server"
import { fetchConversationByContact, saveLead, updateLeadZohoId, upsertConversationSnapshot } from "@/lib/supabase-persistence"
import { bookMeeting, formatSlotsForProspect, getAvailableSlots, getSlotsByPreference, getTimezone, matchSlotFromMessage, parsePreferredTime } from "@/lib/calendar"
import { lookupZohoByPhone, sendZohoTemplateEmail, ZOHO_TEMPLATE_LEAD, ZOHO_TEMPLATE_DEAL } from "@/lib/zoho-lookup"

type ConversationMessage = { role: "user" | "assistant"; content: string; at: string }
type LeadData = {
  nombre?: string; empresa?: string; cargo?: string; email?: string; correo?: string
  telefono?: string; pais?: string; trabajadores?: string; necesidad?: string
  idioma?: string; reunion_agendada?: boolean | string; preferencia_horario?: string; meetingSlot?: string
}
type ConversationState = {
  contact: string; startedAt: string; updatedAt: string; lastUserAt?: string
  messages: ConversationMessage[]; lead?: LeadData; pendingSlots?: string[]
  isSupport?: boolean; firstResponseId?: string; isKnownClient?: boolean
  meetingBooked?: boolean; meetingBookingId?: string; zohoLeadId?: string; organizerEmail?: string
}

const globalStore = globalThis as unknown as {
  __vicConversations?: Map<string, ConversationState>
  __vicProcessing?: Set<string>
}
if (!globalStore.__vicConversations) globalStore.__vicConversations = new Map()
if (!globalStore.__vicProcessing) globalStore.__vicProcessing = new Set()
const conversations = globalStore.__vicConversations
const processing = globalStore.__vicProcessing

const MAX_INPUT_CHARS = 2000
const EMAIL_RE = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/
const INJECT_RE = /###|IGNORE|DUMP|INSTRUC|SYSTEM PROMPT|\bPROMPT\b|\\u202|<script|DROP\s+TABLE|DELETE\s+FROM|UNION\s+SELECT/i

function getEnv(name: string) { return (process.env[name] || "").trim() }
function isoNow() { return new Date().toISOString() }

async function sendTypingIndicator(contactId: string) {
  const token = getEnv("BOTMAKER_ACCESS_TOKEN")
  if (!token) return
  const channelId = "GeoVictoriaEspaol-whatsapp-56967308227"
  // Usar contactId sin el + para BotMaker
  const contact = contactId.replace(/^\+/, "")
  await fetch("https://api.botmaker.com/v2.0/chats-actions/send-read-typing-feedback", {
    method: "POST",
    headers: { "access-token": token, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ channelId, contactId: contact, typing: true }),
  }).catch(() => {})
}

async function callFirstResponseAgent(
  message: string,
  previousResponseId?: string
): Promise<{ reply: string; responseId: string; marker: "ESCALAR" | "END" | null }> {
  const apiKey = getEnv("FOUNDRY_API_KEY")
  const endpoint = "https://claude-product-design.services.ai.azure.com/api/projects/claude-product-design/openai/v1/responses"

  const body: Record<string, unknown> = {
    input: message,
    agent_reference: { name: "first-response-zoho", version: "14", type: "agent_reference" },
  }
  if (previousResponseId) body.previous_response_id = previousResponseId

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  })
  if (!res.ok) throw new Error(`Foundry error: ${res.status}`)

  const data = await res.json() as {
    id: string
    output: Array<{ type: string; content: Array<{ type: string; text: string }> }>
  }

  const rawReply = data.output
    ?.find(o => o.type === "message")
    ?.content?.find(c => c.type === "output_text")
    ?.text ?? ""

  let marker: "ESCALAR" | "END" | null = null
  let reply = rawReply
  if (rawReply.includes("[ESCALAR]")) { marker = "ESCALAR"; reply = rawReply.replace("[ESCALAR]", "").trim() }
  else if (rawReply.includes("[END]")) { marker = "END"; reply = rawReply.replace("[END]", "").trim() }

  return { reply, responseId: data.id, marker }
}

const ESCALAR_MSG = "Para esta consulta puedes contactar directamente a nuestro equipo de soporte:\n📲 WhatsApp: *+56 9 4401 3873*\n📧 Email: *soporte@geovictoria.com*\n📞 Teléfono: *228976512* o *228976517*\n¡Ellos te ayudarán de inmediato! 🙌"

async function sendWhatsAppText(to: string, text: string) {
  const token = getEnv("WHATSAPP_ACCESS_TOKEN")
  const phoneId = getEnv("WHATSAPP_PHONE_NUMBER_ID")
  if (!token || !phoneId) return
  await fetch(`https://graph.facebook.com/v22.0/${phoneId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { body: text },
    }),
  }).catch(() => {})
}
function formatPhone(from: string) { return `+${from.replace(/\D/g, "")}` }

function inferCountry(from: string): string {
  const d = from.replace(/\D/g, "")
  const prefixes: [string, string][] = [
    ["569", "Chile"], ["56", "Chile"], ["54", "Argentina"], ["57", "Colombia"],
    ["51", "Perú"], ["52", "México"], ["55", "Brasil"], ["593", "Ecuador"],
    ["591", "Bolivia"], ["595", "Paraguay"], ["598", "Uruguay"], ["58", "Venezuela"],
  ]
  for (const [p, c] of prefixes) if (d.startsWith(p)) return c
  return "Chile"
}

function sanitizeText(text: string, maxLen = 200) {
  return text.replace(/[^\x20-\x7EÀ-ɏ -ÿ]/g, " ").slice(0, maxLen).trim()
}

function validateLead(lead: LeadData): LeadData {
  const email = (lead.email || lead.correo || "").trim()
  return {
    ...lead,
    nombre: lead.nombre ? sanitizeText(lead.nombre, 100) : lead.nombre,
    empresa: lead.empresa ? sanitizeText(lead.empresa, 150) : lead.empresa,
    trabajadores: lead.trabajadores ? String(lead.trabajadores).replace(/\D/g, "").slice(0, 7) : lead.trabajadores,
    email: EMAIL_RE.test(email) ? email : "",
    correo: EMAIL_RE.test(email) ? email : "",
  }
}

function slotChoicePrompt(_count: number) {
  return "¿Alguna te viene bien, o prefieres que te contactemos directamente? 😊"
}

function extractLead(raw: string) {
  const match = raw.match(/LEAD_CAPTURED:(\{[\s\S]*?\})/m)
  if (!match) return { cleanReply: raw.trim(), lead: null }
  let lead: LeadData | null = null
  try { lead = JSON.parse(match[1]) } catch { lead = null }
  return { cleanReply: raw.replace(/LEAD_CAPTURED:(\{[\s\S]*?\})/m, "").trim(), lead }
}

function extractSlotMarker(raw: string) {
  const confirmed = raw.match(/SLOT_CONFIRMED:(\d)/m)
  const custom = raw.match(/SLOT_CUSTOM:([^\n]+)/m)
  const isSupport = /SUPPORT_CASE/m.test(raw)
  const clean = raw
    .replace(/SLOT_CONFIRMED:\d/gm, "")
    .replace(/SLOT_CUSTOM:[^\n]+/gm, "")
    .replace(/SUPPORT_CASE/gm, "")
    .trim()
  return {
    cleanReply: clean,
    slotConfirmed: confirmed ? parseInt(confirmed[1]) : null,
    slotCustom: custom ? custom[1].trim() : null,
    isSupport,
  }
}

function getConversation(contact: string): ConversationState {
  const existing = conversations.get(contact)
  if (existing) return existing
  const created: ConversationState = { contact, startedAt: isoNow(), updatedAt: isoNow(), messages: [] }
  conversations.set(contact, created)
  return created
}

function appendMessage(contact: string, role: "user" | "assistant", content: string) {
  const state = getConversation(contact)
  const at = isoNow()
  state.messages.push({ role, content, at })
  state.updatedAt = at
  if (role === "user") state.lastUserAt = at
  if (state.messages.length > 120) state.messages = state.messages.slice(-120)
  return state
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
        type: "lead_captured", contact: state.contact,
        lead: state.lead, conversation: state.messages,
        source: "whatsapp_botmaker_vic",
        ...(ownerEmail ? { ownerEmail } : {}),
      }),
      cache: "no-store",
    })
    if (res.ok) {
      const data = await res.json() as { leadId?: string }
      return data.leadId || null
    }
  } catch { /* silent */ }
  return null
}

async function callVicSalesAgent(
  request: Request,
  messages: ConversationMessage[],
  lead?: LeadData,
  extraContext?: string,
  contact?: string,
) {
  const endpoint = new URL("/api/vic-sales-agent", request.url)
  const contextParts: Array<{ role: "user" | "assistant"; content: string }> = []

  const leadFields = lead ? Object.entries({
    nombre: lead.nombre, empresa: lead.empresa, trabajadores: lead.trabajadores,
    email: lead.email || lead.correo, necesidad: lead.necesidad,
  }).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(", ") : ""

  if (leadFields) {
    contextParts.push({ role: "user", content: `[CONTEXTO INTERNO] Datos capturados: ${leadFields}. NO volver a pedir.` })
    contextParts.push({ role: "assistant", content: "Entendido." })
  }

  if (lead?.meetingSlot) {
    contextParts.push({ role: "user", content: `[REUNION_CONFIRMADA] Reunión agendada para el ${lead.meetingSlot}. Si quiere reagendar, mostrar nuevas opciones.` })
    contextParts.push({ role: "assistant", content: "Entendido." })
  } else if (leadFields && !lead?.meetingSlot) {
    // Prospecto recurrente con datos previos pero sin reunión activa
    contextParts.push({ role: "user", content: `[LEAD_PREVIO] Este prospecto ya nos había contactado. Salúdalo por nombre, confirma sus datos antes de continuar.` })
    contextParts.push({ role: "assistant", content: "Entendido." })
  }

  if (extraContext) {
    contextParts.push({ role: "user", content: extraContext })
    contextParts.push({ role: "assistant", content: "Entendido." })
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [...contextParts, ...messages.map((m) => ({ role: m.role, content: m.content }))],
      contact, lead,
    }),
    cache: "no-store",
  })

  if (!res.ok) throw new Error(`Error agente (${res.status})`)
  const payload = await res.json()
  return typeof payload?.message === "string" ? payload.message.trim() : ""
}

export async function POST(request: Request) {
  let lockedContact = ""
  try {
    const secret = request.headers.get("x-secret") || ""
    const expected = getEnv("BOTMAKER_SECRET")
    if (expected && secret !== expected) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const body = await request.json() as { contact?: string; message?: string }
    const contact = (body.contact || "").trim().replace(/\D/g, "")
    const message = (body.message || "").trim()

    if (!contact || !message) {
      return NextResponse.json({ reply: "Error: contact y message son requeridos.", handoff: false }, { status: 400 })
    }

    if (message.length > MAX_INPUT_CHARS || INJECT_RE.test(message)) {
      return NextResponse.json({ reply: "El formato del mensaje no es válido. ¿Me envías tus datos uno por uno?", handoff: false })
    }

    // Race condition guard: si ya hay un request en vuelo para este contacto, descartar silenciosamente
    if (processing.has(contact)) {
      return NextResponse.json({ reply: "" })
    }
    processing.add(contact)
    lockedContact = contact

    // Siempre recargar desde Supabase para garantizar estado fresco entre instancias
    try {
      const saved = await Promise.race([
        fetchConversationByContact(contact),
        new Promise<null>((_, reject) => setTimeout(() => reject(new Error("timeout")), 4000)),
      ])
      if (saved) {
        conversations.set(contact, saved)
        // Restaurar pendingSlots si hay lead con email pero sin reunión — se pierden en Supabase
        const lead = saved.lead as LeadData | undefined
        const hasEmail = !!(lead?.email || lead?.correo)
        if (hasEmail && !saved.meetingBooked && !lead?.meetingSlot && !saved.pendingSlots?.length) {
          const restoredSlots = await getAvailableSlots(lead?.pais || inferCountry(contact)).catch(() => [])
          if (restoredSlots.length) saved.pendingSlots = restoredSlots
        }
      } else {
        // Supabase no tiene registro → limpiar memoria también para garantizar estado fresco
        // Esto permite que el dedup corra correctamente aunque la instancia tenga estado viejo en RAM
        conversations.delete(contact)
      }
    } catch { /* continuar con lo que haya en memoria */ }

    const state = getConversation(contact)
    const phone = `+${contact}`

    // Deduplicación Zoho — solo en el primer mensaje del contacto (messages vacíos = primera vez ever)
    const isFirstMessage = state.messages.length === 0
    if (isFirstMessage && !state.zohoLeadId && !state.isKnownClient) {
      try {
        const lookup = await Promise.race([
          lookupZohoByPhone(contact),
          new Promise<Awaited<ReturnType<typeof lookupZohoByPhone>>>(
            (_, rej) => setTimeout(() => rej(new Error("timeout")), 5000)
          ),
        ])

        if (lookup.found && lookup.isActive && lookup.owner?.email) {
          // Casos 2, 3, 5: lead/deal activo con ejecutivo asignado → re-contacto
          state.zohoLeadId = lookup.recordId
          state.isKnownClient = true

          const firstName = lookup.prospectName?.split(" ")[0] || ""
          const greeting = firstName ? `¡${firstName}! 👋` : "¡Hola! 👋"
          const ownerLines: string[] = []
          if (lookup.owner.phone) ownerLines.push(`📞 *${lookup.owner.name}*: ${lookup.owner.phone}`)
          ownerLines.push(`📧 ${lookup.owner.email}`)
          const reContactMsg = `${greeting} Ya tienes un ejecutivo GeoVictoria asignado a tu cuenta:\n\n${ownerLines.join("\n")}\n\nPuedes escribirle directamente para coordinar los detalles. Mientras tanto, con gusto te cuento más sobre GeoVictoria, resuelvo tus dudas o te ayudo a preparar la conversación con él. ¿Qué necesitas? 😊`

          // Notificar al ejecutivo por email — fire-and-forget
          if (lookup.recordId && lookup.type) {
            const templateId = lookup.type === "deal" ? ZOHO_TEMPLATE_DEAL : ZOHO_TEMPLATE_LEAD
            sendZohoTemplateEmail(lookup.recordId, lookup.type, templateId).catch(() => {})
          }

          appendMessage(contact, "user", message)
          appendMessage(contact, "assistant", reContactMsg)
          await upsertConversationSnapshot(state)
          return NextResponse.json({ reply: reContactMsg })

        } else if (lookup.found && !lookup.isActive) {
          // Casos 4, 6: registro inactivo/ganado → flujo normal con datos pre-cargados
          if (lookup.isClient) state.isKnownClient = true
          if (lookup.prospectName || lookup.prospectEmail || lookup.empresa) {
            if (!state.lead) state.lead = {}
            if (lookup.prospectName && !state.lead.nombre) state.lead.nombre = lookup.prospectName
            if (lookup.prospectEmail && !(state.lead.email || state.lead.correo)) state.lead.email = lookup.prospectEmail
            if (lookup.empresa && !state.lead.empresa) state.lead.empresa = lookup.empresa
          }
          // Continuar al flujo normal de Vicky
        }
        // Caso 1: sin registro → flujo normal (no hacer nada)
      } catch { /* Zoho no disponible — continuar sin dedup */ }
    }

    // Ruta de soporte activa — derivar directo a Victoria (first-response agent)
    if (state.isSupport) {
      // Cambio de interés explícito — el usuario quiere conocer servicios/precios
      const wantsSales = /quiero conocer|me interesa el (producto|sistema|servicio)|cu[aá]nto cuesta|cu[aá]nto vale|precio|tarifa|cotiza|quiero comprar|quiero contratar/i.test(message)
      if (wantsSales) {
        state.isSupport = false
        state.firstResponseId = undefined
        state.isKnownClient = true
        // Continuar al flujo normal de Vicky (no retornar aquí)
      } else {
        const stateSupport = appendMessage(contact, "user", message)
        await sendTypingIndicator(phone)
        try {
          const { reply, responseId, marker } = await callFirstResponseAgent(message, state.firstResponseId)
          stateSupport.firstResponseId = responseId
          const replyText = marker === "ESCALAR" ? ESCALAR_MSG : reply

          if (marker === "END") {
            // Problema resuelto — liberar sesión y marcar como cliente conocido
            stateSupport.isSupport = false
            stateSupport.firstResponseId = undefined
            stateSupport.isKnownClient = true
          } else if (marker === "ESCALAR") {
            // Victoria no pudo — liberar sesión, fresh start si vuelve a preguntar
            stateSupport.isSupport = false
            stateSupport.firstResponseId = undefined
            stateSupport.isKnownClient = true
          }

          appendMessage(contact, "assistant", replyText)
          await upsertConversationSnapshot(stateSupport)
          return NextResponse.json({ reply: replyText })
        } catch {
          stateSupport.isSupport = false
          stateSupport.firstResponseId = undefined
          stateSupport.isKnownClient = true
          appendMessage(contact, "assistant", ESCALAR_MSG)
          await upsertConversationSnapshot(stateSupport)
          return NextResponse.json({ reply: ESCALAR_MSG })
        }
      }
    }

    // Anti-loop: detectar mensaje repetido consecutivo
    const recentMsgs = state.messages.slice(-6)
    const userRecentMsgs = recentMsgs.filter(m => m.role === "user")
    const sameCount = userRecentMsgs.filter(m => m.content.trim().toLowerCase() === message.trim().toLowerCase()).length
    if (sameCount >= 2) {
      // Mismo mensaje 2+ veces seguidas — devolver última respuesta del asistente sin llamar al LLM
      const lastAssistant = [...recentMsgs].reverse().find(m => m.role === "assistant")
      if (lastAssistant) return NextResponse.json({ reply: lastAssistant.content })
    }

    const stateAfterUser = appendMessage(contact, "user", message)
    const existingLead = stateAfterUser.lead
    const country = existingLead?.pais || inferCountry(contact)
    const hasLeadData = !!(existingLead?.email || existingLead?.correo)

    const wantsSlots = /horario|agenda|agendar|slot|reuni[oó]n|disponib|fecha|cu[aá]ndo|opcion|opción|reagend|otro d[ií]a|otra fecha|lunes|martes|mi[eé]rcoles|jueves|viernes|mañana|tarde/i.test(message)
    const alreadyHasSlots = (stateAfterUser.pendingSlots?.length ?? 0) > 0
    const hasCompleteData = hasLeadData && !!existingLead?.nombre && !!existingLead?.empresa
    const isAffirmative = /\bsi+\b|sí|ok\b|dale|claro|perfecto|quiero|agend|interesa|disponib/i.test(message)

    // Mostrar slots si quiere agenda explícitamente O si tiene datos completos y responde afirmativamente
    if (existingLead && hasLeadData && (wantsSlots || (hasCompleteData && isAffirmative)) && !alreadyHasSlots && !stateAfterUser.meetingBooked && !existingLead.meetingSlot) {
      const slots = await getAvailableSlots(country)
      stateAfterUser.pendingSlots = slots
      if (slots.length > 0) {
        const name = existingLead.nombre?.split(" ")[0] || ""
        const greeting = name ? `${name}, r` : "R"
        const reply = `${greeting}evisé la agenda y tengo estas opciones:\n\n${formatSlotsForProspect(slots, country)}\n\n${slotChoicePrompt(slots.length)}`
        appendMessage(contact, "assistant", reply)
        await upsertConversationSnapshot(stateAfterUser)
        return NextResponse.json({ reply, handoff: false })
      }
    }

    // Detectar selección de slot
    const pendingSlots = stateAfterUser.pendingSlots || []
    if (pendingSlots.length > 0) {
      if (stateAfterUser.meetingBooked) stateAfterUser.meetingBooked = false
    }
    if (pendingSlots.length > 0 && !stateAfterUser.meetingBooked) {
      const slotIndex = matchSlotFromMessage(message, pendingSlots, getTimezone(country))

      if (slotIndex) {
        const slot = pendingSlots[slotIndex - 1]
        const leadData = stateAfterUser.lead || {}
        const result = await bookMeeting({
          slotIso: slot,
          prospectName: leadData.nombre || "Prospecto",
          prospectEmail: leadData.email || leadData.correo || "",
          timeZone: getTimezone(country),
        })

        const reply = result.success
          ? `¡Perfecto! ✅ Reunión confirmada.\n\nRecibirás confirmación en ${leadData.email || leadData.correo} con el enlace.\n\n¡Nos vemos pronto! 😊`
          : `Tuve un problema al agendar. Un ejecutivo te contactará a ${leadData.email || leadData.correo} para confirmar.`

        if (result.success) {
          stateAfterUser.meetingBooked = true
          stateAfterUser.meetingBookingId = result.bookingId
          stateAfterUser.pendingSlots = []
          if (stateAfterUser.lead) stateAfterUser.lead.meetingSlot = slot

          const crmBase = getEnv("CRM_LEAD_WEBHOOK_URL")
          // Race condition fix: si el lead se creó en otra instancia, buscar el ID en Supabase
          let zohoLeadId = stateAfterUser.zohoLeadId
          if (!zohoLeadId) {
            try {
              const { fetchConversationByContact: fetchConv } = await import("@/lib/supabase-persistence")
              const fresh = await Promise.race([
                fetchConv(contact),
                new Promise<null>((_, rej) => setTimeout(() => rej(new Error("timeout")), 3000)),
              ])
              if (fresh?.zohoLeadId) {
                zohoLeadId = fresh.zohoLeadId
                stateAfterUser.zohoLeadId = zohoLeadId
              }
            } catch { /* continuar sin ID */ }
          }
          // Con creación diferida, zohoLeadId puede ser null — crear en Zoho ahora con owner correcto
          if (!zohoLeadId && stateAfterUser.lead) {
            const newLeadId = await pushLeadToCrm(stateAfterUser, result.organizerEmail || undefined)
            if (newLeadId) {
              zohoLeadId = newLeadId
              stateAfterUser.zohoLeadId = newLeadId
              updateLeadZohoId(contact, newLeadId).catch(() => {})
            }
          }
          if (result.organizerEmail) stateAfterUser.organizerEmail = result.organizerEmail
          if (result.organizerEmail && zohoLeadId) {
            fetch(crmBase.replace("/zoho-lead", "/zoho-owner"), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ leadId: zohoLeadId, ownerEmail: result.organizerEmail }),
              cache: "no-store",
            }).catch(() => {})
          }
          if (zohoLeadId) {
            const zohoMeetingUrl = crmBase.replace("/zoho-lead", "/zoho-meeting")
            fetch(zohoMeetingUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                leadId: zohoLeadId,
                slot,
                slotEnd: new Date(new Date(slot).getTime() + 20 * 60 * 1000).toISOString(),
                meetingUrl: result.meetingUrl,
                prospectName: leadData.nombre,
                prospectEmail: leadData.email || leadData.correo,
                prospectTimezone: getTimezone(country),
                hostEmail: result.organizerEmail || "onboarding@geovictoria.com",
                hostTimezone: "America/Santiago",
                empresa: leadData.empresa,
                trabajadores: leadData.trabajadores,
                necesidad: leadData.necesidad,
              }),
              cache: "no-store",
            }).catch(() => {})
          }
        }

        appendMessage(contact, "assistant", reply)
        await upsertConversationSnapshot(stateAfterUser)
        return NextResponse.json({ reply, handoff: false })
      }
    }

    // Si hay slots pendientes y el usuario expresa preferencia horaria diferente, buscar en Cal.com
    if (pendingSlots.length > 0 && !stateAfterUser.meetingBooked) {
      const preference = parsePreferredTime(message)
      if (preference) {
        await sendTypingIndicator(phone)
        await sendWhatsAppText(phone, "Dame un momento, reviso la agenda 📅")
        const newSlots = await getSlotsByPreference(preference.date, country, preference.hour).catch(() => [])
        if (newSlots.length > 0) {
          stateAfterUser.pendingSlots = newSlots
          const name = existingLead?.nombre?.split(" ")[0] || ""
          const intro = name ? `${name}, b` : "B"
          const reply = `${intro}usqué disponibilidad cerca de ese horario:\n\n${formatSlotsForProspect(newSlots, country)}\n\n¿Alguna te viene bien?`
          appendMessage(contact, "assistant", reply)
          await upsertConversationSnapshot(stateAfterUser)
          return NextResponse.json({ reply })
        }
      }
    }

    // Contexto de slots pendientes para el LLM
    let extraContext: string | undefined
    if (pendingSlots.length > 0 && !stateAfterUser.meetingBooked) {
      extraContext = `[SLOTS_DISPONIBLES — ya presentados]\n${formatSlotsForProspect(pendingSlots, country)}\n[/SLOTS_DISPONIBLES]`
    }
    // Cliente conocido — ya fue atendido por soporte, no preguntar si es cliente o prospecto
    if (stateAfterUser.isKnownClient) {
      const clienteCtx = `[CLIENTE_GEOVICTORIA] Este usuario ya es cliente activo de GeoVictoria. NO preguntes si es cliente. Salúdalo por nombre si lo tienes. Si pregunta por servicios o precios, ofrece agendar una reunión de 20 min con un ejecutivo.`
      extraContext = extraContext ? `${extraContext}\n${clienteCtx}` : clienteCtx
    }

    // Llamar a Vicky — mantener typing vivo durante la generación
    await sendTypingIndicator(phone)
    const typingInterval = setInterval(() => { sendTypingIndicator(phone) }, 2500)
    let rawReply = "Tuve un problema técnico momentáneo. ¿Podrías repetir tu mensaje?"
    try {
      rawReply = await callVicSalesAgent(request, stateAfterUser.messages.slice(-40), stateAfterUser.lead, extraContext, contact)
    } catch { /* silent */ } finally {
      clearInterval(typingInterval)
    }

    const { cleanReply: afterLead, lead } = extractLead(rawReply)
    const meetingDeclined = /MEETING_DECLINED/m.test(afterLead)
    const { cleanReply, slotConfirmed, slotCustom, isSupport } = extractSlotMarker(
      afterLead.replace(/MEETING_DECLINED/gm, "")
    )
    const finalReply = cleanReply || "Gracias por escribir."

    const stateAfterAssistant = appendMessage(contact, "assistant", finalReply)
    if (isSupport) {
      stateAfterAssistant.isSupport = true
      // Si el mensaje es vago (sin problema concreto), pedir contexto antes de llamar a Victoria
      const isVague = message.trim().split(/\s+/).length <= 6 &&
        /^(hola|necesito|quiero|busco|ayuda|soporte|comunicarme|hablar|contactar)/i.test(message.trim()) &&
        !/contrase|clave|reloj|marcaj|factura|usuario|ingresar|error|problema con|no puedo|no me|no funciona/i.test(message)
      if (isVague) {
        const clarifyMsg = "¿En qué podemos ayudarte? Cuéntame el problema con más detalle para orientarte mejor 😊"
        const msgs = stateAfterAssistant.messages
        if (msgs.length && msgs[msgs.length - 1].role === "assistant") msgs[msgs.length - 1].content = clarifyMsg
        await upsertConversationSnapshot(stateAfterAssistant)
        return NextResponse.json({ reply: clarifyMsg })
      }
      // Primera detección de soporte con contexto suficiente — llamar a Victoria
      try {
        const { reply: victoriaReply, responseId, marker } = await callFirstResponseAgent(message)
        stateAfterAssistant.firstResponseId = responseId
        const replyToSend = marker === "ESCALAR" ? ESCALAR_MSG : victoriaReply
        // END o ESCALAR en primer turno — liberar sesión y marcar cliente conocido
        if (marker === "END" || marker === "ESCALAR") {
          stateAfterAssistant.isSupport = false
          stateAfterAssistant.firstResponseId = undefined
          stateAfterAssistant.isKnownClient = true
        }
        // Reemplazar el último mensaje del asistente (el de Vicky) por el de Victoria
        const msgs = stateAfterAssistant.messages
        if (msgs.length && msgs[msgs.length - 1].role === "assistant") {
          msgs[msgs.length - 1].content = replyToSend
        }
        await upsertConversationSnapshot(stateAfterAssistant)
        return NextResponse.json({ reply: replyToSend })
      } catch {
        stateAfterAssistant.isSupport = false
        stateAfterAssistant.firstResponseId = undefined
        stateAfterAssistant.isKnownClient = true
        await upsertConversationSnapshot(stateAfterAssistant)
        return NextResponse.json({ reply: ESCALAR_MSG })
      }
    }

    // Procesar lead capturado — bloqueado para soporte
    if (lead && !stateAfterAssistant.isSupport) {
      const sanitized = validateLead(lead)
      sanitized.telefono = formatPhone(contact)
      sanitized.pais = inferCountry(contact)
      stateAfterAssistant.lead = sanitized
      // Guardar en Supabase — no enviar a Zoho aún.
      // El lead se crea en Zoho al confirmar el slot, cuando ya conocemos el host de Cal.com.
      await saveLead(stateAfterAssistant)

      const slots = await getAvailableSlots(sanitized.pais || "Chile")
      stateAfterAssistant.pendingSlots = slots
      if (slots.length > 0) {
        const name = sanitized.nombre?.split(" ")[0] || ""
        const empresa = sanitized.empresa ? ` en ${sanitized.empresa}` : ""
        const slotMsg = `¡Perfecto${name ? `, ${name}` : ""}! Registré tu información${empresa}.\n\nRevisé la agenda y tengo estas opciones para tu reunión de 20 min:\n\n${formatSlotsForProspect(slots, sanitized.pais || "Chile")}\n\n${slotChoicePrompt(slots.length)}`
        appendMessage(contact, "assistant", slotMsg)
        await upsertConversationSnapshot(stateAfterAssistant)
        return NextResponse.json({ reply: slotMsg })
      }
    }

    // Procesar slot confirmado por el LLM
    if (slotConfirmed && pendingSlots.length >= slotConfirmed && !stateAfterUser.meetingBooked) {
      const slot = pendingSlots[slotConfirmed - 1]
      const leadData = stateAfterAssistant.lead || {}
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
        if (stateAfterAssistant.lead) stateAfterAssistant.lead.meetingSlot = slot
        if (result.organizerEmail && stateAfterAssistant.zohoLeadId) {
          fetch(getEnv("CRM_LEAD_WEBHOOK_URL").replace("/zoho-lead", "/zoho-owner"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ leadId: stateAfterAssistant.zohoLeadId, ownerEmail: result.organizerEmail }),
            cache: "no-store",
          }).catch(() => {})
        }
      }
    }

    if (slotCustom && stateAfterAssistant.lead) {
      stateAfterAssistant.lead.preferencia_horario = slotCustom
    }

    // Prospecto declinó reunión — crear lead en Zoho inmediatamente con owner=Vicky
    if (meetingDeclined && stateAfterAssistant.lead && !stateAfterAssistant.zohoLeadId && !stateAfterAssistant.isSupport) {
      stateAfterAssistant.lead.reunion_agendada = false
      stateAfterAssistant.pendingSlots = []
      const newLeadId = await pushLeadToCrm(stateAfterAssistant)
      if (newLeadId) {
        stateAfterAssistant.zohoLeadId = newLeadId
        updateLeadZohoId(contact, newLeadId).catch(() => {})
      }
    }

    await upsertConversationSnapshot(stateAfterAssistant)

    return NextResponse.json({ reply: finalReply })

  } catch (error) {
    const msg = error instanceof Error ? error.message : "Error inesperado"
    console.error("[vic-botmaker]", msg)
    return NextResponse.json({ reply: "Tuve un problema técnico momentáneo. ¿Podrías repetir tu mensaje?" })
  } finally {
    if (lockedContact) processing.delete(lockedContact)
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { Allow: "OPTIONS, POST" } })
}
