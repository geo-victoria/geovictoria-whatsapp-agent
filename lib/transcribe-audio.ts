/**
 * Transcripción de notas de voz de WhatsApp.
 *
 * Botmaker NO transcribe; sí entrega la URL del audio (variable `audioURL`).
 * Acá descargamos ese audio y lo transcribimos con OpenAI (Whisper), usando la
 * OPENAI_API_KEY que el proyecto ya tiene configurada. Devuelve el texto, o ""
 * si algo falla (el caller decide el fallback: pedir el mensaje por texto).
 */

const OPENAI_TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions"
const TRANSCRIBE_MODEL = (
  process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1"
).trim()
// Límite defensivo de descarga (WhatsApp tope 16MB; las notas de voz son chicas).
const MAX_AUDIO_BYTES = 20 * 1024 * 1024

/**
 * Descarga el audio de `audioUrl` y lo transcribe a texto (español).
 * Best-effort: nunca lanza, devuelve "" ante cualquier problema.
 */
export async function transcribirAudio(audioUrl: string): Promise<string> {
  const apiKey = (process.env.OPENAI_API_KEY || "").trim()
  if (!apiKey) {
    console.warn("[v3-audio] OPENAI_API_KEY no configurada; no se transcribe")
    return ""
  }
  if (!audioUrl || !/^https?:\/\//i.test(audioUrl)) return ""

  try {
    // 1. Descargar el audio desde Botmaker.
    const audioRes = await fetch(audioUrl, { cache: "no-store" })
    if (!audioRes.ok) {
      console.error(`[v3-audio] descarga falló: HTTP ${audioRes.status}`)
      return ""
    }
    const buf = await audioRes.arrayBuffer()
    if (buf.byteLength === 0 || buf.byteLength > MAX_AUDIO_BYTES) {
      console.error(`[v3-audio] audio inválido (bytes=${buf.byteLength})`)
      return ""
    }
    const contentType = audioRes.headers.get("content-type") || "audio/ogg"
    const ext = contentType.includes("mpeg")
      ? "mp3"
      : contentType.includes("mp4") || contentType.includes("m4a")
        ? "m4a"
        : contentType.includes("wav")
          ? "wav"
          : "ogg"

    // 2. Transcribir con OpenAI.
    const form = new FormData()
    form.append("file", new Blob([buf], { type: contentType }), `audio.${ext}`)
    form.append("model", TRANSCRIBE_MODEL)
    form.append("language", "es")

    const res = await fetch(OPENAI_TRANSCRIBE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      cache: "no-store",
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => "")
      console.error(`[v3-audio] OpenAI ${res.status}: ${detail.slice(0, 200)}`)
      return ""
    }
    const data = (await res.json().catch(() => null)) as { text?: string } | null
    const texto = (data?.text || "").trim()
    console.log(`[v3-audio] transcrito ok (len=${texto.length}, model=${TRANSCRIBE_MODEL})`)
    return texto
  } catch (err) {
    console.error("[v3-audio] excepción transcribiendo:", err)
    return ""
  }
}
