/**
 * Utilidades del canal de VOZ (Dapta) — la misma Vicky por teléfono.
 *
 * - parseFechaRecontacto: convierte el "cuándo te acomoda que te llame" dicho
 *   en la llamada ("mañana a las 4", "el jueves en la mañana") a un timestamp
 *   concreto en America/Santiago, con Haiku (mismo patrón de extracción que
 *   nombreDesdeHistorial).
 * - vic_scheduled_calls: agenda de llamadas devueltas. El post-llamada inserta,
 *   vic-callback-cron dispara las vencidas re-invocando el flujo de Dapta.
 */

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
const MODELO_EXTRACCION = (
  process.env.MODELO_SIMPLE || "claude-haiku-4-5-20251001"
).trim()

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
}

/**
 * Interpreta la petición de recontacto del cliente y devuelve un ISO timestamp
 * (UTC) o null si no hay fecha/hora interpretable. `llamadaAt` ancla el
 * "mañana"/"el jueves" al momento real de la llamada.
 */
export async function parseFechaRecontacto(
  texto: string,
  llamadaAt: Date,
): Promise<string | null> {
  const apiKey = (process.env.ANTHROPIC_API_KEY || "").trim()
  if (!apiKey || !texto.trim()) return null

  const ahoraChile = llamadaAt.toLocaleString("es-CL", {
    timeZone: "America/Santiago",
    dateStyle: "full",
    timeStyle: "short",
  })
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODELO_EXTRACCION,
        max_tokens: 100,
        messages: [
          {
            role: "user",
            content:
              `Ahora en Chile es: ${ahoraChile}.\n` +
              `Un cliente pidió por teléfono que lo llamen de vuelta: "${texto.trim()}".\n` +
              `Responde SOLO con la fecha y hora concreta del recontacto en formato ` +
              `YYYY-MM-DD HH:MM (hora de Chile continental). Reglas: si dio solo el día sin hora, usa 10:00; ` +
              `"en la mañana"=10:00, "a mediodía"=12:00, "en la tarde"=16:00, "después"/"más tarde" sin día=suma 3 horas; ` +
              `si pidió que lo llamen de vuelta SIN indicar cuándo ("llámame de vuelta", "no te escucho, llámame", "en un rato") = suma 15 minutos; ` +
              `si la hora resultante cae antes de las 09:00 o después de las 19:00, muévela al siguiente horario hábil (09:00-19:00, lunes a viernes). ` +
              `Solo si el texto descarta explícitamente el recontacto o no dice nada sobre volver a llamar, responde exactamente: NO`,
          },
        ],
      }),
      cache: "no-store",
    })
    if (!res.ok) return null
    const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> }
    const out = (data.content?.find((c) => c.type === "text")?.text || "").trim()
    const m = out.match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/)
    if (!m) return null
    // Chile continental: UTC-4 (invierno). Suficiente para agendar el tick del
    // cron; el cron corre cada 10 min así que ±1h de DST no rompe el flujo,
    // pero lo dejamos anotado por si se retoma el huso de verano (UTC-3).
    const iso = new Date(`${m[1]}T${m[2]}:00-04:00`).toISOString()
    return iso
  } catch (e) {
    console.error("[dapta-voice] parseFechaRecontacto falló:", e)
    return null
  }
}

export type ScheduledCall = {
  id: string
  contact: string
  due_at: string
  payload: Record<string, unknown>
  status: string
}

/**
 * Agenda una llamada devuelta. Cancela cualquier otra pendiente del mismo
 * contacto (la petición más reciente manda).
 */
export async function scheduleCallback(
  contact: string,
  dueAtIso: string,
  payload: Record<string, unknown>,
): Promise<boolean> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return false
  await fetch(
    `${SUPABASE_URL}/rest/v1/vic_scheduled_calls?contact=eq.${contact}&status=eq.pending`,
    {
      method: "PATCH",
      headers: { ...HEADERS, Prefer: "return=minimal" },
      body: JSON.stringify({ status: "superseded" }),
      cache: "no-store",
    },
  ).catch(() => {})
  const res = await fetch(`${SUPABASE_URL}/rest/v1/vic_scheduled_calls`, {
    method: "POST",
    headers: { ...HEADERS, Prefer: "return=minimal" },
    body: JSON.stringify({ contact, due_at: dueAtIso, payload, status: "pending" }),
    cache: "no-store",
  })
  return res.ok
}

/** Reclama (atómicamente vía status swap) las llamadas vencidas. */
export async function claimDueCallbacks(limit = 5): Promise<ScheduledCall[]> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return []
  const now = new Date().toISOString()
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/vic_scheduled_calls?status=eq.pending&due_at=lte.${now}` +
      `&order=due_at.asc&limit=${limit}`,
    { headers: HEADERS, cache: "no-store" },
  )
  if (!res.ok) return []
  const rows = ((await res.json()) as ScheduledCall[]) || []
  const claimed: ScheduledCall[] = []
  for (const r of rows) {
    // Swap pending→calling con filtro por status: si otro tick ya lo tomó, el
    // PATCH no matchea filas y lo saltamos.
    const patch = await fetch(
      `${SUPABASE_URL}/rest/v1/vic_scheduled_calls?id=eq.${r.id}&status=eq.pending`,
      {
        method: "PATCH",
        headers: { ...HEADERS, Prefer: "return=representation" },
        body: JSON.stringify({ status: "calling" }),
        cache: "no-store",
      },
    )
    const updated = patch.ok ? ((await patch.json().catch(() => [])) as unknown[]) : []
    if (updated.length > 0) claimed.push(r)
  }
  return claimed
}

/**
 * ¿El cliente aceptó la llamada anunciada? Clasifica su(s) respuesta(s) al
 * mensaje "¿te parece si te llamo?".
 *   "si"   → aceptó (llamar)
 *   "no"   → la rechazó (respetar: NO llamar)
 *   "otro" → respondió otra cosa (la Vicky de texto ya está conversando con
 *            él: no interrumpir con una llamada no consentida)
 */
export async function clasificarConsentimiento(respuestas: string): Promise<"si" | "no" | "otro"> {
  const apiKey = (process.env.ANTHROPIC_API_KEY || "").trim()
  if (!apiKey || !respuestas.trim()) return "otro"
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODELO_EXTRACCION,
        max_tokens: 5,
        messages: [
          {
            role: "user",
            content:
              `Le preguntamos a un cliente por WhatsApp: "¿te parece si te llamo a tu celular y conversamos?". ` +
              `Respondió: "${respuestas.trim().slice(0, 500)}".\n` +
              `¿Aceptó que lo llamemos? Responde SOLO una palabra: SI (aceptó), NO (rechazó o pidió no llamar), OTRO (respondió otra cosa / no se refiere a la llamada).`,
          },
        ],
      }),
      cache: "no-store",
    })
    if (!res.ok) return "otro"
    const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> }
    const out = (data.content?.find((c) => c.type === "text")?.text || "").trim().toUpperCase()
    if (out.startsWith("SI")) return "si"
    if (out.startsWith("NO")) return "no"
    return "otro"
  } catch {
    return "otro"
  }
}

/** Mensajes del CLIENTE posteriores a un instante (para el gate de consentimiento). */
export async function fetchUserRepliesSince(contact: string, sinceIso: string): Promise<string[]> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return []
  const conv = await fetch(
    `${SUPABASE_URL}/rest/v1/vic_v3_conversations?contact=eq.${encodeURIComponent(contact)}&select=id&limit=1`,
    { headers: HEADERS, cache: "no-store" },
  )
  if (!conv.ok) return []
  const rows = ((await conv.json()) as Array<{ id: string }>) || []
  if (!rows.length) return []
  const msgs = await fetch(
    `${SUPABASE_URL}/rest/v1/vic_v3_messages?conversation_id=eq.${rows[0].id}` +
      `&role=eq.user&at=gt.${encodeURIComponent(sinceIso)}&select=content&order=at.asc&limit=10`,
    { headers: HEADERS, cache: "no-store" },
  )
  if (!msgs.ok) return []
  return (((await msgs.json()) as Array<{ content: string }>) || []).map((m) => m.content || "")
}

export async function markCallbackDone(
  id: string,
  status: "done" | "failed" | "declined" | "skipped",
): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return
  await fetch(`${SUPABASE_URL}/rest/v1/vic_scheduled_calls?id=eq.${id}`, {
    method: "PATCH",
    headers: { ...HEADERS, Prefer: "return=minimal" },
    body: JSON.stringify({ status, fired_at: new Date().toISOString() }),
    cache: "no-store",
  }).catch(() => {})
}
