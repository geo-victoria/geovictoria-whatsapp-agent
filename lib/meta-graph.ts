/**
 * GRAPH API DE META — envío a Messenger / Instagram (15-sep, Lalo: "una sola
 * Vicky; Messenger es un canal más").
 *
 * El contacto de este canal es `FB.<psid>` (Messenger) o `IG.<igsid>`
 * (Instagram): el PSID es el ID que Meta le asigna a la persona PARA NUESTRA
 * PÁGINA — estable, sirve para responderle, es el homólogo del teléfono en
 * WhatsApp. Toda salida a esos contactos pasa por acá (la llaman los
 * `sendBotmaker*` de botmaker-push-v3 cuando ven el prefijo), así que el resto
 * de la máquina (tools, loop, relojes, post-pago) no sabe que el canal cambió.
 *
 * Límites del canal que hay que decir siempre:
 *  - VENTANA DE 24 h: fuera de ella Meta rechaza todo (no existen plantillas
 *    como en WhatsApp). Un envío fuera de ventana se registra como fallo
 *    `meta_fuera_de_ventana` y NO se reintenta a ciegas.
 *  - Messenger acepta adjuntos por URL pública (PDF ≤ 25 MB, imagen);
 *    Instagram NO acepta archivos: el PDF va como URL en texto.
 *  - Texto máximo 2.000 caracteres por mensaje: lo largo se parte.
 *
 * Credenciales: env o vic_kv `meta_page_access_token` / `meta_app_secret` /
 * `meta_verify_token` (se leen por request: rotar sin deploy).
 */
import { getKvValue } from "./supabase-persistence-v3"
import { canalMetaDe, psidDe } from "./origen-canal.ts"

export const GRAPH = "https://graph.facebook.com/v21.0"
const MAX_TEXTO = 2000

export async function credencialesMeta(): Promise<{ verify: string; secret: string; token: string }> {
  const kv = async (k: string) => ((await getKvValue(k).catch(() => null)) || "").trim()
  return {
    verify: (process.env.META_VERIFY_TOKEN || "").trim() || (await kv("meta_verify_token")),
    secret: (process.env.META_APP_SECRET || "").trim() || (await kv("meta_app_secret")),
    token: (process.env.META_PAGE_ACCESS_TOKEN || "").trim() || (await kv("meta_page_access_token")),
  }
}

/** ¿La ventana de 24 h de Meta sigue abierta para este contacto? Se mide
 * con el último mensaje del CLIENTE en vic_v3_conversations. Sin dato →
 * false (fail-closed: mejor no mandar que gastar un intento seguro de fallo). */
export async function ventanaMetaAbierta(contact: string): Promise<boolean> {
  const url = (process.env.SUPABASE_URL || "").trim()
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
  if (!url || !key) return false
  try {
    const r = await fetch(
      `${url}/rest/v1/vic_v3_conversations?contact=eq.${encodeURIComponent(contact)}&select=last_user_at&limit=1`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: "no-store" },
    )
    const rows = r.ok ? ((await r.json().catch(() => [])) as Array<{ last_user_at?: string | null }>) : []
    const at = rows[0]?.last_user_at ? Date.parse(String(rows[0].last_user_at)) : NaN
    return Number.isFinite(at) && Date.now() - at < 24 * 3600e3
  } catch {
    return false
  }
}

type Resultado = { ok: boolean; detalle?: string }

async function postMessages(payload: Record<string, unknown>, token: string): Promise<Resultado> {
  const r = await fetch(`${GRAPH}/me/messages?access_token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store",
  }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }) as unknown as Response)
  if (!r.ok) {
    const t = (await r.text().catch(() => "")).slice(0, 300)
    return { ok: false, detalle: `graph ${r.status}: ${t}` }
  }
  return { ok: true }
}

/** Parte un texto largo en trozos ≤ MAX_TEXTO cortando en borde de párrafo/oración. */
function partirTexto(texto: string): string[] {
  const t = String(texto || "").trim()
  if (t.length <= MAX_TEXTO) return t ? [t] : []
  const out: string[] = []
  let resto = t
  while (resto.length > MAX_TEXTO) {
    let corte = resto.lastIndexOf("\n\n", MAX_TEXTO)
    if (corte < MAX_TEXTO * 0.5) corte = resto.lastIndexOf(". ", MAX_TEXTO)
    if (corte < MAX_TEXTO * 0.5) corte = MAX_TEXTO
    out.push(resto.slice(0, corte).trim())
    resto = resto.slice(corte).trim()
  }
  if (resto) out.push(resto)
  return out
}

/** Texto a un contacto Meta (varios mensajes si es largo). */
export async function enviarTextoMeta(contact: string, texto: string): Promise<Resultado> {
  const psid = psidDe(contact)
  if (!psid) return { ok: false, detalle: "contacto no es Meta" }
  const { token } = await credencialesMeta()
  if (!token) return { ok: false, detalle: "sin meta_page_access_token" }
  const partes = partirTexto(texto)
  if (!partes.length) return { ok: false, detalle: "texto vacío" }
  for (const parte of partes) {
    const r = await postMessages(
      { recipient: { id: psid }, messaging_type: "RESPONSE", message: { text: parte } },
      token,
    )
    if (!r.ok) return r
  }
  return { ok: true }
}

/** Adjunto por URL. Messenger: archivo/imagen real; Instagram: solo imagen —
 * un PDF va como texto con la URL (Instagram no acepta archivos). */
export async function enviarAdjuntoMeta(
  contact: string,
  url: string,
  opts: { caption?: string; mimeType?: string } = {},
): Promise<Resultado> {
  const psid = psidDe(contact)
  if (!psid) return { ok: false, detalle: "contacto no es Meta" }
  const { token } = await credencialesMeta()
  if (!token) return { ok: false, detalle: "sin meta_page_access_token" }
  const esImagen = /^image\//i.test(opts.mimeType || "") || /\.(png|jpe?g|gif|webp)(\?|$)/i.test(url)
  const canal = canalMetaDe(contact)
  if (opts.caption) {
    const c = await enviarTextoMeta(contact, opts.caption)
    if (!c.ok) return c
  }
  if (canal === "instagram" && !esImagen) {
    return enviarTextoMeta(contact, `Aquí tienes el documento: ${url}`)
  }
  return postMessages(
    {
      recipient: { id: psid },
      messaging_type: "RESPONSE",
      message: { attachment: { type: esImagen ? "image" : "file", payload: { url, is_reusable: false } } },
    },
    token,
  )
}

/** Indicador "escribiendo…" (best-effort, jamás falla hacia afuera). */
export async function typingMeta(contact: string, on: boolean): Promise<void> {
  const psid = psidDe(contact)
  if (!psid) return
  const { token } = await credencialesMeta()
  if (!token) return
  await postMessages({ recipient: { id: psid }, sender_action: on ? "typing_on" : "typing_off" }, token).catch(() => undefined)
}

// ── PERFIL DE LA PERSONA (15-sep, pedido de Lalo: "me interesa first_name,
// last_name, profile_pic, y con permisos extra locale, timezone y gender") ──
// User Profile API: GET /<psid>?fields=… con el token de la Página. Los tres
// básicos exigen pages_messaging con la app APROBADA (en modo desarrollo el
// endpoint responde error 100 subcode 33, medido 15-sep); locale/timezone/
// gender exigen además pages_user_locale / pages_user_timezone /
// pages_user_gender (App Review). Por eso se pide en cascada: completo →
// básico → nombre del hilo (`/me/conversations` participants, que SÍ responde
// con el token del panel). Todo fail-open y cacheado 7 d en vic_kv
// `meta_perfil_<contact>` — nunca toca la conversación.
export type PerfilMeta = {
  firstName: string
  lastName: string
  profilePic: string
  locale: string
  timezone: number | null
  gender: string
  fuente: "perfil_completo" | "perfil_basico" | "hilo" | "ninguna"
  at: string
}

const PERFIL_TTL_MS = 7 * 24 * 3600e3

async function graphGet(path: string, token: string): Promise<Record<string, unknown> | null> {
  const r = await fetch(`${GRAPH}${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(6000),
  }).catch(() => null)
  if (!r) return null
  const j = (await r.json().catch(() => null)) as Record<string, unknown> | null
  if (!j || (j as { error?: unknown }).error) return null
  return j
}

function partirNombre(full: string): { firstName: string; lastName: string } {
  const partes = String(full || "").trim().split(/\s+/).filter(Boolean)
  if (!partes.length) return { firstName: "", lastName: "" }
  if (partes.length === 1) return { firstName: partes[0], lastName: "" }
  return { firstName: partes.slice(0, -1).join(" "), lastName: partes[partes.length - 1] }
}

/** Perfil desde Graph (sin caché). Devuelve fuente "ninguna" si nada respondió. */
export async function perfilMetaDesdeGraph(contact: string): Promise<PerfilMeta> {
  const vacio: PerfilMeta = { firstName: "", lastName: "", profilePic: "", locale: "", timezone: null, gender: "", fuente: "ninguna", at: new Date().toISOString() }
  const psid = psidDe(contact)
  if (!psid) return vacio
  const { token } = await credencialesMeta()
  if (!token) return vacio
  const completo = await graphGet(`/${psid}?fields=first_name,last_name,profile_pic,locale,timezone,gender`, token)
  const basico = completo || (await graphGet(`/${psid}?fields=first_name,last_name,profile_pic`, token))
  if (basico) {
    return {
      ...vacio,
      firstName: String(basico.first_name || "").trim(),
      lastName: String(basico.last_name || "").trim(),
      profilePic: String(basico.profile_pic || "").trim(),
      locale: String(basico.locale || "").trim(),
      timezone: typeof basico.timezone === "number" ? basico.timezone : null,
      gender: String(basico.gender || "").trim(),
      fuente: completo ? "perfil_completo" : "perfil_basico",
    }
  }
  // Fallback: el nombre del participante en el hilo (responde con pages_messaging).
  const plataforma = canalMetaDe(contact) === "instagram" ? "instagram" : "messenger"
  const conv = await graphGet(`/me/conversations?platform=${plataforma}&user_id=${psid}&fields=participants&limit=1`, token)
  const data = (conv?.data as Array<{ participants?: { data?: Array<{ id?: string; name?: string }> } }> | undefined) || []
  const p = data[0]?.participants?.data?.find((x) => String(x.id) === psid)
  if (p?.name) return { ...vacio, ...partirNombre(String(p.name)), fuente: "hilo" }
  return vacio
}

/** Perfil con caché kv (7 d). `forzar` relee Graph. */
export async function perfilMeta(contact: string, opts: { forzar?: boolean } = {}): Promise<PerfilMeta | null> {
  if (!psidDe(contact)) return null
  const llave = `meta_perfil_${String(contact).trim()}`
  if (!opts.forzar) {
    const raw = await getKvValue(llave).catch(() => null)
    if (raw) {
      try {
        const p = JSON.parse(raw) as PerfilMeta
        if (p && p.fuente !== "ninguna" && Date.now() - Date.parse(p.at || "") < PERFIL_TTL_MS) return p
      } catch { /* ilegible → releer */ }
    }
  }
  const p = await perfilMetaDesdeGraph(contact)
  if (p.fuente !== "ninguna") {
    const { setKvValue } = await import("./supabase-persistence-v3")
    await setKvValue(llave, JSON.stringify(p)).catch(() => undefined)
  }
  return p
}
