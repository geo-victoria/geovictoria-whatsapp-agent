/**
 * Lectura de imágenes de WhatsApp (fotos, pantallazos, documentos fotografiados).
 *
 * Botmaker NO interpreta imágenes; sí entrega la URL del archivo. Acá la
 * descargamos y la "transcribimos" con visión (Claude Haiku): descripción
 * fiel + texto legible extraído. El caller inserta ese texto en el flujo
 * normal como si el cliente lo hubiera escrito (mismo patrón que las notas
 * de voz en transcribe-audio.ts). Devuelve "" si algo falla (el caller decide
 * el fallback: pedir el mensaje por texto).
 */

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
// Visión barata y suficiente para describir/extraer texto. Override por env.
const VISION_MODEL = (
  process.env.MODELO_VISION ||
  process.env.MODELO_SIMPLE ||
  "claude-haiku-4-5-20251001"
).trim()
// Límite defensivo (WhatsApp comprime fotos; el tope de la API es 5MB/imagen).
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

type ImageMime = "image/jpeg" | "image/png" | "image/gif" | "image/webp"

// La API de visión solo acepta estos cuatro formatos. El content-type del
// storage de Botmaker no es confiable (suele ser application/octet-stream),
// así que primero detectamos por BYTES MÁGICOS y el header queda de respaldo.
function pickImageMime(bytes: Uint8Array, rawType: string): ImageMime | null {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"
  if (bytes.length > 7 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png"
  if (bytes.length > 5 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "image/gif"
  if (
    bytes.length > 11 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return "image/webp"
  // PDF (%PDF): no se procesa como imagen.
  if (bytes.length > 3 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return null
  if (rawType.includes("jpeg") || rawType.includes("jpg")) return "image/jpeg"
  if (rawType.includes("png")) return "image/png"
  if (rawType.includes("gif")) return "image/gif"
  if (rawType.includes("webp")) return "image/webp"
  if (rawType.includes("pdf")) return null
  return "image/jpeg"
}

const PROMPT_VISION =
  "Eres los ojos de Vicky, ejecutiva comercial de GeoVictoria (plataforma de control de asistencia laboral) en WhatsApp. " +
  "Un prospecto o cliente envió esta imagen en la conversación. Descríbela en español, breve y FIEL, para que Vicky pueda responder: " +
  "(1) qué se ve y qué parece querer comunicar; " +
  "(2) TRANSCRIBE textualmente todo texto legible relevante (pantallazos, cotizaciones, documentos, errores en pantalla, datos de contacto). " +
  "No inventes nada: si algo no se distingue, dilo. Máximo ~150 palabras. Responde SOLO con la descripción, sin preámbulos."

/**
 * Descarga la imagen de `imageUrl` y devuelve una descripción textual fiel
 * (con el texto visible transcrito). Best-effort: nunca lanza, devuelve ""
 * ante cualquier problema.
 */
export async function describirImagen(imageUrl: string): Promise<string> {
  const apiKey = (process.env.ANTHROPIC_API_KEY || "").trim()
  if (!apiKey) {
    console.warn("[v3-imagen] ANTHROPIC_API_KEY no configurada; no se describe")
    return ""
  }
  if (!imageUrl || !/^https?:\/\//i.test(imageUrl)) return ""

  try {
    // 1. Descargar la imagen desde Botmaker (fetch sigue el redirect al storage).
    const imgRes = await fetch(imageUrl, { cache: "no-store" })
    if (!imgRes.ok) {
      console.error(`[v3-imagen] descarga falló: HTTP ${imgRes.status}`)
      return ""
    }
    const buf = await imgRes.arrayBuffer()
    if (buf.byteLength === 0 || buf.byteLength > MAX_IMAGE_BYTES) {
      console.error(`[v3-imagen] imagen inválida (bytes=${buf.byteLength})`)
      return ""
    }
    const rawType = (imgRes.headers.get("content-type") || "").toLowerCase()
    const bytes = new Uint8Array(buf)
    const mime = pickImageMime(bytes, rawType)
    if (!mime) {
      console.warn(`[v3-imagen] tipo no soportado como imagen: ${rawType}`)
      return ""
    }
    const b64 = Buffer.from(buf).toString("base64")

    // 2. Describir con visión.
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: VISION_MODEL,
        max_tokens: 400,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mime, data: b64 } },
              { type: "text", text: PROMPT_VISION },
            ],
          },
        ],
      }),
      cache: "no-store",
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => "")
      console.error(`[v3-imagen] visión ${res.status}: ${detail.slice(0, 200)}`)
      return ""
    }
    const data = (await res.json().catch(() => null)) as {
      content?: Array<{ type?: string; text?: string }>
    } | null
    const texto = (data?.content || [])
      .filter((b) => b?.type === "text")
      .map((b) => b.text || "")
      .join("")
      .trim()
    console.log(`[v3-imagen] descrita ok (len=${texto.length}, model=${VISION_MODEL})`)
    return texto
  } catch (err) {
    console.error("[v3-imagen] excepción describiendo:", err)
    return ""
  }
}
