/**
 * USO DEL DASH POR PERSONA (Ignacio 24-sep-2026, acordado con Lalo): quién
 * entra al selector de deals, abre la calculadora comercial, baja el PDF o
 * emite, y quién usa el editor de cotizaciones. Es el mismo marcador de uso
 * que tiene el portal comercial, traído acá porque la gente cotiza en este
 * dash y no en el portal.
 *
 * Un contador por (día CL, persona, evento) en vic_kv:
 *   key   = uso_<YYYY-MM-DD>_<persona>_<evento>
 *   value = JSON { n, primero, ultimo, quien, detalle }
 * Read-modify-write best-effort: dos clics en el mismo segundo pueden contar
 * uno y no importa — la pregunta es SI la persona usa la herramienta y cuándo,
 * no el conteo exacto. TTL 180 días por expires_at (como pf_*). Solo sesiones
 * HUMANAS (cookie vic_quien): el acceso máquina por ?key= no cuenta.
 * Lo consume `vista=uso` del dash (solo Administrador). Nada de esto puede
 * afectar la acción que lo dispara: todo va en catch silencioso.
 *
 * Las funciones puras (slug, clave, parseo, agregación) las vigila
 * tests/uso-dash.test.ts.
 */

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const TTL_DIAS = 180

export const EVENTOS_USO = ["selector", "calc_abrio", "calc_pdf", "calc_emitio", "editor"] as const
export type EventoUso = (typeof EVENTOS_USO)[number]

export const ETIQUETA_EVENTO: Record<EventoUso, string> = {
  selector: "Eligió oportunidad",
  calc_abrio: "Abrió la calculadora",
  calc_pdf: "Bajó PDF",
  calc_emitio: "Emitió",
  editor: "Editor de cotizaciones",
}

export type RegistroUso = {
  n: number
  primero: string
  ultimo: string
  quien: string
  detalle?: string
}

/** Fecha YYYY-MM-DD en hora de Chile. */
export function fechaCL(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Santiago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d)
}

/** "Ana Paula Pérez" → "ana-paula-perez"; sin tildes, solo [a-z0-9-], máx 40. */
export function slugPersona(quien: string): string {
  return String(quien || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "")
}

export function claveUso(fecha: string, slug: string, evento: EventoUso): string {
  return `uso_${fecha}_${slug}_${evento}`
}

/** Inverso de claveUso. El slug no lleva "_" y el evento sí puede, así que
 * el evento se reconoce por sufijo contra la lista blanca. */
export function parseClaveUso(key: string): { fecha: string; slug: string; evento: EventoUso } | null {
  const m = /^uso_(\d{4}-\d{2}-\d{2})_(.+)$/.exec(key)
  if (!m) return null
  const resto = m[2]
  for (const ev of EVENTOS_USO) {
    if (resto.endsWith(`_${ev}`)) {
      const slug = resto.slice(0, -(ev.length + 1))
      if (!slug) return null
      return { fecha: m[1], slug, evento: ev }
    }
  }
  return null
}

export function parseRegistro(value: string): RegistroUso | null {
  try {
    const v = JSON.parse(value) as Partial<RegistroUso>
    const n = Number(v.n)
    if (!Number.isFinite(n) || n < 0) return null
    return {
      n,
      primero: String(v.primero || ""),
      ultimo: String(v.ultimo || ""),
      quien: String(v.quien || ""),
      detalle: v.detalle ? String(v.detalle) : undefined,
    }
  } catch {
    return null
  }
}

/** Suma un uso sobre el registro anterior (o crea uno). Puro. */
export function sumarUso(prev: RegistroUso | null, quien: string, ahoraISO: string, detalle?: string): RegistroUso {
  return {
    n: (prev?.n || 0) + 1,
    primero: prev?.primero || ahoraISO,
    ultimo: ahoraISO,
    quien: prev?.quien || quien,
    detalle: detalle || prev?.detalle,
  }
}

export type FilaKv = { key: string; value: string }

export type ResumenPersona = {
  slug: string
  quien: string
  total: number
  porEvento: Record<EventoUso, number>
  dias: number
  ultimo: string
}

export type ResumenDia = {
  fecha: string
  total: number
  personas: number
  porEvento: Record<EventoUso, number>
}

function ceros(): Record<EventoUso, number> {
  return { selector: 0, calc_abrio: 0, calc_pdf: 0, calc_emitio: 0, editor: 0 }
}

/** Agrega las filas crudas de vic_kv en dos tablas: por persona y por día.
 * Filas que no parsean se ignoran. Orden: personas por total desc, días
 * más reciente primero. */
export function agregarUso(filas: FilaKv[]): { personas: ResumenPersona[]; dias: ResumenDia[] } {
  const porPersona = new Map<string, ResumenPersona & { diasSet: Set<string> }>()
  const porDia = new Map<string, ResumenDia & { personasSet: Set<string> }>()
  for (const f of filas) {
    const k = parseClaveUso(String(f.key || ""))
    const r = parseRegistro(String(f.value || ""))
    if (!k || !r) continue
    let p = porPersona.get(k.slug)
    if (!p) {
      p = { slug: k.slug, quien: r.quien || k.slug, total: 0, porEvento: ceros(), dias: 0, ultimo: "", diasSet: new Set() }
      porPersona.set(k.slug, p)
    }
    p.total += r.n
    p.porEvento[k.evento] += r.n
    p.diasSet.add(k.fecha)
    if (r.ultimo > p.ultimo) p.ultimo = r.ultimo
    if (!p.quien && r.quien) p.quien = r.quien
    let d = porDia.get(k.fecha)
    if (!d) {
      d = { fecha: k.fecha, total: 0, personas: 0, porEvento: ceros(), personasSet: new Set() }
      porDia.set(k.fecha, d)
    }
    d.total += r.n
    d.porEvento[k.evento] += r.n
    d.personasSet.add(k.slug)
  }
  const personas = [...porPersona.values()]
    .map(({ diasSet, ...p }) => ({ ...p, dias: diasSet.size }))
    .sort((a, b) => b.total - a.total || a.quien.localeCompare(b.quien, "es"))
  const dias = [...porDia.values()]
    .map(({ personasSet, ...d }) => ({ ...d, personas: personasSet.size }))
    .sort((a, b) => b.fecha.localeCompare(a.fecha))
  return { personas, dias }
}

// ── I/O (best-effort, jamás lanza) ──────────────────────────────────────

const cab = () => ({
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
})

/** Estampa un uso. `quien` vacío (acceso máquina) no se registra. */
export async function registrarUso(quien: string, evento: EventoUso, detalle?: string): Promise<void> {
  try {
    const slug = slugPersona(quien)
    if (!slug || !SUPABASE_URL || !SUPABASE_KEY) return
    const key = claveUso(fechaCL(), slug, evento)
    const r = await fetch(`${SUPABASE_URL}/rest/v1/vic_kv?key=eq.${encodeURIComponent(key)}&select=value&limit=1`, {
      headers: cab(),
      cache: "no-store",
    })
    const rows = r.ok ? ((await r.json()) as Array<{ value?: string }>) : []
    const prev = rows[0]?.value ? parseRegistro(String(rows[0].value)) : null
    const nuevo = sumarUso(prev, quien, new Date().toISOString(), detalle ? String(detalle).slice(0, 40) : undefined)
    await fetch(`${SUPABASE_URL}/rest/v1/vic_kv?on_conflict=key`, {
      method: "POST",
      headers: { ...cab(), Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        key,
        value: JSON.stringify(nuevo),
        expires_at: new Date(Date.now() + TTL_DIAS * 86_400_000).toISOString(),
      }),
      cache: "no-store",
    })
  } catch {
    // best-effort
  }
}

/** Filas uso_* entre dos fechas YYYY-MM-DD (inclusive). Las claves ordenan
 * por fecha porque la fecha va justo tras el prefijo. */
export async function leerUso(desde: string, hasta: string): Promise<FilaKv[]> {
  try {
    if (!SUPABASE_URL || !SUPABASE_KEY) return []
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/vic_kv?key=like.uso_*&key=gte.${encodeURIComponent(`uso_${desde}`)}&key=lte.${encodeURIComponent(`uso_${hasta}~`)}&select=key,value&limit=5000`,
      { headers: cab(), cache: "no-store" },
    )
    if (!r.ok) return []
    const rows = (await r.json()) as Array<{ key?: string; value?: string }>
    return rows.map((f) => ({ key: String(f.key || ""), value: String(f.value || "") }))
  } catch {
    return []
  }
}
