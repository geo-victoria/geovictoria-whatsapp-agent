/**
 * Adjuntar el comprobante de transferencia (imagen/PDF) a la cotización en
 * Zoho (petición Lalo 03-ago, "sirve para gestión interna"): la transcripción
 * en la nota está bien para leer rápido, pero finanzas necesita el archivo
 * original colgado del registro.
 *
 * Dos piezas:
 *  - mediaEntranteReciente: recupera desde la API de Botmaker la URL del
 *    último archivo que el contacto envió (fallback cuando vic_kv no alcanzó
 *    a guardar `media_reciente_<contact>`, p. ej. pagos previos al 03-ago).
 *  - adjuntarComprobanteACotizacion: descarga la media y la sube como
 *    Attachment del registro de la cotización.
 *
 * Todo best-effort: nunca lanza, y su falla no toca la conversación.
 */

import { getZohoAccessToken } from "./zoho-token"

const QUOTE_MODULE = (process.env.ZOHO_QUOTE_MODULE || "Cotizaciones_GeoVictoria").trim()
const ZOHO_API_DOMAIN = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
const BM_TOKEN = (process.env.BOTMAKER_ACCESS_TOKEN || "").trim()

/**
 * Claves de un mensaje de Botmaker que suelen traer la URL de la media.
 * Forma real (verificada 03-ago con COT307): content.type="image" y la URL en
 * content.media.url — por eso también se acepta la clave pelada `url`/`href`.
 */
function urlsDeMedia(obj: unknown, encontradas: string[] = []): string[] {
  if (!obj || typeof obj !== "object") return encontradas
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (
      typeof v === "string" &&
      /^https?:\/\//i.test(v) &&
      /^(url|href)$|media|image|file|attachment|document/i.test(k)
    ) {
      encontradas.push(v)
    } else if (v && typeof v === "object") {
      urlsDeMedia(v, encontradas)
    }
  }
  return encontradas
}

export async function mediaEntranteReciente(
  contact: string,
  horas = 6,
  opts?: { desdeIso?: string; hastaIso?: string },
): Promise<{ url: string; creationTime: string } | null> {
  const res = await mediaEntranteRecienteDebug(contact, horas, opts)
  return res.top
}

/**
 * Variante con diagnóstico (la usa el endpoint admin): además del hallazgo,
 * cuenta cuántos mensajes devolvió la API y cuántos eran del contacto — para
 * distinguir "link vencido" de "la ventana/limit no alcanzó al mensaje".
 */
export async function mediaEntranteRecienteDebug(
  contact: string,
  horas = 6,
  opts?: { desdeIso?: string; hastaIso?: string },
): Promise<{
  top: { url: string; creationTime: string } | null
  totalItems: number
  delContacto: number
  conMedia: number
  kesMuestra?: string[]
  muestra?: string[]
}> {
  const vacio = { top: null, totalItems: 0, delContacto: 0, conMedia: 0 }
  if (!BM_TOKEN) return vacio
  const clean = contact.replace(/\D/g, "")
  try {
    const desde = opts?.desdeIso || new Date(Date.now() - horas * 60 * 60 * 1000).toISOString()
    const hasta = opts?.hastaIso || ""
    const r = await fetch(
      `https://api.botmaker.com/v2.0/messages?chat-platform=whatsapp&limit=250&from=${encodeURIComponent(desde)}${hasta ? `&to=${encodeURIComponent(hasta)}` : ""}`,
      { headers: { "access-token": BM_TOKEN, Accept: "application/json" }, cache: "no-store" },
    )
    if (!r.ok) return vacio
    const data = (await r.json().catch(() => ({}))) as {
      items?: Array<{ from?: string; creationTime?: string; chat?: { contactId?: string } } & Record<string, unknown>>
    }
    const items = data.items || []
    const propios = items.filter(
      (m) => m.from === "user" && (m.chat?.contactId || "").replace(/\D/g, "") === clean,
    )
    const conMedia = propios
      .map((m) => ({ creationTime: String(m.creationTime || ""), urls: urlsDeMedia(m) }))
      .filter((m) => m.urls.length > 0)
      .sort((a, b) => b.creationTime.localeCompare(a.creationTime))
    const top = conMedia[0]
    return {
      top: top ? { url: top.urls[0], creationTime: top.creationTime } : null,
      totalItems: items.length,
      delContacto: propios.length,
      conMedia: conMedia.length,
      kesMuestra: propios[0] ? Object.keys(propios[0]) : undefined,
      muestra: propios.slice(0, 3).map((m) => JSON.stringify(m).slice(0, 600)),
    }
  } catch (e) {
    console.error("[comprobante-adjunto] mediaEntranteReciente falló:", e)
    return vacio
  }
}

/** Sube un archivo ya en memoria como Attachment de la cotización. */
async function subirAdjunto(
  quoteId: string,
  buf: ArrayBuffer,
  contentType: string,
  filename: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!buf.byteLength) return { ok: false, error: "archivo vacío" }
  const ext = contentType.includes("pdf")
    ? "pdf"
    : contentType.includes("png")
      ? "png"
      : contentType.includes("webp")
        ? "webp"
        : "jpg"
  const nombre = /\.[a-z0-9]{2,4}$/i.test(filename) ? filename : `${filename}.${ext}`
  const form = new FormData()
  form.append("file", new Blob([buf], { type: contentType }), nombre)
  const token = await getZohoAccessToken()
  const up = await fetch(
    `${ZOHO_API_DOMAIN}/crm/v3/${QUOTE_MODULE}/${encodeURIComponent(quoteId)}/Attachments`,
    {
      method: "POST",
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      body: form,
      cache: "no-store",
    },
  )
  if (!up.ok) {
    const detalle = await up.text().catch(() => "")
    console.error(`[comprobante-adjunto] Zoho ${up.status} quote=${quoteId}:`, detalle.slice(0, 300))
    return { ok: false, error: `Zoho ${up.status}: ${detalle.slice(0, 250)}` }
  }
  console.log(`[comprobante-adjunto] adjunto OK quote=${quoteId} (${contentType}, ${buf.byteLength} bytes)`)
  return { ok: true }
}

/**
 * Adjunta un comprobante que NO vino por el chat (Lalo 14-ago, levantamiento
 * histórico de transferencias): los ejecutivos y finanzas guardan PDFs en sus
 * teléfonos y correos, sin URL pública que Zoho pueda descargar. Acá el
 * archivo viaja en base64 y se sube igual que los del chat.
 */
export async function adjuntarComprobanteBase64(
  quoteId: string,
  contenidoBase64: string,
  filename = "comprobante-transferencia.pdf",
  contentType = "application/pdf",
): Promise<{ ok: boolean; error?: string }> {
  if (!quoteId || !contenidoBase64) return { ok: false, error: "quoteId o contenidoBase64 faltante" }
  try {
    const limpio = contenidoBase64.replace(/^data:[^;]+;base64,/, "").replace(/\s+/g, "")
    const buf = Buffer.from(limpio, "base64")
    return await subirAdjunto(
      quoteId,
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
      contentType,
      filename,
    )
  } catch (e) {
    console.error(`[comprobante-adjunto] base64 excepción quote=${quoteId}:`, e)
    return { ok: false, error: e instanceof Error ? e.message : "excepción" }
  }
}

export async function adjuntarComprobanteACotizacion(
  quoteId: string,
  mediaUrl: string,
  filename = "comprobante-transferencia",
): Promise<{ ok: boolean; error?: string }> {
  if (!quoteId || !mediaUrl) return { ok: false, error: "quoteId o mediaUrl faltante" }
  try {
    const dl = await fetch(mediaUrl, { cache: "no-store" })
    if (!dl.ok) return { ok: false, error: `descarga de la media falló (${dl.status}) — link vencido?` }
    const contentType = dl.headers.get("content-type") || "application/octet-stream"
    const buf = await dl.arrayBuffer()
    return await subirAdjunto(quoteId, buf, contentType, filename)
  } catch (e) {
    console.error(`[comprobante-adjunto] excepción quote=${quoteId}:`, e)
    return { ok: false, error: e instanceof Error ? e.message : "excepción" }
  }
}
