/**
 * PROMESAS DE CONTACTO HUMANO RASTREABLES (P1 27-ago, catastro de Rodrigo:
 * "pidió llamada" ×2 y "cotización por correo del ejecutivo" ×1 quedaban en
 * tierra de nadie si el humano no ejecutaba — plata parada de 25-30 personas).
 *
 * Regla: cada vez que VICKY promete que un humano hará algo ("te llama un
 * ejecutivo", "te llamamos a la hora que pediste"), la promesa queda REGISTRADA
 * con deadline en horas hábiles. El vigía (vic-ptv-cron) busca EVIDENCIA de
 * cumplimiento en el espejo (mensaje del vendedor `from_me` o llamada
 * posterior al registro); si venció sin evidencia → alerta interna y la
 * promesa queda visible en la Cartera como "alertada".
 *
 * Todo best-effort: registrar o vigilar jamás toca la conversación.
 */

import { avisarEquipoInterno } from "./alerta-interna"

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()

const H = () => ({
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
})

export type Promesa = {
  id: number
  contact: string
  tipo: string
  detalle?: string | null
  vendedor_email?: string | null
  creado_at: string
  deadline_at: string
  estado: string
}

/** Suma `horas` HÁBILES (L-V 8-18 Chile) desde `desde`, caminando hora a
 * hora — una promesa hecha un viernes 17:30 vence el lunes, no el sábado. */
export function sumarHorasHabiles(desde: Date, horas: number): Date {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Santiago",
    weekday: "short",
    hour: "numeric",
    hour12: false,
  })
  const HORA_MS = 3_600_000
  let t = desde.getTime()
  let restantes = Math.max(1, Math.round(horas))
  for (let pasos = 0; restantes > 0 && pasos < 24 * 14; pasos++) {
    t += HORA_MS
    const partes = fmt.formatToParts(new Date(t))
    const dia = partes.find((p) => p.type === "weekday")?.value || ""
    const hora = Number(partes.find((p) => p.type === "hour")?.value || "0")
    if (dia !== "Sat" && dia !== "Sun" && hora >= 8 && hora < 18) restantes--
  }
  return new Date(t)
}

/** Registra una promesa. Dedup: una promesa PENDIENTE del mismo contacto y
 * tipo en las últimas 24 h no se duplica (retries de tools). */
export async function registrarPromesa(p: {
  contact: string
  tipo: "llamada_ejecutivo" | "callback" | "cotizacion_por_correo"
  detalle?: string
  vendedorEmail?: string
  quoteId?: string
  horasHabiles?: number
}): Promise<boolean> {
  const contact = p.contact.replace(/\D/g, "")
  if (!contact || !SUPABASE_URL || !SUPABASE_KEY) return false
  try {
    const desde = new Date(Date.now() - 24 * 3600e3).toISOString()
    const rDup = await fetch(
      `${SUPABASE_URL}/rest/v1/vic_promesas?contact=eq.${contact}&tipo=eq.${p.tipo}&estado=eq.pendiente&creado_at=gte.${encodeURIComponent(desde)}&select=id&limit=1`,
      { headers: H(), cache: "no-store" },
    )
    const dup = rDup.ok ? ((await rDup.json().catch(() => [])) as unknown[]) : []
    if (dup.length > 0) return true
    const deadline = sumarHorasHabiles(new Date(), p.horasHabiles ?? 4)
    const r = await fetch(`${SUPABASE_URL}/rest/v1/vic_promesas`, {
      method: "POST",
      headers: H(),
      body: JSON.stringify({
        contact,
        tipo: p.tipo,
        detalle: (p.detalle || "").slice(0, 300) || null,
        vendedor_email: p.vendedorEmail || null,
        quote_id: p.quoteId || null,
        deadline_at: deadline.toISOString(),
      }),
      cache: "no-store",
    })
    return r.ok
  } catch {
    return false
  }
}

/** ¿Hay evidencia en el ESPEJO de que un humano contactó a este número
 * después de `desdeIso`? (mensaje del vendedor from_me o llamada). */
async function evidenciaDeContacto(contact: string, desdeIso: string): Promise<string> {
  const nueve = contact.slice(-9)
  try {
    const [rMsg, rCall] = await Promise.all([
      fetch(
        `${SUPABASE_URL}/rest/v1/vic_wa_espejo_mensajes?select=enviado_at,session_id&telefono_chat=like.*${nueve}&from_me=eq.true&es_grupo=eq.false&enviado_at=gte.${encodeURIComponent(desdeIso)}&order=enviado_at.asc&limit=1`,
        { headers: H(), cache: "no-store" },
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/vic_wa_espejo_llamadas?select=at,session_id&telefono=like.*${nueve}&at=gte.${encodeURIComponent(desdeIso)}&order=at.asc&limit=1`,
        { headers: H(), cache: "no-store" },
      ),
    ])
    const msgs = rMsg.ok ? ((await rMsg.json().catch(() => [])) as Array<{ enviado_at: string; session_id?: string }>) : []
    const calls = rCall.ok ? ((await rCall.json().catch(() => [])) as Array<{ at: string; session_id?: string }>) : []
    if (msgs[0]) return `whatsapp ${msgs[0].session_id || ""} ${msgs[0].enviado_at}`.trim()
    if (calls[0]) return `llamada ${calls[0].session_id || ""} ${calls[0].at}`.trim()
  } catch { /* espejo caído: sin evidencia por ahora */ }
  return ""
}

/** Vigía: promesas vencidas sin evidencia → alerta interna; con evidencia →
 * cumplida. Acotado por corrida; corre del vic-ptv-cron. */
export async function vigilarPromesas(max = 15): Promise<{ revisadas: number; cumplidas: number; alertadas: number }> {
  const out = { revisadas: 0, cumplidas: 0, alertadas: 0 }
  if (!SUPABASE_URL || !SUPABASE_KEY) return out
  const ahora = new Date().toISOString()
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/vic_promesas?estado=eq.pendiente&deadline_at=lt.${encodeURIComponent(ahora)}&order=deadline_at.asc&limit=${max}`,
    { headers: H(), cache: "no-store" },
  ).catch(() => null)
  if (!r || !r.ok) return out
  const filas = ((await r.json().catch(() => [])) as Promesa[]) || []
  for (const p of filas) {
    out.revisadas++
    const evidencia = await evidenciaDeContacto(p.contact, p.creado_at)
    if (evidencia) {
      await fetch(`${SUPABASE_URL}/rest/v1/vic_promesas?id=eq.${p.id}`, {
        method: "PATCH",
        headers: H(),
        body: JSON.stringify({ estado: "cumplida", evidencia }),
        cache: "no-store",
      }).catch(() => {})
      out.cumplidas++
      continue
    }
    const etiqueta =
      p.tipo === "callback" ? "llamada pedida por el cliente" : p.tipo === "cotizacion_por_correo" ? "cotización por correo" : "llamada de ejecutivo"
    await avisarEquipoInterno(
      `🤝⏰ PROMESA VENCIDA sin evidencia de contacto: ${etiqueta} a +${p.contact}` +
        (p.vendedor_email ? ` (responsable: ${p.vendedor_email})` : "") +
        (p.detalle ? ` — ${p.detalle}` : "") +
        `. Prometida ${p.creado_at.slice(0, 16)}Z, vencía ${p.deadline_at.slice(0, 16)}Z. Queda visible en la Cartera.`,
    ).catch(() => false)
    await fetch(`${SUPABASE_URL}/rest/v1/vic_promesas?id=eq.${p.id}`, {
      method: "PATCH",
      headers: H(),
      body: JSON.stringify({ estado: "alertada", alertado_at: new Date().toISOString() }),
      cache: "no-store",
    }).catch(() => {})
    out.alertadas++
  }
  return out
}
