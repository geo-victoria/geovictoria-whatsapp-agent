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
async function getOrCreateConversationId(
  contact: string,
  // Multi-país: país de la LÍNEA por la que llegó el primer mensaje. Solo se
  // usa al CREAR la conversación (una existente nunca cambia de país).
  country: string = "cl",
): Promise<string | null> {
  const existing = await supabaseFetch<ConversationRow[]>(
    `vic_v3_conversations?contact=eq.${encodeURIComponent(contact)}&select=id&limit=1`,
  )
  if (existing && existing.length > 0) return existing[0].id

  const created = await supabaseFetch<ConversationRow[]>(
    `vic_v3_conversations`,
    {
      method: "POST",
      body: JSON.stringify({ contact, country }),
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
  country: string = "cl",
): Promise<void> {
  const conversationId = await getOrCreateConversationId(contact, country)
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
  rut?: string
  empresa?: string
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
  rut?: string | null
  empresa?: string | null
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
    rut?: string
    empresa?: string
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
    // Multi-RUT: etiqueta de la razón social dueña de esta cotización.
    rut: data.rut ? data.rut.replace(/[.\s-]/g, "").toUpperCase() : null,
    empresa: data.empresa ?? null,
    updated_at: new Date().toISOString(),
  }
  await supabaseFetch(`vic_v3_quote_pointers?on_conflict=contact,quote_id`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(body),
  })
}

/**
 * Devuelve el puntero durable de la cotización del contacto, o null si no hay.
 */
function rowToPointer(r: QuotePointerRow): QuotePointer {
  return {
    quoteId: r.quote_id || "",
    dealId: r.deal_id || "",
    acceptanceUrl: r.acceptance_url || "",
    pdfUrl: r.pdf_url || "",
    totalClp: r.total_clp,
    totalUf: r.total_uf,
    updatedAt: r.updated_at || "",
    rut: r.rut || "",
    empresa: r.empresa || "",
  }
}

const POINTER_SELECT =
  "quote_id,deal_id,acceptance_url,pdf_url,total_clp,total_uf,updated_at,rut,empresa"

/** La cotización formal MÁS RECIENTE del contacto (compatibilidad single). */
export async function getQuotePointer(contact: string): Promise<QuotePointer | null> {
  if (!contact) return null
  const rows = await supabaseFetch<QuotePointerRow[]>(
    `vic_v3_quote_pointers?contact=eq.${encodeURIComponent(contact)}&select=${POINTER_SELECT}&order=updated_at.desc&limit=1`,
  )
  if (!rows || rows.length === 0 || !rows[0].quote_id) return null
  return rowToPointer(rows[0])
}

/** TODAS las cotizaciones formales vivas del contacto (multi-RUT, más reciente primero). */
export async function getQuotePointers(contact: string): Promise<QuotePointer[]> {
  if (!contact) return []
  const rows = await supabaseFetch<QuotePointerRow[]>(
    `vic_v3_quote_pointers?contact=eq.${encodeURIComponent(contact)}&select=${POINTER_SELECT}&order=updated_at.desc&limit=10`,
  )
  return (rows || []).filter((r) => r.quote_id).map(rowToPointer)
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
// Cadencia (espejo de vic_v3_claim_followups en SQL): 2 toques de texto libre a
// 1h y 23h (dentro de la ventana de 24h), gateados a horario hábil en la zona del
// contacto (Lun-Sáb 9-19 local, sin feriado; ver vic_is_business_now). Los toques
// largos (47h/7d/15d, fuera de 24h) van por plantilla HSM en vic-reactivation-cron.
// Antes: 3 toques a ~1h/~6h/~18h SIN horario hábil (causaba toques de madrugada).
// `silence_anchor_at` = momento en que Vicky respondió y quedó esperando; los
// toques de push NO lo mueven (si lo movieran, la cadencia nunca avanzaría).

const FOLLOWUP_FIRST_OFFSET_MS = 60 * 60 * 1000 // primer toque: +1 h
// PRUEBAS 14-jul (Eduardo y Rodrigo): primer toque a los 2 min, igual que los
// offsets acelerados de vic_v3_claim_followups. Quitar al terminar las pruebas.
const FOLLOWUP_FIRST_OFFSET_TEST_MS = 2 * 60 * 1000
const CONTACTOS_PRUEBA_RAPIDA = new Set(["56944668823", "56978385048"])

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
 * Último mensaje del CLIENTE (para decidir si la ventana de 24h de WhatsApp
 * está abierta antes de intentar un push de texto libre — fuera de ventana el
 * push muere silenciosamente y hay que ir por plantilla HSM).
 */
export async function getLastUserAt(contact: string): Promise<Date | null> {
  if (!contact) return null
  const rows = await supabaseFetch<Array<{ last_user_at: string | null }>>(
    `vic_v3_conversations?contact=eq.${encodeURIComponent(contact)}&select=last_user_at&limit=1`,
  )
  const raw = rows?.[0]?.last_user_at
  if (!raw) return null
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * Marca actividad del cliente: actualiza last_user_at y, si había un ciclo
 * activo, lo pausa (el cliente respondió → se cancela la cadencia en curso;
 * se re-armará cuando Vicky conteste). Best-effort.
 */
export async function markUserActivity(contact: string, country = "cl"): Promise<void> {
  if (!contact) return
  const conversationId = await getOrCreateConversationId(contact, country)
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
export async function armFollowup(contact: string, country = "cl"): Promise<void> {
  if (!contact) return
  const conversationId = await getOrCreateConversationId(contact, country)
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
      followup_next_at: new Date(
        now.getTime() +
          (CONTACTOS_PRUEBA_RAPIDA.has(contact)
            ? FOLLOWUP_FIRST_OFFSET_TEST_MS
            : FOLLOWUP_FIRST_OFFSET_MS),
      ).toISOString(),
      followup_closed_reason: null,
    }),
  })
}

/** Cierra el ciclo definitivamente (opt_out, derivado, agotado, respondio). */
/**
 * Lookup inverso: contacto dueño de una cotización formal (por su id de Zoho).
 * Lo usa vic-quote-notify para cerrar la cadencia cuando la cotización se
 * acepta o paga.
 */
export async function findContactByQuoteId(quoteId: string): Promise<string | null> {
  if (!quoteId) return null
  const rows = await supabaseFetch<Array<{ contact: string }>>(
    `vic_v3_conversations?formal_quote_id=eq.${encodeURIComponent(quoteId)}&select=contact&limit=1`,
  )
  return rows?.[0]?.contact || null
}

export async function closeFollowup(
  contact: string,
  reason: string,
  country = "cl",
): Promise<void> {
  if (!contact) return
  const conversationId = await getOrCreateConversationId(contact, country)
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
 * Programa un seguimiento CONSENSUADO: el cliente dio una señal explícita de
 * decisión diferida ("lo veo con mi jefe", "consúltame el lunes") y acordó un
 * momento para retomar. Se apaga la cadencia automática (status 'consensuado',
 * que ni el follow-up de 1h/23h ni la reactivación 47h/7d/15d tocan) y se deja
 * UN solo toque programado a `cuandoIso`. El gate de horario hábil se aplica al
 * enviarlo (en el cron de reactivación), así que no hace falta ajustarlo aquí.
 */
export async function scheduleConsensualFollowup(
  contact: string,
  cuandoIso: string,
  country = "cl",
): Promise<void> {
  if (!contact || !cuandoIso) return
  const conversationId = await getOrCreateConversationId(contact, country)
  if (!conversationId) return
  await supabaseFetch(`vic_v3_conversations?id=eq.${conversationId}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      followup_status: "consensuado",
      followup_next_at: cuandoIso,
      followup_stage: 0,
      followup_attempts: 0,
      followup_closed_reason: null,
    }),
  })
}

/**
 * Persiste un toque de re-engagement como mensaje del asistente (para que el
 * próximo turno de Vicky tenga el contexto), SIN tocar silence_anchor_at ni
 * last_user_at (el push no reinicia la cadencia).
 */
export async function appendAssistantV3(
  contact: string,
  content: string,
  // Multi-país (17-jul): marca el país al CREAR la conversación (outbound CO
  // escribe primero). Default "cl" — todos los llamadores existentes intactos.
  country: string = "cl",
): Promise<void> {
  if (!contact || !content) return
  const conversationId = await getOrCreateConversationId(contact, country)
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

/**
 * ¿Este contacto está respondiendo a un toque de reactivación? True cuando hay
 * un `reactivation_at` posterior al último mensaje del cliente (`last_user_at`):
 * o sea, lo reactivamos estando frío y esta es su PRIMERA respuesta al toque.
 * Se auto-limpia: al persistir esa respuesta, appendTurnV3 actualiza
 * last_user_at, por lo que en los turnos siguientes vuelve a ser false.
 */
export async function isReengaged(contact: string): Promise<boolean> {
  if (!contact) return false
  const rows = await supabaseFetch<
    Array<{ reactivation_at: string | null; last_user_at: string | null }>
  >(
    `vic_v3_conversations?contact=eq.${encodeURIComponent(
      contact,
    )}&select=reactivation_at,last_user_at&limit=1`,
  )
  if (!rows || rows.length === 0) return false
  const { reactivation_at, last_user_at } = rows[0]
  if (!reactivation_at) return false
  if (!last_user_at) return true
  return Date.parse(reactivation_at) > Date.parse(last_user_at)
}

// ── Reuniones agendadas (recordatorios por WhatsApp) ───────────────────────
// Tabla vic_v3_meetings: fuente de verdad para el recordatorio (cron) y la
// confirmación de asistencia. Se llena al agendar (agent-loop) y se mantiene
// en sync con los webhooks de Cal.com (reschedule/cancel). Best-effort.

export type MeetingRow = {
  booking_uid: string
  contact: string
  prospect_name: string | null
  start_at: string
  timezone: string
  meeting_url: string | null
  organizer_email: string | null
  zoho_lead_id?: string | null
}

/** Inserta (o actualiza por booking_uid) una reunión agendada. */
export async function persistMeeting(m: {
  bookingUid: string
  contact: string
  prospectName?: string
  prospectEmail?: string
  startIso: string
  timezone: string
  organizerEmail?: string
  meetingUrl?: string
  zohoLeadId?: string
  zohoEventId?: string
  reminderAt?: string | null
}): Promise<void> {
  if (!m.bookingUid || !m.contact) return
  await supabaseFetch(`vic_v3_meetings?on_conflict=booking_uid`, {
    method: "POST",
    headers: { Prefer: "return=minimal,resolution=merge-duplicates" },
    body: JSON.stringify({
      booking_uid: m.bookingUid,
      contact: m.contact,
      prospect_name: m.prospectName || null,
      prospect_email: m.prospectEmail || null,
      start_at: m.startIso,
      timezone: m.timezone,
      organizer_email: m.organizerEmail || null,
      meeting_url: m.meetingUrl || null,
      zoho_lead_id: m.zohoLeadId || null,
      zoho_event_id: m.zohoEventId || null,
      status: "scheduled",
      reminder_at: m.reminderAt || null,
      updated_at: new Date().toISOString(),
    }),
  }).catch(() => {})
}

/** Actualiza campos de una reunión por su booking_uid (Cal.com). Best-effort. */
export async function updateMeetingByUid(
  bookingUid: string,
  fields: Record<string, unknown>,
): Promise<void> {
  if (!bookingUid) return
  await supabaseFetch(
    `vic_v3_meetings?booking_uid=eq.${encodeURIComponent(bookingUid)}`,
    {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ ...fields, updated_at: new Date().toISOString() }),
    },
  ).catch(() => {})
}

/** Reuniones con recordatorio vencido y aún no enviado (para el cron). */
export async function getDueMeetingReminders(limit = 20): Promise<MeetingRow[]> {
  const nowIso = new Date().toISOString()
  const rows = await supabaseFetch<MeetingRow[]>(
    `vic_v3_meetings?status=eq.scheduled&reminder_sent_at=is.null` +
      `&reminder_at=lte.${nowIso}&start_at=gt.${nowIso}` +
      `&select=booking_uid,contact,prospect_name,start_at,timezone,meeting_url,organizer_email` +
      `&order=reminder_at.asc&limit=${limit}`,
  )
  return rows || []
}

/** Marca el recordatorio como enviado. */
export async function markMeetingReminded(bookingUid: string): Promise<void> {
  await updateMeetingByUid(bookingUid, { reminder_sent_at: new Date().toISOString() })
}

/**
 * Claim ATÓMICO del recordatorio: setea reminder_sent_at SOLO si seguía en null.
 * Devuelve true si ESTE llamado ganó el claim (debe enviar), false si otro tick
 * ya lo tomó. Evita doble envío entre ticks solapados del cron sin un lock.
 */
export async function claimMeetingReminder(bookingUid: string): Promise<boolean> {
  if (!bookingUid) return false
  const now = new Date().toISOString()
  const rows = await supabaseFetch<{ booking_uid: string }[]>(
    `vic_v3_meetings?booking_uid=eq.${encodeURIComponent(bookingUid)}&reminder_sent_at=is.null`,
    {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ reminder_sent_at: now, updated_at: now }),
    },
  )
  return Array.isArray(rows) && rows.length > 0
}

/** Revierte el claim (vuelve reminder_sent_at a null) si el envío falló. */
export async function unclaimMeetingReminder(bookingUid: string): Promise<void> {
  await updateMeetingByUid(bookingUid, { reminder_sent_at: null })
}

/** Próxima reunión futura agendada del contacto (para reagendar/confirmar). */
export async function getUpcomingMeeting(contact: string): Promise<MeetingRow | null> {
  if (!contact) return null
  const nowIso = new Date().toISOString()
  const rows = await supabaseFetch<MeetingRow[]>(
    `vic_v3_meetings?contact=eq.${encodeURIComponent(contact)}&status=eq.scheduled` +
      `&start_at=gt.${nowIso}` +
      `&select=booking_uid,contact,prospect_name,start_at,timezone,meeting_url,organizer_email,zoho_lead_id` +
      `&order=start_at.asc&limit=1`,
  )
  return rows && rows.length > 0 ? rows[0] : null
}

/** Marca la próxima reunión futura del contacto como confirmada por WhatsApp. */
export async function confirmMeetingAttendance(contact: string): Promise<MeetingRow | null> {
  if (!contact) return null
  const nowIso = new Date().toISOString()
  const rows = await supabaseFetch<MeetingRow[]>(
    `vic_v3_meetings?contact=eq.${encodeURIComponent(contact)}&status=eq.scheduled` +
      `&start_at=gt.${nowIso}` +
      `&select=booking_uid,contact,prospect_name,start_at,timezone,meeting_url,organizer_email` +
      `&order=start_at.asc&limit=1`,
  )
  if (!rows || rows.length === 0) return null
  await updateMeetingByUid(rows[0].booking_uid, {
    attendance_confirmed_at: new Date().toISOString(),
  })
  return rows[0]
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

/** País de la conversación de un contacto ('cl' default). Para crons que
 * deben decidir canal/plantilla por país a partir del contacto. */
export async function getContactCountry(contact: string): Promise<string> {
  if (!contact) return "cl"
  const rows = await supabaseFetch<Array<{ country: string | null }>>(
    `vic_v3_conversations?contact=eq.${encodeURIComponent(contact)}&select=country&limit=1`,
  )
  return (rows?.[0]?.country || "cl").toLowerCase()
}

/**
 * País de cada conversación (columna `country`), en un solo query. Usado por
 * los crons para elegir idioma/registro del nudge y el canal de Botmaker
 * (el RPC de claim no devuelve el país; esto evita tocar la migración).
 */
export async function getConversationCountries(
  conversationIds: string[],
): Promise<Record<string, string>> {
  const ids = conversationIds.filter(Boolean)
  if (ids.length === 0) return {}
  const rows = await supabaseFetch<Array<{ id: string; country: string | null }>>(
    `vic_v3_conversations?id=in.(${ids.map(encodeURIComponent).join(",")})&select=id,country`,
  )
  const map: Record<string, string> = {}
  for (const r of rows || []) map[r.id] = (r.country || "cl").toLowerCase()
  return map
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

/** KV genérico sobre vic_kv, para estado chico compartido entre invocaciones
 * (ej. el turno del round-robin de reasignación a SDRs). Best-effort. */
export async function getKvValue(key: string): Promise<string | null> {
  const rows = await supabaseFetch<{ value: string }[]>(
    `vic_kv?key=eq.${encodeURIComponent(key)}&select=value&limit=1`,
  )
  return rows && rows.length > 0 ? rows[0].value : null
}

export async function setKvValue(key: string, value: string): Promise<void> {
  await supabaseFetch<unknown>(`vic_kv?on_conflict=key`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key, value }),
  })
}
