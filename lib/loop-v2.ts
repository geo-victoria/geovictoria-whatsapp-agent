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
  const c = (country || "cl").trim().toLowerCase()
  if (c === "co") return "America/Bogota"
  if (c === "mx") return "America/Mexico_City"
  return "America/Santiago"
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

// ── Clasificador de señal de espera ─────────────────────────────────────────
//
// Detecta en el mensaje del cliente señales IMPLÍCITAS de "no me hables
// todavía" que no llegan a activar programar_seguimiento (no traen fecha
// explícita) ni marcar_no_contactar: "lo veo con mi jefe y te aviso", "la
// próxima semana", "mañana te cuento"… Sin esto, la escalera arma el nudge
// ciego de +1h y quema al usuario (auditoría 24-jul: 11 casos). Función PURA
// (sin red, sin flag): los webhooks la usan HOY para diferir la cadencia
// vieja vía scheduleConsensualFollowup, y resetLoop la usa para anclar el
// loop v2 cuando se encienda. Un falso positivo solo espacia el seguimiento
// (dirección conservadora); un falso negativo cae al flujo normal.

export type SenalEspera = {
  tipo:
    | "proxima_semana"
    | "fin_de_semana"
    | "manana"
    | "dia_nombrado"
    | "largo_plazo"
    | "espera_tercero"
  cuando: Date
}

// Los regex corren sobre texto en minúsculas y SIN acentos (NFD + strip de
// combinantes: "próxima"→"proxima", "mañana"→"manana", "dueño"→"dueno").
const RE_PROX_SEMANA = /\b(proxima|siguiente|otra) semana\b|\bsemana (que viene|entrante|siguiente)\b/
const RE_FINDE = /\bfin de semana\b|\bfinde\b/
const RE_PASADO_MANANA = /\bpasado manana\b/
// "mañana" a secas es el día siguiente; "la/de/esta mañana" es la franja
// horaria (matinal) y NO difiere nada.
const RE_MANANA = /(?<!\b(?:la|de|esta) )\bmanana\b/
const RE_HOY_DEFINE =
  /\b(reunion|junta|lo reviso|lo veo|lo converso|lo evaluo|te aviso|te cuento|te confirmo|te escribo|en la tarde)\b/
const RE_LARGO =
  /\bmas (adelante|para adelante)\b|\ben unos meses\b|\ben un mes( mas)?\b|\bel (proximo|otro) mes\b|\ba fin(es)? de mes\b|\bcuando (parta|partamos|empiece|empecemos|inicie|iniciemos|arranque|comience)\b/
// El cliente promete volver él ("te aviso", "me comunico", "apenas sepa").
const RE_AVISO_PROPIO =
  /\b(te|les?|los) (aviso|avisare|avisamos|escribo|escribire|contacto|contactare|llamo|llamare|confirmo|confirmare|cuento|contare|comento|comentare|digo|dire)\b|\bme comunico\b|\bnos comunicamos\b|\byo (me comunico|los? contacto|te contacto|te busco)\b|\bestamos en contacto\b|\bcuando tenga (novedades|respuesta|noticias|el ok)\b|\bapenas (sepa|tenga)\b/
// La decisión está en manos de un tercero (jefe, gerencia, socio…).
const RE_TERCERO =
  /\b(mi|el|la|nuestro|nuestra) (jefe|jefa|jefatura|gerente|dueno|duena|socio|socia|patron|senora|marido|esposo|esposa)\b|\bgerencia\b|\bdirectorio\b|\blos socios\b|\brecursos humanos\b|\ben manos de\b|\bno depende de mi\b|\bdepende de (el|ella|ellos|otra)\b/
// El cliente pidió tiempo para evaluar/revisar (sin fecha).
const RE_EVALUANDO =
  /\b(lo|la|los) (voy|vamos) a (evaluar|revisar|analizar|conversar|presentar|estudiar|ver)\b|\b(lo|la) (tengo|tenemos) que (ver|revisar|evaluar|consultar|conversar|presentar)\b|\besta(mos|re)? evaluando\b|\bestoy evaluando\b|\bdejame (revisar|ver|evaluar)\w*\b|\b(lo|la) estoy (viendo|evaluando|revisando|analizando)\b|\btengo que (verlo|revisarlo|evaluarlo|consultarlo|conversarlo)\b/
// Promesa INMEDIATA ("te confirmo enseguida") → no es señal de espera; solo
// suprime la categoría espera_tercero (las de fecha concreta ganan igual).
const RE_INMEDIATO =
  /\b(enseguida|de inmediato|ahora mismo|al ?tiro|en un rat(it)?o|en unos minutos|en breve|en un momento)\b/
// DÍA DE LA SEMANA NOMBRADO — el hueco del caso Tamara (+56966432322, 24-jul):
// pidió que no la contactaran "hasta el martes" y el clasificador devolvía null,
// así que el loop la trataba con cadencia normal. Ninguna de las categorías
// anteriores mira un día concreto: "próxima semana" sí, "mañana" sí, "el martes"
// no. Se detecta el día nombrado y se agenda a su PRÓXIMA ocurrencia.
const RE_DIA_SEMANA =
  /\b(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/
const DIAS_SEMANA: Record<string, number> = {
  domingo: 0,
  lunes: 1,
  martes: 2,
  miercoles: 3,
  jueves: 4,
  viernes: 5,
  sabado: 6,
}

/**
 * Clasifica el mensaje del cliente y devuelve cuándo corresponde el próximo
 * toque (ya corrido a horario hábil 9:00 + jitter del contacto), o null si no
 * hay señal (→ cadencia normal). Precedencia: fecha más concreta primero.
 */
export function clasificarSenalEspera(
  mensaje: string,
  country?: string | null,
  contact = "",
  ahora: Date = new Date(),
): SenalEspera | null {
  const texto = ` ${(mensaje || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")} `
  if (!texto.trim()) return null
  const tz = tzDePais(country)

  // "Día D a las 9:00 locales + jitter", corrido a hábil si cae en finde.
  const alas9En = (diasCorridos: number): Date => {
    const p = partesEn(new Date(ahora.getTime() + diasCorridos * 24 * 3600e3), tz)
    const alas9 = utcDesdeLocal(p.y, p.m, p.d, 9, 0, tz)
    return ajustarAHabil(new Date(alas9.getTime() + jitterMs(contact)), tz, contact)
  }
  const hoy = partesEn(ahora, tz)
  const hastaLunes = (8 - hoy.weekday) % 7 || 7

  if (RE_PROX_SEMANA.test(texto))
    return { tipo: "proxima_semana", cuando: alas9En(hastaLunes + 1) } // martes
  if (RE_FINDE.test(texto)) return { tipo: "fin_de_semana", cuando: alas9En(hastaLunes) }
  if (RE_PASADO_MANANA.test(texto)) return { tipo: "manana", cuando: alas9En(2) }
  // Día nombrado ("el martes", "hasta el jueves"): próxima ocurrencia, 1..7 días
  // adelante. Si el cliente nombra el día de HOY se entiende la semana siguiente
  // — quien dice "hablamos el martes" un martes no habla del rato que viene.
  // Un finde nombrado lo corre ajustarAHabil al lunes, como todo lo demás.
  const diaNombrado = texto.match(RE_DIA_SEMANA)?.[1]
  if (diaNombrado) {
    const objetivo = DIAS_SEMANA[diaNombrado]
    const faltan = (objetivo - hoy.weekday + 7) % 7 || 7
    return { tipo: "dia_nombrado", cuando: alas9En(faltan) }
  }
  if (RE_MANANA.test(texto) || (/\bhoy\b/.test(texto) && RE_HOY_DEFINE.test(texto)))
    return { tipo: "manana", cuando: alas9En(1) }
  if (RE_LARGO.test(texto)) return { tipo: "largo_plazo", cuando: alas9En(7) }
  if (
    !RE_INMEDIATO.test(texto) &&
    (RE_AVISO_PROPIO.test(texto) || RE_TERCERO.test(texto) || RE_EVALUANDO.test(texto))
  ) {
    return {
      tipo: "espera_tercero",
      cuando: ajustarAHabil(sumarDiasHabiles(ahora, 2, tz), tz, contact),
    }
  }
  return null
}

// ── Estado del loop por contacto ────────────────────────────────────────────

/**
 * Re-ancla el loop al hablar el cliente (regla del re-anclaje): T0 = ahora,
 * la cuenta vuelve al toque 1 (+1h corrido a hábil) y cualquier compromiso
 * pendiente se limpia (el cliente ya volvió solo). Si el mensaje trae una
 * señal de espera ("lo veo con mi jefe", "la próxima semana"…), T0 se ancla
 * a plazoInferido − 1h: el toque 1 cae justo en el plazo y los toques 2+ se
 * espacian desde ahí hacia adelante — el loop respeta lo que pidió el
 * cliente sin salirse de su cadencia. Solo aplica a loops en
 * activo/pausado_compromiso/finalizado — un loop 'cerrado' (opt-out, pagado…)
 * NUNCA revive solo. Best-effort: los webhooks la llaman con .catch(()=>{}).
 */
export async function resetLoop(contact: string, mensaje?: string): Promise<void> {
  if (!loopV2Enabled() || !contact || !SUPABASE_URL || !SUPABASE_KEY) return
  const res = await supa(
    `vic_loop?contact=eq.${encodeURIComponent(contact)}&select=contact,country,estado&limit=1`,
  )
  const rows = res.ok ? (((await res.json().catch(() => [])) as LoopRow[]) || []) : []
  const row = rows[0]
  if (!row) return
  if (!["activo", "pausado_compromiso", "finalizado"].includes(row.estado || "")) return
  const ahora = new Date()
  const senal = mensaje ? clasificarSenalEspera(mensaje, row.country, contact, ahora) : null
  const t0 = senal ? new Date(senal.cuando.getTime() - 3600e3) : ahora
  await supa(`vic_loop?contact=eq.${encodeURIComponent(contact)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      t0: t0.toISOString(),
      next_touch: 1,
      next_touch_at: calcularProximoToque(t0, 1, row.country, contact).toISOString(),
      estado: "activo",
      compromiso_at: null,
      updated_at: ahora.toISOString(),
    }),
  })
  if (senal) {
    console.log(
      `[loop-v2] señal de espera '${senal.tipo}' → t0 anclado a ${t0.toISOString()} contact=${contact}`,
    )
  }
}

/**
 * Enrola un contacto NUEVO al loop (llamada desde el T0 outbound de
 * vic-outbound-lead, 25-jul: los leads nuevos entran al loop desde el
 * encendido). Si ya existe fila: 'cerrado' NUNCA revive; cualquier otro
 * estado se re-ancla vía resetLoop (un T0 repetido = el lead volvió a
 * convertir). Best-effort: el llamador usa .catch(()=>{}).
 */
export async function enrolarEnLoop(contact: string, country: string): Promise<void> {
  if (!loopV2Enabled() || !contact || !SUPABASE_URL || !SUPABASE_KEY) return
  const res = await supa(
    `vic_loop?contact=eq.${encodeURIComponent(contact)}&select=contact,estado&limit=1`,
  )
  const rows = res.ok ? (((await res.json().catch(() => [])) as LoopRow[]) || []) : []
  if (rows[0]) {
    if (rows[0].estado === "cerrado") return
    await resetLoop(contact)
    return
  }
  const t0 = new Date()
  await supa(`vic_loop`, {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      contact,
      country: (country || "cl").trim().toLowerCase(),
      stage: "sin_precio",
      t0: t0.toISOString(),
      next_touch: 1,
      next_touch_at: calcularProximoToque(t0, 1, country, contact).toISOString(),
      estado: "activo",
      updated_at: t0.toISOString(),
    }),
  })
  console.log(`[loop-v2] enrolado contact=${contact} country=${country}`)
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
