/**
 * MATCH DEL MINI-FORM POR NOMBRE (01-oct, caso Ernesto / ITV Cambridge, orden
 * de Lalo "dale con el match por nombre").
 *
 * El botón "Cotiza por WhatsApp con Vicky" de las landing crea el lead del
 * formulario (Form_Vicky = Si) y abre WhatsApp con el texto prellenado
 * "Hola, soy {Nombre}, me gustaría cotizar sus soluciones." — segundos
 * después. Cuando el teléfono que la persona escribió en el formulario NO es
 * el de su WhatsApp (otro número, typo, fijo) o el chat llega con un
 * identificador sin número (BSUID "CO.…"/"PE.…"), el dedup por teléfono no
 * los junta: nacía un lead gemelo desde el chat y el del formulario quedaba
 * huérfano a nombre de Vicky, con riesgo de que el rescate le escribiera al
 * otro número y se lo entregara a una SDR.
 *
 * El match exige las tres cosas a la vez (un nombre de pila solo es común):
 *   1. el primer mensaje del cliente es el texto prellenado del botón;
 *   2. el nombre del prellenado = First_Name del lead del formulario;
 *   3. el formulario se creó entre 30 min antes y 5 min después de ese
 *      primer mensaje, y hay UN solo candidato en esa ventana.
 */

const PREFILL_RE = /^\s*hola[,!.]?\s+soy\s+([^,.!\n]{1,60}?)\s*[,.]\s*me\s+gustar[ií]a\s+cotizar/i

/** Nombre del texto prellenado del botón, o null si el mensaje no lo es. */
export function nombreDelPrefill(texto: string): string | null {
  const m = PREFILL_RE.exec(String(texto || ""))
  if (!m) return null
  const nombre = m[1].trim()
  return nombre ? nombre : null
}

/** Normaliza para comparar nombres: minúsculas, sin tildes ni espacios dobles. */
export function normalizarNombre(s: string): string {
  return String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
}

export const VENTANA_ANTES_MS = 30 * 60_000
export const VENTANA_DESPUES_MS = 5 * 60_000

export type LeadFormCandidato = { id: string; firstName: string; createdMs: number }

/**
 * De los candidatos, el único lead del formulario que calza con el nombre y la
 * hora del primer mensaje. Dos o más que calzan = ambiguo → null (no se adivina).
 */
export function elegirLeadDelForm(
  nombrePrefill: string,
  primerMensajeMs: number,
  candidatos: LeadFormCandidato[],
): string | null {
  const n = normalizarNombre(nombrePrefill)
  if (!n) return null
  const calzan = candidatos.filter(
    (c) =>
      normalizarNombre(c.firstName) === n &&
      c.createdMs >= primerMensajeMs - VENTANA_ANTES_MS &&
      c.createdMs <= primerMensajeMs + VENTANA_DESPUES_MS,
  )
  return calzan.length === 1 ? calzan[0].id : null
}

// ─── Con red (Supabase + Zoho) ──────────────────────────────────────────────

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()

async function supa<T>(path: string): Promise<T[]> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return []
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    cache: "no-store",
  }).catch(() => null)
  if (!r || !r.ok) return []
  return ((await r.json().catch(() => [])) as T[]) || []
}

/** Primer mensaje del cliente en la conversación de este contacto. */
export async function primerMensajeCliente(contact: string): Promise<{ texto: string; at: string } | null> {
  const conv = await supa<{ id: string }>(
    `vic_v3_conversations?contact=eq.${encodeURIComponent(contact)}&select=id&order=started_at.asc&limit=1`,
  )
  if (!conv[0]?.id) return null
  const msg = await supa<{ content: string; at: string }>(
    `vic_v3_messages?conversation_id=eq.${conv[0].id}&role=eq.user&select=content,at&order=at.asc&limit=1`,
  )
  return msg[0] ? { texto: String(msg[0].content || ""), at: String(msg[0].at || "") } : null
}

async function coql(select: string): Promise<Array<Record<string, unknown>>> {
  const { getZohoAccessToken } = await import("./zoho-token")
  const token = await getZohoAccessToken()
  const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
  const r = await fetch(`${api}/crm/v8/coql`, {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({ select_query: select }),
  })
  if (r.status === 204) return []
  if (!r.ok) {
    console.warn(`[match-miniform] COQL ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`)
    return []
  }
  return (((await r.json().catch(() => ({}))) as { data?: Array<Record<string, unknown>> }).data) || []
}

function isoZoho(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "+00:00")
}

/**
 * Lead del mini-form (sin convertir) que corresponde a la conversación de este
 * contacto según su primer mensaje. null si el primer mensaje no es el
 * prellenado o no hay un candidato único.
 */
export async function leadDelFormPorPrefill(contact: string): Promise<string | null> {
  const primero = await primerMensajeCliente(contact)
  if (!primero) return null
  const nombre = nombreDelPrefill(primero.texto)
  const ms = Date.parse(primero.at)
  if (!nombre || !Number.isFinite(ms)) return null
  const filas = await coql(
    "select id, First_Name, Created_Time from Leads where ((Form_Vicky = 'Si' and Converted__s = false) and " +
      `(Created_Time between '${isoZoho(ms - VENTANA_ANTES_MS)}' and '${isoZoho(ms + VENTANA_DESPUES_MS)}')) limit 50`,
  )
  const candidatos = filas
    .map((f) => ({ id: String(f.id || ""), firstName: String(f.First_Name || ""), createdMs: Date.parse(String(f.Created_Time || "")) }))
    .filter((c) => c.id && Number.isFinite(c.createdMs))
  return elegirLeadDelForm(nombre, ms, candidatos)
}

/**
 * Al revés, para el rescate del formulario: conversación que empezó con el
 * prellenado de ESTE nombre en la ventana del formulario. Devuelve el contacto
 * solo si hay uno.
 */
export async function conversacionDelFormPorNombre(firstName: string, creadoMs: number): Promise<string | null> {
  const n = normalizarNombre(firstName)
  if (!n || !Number.isFinite(creadoMs)) return null
  const desde = new Date(creadoMs - VENTANA_DESPUES_MS).toISOString()
  const hasta = new Date(creadoMs + VENTANA_ANTES_MS).toISOString()
  const convs = await supa<{ id: string; contact: string }>(
    `vic_v3_conversations?started_at=gte.${encodeURIComponent(desde)}&started_at=lte.${encodeURIComponent(hasta)}&select=id,contact&limit=200`,
  )
  const calzan: string[] = []
  for (const c of convs) {
    const msg = await supa<{ content: string; at: string }>(
      `vic_v3_messages?conversation_id=eq.${c.id}&role=eq.user&select=content,at&order=at.asc&limit=1`,
    )
    const nombre = msg[0] ? nombreDelPrefill(String(msg[0].content || "")) : null
    if (!nombre || normalizarNombre(nombre) !== n) continue
    const ms = Date.parse(String(msg[0].at || ""))
    if (!Number.isFinite(ms)) continue
    if (creadoMs >= ms - VENTANA_ANTES_MS && creadoMs <= ms + VENTANA_DESPUES_MS) calzan.push(c.contact)
  }
  const unicos = [...new Set(calzan)]
  return unicos.length === 1 ? unicos[0] : null
}
