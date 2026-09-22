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


/**
 * DUEÑO REAL DE LA PROMESA (03-sep). Las 33 promesas registradas desde el
 * 29-ago nacieron con `vendedor_email` en NULL, y las 20 que vencieron
 * generaron alertas sin destinatario: "promesa vencida con +569…" sin decir
 * de quién era. Nadie persigue una carta sin dirección.
 *
 * La causa era de ORDEN: se preguntaba quién era el responsable en el mismo
 * instante de la derivación, ANTES de que la tómbola lo decidiera. Por eso
 * ahora se resuelve TARDE, cuando el vigía pasa — para entonces el traspaso ya
 * ocurrió y `vic_ptv` tiene al dueño real.
 */
async function duenoDeLaPromesa(contact: string): Promise<string> {
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/vic_ptv?contact=eq.${encodeURIComponent(contact)}&select=vendedor_email&order=traspasado_at.desc&limit=1`,
      { headers: H(), cache: "no-store" },
    )
    const filas = r.ok ? ((await r.json().catch(() => [])) as Array<{ vendedor_email?: string }>) : []
    if (filas[0]?.vendedor_email) return filas[0].vendedor_email
  } catch { /* sigue el fallback */ }
  try {
    const { getKvValue } = await import("./supabase-persistence-v3")
    const raw = await getKvValue(`ejec_sobre_umbral_${contact.replace(/\D/g, "")}`)
    if (raw) {
      const j = JSON.parse(raw) as { email?: string }
      if (j?.email) return j.email
    }
  } catch { /* sin dueño */ }
  return ""
}

/** Horas hábiles que espera una promesa YA alertada antes de escalar. */
const HORAS_PARA_ESCALAR = 4

/** Vigía: promesas vencidas sin evidencia → alerta interna; con evidencia →
 * cumplida. Acotado por corrida; corre del vic-ptv-cron. */
export async function vigilarPromesas(max = 15): Promise<{ revisadas: number; cumplidas: number; alertadas: number }> {
  const out = { revisadas: 0, cumplidas: 0, alertadas: 0 }
  if (!SUPABASE_URL || !SUPABASE_KEY) return out
  const ahora = new Date().toISOString()
  const r = await fetch(
    // ALERTADA YA NO ES TERMINAL (03-sep): antes el vigía solo miraba
    // `pendiente`, así que una promesa alertada nunca se volvía a revisar —
    // ni para marcarla cumplida si alguien la atendía tarde, ni para escalar
    // si seguía sin nadie. Un aviso al vacío y se acababa.
    `${SUPABASE_URL}/rest/v1/vic_promesas?estado=in.(pendiente,alertada)&deadline_at=lt.${encodeURIComponent(ahora)}&order=deadline_at.asc&limit=${max}`,
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

    // El dueño se resuelve ACÁ, no al registrar: para este momento la tómbola
    // ya corrió y vic_ptv tiene al responsable real. Si aparece, se persiste
    // para que la Cartera y el correo diario también lo muestren.
    const responsable = p.vendedor_email || (await duenoDeLaPromesa(p.contact))

    // SEGUNDA VUELTA = ESCALAMIENTO. Una promesa ya alertada que sigue sin
    // evidencia pasadas 4 horas hábiles deja de ser un aviso más: se escala,
    // nombrando al responsable, y se cierra el ciclo del vigía para no repetir
    // el mismo grito cada 10 minutos.
    if (p.estado === "alertada") {
      const desdeAlerta = Date.parse(String((p as { alertado_at?: string }).alertado_at || p.deadline_at))
      const vence = Number.isFinite(desdeAlerta) ? sumarHorasHabiles(new Date(desdeAlerta), HORAS_PARA_ESCALAR) : null
      if (!vence || vence.getTime() > Date.now()) continue
      await avisarEquipoInterno(
        `🚨 ESCALAMIENTO — promesa incumplida hace ${HORAS_PARA_ESCALAR} h hábiles: ${etiqueta} a +${p.contact}` +
          (responsable ? ` · responsable: ${responsable}` : " · SIN RESPONSABLE ASIGNADO") +
          (p.detalle ? ` — ${p.detalle}` : "") +
          `. El cliente PIDIÓ que lo contactaran y nadie lo hizo. Necesita que alguien lo tome AHORA.`,
      ).catch(() => false)
      await fetch(`${SUPABASE_URL}/rest/v1/vic_promesas?id=eq.${p.id}`, {
        method: "PATCH",
        headers: H(),
        body: JSON.stringify({ estado: "escalada", vendedor_email: responsable || null }),
        cache: "no-store",
      }).catch(() => {})
      out.alertadas++
      continue
    }

    await avisarEquipoInterno(
      `🤝⏰ PROMESA VENCIDA sin evidencia de contacto: ${etiqueta} a +${p.contact}` +
        (responsable ? ` · RESPONSABLE: ${responsable}` : " · SIN RESPONSABLE ASIGNADO") +
        (p.detalle ? ` — ${p.detalle}` : "") +
        `. Prometida ${p.creado_at.slice(0, 16)}Z, vencía ${p.deadline_at.slice(0, 16)}Z. Queda visible en la Cartera.`,
    ).catch(() => false)
    await fetch(`${SUPABASE_URL}/rest/v1/vic_promesas?id=eq.${p.id}`, {
      method: "PATCH",
      headers: H(),
      body: JSON.stringify({
        estado: "alertada",
        alertado_at: new Date().toISOString(),
        vendedor_email: responsable || null,
      }),
      cache: "no-store",
    }).catch(() => {})
    out.alertadas++
  }
  return out
}
