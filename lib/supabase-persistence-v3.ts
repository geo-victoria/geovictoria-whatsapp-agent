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

// ── Puntero de negociación del preform (pref_escalon) ──────────────────
//
// El descuento del preform se negocia en un turno y se acepta en otro. Entre
// turnos solo persistimos texto, así que el `escalonActual` (el escalón que
// Vicky ofreció) se perdía y, al aceptar, el modelo pasaba un escalón viejo a
// generar_link_cotizadora → la cotización nacía con un descuento menor al
// acordado. Para evitarlo, guardamos el último escalón ofrecido por contacto:
// consultar_descuento_referencial lo escribe y generar_link_cotizadora lo
// consume. Se limpia al crear la cotización.
//
// Convención: pref_escalon usa la forma "siguiente índice" (= escalón + 1),
// idéntica a `escalonDescuento` de generar_link_cotizadora.

// Descartar negociaciones abandonadas: si el último escalón se ofreció hace
// más de esto, se ignora (el cliente probablemente arrancó una cotización
// nueva sin negociar).
const PREF_ESCALON_TTL_MS = 6 * 60 * 60 * 1000 // 6 horas

type PrefEscalonRow = { pref_escalon: number | null; pref_escalon_at: string | null }

/**
 * Lee el escalón negociado vigente para el contacto. Devuelve 0 si no hay,
 * si expiró, o si Supabase no está disponible (fallback no-op).
 */
export async function getPrefEscalon(contact: string): Promise<number> {
  if (!contact) return 0
  const rows = await supabaseFetch<PrefEscalonRow[]>(
    `vic_v3_conversations?contact=eq.${encodeURIComponent(contact)}&select=pref_escalon,pref_escalon_at&limit=1`,
  )
  if (!rows || rows.length === 0) return 0
  const { pref_escalon, pref_escalon_at } = rows[0]
  const value = Number(pref_escalon || 0)
  if (!Number.isFinite(value) || value <= 0) return 0
  if (pref_escalon_at) {
    const age = Date.now() - Date.parse(pref_escalon_at)
    if (Number.isFinite(age) && age > PREF_ESCALON_TTL_MS) return 0
  }
  return value
}

/**
 * Guarda el escalón ofrecido para el contacto. Crea la conversación si no
 * existía. Best-effort: si falla, no rompe el turno.
 */
export async function setPrefEscalon(contact: string, escalon: number): Promise<void> {
  if (!contact) return
  const value = Math.max(0, Number(escalon || 0))
  if (!value) return
  const conversationId = await getOrCreateConversationId(contact)
  if (!conversationId) return
  await supabaseFetch(`vic_v3_conversations?id=eq.${conversationId}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      pref_escalon: value,
      pref_escalon_at: new Date().toISOString(),
    }),
  })
}

/**
 * Limpia el escalón negociado del contacto (al crear la cotización formal o al
 * abandonar la negociación). Best-effort.
 */
export async function clearPrefEscalon(contact: string): Promise<void> {
  if (!contact) return
  const conv = await supabaseFetch<ConversationRow[]>(
    `vic_v3_conversations?contact=eq.${encodeURIComponent(contact)}&select=id&limit=1`,
  )
  if (!conv || conv.length === 0) return
  await supabaseFetch(`vic_v3_conversations?id=eq.${conv[0].id}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ pref_escalon: null, pref_escalon_at: null }),
  })
}
