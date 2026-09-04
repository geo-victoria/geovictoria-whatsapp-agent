/**
 * Lectura de imágenes Y PDFs de WhatsApp (fotos, pantallazos, comprobantes).
 *
 * Botmaker NO interpreta archivos; sí entrega la URL. Acá lo descargamos y lo
 * "transcribimos" con visión (Claude Haiku): descripción fiel + texto legible
 * extraído. Los PDF van como bloque `document` de la API (decisión Lalo
 * 25-jul: todo comprobante va a Vicky y debe poder leer imagen y PDF — antes
 * el PDF se descartaba y solo quedaba un placeholder ciego). El caller
 * inserta ese texto en el flujo normal como si el cliente lo hubiera escrito
 * (mismo patrón que las notas de voz). Devuelve "" si algo falla (el caller
 * decide el fallback).
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
// PDFs (comprobantes, cotizaciones): el tope de request de la API es 32MB;
// 10MB en crudo (~13MB en base64) deja margen holgado.
const MAX_PDF_BYTES = 10 * 1024 * 1024

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

const PROMPT_VISION_PDF =
  "Eres los ojos de Vicky, ejecutiva comercial de GeoVictoria (plataforma de control de asistencia laboral) en WhatsApp. " +
  "Un prospecto o cliente envió este documento PDF en la conversación. Descríbelo en español, breve y FIEL, para que Vicky pueda responder: " +
  "(1) qué tipo de documento es y qué parece querer comunicar (si es un comprobante de transferencia: monto, banco, fecha, destinatario y nro de operación); " +
  "(2) TRANSCRIBE textualmente todo dato relevante (montos, RUT/NIT, correos, fechas, nombres). " +
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
    const rawType = (imgRes.headers.get("content-type") || "").toLowerCase()
    const bytes = new Uint8Array(buf)
    // PDF por bytes mágicos (%PDF) — el content-type de Botmaker no es fiable.
    const esPdf =
      (bytes.length > 3 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) ||
      rawType.includes("pdf")
    if (buf.byteLength === 0 || buf.byteLength > (esPdf ? MAX_PDF_BYTES : MAX_IMAGE_BYTES)) {
      // Un adjunto vacío o más pesado que el tope no es una falla nuestra: es
      // lo que mandó el cliente, y el lector lo rechaza bien (con tope de 3
      // intentos en el cron). Va en warn para no ocupar el panel de errores.
      console.warn(`[v3-imagen] archivo inválido (bytes=${buf.byteLength}, pdf=${esPdf})`)
      return ""
    }
    // EXCEL (.xlsx = zip) — 25-ago, F2 nómina multi-modal: la visión no lee
    // binarios; la planilla se transcribe a texto tabular y ESO es la
    // "descripción" (el modelo la procesa igual que una nómina pegada).
    if (!esPdf) {
      const { esZip, excelATexto } = await import("./leer-excel")
      if (esZip(bytes)) {
        const tabla = excelATexto(bytes)
        if (tabla) {
          console.log(`[v3-imagen] planilla Excel transcrita (${tabla.length} chars)`)
          return `Planilla Excel adjunta — contenido transcrito fila por fila (columnas separadas por tab):\n${tabla}`
        }
        console.warn(`[v3-imagen] zip sin hoja de cálculo legible: ${rawType}`)
        return ""
      }
      // CSV / texto plano tabular.
      if (rawType.includes("csv") || rawType.startsWith("text/")) {
        const texto = Buffer.from(buf).toString("utf8").slice(0, 8000).trim()
        if (texto) return `Archivo de texto adjunto — contenido:\n${texto}`
      }
    }
    const mime = esPdf ? null : pickImageMime(bytes, rawType)
    if (!esPdf && !mime) {
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
              esPdf
                ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } }
                : { type: "image", source: { type: "base64", media_type: mime, data: b64 } },
              { type: "text", text: esPdf ? PROMPT_VISION_PDF : PROMPT_VISION },
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
