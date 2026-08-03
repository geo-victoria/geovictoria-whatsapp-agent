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

/** Claves de un mensaje de Botmaker que suelen traer la URL de la media. */
function urlsDeMedia(obj: unknown, encontradas: string[] = []): string[] {
  if (!obj || typeof obj !== "object") return encontradas
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof v === "string" && /^https?:\/\//i.test(v) && /media|image|file|attachment|document/i.test(k)) {
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
): Promise<{ url: string; creationTime: string } | null> {
  if (!BM_TOKEN) return null
  const clean = contact.replace(/\D/g, "")
  try {
    const desde = new Date(Date.now() - horas * 60 * 60 * 1000).toISOString()
    const r = await fetch(
      `https://api.botmaker.com/v2.0/messages?chat-platform=whatsapp&limit=250&from=${encodeURIComponent(desde)}`,
      { headers: { "access-token": BM_TOKEN, Accept: "application/json" }, cache: "no-store" },
    )
    if (!r.ok) return null
    const data = (await r.json().catch(() => ({}))) as {
      items?: Array<{ from?: string; creationTime?: string; chat?: { contactId?: string } } & Record<string, unknown>>
    }
    const conMedia = (data.items || [])
      .filter((m) => m.from === "user" && (m.chat?.contactId || "").replace(/\D/g, "") === clean)
      .map((m) => ({ creationTime: String(m.creationTime || ""), urls: urlsDeMedia(m) }))
      .filter((m) => m.urls.length > 0)
      .sort((a, b) => b.creationTime.localeCompare(a.creationTime))
    const top = conMedia[0]
    return top ? { url: top.urls[0], creationTime: top.creationTime } : null
  } catch (e) {
    console.error("[comprobante-adjunto] mediaEntranteReciente falló:", e)
    return null
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
    if (!buf.byteLength) return { ok: false, error: "media vacía" }
    const ext = contentType.includes("pdf")
      ? "pdf"
      : contentType.includes("png")
        ? "png"
        : contentType.includes("webp")
          ? "webp"
          : "jpg"
    const form = new FormData()
    form.append("file", new Blob([buf], { type: contentType }), `${filename}.${ext}`)
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
  } catch (e) {
    console.error(`[comprobante-adjunto] excepción quote=${quoteId}:`, e)
    return { ok: false, error: e instanceof Error ? e.message : "excepción" }
  }
}
