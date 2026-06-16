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
  pref_params: PrefParams | null
}

// Parámetros de la opción negociada (los mismos que se pasan a
// generar_link_cotizadora). Se anclan al ofrecer un descuento para que la
// cotización formal se finalice sobre la MISMA opción negociada.
export type PrefParams = {
  userCount?: number
  modulos?: string[]
  hardware?: Array<{ id: string; cantidad?: number; modalidad?: "arriendo" | "venta" }>
  puntosInstalacion?: Array<{ ubicacion: string; autoInstalada: boolean }>
}

export type PrefDraft = {
  escalon: number
  quoteId: string
  dealId: string
  accountId: string
  contactId: string
  params: PrefParams | null
}

const EMPTY_PREF_DRAFT: PrefDraft = {
  escalon: 0,
  quoteId: "",
  dealId: "",
  accountId: "",
  contactId: "",
  params: null,
}

/**
 * Lee el Borrador negociado vigente para el contacto (escalón + IDs de Zoho).
 * Devuelve valores vacíos (escalon 0, IDs "") si no hay, si expiró el TTL, o si
 * Supabase no está disponible (fallback no-op).
 */
export async function getPrefDraft(contact: string): Promise<PrefDraft> {
  if (!contact) return { ...EMPTY_PREF_DRAFT }
  const rows = await supabaseFetch<PrefDraftRow[]>(
    `vic_v3_conversations?contact=eq.${encodeURIComponent(contact)}&select=pref_escalon,pref_escalon_at,pref_quote_id,pref_deal_id,pref_account_id,pref_contact_id,pref_params&limit=1`,
  )
  if (!rows || rows.length === 0) return { ...EMPTY_PREF_DRAFT }
  const row = rows[0]
  // TTL: una negociación vieja se descarta por completo (escalón, IDs y params).
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
    params: row.pref_params && typeof row.pref_params === "object" ? row.pref_params : null,
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
    params?: PrefParams | null
  },
): Promise<void> {
  if (!contact) return
  const conversationId = await getOrCreateConversationId(contact)
  if (!conversationId) return

  const patch: Record<string, unknown> = { pref_escalon_at: new Date().toISOString() }
  if (typeof fields.escalon === "number" && fields.escalon > 0) {
    // Monotonicidad: el escalón negociado NUNCA retrocede. Si el modelo reinició
    // la negociación en un escalón menor (p. ej. tras un loop de muletilla en el
    // tope), no degradamos el valor ya alcanzado — esa degradación era la causa
    // raíz de que un 30% aceptado terminara persistido como 20%.
    const actual = await getPrefEscalon(contact).catch(() => 0)
    patch.pref_escalon = Math.max(actual, fields.escalon)
  }
  if (fields.quoteId) patch.pref_quote_id = fields.quoteId
  if (fields.dealId) patch.pref_deal_id = fields.dealId
  if (fields.accountId) patch.pref_account_id = fields.accountId
  if (fields.contactId) patch.pref_contact_id = fields.contactId
  // Anclar los parámetros de la opción negociada (la última que se negoció): al
  // finalizar, la cotización formal se genera sobre ESTA opción y no sobre la que
  // el modelo reconstruya en el turno de cierre (causa del "PDF de otra opción").
  if (fields.params && typeof fields.params === "object") {
    patch.pref_params = fields.params
  }

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
      pref_params: null,
    }),
  })
}

// ── Cotización formal vigente (acotamiento de la negociación) ────────────────
//
// Política: apenas existe una cotización FORMAL en la conversación, toda
// negociación de descuento va por el camino post-formal sobre ese quote_id
// (consultar_siguiente_descuento / aplicar_siguiente_descuento). La negociación
// preform (consultar_descuento_referencial) queda BLOQUEADA mientras la formal
// esté vigente — un % negociado en preform con formal viva no aterriza en
// ninguna cotización y se pierde (bug real visto en los tests multi-opción).

// Vigencia del bloqueo: alineada con la ventana de contratación más larga de
// la escalera (24h). Pasado esto, el cliente probablemente arranca de cero.
const FORMAL_QUOTE_TTL_MS = 24 * 60 * 60 * 1000

type FormalQuoteRow = {
  formal_quote_id: string | null
  formal_quote_at: string | null
}

/**
 * Registra la cotización formal vigente del contacto (al generarla, y se
 * refresca cuando se le aplica un descuento post-formal). Best-effort.
 */
export async function setFormalQuote(contact: string, quoteId: string): Promise<void> {
  if (!contact || !quoteId) return
  const conversationId = await getOrCreateConversationId(contact)
  if (!conversationId) return
  await supabaseFetch(`vic_v3_conversations?id=eq.${conversationId}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      formal_quote_id: quoteId,
      formal_quote_at: new Date().toISOString(),
    }),
  })
}

/**
 * Devuelve el quote_id de la cotización formal vigente del contacto, o "" si
 * no hay, si expiró el TTL, o si Supabase no está disponible.
 */
export async function getFormalQuote(contact: string): Promise<string> {
  if (!contact) return ""
  const rows = await supabaseFetch<FormalQuoteRow[]>(
    `vic_v3_conversations?contact=eq.${encodeURIComponent(contact)}&select=formal_quote_id,formal_quote_at&limit=1`,
  )
  if (!rows || rows.length === 0) return ""
  const row = rows[0]
  if (!row.formal_quote_id) return ""
  if (row.formal_quote_at) {
    const age = Date.now() - Date.parse(row.formal_quote_at)
    if (Number.isFinite(age) && age > FORMAL_QUOTE_TTL_MS) return ""
  }
  return row.formal_quote_id
}

// ── Item B: puntero durable a la cotización existente (anti-amnesia) ────────
//
// Vive en vic_v3_quote_pointers, tabla SEPARADA de vic_v3_conversations, para
// sobrevivir al borrado de historial. Permite que Vicky reconozca que el
// contacto YA tiene una cotización formal y la retome (reenviar link, negociar
// sobre ella) en vez de pedir datos de nuevo o generar otra — el bug de
// amnesia de Rodrigo. A diferencia de getFormalQuote, NO tiene TTL: la
// cotización vive su propia vigencia en Zoho / en el token de aceptación.

export type QuotePointer = {
  quoteId: string
  dealId: string
  acceptanceUrl: string
  pdfUrl: string
  totalClp: number | null
  totalUf: number | null
  updatedAt: string
}

type QuotePointerRow = {
  quote_id: string | null
  deal_id: string | null
  acceptance_url: string | null
  pdf_url: string | null
  total_clp: number | null
  total_uf: number | null
  updated_at: string | null
}

/**
 * Registra/actualiza el puntero durable a la última cotización formal del
 * contacto. Best-effort (nunca rompe el flujo). Upsert por `contact` (PK).
 */
export async function setQuotePointer(
  contact: string,
  data: {
    quoteId: string
    dealId?: string
    acceptanceUrl?: string
    pdfUrl?: string
    totalClp?: number
    totalUf?: number
  },
): Promise<void> {
  if (!contact || !data.quoteId) return
  const body = {
    contact,
    quote_id: data.quoteId,
    deal_id: data.dealId ?? null,
    acceptance_url: data.acceptanceUrl ?? null,
    pdf_url: data.pdfUrl ?? null,
    total_clp: typeof data.totalClp === "number" ? data.totalClp : null,
    total_uf: typeof data.totalUf === "number" ? data.totalUf : null,
    updated_at: new Date().toISOString(),
  }
  await supabaseFetch(`vic_v3_quote_pointers?on_conflict=contact`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(body),
  })
}

/**
 * Devuelve el puntero durable de la cotización del contacto, o null si no hay.
 */
export async function getQuotePointer(contact: string): Promise<QuotePointer | null> {
  if (!contact) return null
  const rows = await supabaseFetch<QuotePointerRow[]>(
    `vic_v3_quote_pointers?contact=eq.${encodeURIComponent(contact)}&select=quote_id,deal_id,acceptance_url,pdf_url,total_clp,total_uf,updated_at&limit=1`,
  )
  if (!rows || rows.length === 0) return null
  const r = rows[0]
  if (!r.quote_id) return null
  return {
    quoteId: r.quote_id,
    dealId: r.deal_id || "",
    acceptanceUrl: r.acceptance_url || "",
    pdfUrl: r.pdf_url || "",
    totalClp: r.total_clp,
    totalUf: r.total_uf,
    updatedAt: r.updated_at || "",
  }
}

// ── Re-engagement (item 5): seguimiento por inactividad del cliente ─────────
//
// Estados de followup_status:
//   null       → la conversación nunca mostró intención comercial.
//   "activo"   → la pelota está en el cliente; los timers corren.
//   "pausado"  → es comercial, pero el cliente respondió (o aún no respondemos):
//                se re-arma cuando Vicky entrega su próxima respuesta real.
//   "cerrado"  → ciclo terminado (respondió y cerró, opt-out, derivado, agotado).
//
// Cadencia (espejo de vic_v3_claim_followups en SQL): 3 toques a ~1h, ~1 día y
// ~3 días. `silence_anchor_at` = momento en que Vicky respondió y quedó
// esperando; los toques de push NO lo mueven (si lo movieran, la cadencia nunca
// avanzaría).

const FOLLOWUP_FIRST_OFFSET_MS = 60 * 60 * 1000 // primer toque: +1 h

type FollowupStateRow = {
  id: string
  followup_status: string | null
}

/** Estado actual del followup del contacto (status o null si no hay fila). */
export async function getFollowupStatus(contact: string): Promise<string | null> {
  if (!contact) return null
  const rows = await supabaseFetch<FollowupStateRow[]>(
    `vic_v3_conversations?contact=eq.${encodeURIComponent(contact)}&select=id,followup_status&limit=1`,
  )
  if (!rows || rows.length === 0) return null
  return rows[0].followup_status
}

/**
 * Marca actividad del cliente: actualiza last_user_at y, si había un ciclo
 * activo, lo pausa (el cliente respondió → se cancela la cadencia en curso;
 * se re-armará cuando Vicky conteste). Best-effort.
 */
export async function markUserActivity(contact: string): Promise<void> {
  if (!contact) return
  const conversationId = await getOrCreateConversationId(contact)
  if (!conversationId) return
  await supabaseFetch(`vic_v3_conversations?id=eq.${conversationId}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ last_user_at: new Date().toISOString() }),
  })
  // Pausar SOLO si estaba activo (no resucitar cerrados ni tocar null).
  await supabaseFetch(
    `vic_v3_conversations?id=eq.${conversationId}&followup_status=eq.activo`,
    {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        followup_status: "pausado",
        followup_next_at: null,
        followup_stage: 0,
      }),
    },
  )
}

/**
 * Arma (o re-arma) el ciclo de seguimiento: Vicky acaba de responder y la
 * pelota queda en el cliente. Resetea la cadencia desde ahora. Best-effort.
 */
export async function armFollowup(contact: string): Promise<void> {
  if (!contact) return
  const conversationId = await getOrCreateConversationId(contact)
  if (!conversationId) return
  const now = new Date()
  await supabaseFetch(`vic_v3_conversations?id=eq.${conversationId}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      followup_status: "activo",
      silence_anchor_at: now.toISOString(),
      followup_stage: 0,
      followup_attempts: 0,
      followup_next_at: new Date(now.getTime() + FOLLOWUP_FIRST_OFFSET_MS).toISOString(),
      followup_closed_reason: null,
    }),
  })
}

/** Cierra el ciclo definitivamente (opt_out, derivado, agotado, respondio). */
export async function closeFollowup(contact: string, reason: string): Promise<void> {
  if (!contact) return
  const conversationId = await getOrCreateConversationId(contact)
  if (!conversationId) return
  await supabaseFetch(`vic_v3_conversations?id=eq.${conversationId}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      followup_status: "cerrado",
      followup_next_at: null,
      followup_closed_reason: reason,
    }),
  })
}

/**
 * Persiste un toque de re-engagement como mensaje del asistente (para que el
 * próximo turno de Vicky tenga el contexto), SIN tocar silence_anchor_at ni
 * last_user_at (el push no reinicia la cadencia).
 */
export async function appendAssistantV3(contact: string, content: string): Promise<void> {
  if (!contact || !content) return
  const conversationId = await getOrCreateConversationId(contact)
  if (!conversationId) return
  await supabaseFetch(`vic_v3_messages`, {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      conversation_id: conversationId,
      role: "assistant",
      content,
      at: new Date().toISOString(),
    }),
  })
  await supabaseFetch(`vic_v3_conversations?id=eq.${conversationId}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ updated_at: new Date().toISOString() }),
  })
}

// ── Lado del cron de re-engagement ───────────────────────────────────────────

export type FollowupClaim = {
  conversation_id: string
  contact: string
  stage: number
}

/**
 * Reclama atómicamente (server-side, FOR UPDATE SKIP LOCKED) los seguimientos
 * vencidos y avanza su estado. Solo el "ganador" de cada fila la recibe, así
 * dos ticks solapados jamás duplican un envío.
 */
export async function claimFollowups(batch = 10): Promise<FollowupClaim[]> {
  const rows = await supabaseFetch<FollowupClaim[]>(`rpc/vic_v3_claim_followups`, {
    method: "POST",
    body: JSON.stringify({ batch }),
  })
  return rows || []
}

/** Registra el resultado de un toque en la tabla de auditoría. Best-effort. */
export async function logFollowup(entry: {
  conversationId: string
  contact: string
  stage: number
  content: string
  ok: boolean
  error?: string
}): Promise<void> {
  await supabaseFetch(`vic_v3_followup_log`, {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      conversation_id: entry.conversationId,
      contact: entry.contact,
      stage: entry.stage,
      content: entry.content,
      ok: entry.ok,
      error: entry.error || null,
    }),
  })
}

/** Secret compartido del cron (vive en vic_kv; lo setea la migración). */
export async function getFollowupCronSecret(): Promise<string> {
  const rows = await supabaseFetch<{ value: string }[]>(
    `vic_kv?key=eq.followup_cron_secret&select=value&limit=1`,
  )
  return rows && rows.length > 0 ? rows[0].value : ""
}
