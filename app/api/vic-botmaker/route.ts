import { NextResponse } from "next/server"
import { fetchConversationByContact, saveLead, upsertConversationSnapshot } from "@/lib/supabase-persistence"
import { bookMeeting, formatSlotsForProspect, getAvailableSlots, getTimezone, matchSlotFromMessage } from "@/lib/calendar"

type ConversationMessage = { role: "user" | "assistant"; content: string; at: string }
type LeadData = {
  nombre?: string; empresa?: string; cargo?: string; email?: string; correo?: string
  telefono?: string; pais?: string; trabajadores?: string; necesidad?: string
  idioma?: string; reunion_agendada?: boolean | string; preferencia_horario?: string; meetingSlot?: string
}
type UTMData = {
  utm_source?: string; utm_medium?: string; utm_campaign?: string
  utm_content?: string; utm_term?: string; gclid?: string; fbclid?: string; landing_page?: string
}
type ConversationState = {
  contact: string; startedAt: string; updatedAt: string; lastUserAt?: string
  messages: ConversationMessage[]; lead?: LeadData; pendingSlots?: string[]
  meetingBooked?: boolean; meetingBookingId?: string; zohoLeadId?: string; utm?: UTMData
}

const globalStore = globalThis as unknown as { __vicConversations?: Map<string, ConversationState> }
if (!globalStore.__vicConversations) globalStore.__vicConversations = new Map()
const conversations = globalStore.__vicConversations

const MAX_INPUT_CHARS = 2000
const EMAIL_RE = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/
const INJECT_RE = /###|IGNORE|DUMP|INSTRUC|SYSTEM PROMPT|\bPROMPT\b|\\u202|<script|DROP\s+TABLE|DELETE\s+FROM|UNION\s+SELECT/i

function getEnv(name: string) { return (process.env[name] || "").trim() }
function isoNow() { return new Date().toISOString() }
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

function slotChoicePrompt(count: number) {
  if (count === 1) return "¿Te viene bien? Responde *1* para confirmar 😊"
  if (count === 2) return "¿Cuál te viene mejor? Responde *1* o *2* 😊"
  return "¿Cuál te viene mejor? Responde *1*, *2* o *3* 😊"
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
  const handoff = /HANDOFF_REQUESTED/m.test(raw)
  const clean = raw
    .replace(/SLOT_CONFIRMED:\d/gm, "")
    .replace(/SLOT_CUSTOM:[^\n]+/gm, "")
    .replace(/HANDOFF_REQUESTED/gm, "")
    .trim()
  return {
    cleanReply: clean,
    slotConfirmed: confirmed ? parseInt(confirmed[1]) : null,
    slotCustom: custom ? custom[1].trim() : null,
    handoff,
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
        type: "lead_captured", contact: state.contact,
        lead: state.lead, conversation: state.messages,
        source: "whatsapp_botmaker_vic", utm: state.utm || null,
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
        conversations.delete(contact)
      }
    } catch { /* continuar con lo que haya en memoria */ }

    // Extraer UTMs del token [REF:...] si es el primer mensaje
    const state = getConversation(contact)
    if (!state.utm) {
      const refMatch = message.match(/\[REF:([A-Za-z0-9+/=]+)\]/)
      if (refMatch) {
        try {
          state.utm = JSON.parse(decodeURIComponent(escape(atob(refMatch[1])))) as UTMData
        } catch { /* ignorar */ }
      }
    }

    const stateAfterUser = appendMessage(contact, "user", message)
    const existingLead = stateAfterUser.lead
    const country = existingLead?.pais || inferCountry(contact)
    const hasLeadData = !!(existingLead?.email || existingLead?.correo)

    const wantsSlots = /horario|agenda|agendar|slot|reuni[oó]n|disponib|fecha|cu[aá]ndo|opcion|opción|reagend|otro d[ií]a|otra fecha|lunes|martes|mi[eé]rcoles|jueves|viernes|mañana|tarde/i.test(message)
    const alreadyHasSlots = (stateAfterUser.pendingSlots?.length ?? 0) > 0

    // Mostrar slots solo si no hay pendientes y no hay reunión ya confirmada
    if (existingLead && hasLeadData && wantsSlots && !alreadyHasSlots && !stateAfterUser.meetingBooked && !existingLead.meetingSlot) {
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

          if (result.organizerEmail && stateAfterUser.zohoLeadId) {
            fetch(getEnv("CRM_LEAD_WEBHOOK_URL").replace("/zoho-lead", "/zoho-owner"), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ leadId: stateAfterUser.zohoLeadId, ownerEmail: result.organizerEmail }),
              cache: "no-store",
            }).catch(() => {})
          }
        }

        appendMessage(contact, "assistant", reply)
        await upsertConversationSnapshot(stateAfterUser)
        return NextResponse.json({ reply, handoff: false })
      }
    }

    // Contexto de slots pendientes para el LLM
    let extraContext: string | undefined
    if (pendingSlots.length > 0 && !stateAfterUser.meetingBooked) {
      extraContext = `[SLOTS_DISPONIBLES — ya presentados]\n${formatSlotsForProspect(pendingSlots, country)}\n[/SLOTS_DISPONIBLES]`
    }

    // Llamar a Vicky
    let rawReply = "Tuve un problema técnico momentáneo. ¿Podrías repetir tu mensaje?"
    try {
      rawReply = await callVicSalesAgent(request, stateAfterUser.messages.slice(-40), stateAfterUser.lead, extraContext, contact)
    } catch { /* silent */ }

    const { cleanReply: afterLead, lead } = extractLead(rawReply)
    const { cleanReply, slotConfirmed, slotCustom, handoff } = extractSlotMarker(afterLead)
    const finalReply = cleanReply || "Gracias por escribir."

    const stateAfterAssistant = appendMessage(contact, "assistant", finalReply)

    // Procesar lead capturado
    if (lead) {
      const sanitized = validateLead(lead)
      sanitized.telefono = formatPhone(contact)
      sanitized.pais = inferCountry(contact)
      stateAfterAssistant.lead = sanitized
      const zohoLeadId = await pushLeadToCrm(stateAfterAssistant)
      if (zohoLeadId) stateAfterAssistant.zohoLeadId = zohoLeadId

      const slots = await getAvailableSlots(sanitized.pais || "Chile")
      stateAfterAssistant.pendingSlots = slots
      if (slots.length > 0) {
        const name = sanitized.nombre?.split(" ")[0] || ""
        const empresa = sanitized.empresa ? ` en ${sanitized.empresa}` : ""
        const slotMsg = `¡Perfecto${name ? `, ${name}` : ""}! Registré tu información${empresa}.\n\nRevisé la agenda y tengo estas opciones para tu reunión de 45 min:\n\n${formatSlotsForProspect(slots, sanitized.pais || "Chile")}\n\n${slotChoicePrompt(slots.length)}`
        appendMessage(contact, "assistant", slotMsg)
        await upsertConversationSnapshot(stateAfterAssistant)
        return NextResponse.json({ reply: `${finalReply}\n\n${slotMsg}`, handoff: false })
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

    await upsertConversationSnapshot(stateAfterAssistant)
    return NextResponse.json({ reply: finalReply, handoff })

  } catch (error) {
    const msg = error instanceof Error ? error.message : "Error inesperado"
    console.error("[vic-botmaker]", msg)
    return NextResponse.json({ reply: "Tuve un problema técnico. Un ejecutivo te contactará pronto.", handoff: true })
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { Allow: "OPTIONS, POST" } })
}
