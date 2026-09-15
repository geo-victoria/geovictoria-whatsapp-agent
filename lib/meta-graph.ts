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
import { canalMetaDe, psidDe } from "./origen-canal"

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
