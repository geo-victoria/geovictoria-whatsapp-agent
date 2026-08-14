/**
 * Agentes de Botmaker y VISIBILIDAD de conversaciones por dueño de Zoho.
 *
 * Problema (Lalo 14-ago): en Botmaker un OPERATOR solo ve lo que tiene
 * asignado, así que al equipo comercial lo habían subido a admin para que
 * pudiera ver las conversaciones de sus prospectos — y terminaron viéndolo
 * TODO, que confunde más de lo que ayuda.
 *
 * La API NO permite asignar un chat a un agente (PATCH /chats acepta
 * variables, tags, nombre, correo, país e isTester; agentId es de solo
 * lectura). El mecanismo que Botmaker SÍ ofrece es el de ETIQUETAS: el campo
 * `tags` del agente está documentado como "Filter conversations by tag names".
 * Entonces la visibilidad se arma con dos piezas que calzan:
 *   1. cada ejecutivo lleva su etiqueta propia (`owner_asepulveda`),
 *   2. cada conversación se etiqueta con la del DUEÑO DE SU REGISTRO EN ZOHO.
 *
 * Zoho es la fuente de la verdad: si la tómbola cambia al dueño, la etiqueta
 * vieja se apaga y se prende la nueva. Nada de esto toca al agentId real ni
 * la conversación del cliente.
 */

const BM_TOKEN = (process.env.BOTMAKER_ACCESS_TOKEN || "").trim()
const BM_API = "https://api.botmaker.com"

export type RolBotmaker = "ADMIN" | "CONFIGURATOR" | "SUPERVISOR" | "OPERATOR"

export type AgenteBotmaker = {
  id: string
  email: string
  name?: string
  role?: string
  tags?: string[]
  queues?: string[]
}

function headers(): Record<string, string> {
  return { "access-token": BM_TOKEN, "Content-Type": "application/json", Accept: "application/json" }
}

/** Etiqueta estable de un dueño: `owner_` + la parte local del correo, sin
 * acentos ni signos. Estable entre corridas — es la llave del filtro. */
export function etiquetaDeDueno(email: string): string {
  const local = String(email || "").split("@")[0] || ""
  const limpio = local
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase()
  return limpio ? `owner_${limpio}` : ""
}

/** ¿Es una etiqueta de dueño puesta por nosotros? (para apagar la anterior). */
export function esEtiquetaDeDueno(tag: string): boolean {
  return /^owner_[a-z0-9]+$/.test(String(tag || ""))
}

export async function listarAgentes(): Promise<AgenteBotmaker[]> {
  if (!BM_TOKEN) return []
  const r = await fetch(`${BM_API}/v2.0/agents`, { headers: headers(), cache: "no-store" })
  if (!r.ok) {
    console.warn(`[bm-agentes] listar ${r.status}`)
    return []
  }
  const body = (await r.json().catch(() => ({}))) as { items?: AgenteBotmaker[] }
  return Array.isArray(body.items) ? body.items : []
}

/** PATCH parcial. Se mandan SOLO los campos a cambiar: colas, slots y
 * prioridad del agente se conservan. */
export async function actualizarAgente(
  idOrEmail: string,
  cambios: { role?: RolBotmaker; tags?: string[]; showMyChatsFilter?: boolean },
): Promise<{ ok: boolean; error?: string }> {
  if (!BM_TOKEN || !idOrEmail) return { ok: false, error: "sin token o agente" }
  const r = await fetch(`${BM_API}/v2.0/agents/${encodeURIComponent(idOrEmail)}`, {
    method: "PATCH",
    headers: headers(),
    cache: "no-store",
    body: JSON.stringify(cambios),
  })
  if (!r.ok) return { ok: false, error: `${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}` }
  return { ok: true }
}

export async function crearAgente(a: {
  email: string
  name: string
  role: RolBotmaker
  tags?: string[]
}): Promise<{ ok: boolean; id?: string; error?: string }> {
  if (!BM_TOKEN || !a.email) return { ok: false, error: "sin token o correo" }
  const r = await fetch(`${BM_API}/v2.0/agents`, {
    method: "POST",
    headers: headers(),
    cache: "no-store",
    body: JSON.stringify({ email: a.email, name: a.name, role: a.role, tags: a.tags || [] }),
  })
  const txt = await r.text().catch(() => "")
  if (!r.ok) return { ok: false, error: `${r.status} ${txt.slice(0, 300)}` }
  let id = ""
  try {
    id = String((JSON.parse(txt) as { id?: string })?.id || "")
  } catch {
    /* la respuesta puede venir vacía */
  }
  return { ok: true, id }
}

/** Estado del chat. chatReference = chatId, o `<linea>:<contacto>`. */
export async function leerChat(
  chatRef: string,
): Promise<{ tags: string[]; agentId?: string; chatId?: string } | null> {
  if (!BM_TOKEN || !chatRef) return null
  const r = await fetch(`${BM_API}/v2.0/chats/${encodeURIComponent(chatRef)}`, {
    headers: headers(),
    cache: "no-store",
  })
  if (!r.ok) return null
  const b = (await r.json().catch(() => ({}))) as {
    tags?: string[]
    agentId?: string
    chat?: { chatId?: string }
  }
  return { tags: Array.isArray(b.tags) ? b.tags : [], agentId: b.agentId, chatId: b.chat?.chatId }
}

/**
 * Deja la conversación con la etiqueta del dueño VIGENTE en Zoho y apaga
 * cualquier otra etiqueta de dueño anterior. Idempotente: si ya está bien, no
 * escribe. Devuelve `false` cuando no hubo nada que hacer.
 */
export async function etiquetarChatConDueno(
  chatRef: string,
  ownerEmail: string,
): Promise<{ cambiado: boolean; etiqueta?: string; error?: string }> {
  const nueva = etiquetaDeDueno(ownerEmail)
  if (!nueva || !chatRef) return { cambiado: false, error: "sin etiqueta o chat" }
  const chat = await leerChat(chatRef)
  if (!chat) return { cambiado: false, error: "chat no encontrado" }
  const previas = chat.tags.filter((t) => esEtiquetaDeDueno(t) && t !== nueva)
  if (chat.tags.includes(nueva) && previas.length === 0) return { cambiado: false, etiqueta: nueva }
  const tags: Record<string, boolean> = { [nueva]: true }
  for (const t of previas) tags[t] = false
  const r = await fetch(`${BM_API}/v2.0/chats/${encodeURIComponent(chatRef)}`, {
    method: "PATCH",
    headers: headers(),
    cache: "no-store",
    body: JSON.stringify({ tags }),
  })
  if (!r.ok) {
    return { cambiado: false, error: `${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}` }
  }
  return { cambiado: true, etiqueta: nueva }
}

/** Línea por país para armar `<linea>:<contacto>` cuando no hay chatId. */
export function lineaDePais(contact: string): string {
  const c = String(contact || "").replace(/\D/g, "")
  const env = (k: string) => (process.env[k] || "").replace(/\D/g, "")
  if (c.startsWith("57")) return env("BOTMAKER_LINEA_CO") || "573242178172"
  if (c.startsWith("52")) return env("BOTMAKER_LINEA_MX") || "5215585264756"
  if (c.startsWith("51")) return env("BOTMAKER_LINEA_PE") || "51922067167"
  return env("BOTMAKER_LINEA_CL") || "56967308227"
}

/** Referencia de chat de un contacto: la línea de su país + su número. */
export function chatRefDeContacto(contact: string): string {
  const c = String(contact || "").replace(/\D/g, "")
  if (!c) return ""
  return `${lineaDePais(c)}:${c}`
}
