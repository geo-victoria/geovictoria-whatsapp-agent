/**
 * NOTA DE CONVERSACIÓN EN EL LEAD — para que el ejecutivo llegue sabiendo qué
 * se conversó, no con un teléfono pelado.
 *
 * NACE DE UN HUECO (03-sep): la transcripción viajaba bien a los DEALS
 * (actualizarNotaTranscripcion, llamada en 7 puntos) y al lead que entrega el
 * cron, pero NO cuando la escalera dejaba el caso como lead pre-formal —
 * justo el camino de "quiero que me llamen" antes de calificar. El ejecutivo
 * recibía nombre y teléfono, sin saber de qué habían hablado.
 *
 * El armador vivía dentro de vic-ptv-cron; acá queda compartido para que los
 * dos caminos escriban exactamente la misma nota.
 */

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()

const H = () => ({
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
})

async function sb<T>(path: string): Promise<T[]> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return []
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: H(), cache: "no-store" })
    return r.ok ? ((await r.json().catch(() => [])) as T[]) : []
  } catch {
    return []
  }
}

/** Últimos 25 mensajes en orden cronológico, sin los registros internos. */
export async function transcriptReciente(contact: string): Promise<string> {
  const fono = (contact || "").replace(/\D/g, "")
  if (!fono) return ""
  const conv = await sb<{ id: string }>(`vic_v3_conversations?contact=eq.${fono}&select=id&limit=1`)
  if (!conv[0]?.id) return ""
  const msgs = await sb<{ role: string; content: string; at: string }>(
    `vic_v3_messages?conversation_id=eq.${conv[0].id}&select=role,content,at&order=at.desc&limit=25`,
  )
  return msgs
    .reverse()
    .filter((m) => !String(m.content || "").startsWith("[REGISTRO INTERNO"))
    .map(
      (m) =>
        `${String(m.at || "").slice(11, 16)} ${m.role === "user" ? "CLIENTE" : "Vicky"}: ${String(m.content || "").slice(0, 500)}`,
    )
    .join("\n")
}

/**
 * Cuerpo de la nota: link al chat + transcripción. Cuando NO hay conversación
 * lo dice explícito — así nadie pierde diez minutos buscando en el bot un chat
 * que no existe (típico del que llenó el formulario y nunca escribió).
 */
export function cuerpoNotaConversacion(contact: string, transcript: string, chatUrl?: string): string {
  const fono = (contact || "").replace(/\D/g, "")
  const cabecera = chatUrl
    ? `👉 Habla directo con el prospecto en Botmaker: ${chatUrl}\n\n`
    : `👉 Chat en Botmaker: busca el contacto +${fono} en go.botmaker.com\n\n`
  return (
    cabecera +
    (transcript
      ? `CONVERSACIÓN RECIENTE CON VICKY:\n${transcript}`
      : "SIN CONVERSACIÓN: este contacto no ha escrito por WhatsApp (típico: llenó el formulario de la landing y no siguió al chat). No hay transcript que buscar en el bot — llamar directo.")
  )
}

/** Deja la nota en el lead. Best-effort: nunca rompe el flujo que la llama. */
export async function dejarNotaConversacionEnLead(leadId: string, contact: string): Promise<boolean> {
  if (!leadId) return false
  try {
    const transcript = await transcriptReciente(contact)
    const { agregarNotaLead } = await import("./zoho-leads")
    return await agregarNotaLead(
      leadId,
      "Traspaso de Vicky — conversación y chat directo",
      cuerpoNotaConversacion(contact, transcript),
    )
  } catch {
    return false
  }
}
