/**
 * Persistencia de conversaciones V3 en Supabase.
 *
 * Aislado del archivo productivo `lib/supabase-persistence.ts`. Las tablas
 * `vic_v3_conversations` y `vic_v3_messages` son exclusivas del canal V3,
 * no se mezclan con la historia productiva de V1/V2.
 *
 * V3 mantiene todo el estado en el modelo + las tools. Por eso solo
 * persistimos:
 *   - Una fila por `contact` en vic_v3_conversations (timestamps).
 *   - El historial de mensajes en vic_v3_messages.
 */

import type { ConversationMessage } from "@/lib/agent-loop"

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()

const SUPABASE_HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
  Prefer: "return=representation",
}

type ConversationRow = { id: string }
type MessageRow = { role: "user" | "assistant"; content: string; at: string }

async function supabaseFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T | null> {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.warn("[v3-persist] SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY no configurados")
    return null
  }
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { ...SUPABASE_HEADERS, ...(init.headers || {}) },
    cache: "no-store",
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    console.error(`[v3-persist] Supabase ${res.status} on ${path}:`, body.slice(0, 300))
    return null
  }
  const ct = res.headers.get("content-type") || ""
  if (!ct.includes("application/json")) return null
  return (await res.json()) as T
}

/**
 * Obtiene o crea la conversación V3 del contacto. Si no existe, la crea.
 * Devuelve el UUID de la conversación.
 */
async function getOrCreateConversationId(contact: string): Promise<string | null> {
  const existing = await supabaseFetch<ConversationRow[]>(
    `vic_v3_conversations?contact=eq.${encodeURIComponent(contact)}&select=id&limit=1`,
  )
  if (existing && existing.length > 0) return existing[0].id

  const created = await supabaseFetch<ConversationRow[]>(
    `vic_v3_conversations`,
    {
      method: "POST",
      body: JSON.stringify({ contact }),
    },
  )
  return created && created.length > 0 ? created[0].id : null
}

/**
 * Carga el historial de mensajes V3 del contacto, ordenado cronológicamente.
 * Limita a los últimos N mensajes para controlar costos del modelo.
 */
export async function fetchHistoryV3(
  contact: string,
  limit = 40,
): Promise<ConversationMessage[]> {
  const conv = await supabaseFetch<ConversationRow[]>(
    `vic_v3_conversations?contact=eq.${encodeURIComponent(contact)}&select=id&limit=1`,
  )
  if (!conv || conv.length === 0) return []

  const conversationId = conv[0].id
  const messages = await supabaseFetch<MessageRow[]>(
    `vic_v3_messages?conversation_id=eq.${conversationId}&select=role,content,at&order=at.desc&limit=${limit}`,
  )
  if (!messages || messages.length === 0) return []

  return messages.reverse()
}

/**
 * Persiste un turno completo (mensaje del usuario + respuesta del asistente)
 * en las tablas V3. Crea la conversación si no existía.
 */
export async function appendTurnV3(
  contact: string,
  userMessage: string,
  assistantMessage: string,
): Promise<void> {
  const conversationId = await getOrCreateConversationId(contact)
  if (!conversationId) {
    console.error(`[v3-persist] No se pudo obtener/crear conversation_id para ${contact}`)
    return
  }

  const now = new Date().toISOString()
  const userAt = now
  const assistantAt = new Date(Date.parse(now) + 1).toISOString()

  await supabaseFetch(`vic_v3_messages`, {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify([
      { conversation_id: conversationId, role: "user", content: userMessage, at: userAt },
      { conversation_id: conversationId, role: "assistant", content: assistantMessage, at: assistantAt },
    ]),
  })

  await supabaseFetch(
    `vic_v3_conversations?id=eq.${conversationId}`,
    {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ updated_at: assistantAt, last_user_at: userAt }),
    },
  )
}

// ── Puntero del Borrador negociado en el preform (pref_*) ──────────────
//
// El descuento del preform se negocia en un turno y se acepta en otro. Entre
// turnos solo persistimos texto, así que el `escalonActual` (el escalón que
// Vicky ofreció) se perdía y, al aceptar, el modelo pasaba un escalón viejo a
// generar_link_cotizadora → la cotización nacía con un descuento menor al
// acordado.
//
// Para evitarlo persistimos por contacto, además del último escalón ofrecido
// (pref_escalon), los IDs del Borrador que la negociación creó en Zoho
// (pref_quote_id/deal/account/contact). Así:
//   - consultar_descuento_referencial crea/actualiza UN solo Borrador en Zoho
//     (reusando esos IDs entre turnos) con el escalón vigente.
//   - generar_link_cotizadora reusa ese Borrador para finalizarlo (PDF +
//     correo + "Enviada") en vez de crear una cotización nueva.
// Todo se limpia al finalizar la cotización (clearPrefDraft).
//
// Convención: pref_escalon usa la forma "siguiente índice" (= escalón + 1),
// idéntica a `escalonDescuento` de generar_link_cotizadora.

// Descartar negociaciones abandonadas: si el último escalón se ofreció hace
// más de esto, se ignora (el cliente probablemente arrancó una cotización
// nueva sin negociar).
const PREF_ESCALON_TTL_MS = 6 * 60 * 60 * 1000 // 6 horas

type PrefDraftRow = {
  pref_escalon: number | null
  pref_escalon_at: string | null
  pref_quote_id: string | null
  pref_deal_id: string | null
  pref_account_id: string | null
  pref_contact_id: string | null
}

export type PrefDraft = {
  escalon: number
  quoteId: string
  dealId: string
  accountId: string
  contactId: string
}

const EMPTY_PREF_DRAFT: PrefDraft = {
  escalon: 0,
  quoteId: "",
  dealId: "",
  accountId: "",
  contactId: "",
}

/**
 * Lee el Borrador negociado vigente para el contacto (escalón + IDs de Zoho).
 * Devuelve valores vacíos (escalon 0, IDs "") si no hay, si expiró el TTL, o si
 * Supabase no está disponible (fallback no-op).
 */
export async function getPrefDraft(contact: string): Promise<PrefDraft> {
  if (!contact) return { ...EMPTY_PREF_DRAFT }
  const rows = await supabaseFetch<PrefDraftRow[]>(
    `vic_v3_conversations?contact=eq.${encodeURIComponent(contact)}&select=pref_escalon,pref_escalon_at,pref_quote_id,pref_deal_id,pref_account_id,pref_contact_id&limit=1`,
  )
  if (!rows || rows.length === 0) return { ...EMPTY_PREF_DRAFT }
  const row = rows[0]
  // TTL: una negociación vieja se descarta por completo (escalón e IDs).
  if (row.pref_escalon_at) {
    const age = Date.now() - Date.parse(row.pref_escalon_at)
    if (Number.isFinite(age) && age > PREF_ESCALON_TTL_MS) return { ...EMPTY_PREF_DRAFT }
  }
  const escalon = Number(row.pref_escalon || 0)
  return {
    escalon: Number.isFinite(escalon) && escalon > 0 ? escalon : 0,
    quoteId: row.pref_quote_id || "",
    dealId: row.pref_deal_id || "",
    accountId: row.pref_account_id || "",
    contactId: row.pref_contact_id || "",
  }
}

/**
 * Lee solo el escalón negociado vigente (azúcar sobre getPrefDraft).
 */
export async function getPrefEscalon(contact: string): Promise<number> {
  return (await getPrefDraft(contact)).escalon
}

/**
 * Guarda/actualiza el Borrador negociado del contacto. Solo persiste los campos
 * provistos (los `undefined` se omiten). Refresca siempre pref_escalon_at para
 * mantener vivo el TTL. Crea la conversación si no existía. Best-effort.
 */
export async function setPrefDraft(
  contact: string,
  fields: {
    escalon?: number
    quoteId?: string
    dealId?: string
    accountId?: string
    contactId?: string
  },
): Promise<void> {
  if (!contact) return
  const conversationId = await getOrCreateConversationId(contact)
  if (!conversationId) return

  const patch: Record<string, unknown> = { pref_escalon_at: new Date().toISOString() }
  if (typeof fields.escalon === "number" && fields.escalon > 0) patch.pref_escalon = fields.escalon
  if (fields.quoteId) patch.pref_quote_id = fields.quoteId
  if (fields.dealId) patch.pref_deal_id = fields.dealId
  if (fields.accountId) patch.pref_account_id = fields.accountId
  if (fields.contactId) patch.pref_contact_id = fields.contactId

  await supabaseFetch(`vic_v3_conversations?id=eq.${conversationId}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(patch),
  })
}

/**
 * Limpia el Borrador negociado del contacto (al finalizar la cotización formal
 * o al abandonar la negociación): escalón + IDs del Borrador. Best-effort.
 */
export async function clearPrefDraft(contact: string): Promise<void> {
  if (!contact) return
  const conv = await supabaseFetch<ConversationRow[]>(
    `vic_v3_conversations?contact=eq.${encodeURIComponent(contact)}&select=id&limit=1`,
  )
  if (!conv || conv.length === 0) return
  await supabaseFetch(`vic_v3_conversations?id=eq.${conv[0].id}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      pref_escalon: null,
      pref_escalon_at: null,
      pref_quote_id: null,
      pref_deal_id: null,
      pref_account_id: null,
      pref_contact_id: null,
    }),
  })
}
