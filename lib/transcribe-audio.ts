/**
 * Transcripción de notas de voz de WhatsApp.
 *
 * Botmaker NO transcribe; sí entrega la URL del audio (en AUDIOS_URLS). Acá
 * descargamos ese audio y lo transcribimos con ElevenLabs Scribe (speech-to-
 * text), usando ELEVENLABS_API_KEY. Devuelve el texto, o "" si algo falla (el
 * caller decide el fallback: pedir el mensaje por texto).
 *
 * Por qué ElevenLabs y no Groq/Whisper: Botmaker entrega las notas de voz de
 * WhatsApp en AAC (ADTS), y la API de Groq/Whisper NO acepta AAC crudo (solo
 * flac/mp3/mp4/mpeg/mpga/m4a/ogg/opus/wav/webm). ElevenLabs Scribe sí acepta
 * AAC directo, así evitamos transcodificar.
 */

const ELEVENLABS_STT_URL = "https://api.elevenlabs.io/v1/speech-to-text"
// scribe_v1: modelo de speech-to-text de ElevenLabs (multilingüe, alta calidad).
const STT_MODEL = (process.env.ELEVENLABS_STT_MODEL || "scribe_v1").trim()
// Límite defensivo de descarga (WhatsApp tope 16MB; las notas de voz son chicas).
const MAX_AUDIO_BYTES = 20 * 1024 * 1024

// Botmaker entrega las notas de voz de WhatsApp en AAC, pero por robustez
// mapeamos el content-type real (tras seguir el redirect) a un par
// extensión/MIME coherente. Default AAC (lo observado en producción).
function pickAudioFormat(rawType: string): { ext: string; mime: string } {
  if (rawType.includes("aac")) return { ext: "aac", mime: "audio/aac" }
  if (rawType.includes("mpeg") || rawType.includes("mp3")) return { ext: "mp3", mime: "audio/mpeg" }
  if (rawType.includes("mp4") || rawType.includes("m4a")) return { ext: "m4a", mime: "audio/mp4" }
  if (rawType.includes("opus") || rawType.includes("ogg")) return { ext: "ogg", mime: "audio/ogg" }
  if (rawType.includes("wav")) return { ext: "wav", mime: "audio/wav" }
  if (rawType.includes("webm")) return { ext: "webm", mime: "audio/webm" }
  return { ext: "aac", mime: "audio/aac" }
}

/**
 * Descarga el audio de `audioUrl` y lo transcribe a texto (español).
 * Best-effort: nunca lanza, devuelve "" ante cualquier problema.
 */
export async function transcribirAudio(audioUrl: string): Promise<string> {
  const apiKey = (process.env.ELEVENLABS_API_KEY || "").trim()
  if (!apiKey) {
    console.warn("[v3-audio] ELEVENLABS_API_KEY no configurada; no se transcribe")
    return ""
  }
  if (!audioUrl || !/^https?:\/\//i.test(audioUrl)) return ""

  try {
    // 1. Descargar el audio desde Botmaker (fetch sigue el redirect a la URL
    //    final de storage; de ahí sale el content-type real).
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
    const rawType = (audioRes.headers.get("content-type") || "").toLowerCase()
    const { ext, mime } = pickAudioFormat(rawType)

    // 2. Transcribir con ElevenLabs Scribe (multipart/form-data).
    const form = new FormData()
    form.append("file", new Blob([buf], { type: mime }), `audio.${ext}`)
    form.append("model_id", STT_MODEL)
    form.append("language_code", "spa") // español

    const res = await fetch(ELEVENLABS_STT_URL, {
      method: "POST",
      headers: { "xi-api-key": apiKey },
      body: form,
      cache: "no-store",
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => "")
      console.error(`[v3-audio] ElevenLabs ${res.status}: ${detail.slice(0, 200)}`)
      return ""
    }
    const data = (await res.json().catch(() => null)) as { text?: string } | null
    const texto = (data?.text || "").trim()
    console.log(`[v3-audio] transcrito ok (len=${texto.length}, model=${STT_MODEL})`)
    return texto
  } catch (err) {
    console.error("[v3-audio] excepción transcribiendo:", err)
    return ""
  }
}
