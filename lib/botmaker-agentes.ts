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

import { LINEA_POR_PAIS, paisDeContacto } from "./botmaker-tags"

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
  /** Obligatoria al crear (mínimo 8): Botmaker rechaza el alta sin ella. */
  password: string
}): Promise<{ ok: boolean; id?: string; error?: string }> {
  if (!BM_TOKEN || !a.email) return { ok: false, error: "sin token o correo" }
  const r = await fetch(`${BM_API}/v2.0/agents`, {
    method: "POST",
    headers: headers(),
    cache: "no-store",
    body: JSON.stringify({ email: a.email, name: a.name, role: a.role, password: a.password }),
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

/**
 * Referencia de chat de un contacto: `<línea del país>:<teléfono>`.
 *
 * Las líneas salen del MISMO mapa que usa el tagueo comercial desde julio
 * (`LINEA_POR_PAIS`). Tenerlas duplicadas acá ya había producido números de
 * CO y MX distintos de los productivos — y con la línea equivocada el PATCH
 * apunta a un chat que no existe y la etiqueta se pierde en silencio.
 */
export function chatRefDeContacto(contact: string): string {
  const c = String(contact || "").replace(/\D/g, "")
  const pais = paisDeContacto(c)
  if (!c || !pais) return ""
  const linea = LINEA_POR_PAIS[pais]
  return linea ? `${linea}:${c}` : ""
}

/**
 * ASIGNACIÓN REAL de la conversación al dueño del registro en Zoho.
 *
 * La API no deja escribir `agentId` (probado 14-ago: Botmaker responde 400
 * "Property 'agentId' not expected"), pero SÍ deja ejecutar un flujo que
 * contenga la acción "Asignar la conversación a agente específico". Ese flujo
 * lo creó Lalo el 14-ago y lee la variable `correo_ejecutivo`.
 *
 * SE LLAMA POR ID, JAMÁS POR NOMBRE: el workspace tiene DOS intenciones
 * llamadas `transferir_agente` (mayo y agosto) y por nombre la API resuelve a
 * la vieja — devuelve 202 y no hace nada. Tres pruebas se perdieron así.
 *
 * Un solo flujo sirve para los cuatro países: los canales CL/CO/MX/PE cuelgan
 * del mismo bot (`GeoVictoriaEspaol-whatsapp-<línea>`). Verificado asignando
 * un chat mexicano a Yahel con el flujo chileno.
 */
const INTENT_ASIGNAR = (
  process.env.BOTMAKER_INTENT_ASIGNAR || "GeoVictoriaEspaol-psvnpm285o@b.m-1786749912963"
).trim()

/** Correos que NO son personas: asignarles la conversación no tiene sentido. */
const NO_ASIGNABLES = new Set(
  ["vicky@geovictoria.com", "info@geovictoria.com"].concat(
    (process.env.BOTMAKER_NO_ASIGNABLES || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  ),
)

let cacheAgentes: { at: number; correos: Set<string> } | null = null

/** Correos que existen como agente. Cache de 5 min: el barrido pregunta mucho. */
async function correosDeAgentes(): Promise<Set<string>> {
  if (cacheAgentes && Date.now() - cacheAgentes.at < 5 * 60_000) return cacheAgentes.correos
  const lista = await listarAgentes().catch(() => [])
  const correos = new Set(lista.map((a) => String(a.email || "").toLowerCase()).filter(Boolean))
  if (correos.size) cacheAgentes = { at: Date.now(), correos }
  return correos
}

export type ResultadoAsignacion = {
  asignado: boolean
  motivo: string
  agentIdPrevio?: string | null
  agentIdNuevo?: string | null
}

/**
 * Deja la conversación asignada al dueño VIGENTE en Zoho. Best-effort puro:
 * nunca lanza, nunca toca la conversación con el cliente.
 *
 * GUARDA IMPORTANTE: si el correo no existe como agente, la acción de
 * Botmaker NO falla — degrada a "asignar a un agente" cualquiera de la cola,
 * y el prospecto le caería a una persona equivocada sin que nadie se entere.
 * Por eso se verifica ANTES y, si no existe, no se dispara nada.
 */
export async function asignarConversacionAlDueno(
  contact: string,
  ownerEmail: string,
): Promise<ResultadoAsignacion> {
  try {
    const correo = String(ownerEmail || "").trim().toLowerCase()
    const chatRef = chatRefDeContacto(contact)
    if (!BM_TOKEN || !correo || !chatRef) return { asignado: false, motivo: "sin datos" }
    if (NO_ASIGNABLES.has(correo)) return { asignado: false, motivo: "dueño no asignable (bot/interino)" }
    const agentes = await correosDeAgentes()
    if (agentes.size && !agentes.has(correo)) {
      return { asignado: false, motivo: `${correo} no existe como agente en Botmaker` }
    }
    const antes = await leerChat(chatRef)
    if (!antes) return { asignado: false, motivo: "chat no encontrado" }

    const r = await fetch(`${BM_API}/v2.0/chats-actions/trigger-intent`, {
      method: "POST",
      headers: headers(),
      cache: "no-store",
      body: JSON.stringify({
        chat: { channelId: chatRef.split(":")[0], contactId: chatRef.split(":")[1] },
        intentIdOrName: INTENT_ASIGNAR,
        variables: { correo_ejecutivo: correo },
      }),
    })
    if (!r.ok) {
      return { asignado: false, motivo: `trigger ${r.status} ${(await r.text().catch(() => "")).slice(0, 150)}` }
    }
    // El flujo corre asíncrono; se le da un respiro y se VERIFICA. Un 202 no
    // prueba nada por sí solo (así se veían los intentos contra el flujo
    // equivocado).
    await new Promise((res) => setTimeout(res, 4000))
    const despues = await leerChat(chatRef)
    const cambio = (antes.agentId || null) !== (despues?.agentId || null)
    return {
      asignado: cambio,
      motivo: cambio ? "asignada" : "el flujo no movió el agente",
      agentIdPrevio: antes.agentId || null,
      agentIdNuevo: despues?.agentId || null,
    }
  } catch (e) {
    return { asignado: false, motivo: e instanceof Error ? e.message : "excepción" }
  }
}
