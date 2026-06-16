/**
 * Transcripción de notas de voz de WhatsApp.
 *
 * Botmaker NO transcribe; sí entrega la URL del audio (variable `audioURL`).
 * Acá descargamos ese audio y lo transcribimos con Groq (Whisper open-source
 * hospedado en Groq — NO es OpenAI), usando GROQ_API_KEY. La API de Groq es
 * compatible con el formato de OpenAI (mismo endpoint /audio/transcriptions),
 * así que el shape de request/response es idéntico. Devuelve el texto, o ""
 * si algo falla (el caller decide el fallback: pedir el mensaje por texto).
 *
 * Capa gratis de Groq: suficiente para el volumen de notas de voz de ventas.
 */

const GROQ_TRANSCRIBE_URL =
  "https://api.groq.com/openai/v1/audio/transcriptions"
// whisper-large-v3-turbo: el más rápido y barato; calidad sobrada en español.
const TRANSCRIBE_MODEL = (
  process.env.GROQ_TRANSCRIBE_MODEL || "whisper-large-v3-turbo"
).trim()
// Límite defensivo de descarga (WhatsApp tope 16MB; las notas de voz son chicas).
const MAX_AUDIO_BYTES = 20 * 1024 * 1024

/**
 * Descarga el audio de `audioUrl` y lo transcribe a texto (español).
 * Best-effort: nunca lanza, devuelve "" ante cualquier problema.
 */
export async function transcribirAudio(audioUrl: string): Promise<string> {
  const apiKey = (process.env.GROQ_API_KEY || "").trim()
  if (!apiKey) {
    console.warn("[v3-audio] GROQ_API_KEY no configurada; no se transcribe")
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
    // Botmaker (botm.cc) a veces sirve la nota de voz con content-type
    // "text/html" aunque los bytes sean audio. No confiamos en el header si no
    // es audio/*: WhatsApp manda las notas de voz en ogg/opus.
    const rawType = (audioRes.headers.get("content-type") || "").toLowerCase()
    const ext = rawType.includes("mpeg")
      ? "mp3"
      : rawType.includes("mp4") || rawType.includes("m4a")
        ? "m4a"
        : rawType.includes("wav")
          ? "wav"
          : "ogg"
    const blobType = rawType.startsWith("audio/") ? rawType : "audio/ogg"

    // 2. Transcribir con Groq (formato compatible con OpenAI).
    const form = new FormData()
    form.append("file", new Blob([buf], { type: blobType }), `audio.${ext}`)
    form.append("model", TRANSCRIBE_MODEL)
    form.append("language", "es")
    form.append("response_format", "json")

    const res = await fetch(GROQ_TRANSCRIBE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      cache: "no-store",
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => "")
      console.error(`[v3-audio] Groq ${res.status}: ${detail.slice(0, 200)}`)
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
