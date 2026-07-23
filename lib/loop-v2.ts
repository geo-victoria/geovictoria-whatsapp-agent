/**
 * Loop v2 — motor unificado de toques proactivos (DETRÁS DEL FLAG LOOP_V2_ENABLED).
 *
 * Un solo ciclo de 7 toques anclado a T0 (el último mensaje del cliente): la
 * mezcla WhatsApp + llamada reemplaza, para los contactos migrados, a la
 * cadencia outbound y a la reactivación (los crons viejos los saltan vía
 * contactosEnLoop). Cada mensaje entrante del cliente RE-ANCLA el loop
 * (resetLoop): T0 vuelve a ahora y la cuenta parte del toque 1.
 *
 * SEGURO POR DEFECTO: con LOOP_V2_ENABLED ausente u "off", TODAS las funciones
 * de este módulo son no-op — el comportamiento del sistema es idéntico al de hoy.
 *
 * La tabla vic_loop NO se crea desde el código. SQL para el operador:
 *
 *   create table if not exists vic_loop (
 *     contact        text primary key,
 *     country        text,                       -- 'cl' | 'co'
 *     stage          text,                       -- 'sin_precio' | 'con_precio' | 'formal'
 *     t0             timestamptz,                -- ancla del ciclo (último mensaje del cliente)
 *     next_touch     int,                        -- 1..7
 *     next_touch_at  timestamptz,
 *     estado         text,                       -- 'activo' | 'pausado_compromiso' | 'humano' | 'finalizado' | 'cerrado'
 *     compromiso_at  timestamptz null,           -- ventana de compromiso acordada con el cliente
 *     motivo_cierre  text null,
 *     updated_at     timestamptz default now()
 *   );
 *   create index if not exists vic_loop_due_idx on vic_loop (estado, next_touch_at);
 *
 * Cadencia de toques (offsets desde T0; 5-7 se miden desde el toque 4):
 *   1: +1h  WhatsApp   ·  2: +3h  llamada  ·  3: +48h llamada  ·  4: +72h WhatsApp
 *   5: toque4 + 3 días hábiles (WhatsApp) · 6: toque4 + 5 dh · 7: toque4 + 7 dh
 * Todos corridos a horario hábil L-V 9:00-19:00 en la zona del país (CL:
 * America/Santiago, CO: America/Bogota — misma regla que vic-callback-cron),
 * con jitter determinista 0-45 min por contacto para no disparar todo a las
 * 9:00 en punto. Tras el toque 7 el cron deja el loop en 'finalizado'.
 */

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()

const HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
}

/** Flag maestro: se lee en cada llamada (no al cargar el módulo) para que un
 *  cambio de env en Vercel aplique sin depender del orden de los imports. */
export function loopV2Enabled(): boolean {
  return (process.env.LOOP_V2_ENABLED || "").trim().toLowerCase() === "on"
}

export type LoopStage = "sin_precio" | "con_precio" | "formal"
export type LoopEstado = "activo" | "pausado_compromiso" | "humano" | "finalizado" | "cerrado"

export type LoopRow = {
  contact: string
  country: string | null
  stage: LoopStage | null
  t0: string | null
  next_touch: number | null
  next_touch_at: string | null
  estado: LoopEstado | null
  compromiso_at: string | null
  motivo_cierre: string | null
}

function supa(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { ...HEADERS, ...(init.headers || {}) },
    cache: "no-store",
  })
}

// ── Calendario hábil por país ───────────────────────────────────────────────

/** Zona horaria del país del loop (misma dupla que vic-callback-cron). */
export function tzDePais(country?: string | null): string {
  return (country || "cl").trim().toLowerCase() === "co"
    ? "America/Bogota"
    : "America/Santiago"
}

type PartesLocales = { y: number; m: number; d: number; hh: number; mm: number; weekday: number }

/** Descompone un instante en la hora de pared de la zona (sin librerías: Intl). */
function partesEn(date: Date, timeZone: string): PartesLocales {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  }).formatToParts(date)
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "0"
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"))
  return {
    y: Number(get("year")),
    m: Number(get("month")),
    d: Number(get("day")),
    // Intl con hour12:false puede reportar "24" a medianoche.
    hh: Number(get("hour")) % 24,
    mm: Number(get("minute")),
    weekday,
  }
}

/**
 * Instante UTC que corresponde a una hora de pared en la zona. Sin offsets
 * hardcodeados (el DST de Chile cambia dos veces al año): parte de un guess en
 * UTC y lo corrige iterando contra lo que Intl reporta para esa zona.
 */
function utcDesdeLocal(
  y: number,
  m: number,
  d: number,
  hh: number,
  mm: number,
  timeZone: string,
): Date {
  let guess = new Date(Date.UTC(y, m - 1, d, hh, mm))
  for (let i = 0; i < 2; i++) {
    const p = partesEn(guess, timeZone)
    const diff = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm) - Date.UTC(y, m - 1, d, hh, mm)
    guess = new Date(guess.getTime() - diff)
  }
  return guess
}

/**
 * Jitter DETERMINISTA 0-45 min por contacto (hash simple del número): así los
 * toques movidos a "próximo día hábil 9:00" no salen todos a las 9:00 en punto,
 * y el mismo contacto siempre recibe el mismo corrimiento (reproducible).
 */
function jitterMs(contact: string): number {
  let h = 0
  for (let i = 0; i < contact.length; i++) h = (h * 31 + contact.charCodeAt(i)) >>> 0
  return (h % 46) * 60_000 // 0..45 minutos
}

/**
 * Corre un instante a horario hábil (L-V 9:00-19:00 de la zona): si ya cae
 * dentro, queda igual; si cae antes de las 9 de un día hábil, va a ese mismo
 * día 9:00 + jitter; si cae después de las 19, en finde o feriado de hora, va
 * al PRÓXIMO día hábil 9:00 + jitter.
 */
export function ajustarAHabil(date: Date, timeZone: string, contact = ""): Date {
  const p = partesEn(date, timeZone)
  const esHabil = p.weekday >= 1 && p.weekday <= 5
  if (esHabil && p.hh >= 9 && p.hh < 19) return date

  let cursor = new Date(date.getTime())
  let pp = p
  // Antes de las 9 de un día hábil → hoy mismo a las 9; cualquier otro caso →
  // avanzar de a 24h hasta caer en día hábil.
  if (!(esHabil && p.hh < 9)) {
    do {
      cursor = new Date(cursor.getTime() + 24 * 3600e3)
      pp = partesEn(cursor, timeZone)
    } while (pp.weekday === 0 || pp.weekday === 6)
  }
  const alas9 = utcDesdeLocal(pp.y, pp.m, pp.d, 9, 0, timeZone)
  return new Date(alas9.getTime() + jitterMs(contact))
}

/** Suma N días hábiles (L-V en la zona) a un instante, conservando la hora. */
function sumarDiasHabiles(date: Date, n: number, timeZone: string): Date {
  let cursor = new Date(date.getTime())
  let restantes = n
  while (restantes > 0) {
    cursor = new Date(cursor.getTime() + 24 * 3600e3)
    const p = partesEn(cursor, timeZone)
    if (p.weekday >= 1 && p.weekday <= 5) restantes--
  }
  return cursor
}

/**
 * Timestamp del toque `touchIdx` (1..7) desde `t0`, corrido a horario hábil.
 * El contacto (4º parámetro) alimenta el jitter determinista; sin él, el
 * corrimiento cae exacto a las 9:00.
 */
export function calcularProximoToque(
  t0: string | Date,
  touchIdx: number,
  country?: string | null,
  contact = "",
): Date {
  const base = typeof t0 === "string" ? new Date(t0) : t0
  const tz = tzDePais(country)
  const h = 3600e3
  // Toques 5-7 se miden desde el toque 4 (t0+72h) en días hábiles.
  const base4 = new Date(base.getTime() + 72 * h)
  let objetivo: Date
  switch (touchIdx) {
    case 1:
      objetivo = new Date(base.getTime() + 1 * h)
      break
    case 2:
      objetivo = new Date(base.getTime() + 3 * h)
      break
    case 3:
      objetivo = new Date(base.getTime() + 48 * h)
      break
    case 4:
      objetivo = base4
      break
    case 5:
      objetivo = sumarDiasHabiles(base4, 3, tz)
      break
    case 6:
      objetivo = sumarDiasHabiles(base4, 5, tz)
      break
    default:
      // 7 (y cualquier índice fuera de rango, defensivo): último toque.
      objetivo = sumarDiasHabiles(base4, 7, tz)
      break
  }
  return ajustarAHabil(objetivo, tz, contact)
}

// ── Estado del loop por contacto ────────────────────────────────────────────

/**
 * Re-ancla el loop al hablar el cliente (regla del re-anclaje): T0 = ahora,
 * la cuenta vuelve al toque 1 (+1h corrido a hábil) y cualquier compromiso
 * pendiente se limpia (el cliente ya volvió solo). Solo aplica a loops en
 * activo/pausado_compromiso/finalizado — un loop 'cerrado' (opt-out, pagado…)
 * NUNCA revive solo. Best-effort: los webhooks la llaman con .catch(()=>{}).
 */
export async function resetLoop(contact: string): Promise<void> {
  if (!loopV2Enabled() || !contact || !SUPABASE_URL || !SUPABASE_KEY) return
  const res = await supa(
    `vic_loop?contact=eq.${encodeURIComponent(contact)}&select=contact,country,estado&limit=1`,
  )
  const rows = res.ok ? (((await res.json().catch(() => [])) as LoopRow[]) || []) : []
  const row = rows[0]
  if (!row) return
  if (!["activo", "pausado_compromiso", "finalizado"].includes(row.estado || "")) return
  const t0 = new Date()
  await supa(`vic_loop?contact=eq.${encodeURIComponent(contact)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      t0: t0.toISOString(),
      next_touch: 1,
      next_touch_at: calcularProximoToque(t0, 1, row.country, contact).toISOString(),
      estado: "activo",
      compromiso_at: null,
      updated_at: t0.toISOString(),
    }),
  })
}

/**
 * El contacto PAGÓ → el loop muere definitivamente (motivo 'pagado'). Exportada
 * para el flujo de pago futuro; todavía no se conecta a ningún llamador.
 */
export async function pagoCierraLoop(contact: string): Promise<void> {
  if (!loopV2Enabled() || !contact || !SUPABASE_URL || !SUPABASE_KEY) return
  await supa(`vic_loop?contact=eq.${encodeURIComponent(contact)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      estado: "cerrado",
      motivo_cierre: "pagado",
      updated_at: new Date().toISOString(),
    }),
  })
}

/**
 * El cliente acordó un momento concreto para retomar ("hablemos el lunes"):
 * el loop se pausa hasta esa fecha y el próximo toque se agenda exactamente
 * ahí. Exportada para uso futuro; todavía sin llamadores.
 */
export async function compromisoLoop(contact: string, fechaIso: string): Promise<void> {
  if (!loopV2Enabled() || !contact || !fechaIso || !SUPABASE_URL || !SUPABASE_KEY) return
  await supa(`vic_loop?contact=eq.${encodeURIComponent(contact)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      compromiso_at: fechaIso,
      next_touch_at: fechaIso,
      estado: "pausado_compromiso",
      updated_at: new Date().toISOString(),
    }),
  })
}

/**
 * Contactos (de la lista dada) que tienen fila en vic_loop — UN solo fetch
 * batch, para que los crons viejos los salten sin caer en N+1. Con el flag
 * apagado devuelve set vacío SIN tocar la red: cero cambio de comportamiento.
 */
export async function contactosEnLoop(contacts: string[]): Promise<Set<string>> {
  const enLoop = new Set<string>()
  if (!loopV2Enabled() || !contacts.length || !SUPABASE_URL || !SUPABASE_KEY) return enLoop
  // in.() de PostgREST con los contactos entre comillas (mismo patrón que la
  // consulta batch de vic-outbound-cadence-cron sobre vic_v3_conversations).
  const lista = contacts.map((c) => `"${c}"`).join(",")
  const res = await supa(`vic_loop?contact=in.(${lista})&select=contact`).catch(() => null)
  if (!res || !res.ok) return enLoop
  const rows = ((await res.json().catch(() => [])) as Array<{ contact: string }>) || []
  for (const r of rows) if (r.contact) enLoop.add(r.contact)
  return enLoop
}
