/**
 * Loop v2 — motor unificado de toques proactivos (DETRÁS DEL FLAG LOOP_V2_ENABLED).
 *
 * Un solo ciclo de 7 toques anclado a T0 (el último mensaje del cliente): la
 * mezcla WhatsApp + llamada reemplaza, para los contactos migrados, a la
 * cadencia outbound y a la reactivación (los crons viejos los saltan vía
 * contactosEnLoop). Cada mensaje entrante del cliente RE-ANCLA el loop
 * (resetLoop): T0 vuelve a ahora, pero la CUENTA DE TOQUES NO RETROCEDE
 * (04-sep). Hasta ese día volvía al toque 1, y con el toque 1 a diez minutos
 * (10-ago) eso le devolvía al cliente el mismo texto enlatado justo después
 * de conversar: 1 de cada 5 toques retrocedía.
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
 * Cadencia de toques (offsets desde T0; 5-7 se miden desde el toque 4).
 * NUEVA del 10-ago (Rodrigo): "el primer toque deben ser siempre 10 minutos,
 * independiente de la etapa. El segundo, 60 minutos después. El tercero,
 * 22 horas después." Los toques 2-3 dejaron de ser llamadas (Dapta muerto,
 * decisión 08-ago) y son WhatsApp con textos propios:
 *   1: +10 min · 2: +70 min · 3: +23h10m · 4: +72h (todos WhatsApp)
 *   5: toque4 + 3 días hábiles · 6: toque4 + 5 dh · 7: toque4 + 7 dh
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

// "aceptada" (25-ago, VB Lalo): cadencia de CIERRE post-aceptación — la
// aceptación sin pago dejaba a Vicky muda (tierra de nadie hasta la Cartera).
// 3 toques: +60min / +24h / +72h (urgencia de vigencia), y finaliza.
export type LoopStage = "sin_precio" | "con_precio" | "formal" | "aceptada"
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
  // Perú (Fase 1b, 05-ago): sin este caso, una conversación "pe" calculaba
  // sus ventanas hábiles con la hora de Santiago (1-2 h de desfase por DST).
  if (c === "pe") return "America/Lima"
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
 * Corre un instante a la VENTANA DE SEGUIMIENTO: TODOS los días, 9:00-21:00
 * de la zona (Rodrigo 09-ago: "si nos cotiza el fin de semana, está bien que
 * le hagamos seguimiento durante el fin de semana, entre 9 am y 9 pm" — antes
 * era L-V 9-19 y una formal emitida el domingo esperaba hasta el lunes). Las
 * pausas anunciadas por el cliente y el opt-out se respetan igual que siempre.
 * Si ya cae dentro, queda igual; antes de las 9 → hoy mismo 9:00 + jitter;
 * después de las 21 → MAÑANA 9:00 + jitter.
 *
 * El nombre se conserva por historia (todos los agendamientos del loop pasan
 * por aquí); la ventana ya no distingue día hábil de finde.
 */
export function ajustarAHabil(date: Date, timeZone: string, contact = ""): Date {
  const p = partesEn(date, timeZone)
  if (p.hh >= 9 && p.hh < 21) return date

  let pp = p
  // Después de las 21 → avanzar al día siguiente; antes de las 9 → hoy mismo.
  if (p.hh >= 21) {
    pp = partesEn(new Date(date.getTime() + 24 * 3600e3), timeZone)
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
  stage?: LoopStage | null,
): Date {
  const base = typeof t0 === "string" ? new Date(t0) : t0
  const tz = tzDePais(country)
  const h = 3600e3
  // Cadencia de CIERRE post-aceptación (25-ago): 60min / 24h / 72h, tope 3
  // (el cron finaliza tras el tercero). Ventana 9-21 como todos los toques.
  if (stage === "aceptada") {
    const objetivoA =
      touchIdx <= 1
        ? new Date(base.getTime() + 60 * 60_000)
        : touchIdx === 2
          ? new Date(base.getTime() + 24 * h)
          : new Date(base.getTime() + 72 * h)
    return ajustarAHabil(objetivoA, tz, contact)
  }
  // Toques 5-7 se miden desde el toque 4 (t0+72h) en días hábiles.
  const base4 = new Date(base.getTime() + 72 * h)
  let objetivo: Date
  switch (touchIdx) {
    case 1:
      objetivo = new Date(base.getTime() + 10 * 60_000)
      break
    case 2:
      objetivo = new Date(base.getTime() + 70 * 60_000) // 10' + 60'
      break
    case 3:
      objetivo = new Date(base.getTime() + 70 * 60_000 + 22 * h) // toque 2 + 22h
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
  // Desde el 09-ago la ventana de seguimiento incluye el finde (9-21 todos los
  // días): "el sábado" cae el sábado mismo, ya no se corre al lunes.
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
/** PAGO REGISTRADO (19-ago, caso MATER/COT546; ventana revisada el 29-ago):
 * un contacto cuyo comprobante de transferencia ya fue casado (vic_kv
 * comprobante_ok_<fono>) es un CLIENTE, no un prospecto — la maquinaria de
 * venta no lo toca: ni enrolamiento/reset de toques, ni relojes de traspaso,
 * ni reapertura del candado v3.
 *
 * POR QUÉ NO ES UNA VENTANA FIJA (saneamiento 29-ago): la guarda nació con 7
 * días y esa fecha de vencimiento reabrió el caso que venía a proteger. La
 * misma clienta de MATER pagó $77.001 el 18-ago, siguió conversando por su
 * onboarding y al noveno día la marca caducó: el loop la reenroló como
 * prospecta y le mandó cuatro toques de venta, el último a los diez días del
 * pago. Alguien que pagó no deja de ser cliente por el paso del tiempo.
 *
 * PERO TAMPOCO ES PARA SIEMPRE, y ese era el motivo legítimo de la ventana: un
 * cliente puede volver meses después a comprar otra cosa, y ahí sí debe entrar
 * al circuito. La señal de que empezó un ciclo NUEVO no es el calendario — es
 * que se le emitió una cotización DESPUÉS del pago. Mientras no exista esa
 * cotización nueva, sigue siendo el mismo ciclo y la venta no lo toca.
 *
 * COSTO EN EL CAMINO DE LA CONVERSACIÓN: cero para el caso normal. Los
 * primeros 7 días responde con la marca, sin consultas extra; recién pasada
 * esa ventana mira los punteros de cotización (Supabase, no Zoho). Rollback
 * sin deploy: VICKY_PAGO_VENTANA_CLASICA=1 restaura el comportamiento viejo. */
export async function pagoRegistradoReciente(contact: string): Promise<boolean> {
  const limpio = (contact || "").replace(/\D/g, "")
  if (!limpio || !SUPABASE_URL || !SUPABASE_KEY) return false
  try {
    const res = await supa(
      `vic_kv?key=eq.${encodeURIComponent(`comprobante_ok_${limpio}`)}&select=value&limit=1`,
    )
    const rows = res.ok ? (((await res.json().catch(() => [])) as Array<{ value?: string }>) || []) : []
    const raw = rows[0]?.value
    if (!raw) return false
    const at = Date.parse((JSON.parse(raw) as { at?: string })?.at || "")
    if (!Number.isFinite(at)) return false
    const dentroDeVentana = Date.now() - at < 7 * 86400e3
    if (dentroDeVentana) return true
    if ((process.env.VICKY_PAGO_VENTANA_CLASICA || "").trim() === "1") return false
    // Pasada la ventana: sigue siendo cliente del MISMO ciclo mientras no se
    // le haya emitido una cotización nueva después del pago.
    const desde = new Date(at).toISOString()
    const q = await supa(
      `vic_v3_quote_pointers?contact=eq.${encodeURIComponent(limpio)}` +
        `&created_at=gt.${encodeURIComponent(desde)}&select=contact&limit=1`,
    )
    if (!q.ok) return true // sin poder verificar, se protege al cliente
    const nuevas = ((await q.json().catch(() => [])) as unknown[]) || []
    return nuevas.length === 0
  } catch {
    return false
  }
}

/** Contacto en fase ONBOARDING (Lalo 25-ago, caso del toque comercial que se
 * cruzó con el alta de cuenta): un cliente creando su cuenta con Vicky
 * Onboarding NO es un prospecto — la maquinaria de VENTA (toques del loop,
 * relojes de traspaso) no lo toca. La fase vive en vic_kv fase_vicky_<fono>
 * (lib/onboarding/fase) y la administra el canal de onboarding. */
export async function enFaseOnboarding(contact: string): Promise<boolean> {
  const limpio = (contact || "").replace(/\D/g, "")
  if (!limpio || !SUPABASE_URL || !SUPABASE_KEY) return false
  try {
    const res = await supa(`vic_kv?key=eq.${encodeURIComponent(`fase_vicky_${limpio}`)}&select=value&limit=1`)
    const rows = res.ok ? (((await res.json().catch(() => [])) as Array<{ value?: string }>) || []) : []
    return String(rows[0]?.value || "").trim() === "onboarding"
  } catch {
    return false
  }
}

export async function resetLoop(contact: string, mensaje?: string): Promise<void> {
  if (!loopV2Enabled() || !contact || !SUPABASE_URL || !SUPABASE_KEY) return
  // Cliente con pago registrado: su mensaje post-venta no re-arma la cadencia.
  if (await pagoRegistradoReciente(contact)) return
  // Cliente en pleno alta de cuenta: sus mensajes son del onboarding, no de venta.
  if (await enFaseOnboarding(contact)) return
  const res = await supa(
    `vic_loop?contact=eq.${encodeURIComponent(contact)}&select=contact,country,estado,stage,next_touch&limit=1`,
  )
  const rows = res.ok ? (((await res.json().catch(() => [])) as LoopRow[]) || []) : []
  const row = rows[0]
  if (!row) return
  if (!["activo", "pausado_compromiso", "finalizado"].includes(row.estado || "")) return
  const ahora = new Date()
  const senal = mensaje ? clasificarSenalEspera(mensaje, row.country, contact, ahora) : null
  const t0 = senal ? new Date(senal.cuando.getTime() - 3600e3) : ahora
  // EL RELOJ SE REANCLA, EL CONTADOR NO RETROCEDE (04-sep, hallazgo de Rodrigo).
  //
  // Hasta hoy esto ponía `next_touch: 1`. Era una decisión explícita del
  // 23-jul ("T0 vuelve a ahora y la cuenta parte del toque 1") y con la
  // cadencia vieja —toque 1 a +1h, toques 2 y 3 por llamada— se notaba poco.
  // El 10-ago el toque 1 se movió a +10 MINUTOS y la combinación se volvió
  // dañina: cada mensaje del cliente rebobinaba la cadencia y le devolvía el
  // MISMO texto enlatado diez minutos después, encima de la conversación viva.
  // Medido: 1 de cada 5 toques retrocedía, y 72 toques repetidos a 66
  // clientes en una semana. Caso Ana Delgado: recibió el texto del toque 1
  // tres veces en dos horas, una de ellas justo después de contarnos que
  // estaba comparando con la competencia.
  //
  // El silencio SÍ se mide desde el último mensaje del cliente (t0 = ahora),
  // pero la escalera de toques solo sube: quien ya recibió el toque 3 recibe
  // el 4, no el 1 otra vez. Y como cada toque conserva su propia distancia
  // desde t0, el cliente que conversa recibe el siguiente toque con el
  // espaciado de SU escalón, no a los diez minutos — menos insistente,
  // exactamente lo que el documento describe (offsets medidos desde T0).
  const siguiente = Math.max(1, Number(row.next_touch) || 1)
  await supa(`vic_loop?contact=eq.${encodeURIComponent(contact)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      t0: t0.toISOString(),
      next_touch: siguiente,
      next_touch_at: calcularProximoToque(t0, siguiente, row.country, contact, row.stage).toISOString(),
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
  // Cliente con pago registrado (comprobante casado): jamás se re-enrola.
  if (await pagoRegistradoReciente(contact)) return
  // Cliente en fase onboarding: la venta ya se cerró, cero cadencia comercial.
  if (await enFaseOnboarding(contact)) return
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
 * PUNTO 4 (Lalo 08-ago): al emitir la cotización FORMAL, el primer toque del
 * loop se adelanta a 35 minutos (la mediana histórica emisión→pago es 36 min;
 * el "¿te ayudo con el pago?" debe caer dentro de la ventana real de compra).
 * Solo toca loops activos que van en el toque 1 — una cadencia avanzada no se
 * reinicia. Best-effort: el llamador usa .catch(()=>{}).
 */
export async function adelantarPrimerToqueFormal(contact: string, country?: string | null): Promise<void> {
  if (!loopV2Enabled() || !contact || !SUPABASE_URL || !SUPABASE_KEY) return
  const d = contact.replace(/\D/g, "")
  const pais =
    country || (d.startsWith("57") ? "co" : d.startsWith("52") ? "mx" : d.startsWith("51") ? "pe" : "cl")
  const objetivo = ajustarAHabil(new Date(Date.now() + 10 * 60_000), tzDePais(pais), contact)
  await supa(
    `vic_loop?contact=eq.${encodeURIComponent(contact)}&estado=eq.activo&next_touch=eq.1`,
    {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ next_touch_at: objetivo.toISOString(), updated_at: new Date().toISOString() }),
    },
  )
}

/**
 * Venta cerrada → el loop muere. MOTIVO DIFERENCIADO (fix 10-ago): la
 * ACEPTACIÓN cerraba con motivo 'pagado' igual que el pago real, y eso dejó
 * ciego al cobro asistido (que existe justo para las aceptadas SIN pagar) y
 * contaminó toda métrica de pagos. Desde hoy: 'aceptada' para el evento de
 * aceptación, 'pagado' solo con pago confirmado. Ambos dejan el loop cerrado
 * (cero toques); la diferencia es solo el registro.
 */
export async function pagoCierraLoop(
  contact: string,
  motivo: "pagado" | "aceptada" = "pagado",
): Promise<void> {
  if (!loopV2Enabled() || !contact || !SUPABASE_URL || !SUPABASE_KEY) return
  // CADENCIA DE CIERRE (25-ago, VB Lalo): la ACEPTACIÓN ya no apaga a Vicky —
  // el loop pasa a la etapa "aceptada" (3 toques: 60min "te ayudo con el
  // pago", 24h facilitador, 72h urgencia de vigencia; después finaliza y el
  // caso queda en la Cartera). El PAGO real sí cierra, como siempre.
  if (motivo === "aceptada") {
    const ahora = new Date()
    const filaRes = await supa(
      `vic_loop?contact=eq.${encodeURIComponent(contact)}&select=contact,country&limit=1`,
    )
    const filas = filaRes.ok ? (((await filaRes.json().catch(() => [])) as LoopRow[]) || []) : []
    const country = filas[0]?.country || (contact.startsWith("57") ? "co" : contact.startsWith("52") ? "mx" : contact.startsWith("51") ? "pe" : "cl")
    const cuerpo = {
      contact,
      country,
      stage: "aceptada",
      t0: ahora.toISOString(),
      next_touch: 1,
      next_touch_at: calcularProximoToque(ahora, 1, country, contact, "aceptada").toISOString(),
      estado: "activo",
      compromiso_at: null,
      motivo_cierre: null,
      updated_at: ahora.toISOString(),
    }
    await supa(`vic_loop?on_conflict=contact`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(cuerpo),
    })
    return
  }
  await supa(`vic_loop?contact=eq.${encodeURIComponent(contact)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      estado: "cerrado",
      motivo_cierre: motivo,
      updated_at: new Date().toISOString(),
    }),
  })
}

/** ¿El loop de este contacto quedó cerrado por PAGO REAL? (con la distinción
 * del 10-ago; filas históricas de aceptaciones viejas pueden decir 'pagado',
 * cohorte que envejece en horas). Conservador: ante error devuelve false. */
export async function loopCerradoPorPagoReal(contact: string): Promise<boolean> {
  if (!contact || !SUPABASE_URL || !SUPABASE_KEY) return false
  try {
    const res = await supa(
      `vic_loop?contact=eq.${encodeURIComponent(contact)}&motivo_cierre=eq.pagado&select=contact&limit=1`,
    )
    if (!res.ok) return false
    const rows = (await res.json().catch(() => [])) as unknown[]
    return rows.length > 0
  } catch {
    return false
  }
}

/**
 * ¿La conversación quedó derivada por SOBRE-UMBRAL? (motivo 'sobre_umbral'
 * 21-50 con N, o 'mas_de_50'). Lo usa la selección de agenda (Lalo 11-ago,
 * solo CL): estas reuniones van al evento de las SDR INBOUND, no a la
 * agenda del vendedor del deal. Fail-safe: ante cualquier duda, false
 * (comportamiento de siempre).
 */
export async function loopCerradoSobreUmbral(contact: string): Promise<boolean> {
  if (!contact || !SUPABASE_URL || !SUPABASE_KEY) return false
  try {
    const res = await supa(
      `vic_loop?contact=eq.${encodeURIComponent(contact)}&motivo_cierre=in.(sobre_umbral,mas_de_50)&select=contact&limit=1`,
    )
    if (!res.ok) return false
    const rows = (await res.json().catch(() => [])) as unknown[]
    return rows.length > 0
  } catch {
    return false
  }
}

/**
 * Prospecto de MÁS de 50 trabajadores → el Loop se cierra (doc "Vicky paso a
 * paso", 30-jul: los >50 quedan FUERA del seguimiento automático — el
 * ejecutivo llama al toque en hábil y Vicky no manda toques; solo responde
 * REACTIVAMENTE si el cliente escribe). Motivo 'mas_de_50' terminal: un loop
 * cerrado nunca revive solo.
 */
export async function mas50CierraLoop(contact: string, motivo = "mas_de_50"): Promise<void> {
  if (!loopV2Enabled() || !contact || !SUPABASE_URL || !SUPABASE_KEY) return
  await supa(`vic_loop?contact=eq.${encodeURIComponent(contact)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      estado: "cerrado",
      motivo_cierre: motivo,
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
 * Contactos ATENDIDOS por su vendedor tras el traspaso: hay evidencia de
 * contacto humano real POSTERIOR a traspasado_at — un mensaje del vendedor
 * desde su WhatsApp espejado (from_me) o una llamada de WhatsApp contestada
 * (estado accept en vic_wa_espejo_llamadas). Margen de 5 min hacia atrás por
 * desfases de reloj. Best-effort: si el espejo no responde, set vacío.
 */
export async function contactosAtendidosPorVendedor(
  pares: Array<{ contact: string; desdeIso: string }>,
): Promise<Set<string>> {
  const out = new Set<string>()
  if (!pares.length || !SUPABASE_URL || !SUPABASE_KEY) return out
  const desdePor = new Map(pares.map((p) => [p.contact, Date.parse(p.desdeIso || "") - 5 * 60_000]))
  const lista = pares.map((p) => `"${p.contact}"`).join(",")
  // Atención MANUAL (punto 5, Lalo 08-ago): vendedores sin WhatsApp espejado
  // (CO/MX/PE y CL sin vincular) marcan "ya lo contacté" en el dashboard →
  // vic_kv atencion_manual_<fono> con timestamp ISO. Cuenta igual que un
  // mensaje espejado o una llamada contestada.
  const listaKv = pares.map((p) => `"atencion_manual_${p.contact}"`).join(",")
  const [msjRes, llamRes, kvRes] = await Promise.all([
    supa(
      `vic_wa_espejo_mensajes?telefono_chat=in.(${lista})&from_me=eq.true&es_grupo=eq.false&select=telefono_chat,enviado_at&limit=5000`,
    ).catch(() => null),
    supa(`vic_wa_espejo_llamadas?telefono=in.(${lista})&estado=eq.accept&select=telefono,at&limit=2000`).catch(
      () => null,
    ),
    supa(`vic_kv?key=in.(${listaKv})&select=key,value&limit=1000`).catch(() => null),
  ])
  const marcar = (tel: string | null | undefined, atIso: string | null | undefined) => {
    const t = String(tel || "")
    const desde = desdePor.get(t)
    if (desde === undefined || !atIso) return
    const at = Date.parse(String(atIso))
    if (Number.isFinite(at) && at >= desde) out.add(t)
  }
  if (msjRes?.ok) {
    const rows = ((await msjRes.json().catch(() => [])) as Array<{ telefono_chat: string; enviado_at: string }>) || []
    for (const r of rows) marcar(r.telefono_chat, r.enviado_at)
  }
  if (llamRes?.ok) {
    const rows = ((await llamRes.json().catch(() => [])) as Array<{ telefono: string; at: string }>) || []
    for (const r of rows) marcar(r.telefono, r.at)
  }
  if (kvRes?.ok) {
    const rows = ((await kvRes.json().catch(() => [])) as Array<{ key: string; value: string }>) || []
    for (const r of rows) marcar(String(r.key).replace("atencion_manual_", ""), r.value)
  }
  return out
}

/**
 * Contactos (de la lista dada) cuyo traspaso a vendedor SILENCIA a Vicky.
 *
 * CANDADO v3 (Lalo 07-ago, "haz la 2"): el traspaso por sí solo YA NO calla a
 * Vicky. Diagnóstico del 07-ago: desde el encendido del traspaso v2 (03-ago
 * 17:30) las formales se traspasaban a los 10-15 min, el candado silenciaba
 * los seguimientos de cierre de Vicky y el vendedor convertía ~0 (0/57
 * outbound) — 68 formales emitidas del 04 al 07 con CERO aceptadas. Ahora el
 * contacto queda mudo para Vicky SOLO cuando su vendedor hizo contacto real
 * (mensaje desde su WhatsApp espejado o llamada contestada, posterior al
 * traspaso): hasta entonces la venta sigue siendo de Vicky, y el vendedor
 * puede sumarse cuando llame. Env VICKY_PTV_CANDADO_CLASICO=1 restaura el
 * comportamiento anterior (traspasado ⇒ mudo) como rollback sin deploy.
 */
export async function contactosTraspasados(contacts: string[]): Promise<Set<string>> {
  const out = new Set<string>()
  if (!contacts.length || !SUPABASE_URL || !SUPABASE_KEY) return out
  // CANDADO v4 (Lalo 27-ago, "no hay que apagar a Vicky en ningún momento"):
  // el traspaso YA NO silencia la proactividad NUNCA — ni siquiera con
  // contacto real del vendedor. Vicky acompaña siempre; lo que cambia con el
  // traspaso es el CONTENIDO del toque (el t5 con contexto pregunta cómo le
  // fue con el ejecutivo y recoge lo clave de la conversación del espejo).
  // Rollbacks sin deploy: VICKY_TRASPASO_SILENCIA=1 restaura el candado v3
  // (silencio con atención real); VICKY_PTV_CANDADO_CLASICO=1 el clásico.
  const modo = (process.env.VICKY_TRASPASO_SILENCIA || "").trim()
  if (modo !== "1" && (process.env.VICKY_PTV_CANDADO_CLASICO || "").trim() !== "1") {
    return out
  }
  const lista = contacts.map((c) => `"${c}"`).join(",")
  const res = await supa(
    `vic_ptv?contact=in.(${lista})&estado=eq.activo&select=contact,traspasado_at`,
  ).catch(() => null)
  if (!res || !res.ok) return out
  const rows =
    ((await res.json().catch(() => [])) as Array<{ contact: string; traspasado_at?: string }>) || []
  if (!rows.length) return out
  if ((process.env.VICKY_PTV_CANDADO_CLASICO || "").trim() === "1") {
    for (const r of rows) if (r.contact) out.add(r.contact)
    return out
  }
  const atendidos = await contactosAtendidosPorVendedor(
    rows.map((r) => ({ contact: r.contact, desdeIso: r.traspasado_at || "" })),
  ).catch(() => new Set<string>())
  for (const r of rows) if (r.contact && atendidos.has(r.contact)) out.add(r.contact)
  return out
}

/**
 * Vendedor del traspaso ACTIVO de un contacto (vic_ptv), o null si no hay.
 * Lo usa el agent-loop para que la cotización formal de un contacto ya
 * traspasado NAZCA con ese ejecutivo como dueño (sin re-sorteo de tómbola):
 * el correo con el PDF debe salir sí o sí con el ejecutivo asignado en copia
 * y presentándolo (Lalo 03-ago).
 */
export async function vendedorTraspasado(
  contact: string,
): Promise<{ zohoId: string; email: string; nombre: string } | null> {
  if (!contact || !SUPABASE_URL || !SUPABASE_KEY) return null
  const res = await supa(
    `vic_ptv?contact=eq.${encodeURIComponent(contact)}&estado=eq.activo&select=vendedor_zoho_id,vendedor_email,vendedor_nombre&limit=1`,
  ).catch(() => null)
  if (!res || !res.ok) return null
  const rows =
    ((await res.json().catch(() => [])) as Array<{
      vendedor_zoho_id?: string
      vendedor_email?: string
      vendedor_nombre?: string
    }>) || []
  const row = rows[0]
  if (!row?.vendedor_zoho_id) return null
  return {
    zohoId: row.vendedor_zoho_id,
    email: row.vendedor_email || "",
    nombre: row.vendedor_nombre || "",
  }
}

/**
 * Contactos (de la lista dada) que tienen fila en vic_loop — UN solo fetch
 * batch, para que los crons viejos los salten sin caer en N+1. Con el flag
 * apagado devuelve set vacío SIN tocar la red: cero cambio de comportamiento.
 */
export async function contactosEnLoop(
  contacts: string[],
  // soloActivos (biblia F3, 12-ago): los CONSENSUADOS quedaban en tierra de
  // nadie — la reactivación los excluía por tener CUALQUIER fila en vic_loop
  // (incluso cerrada) y el loop cerrado jamás los tocaba: 35 promesas
  // vencidas sin disparar. Con soloActivos la exclusión cuenta únicamente
  // loops que de verdad van a tocar al contacto.
  opts: { soloActivos?: boolean } = {},
): Promise<Set<string>> {
  const enLoop = new Set<string>()
  if (!loopV2Enabled() || !contacts.length || !SUPABASE_URL || !SUPABASE_KEY) return enLoop
  // in.() de PostgREST con los contactos entre comillas (mismo patrón que la
  // consulta batch de vic-outbound-cadence-cron sobre vic_v3_conversations).
  const lista = contacts.map((c) => `"${c}"`).join(",")
  const filtroEstado = opts.soloActivos ? "&estado=eq.activo" : ""
  const res = await supa(`vic_loop?contact=in.(${lista})&select=contact${filtroEstado}`).catch(() => null)
  if (!res || !res.ok) return enLoop
  const rows = ((await res.json().catch(() => [])) as Array<{ contact: string }>) || []
  for (const r of rows) if (r.contact) enLoop.add(r.contact)
  return enLoop
}
