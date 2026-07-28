const CAL_API_KEY = (process.env.CAL_API_KEY || "").trim()
const CAL_EVENT_TYPE_ID = (process.env.CAL_EVENT_TYPE_ID || "3188650").trim()
const CAL_BASE = "https://api.cal.com/v2"
const CAL_HEADERS = {
  Authorization: `Bearer ${CAL_API_KEY}`,
  "cal-api-version": "2024-08-13",
  "Content-Type": "application/json",
}

const COUNTRY_TIMEZONES: Record<string, string> = {
  Chile: "America/Santiago",
  Argentina: "America/Argentina/Buenos_Aires",
  Colombia: "America/Bogota",
  México: "America/Mexico_City",
  Mexico: "America/Mexico_City",
  Perú: "America/Lima",
  Peru: "America/Lima",
  Brasil: "America/Sao_Paulo",
  Brazil: "America/Sao_Paulo",
  Venezuela: "America/Caracas",
  Ecuador: "America/Guayaquil",
  Bolivia: "America/La_Paz",
  Paraguay: "America/Asuncion",
  Uruguay: "America/Montevideo",
  Panama: "America/Panama",
  "Costa Rica": "America/Costa_Rica",
  Guatemala: "America/Guatemala",
  Honduras: "America/Tegucigalpa",
  España: "Europe/Madrid",
  Spain: "Europe/Madrid",
  "Estados Unidos": "America/New_York",
  "United States": "America/New_York",
  "Reino Unido": "Europe/London",
  "United Kingdom": "Europe/London",
}

const COUNTRY_CODES: Record<string, string> = {
  Chile: "CL", Argentina: "AR", Colombia: "CO", México: "MX", Mexico: "MX",
  Perú: "PE", Peru: "PE", Brasil: "BR", Brazil: "BR", Venezuela: "VE",
  Ecuador: "EC", Bolivia: "BO", Paraguay: "PY", Uruguay: "UY",
  Panama: "PA", "Costa Rica": "CR", Guatemala: "GT", Honduras: "HN",
  España: "ES", Spain: "ES", "Estados Unidos": "US", "United States": "US",
  "Reino Unido": "GB", "United Kingdom": "GB",
}

export function getTimezone(country: string): string {
  return COUNTRY_TIMEZONES[country] || "America/Santiago"
}

// Offset (en minutos) de una zona horaria en un instante dado. Positivo al este
// de UTC, negativo al oeste (ej. America/Santiago en invierno → -240).
function tzOffsetMinutes(timeZone: string, date: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date)
  const map: Record<string, string> = {}
  for (const p of parts) map[p.type] = p.value
  const asUTC = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second),
  )
  return (asUTC - date.getTime()) / 60000
}

/**
 * Calcula CUÁNDO enviar el recordatorio de una reunión.
 *   - MEETING_REMINDER_MODE="morning" (default): a las HH:00 (MEETING_REMINDER_HOUR,
 *     default 8) hora LOCAL del día de la reunión.
 *   - MEETING_REMINDER_MODE="hours_before": N horas antes del inicio
 *     (MEETING_REMINDER_LEAD_HOURS, default 3).
 * Devuelve null si la fecha es inválida.
 */
export function computeMeetingReminderAt(startIso: string, timeZone: string): Date | null {
  const start = new Date(startIso)
  if (isNaN(start.getTime())) return null

  const mode = (process.env.MEETING_REMINDER_MODE || "morning").trim()
  if (mode === "hours_before") {
    const lead = Number(process.env.MEETING_REMINDER_LEAD_HOURS || "3")
    return new Date(start.getTime() - lead * 60 * 60 * 1000)
  }

  // "morning": HH:00 hora local del día de la reunión.
  const hour = Number(process.env.MEETING_REMINDER_HOUR || "8")
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(start) // "YYYY-MM-DD"
  // Wall time HH:00 de ese día tratada como UTC, corregida por el offset del tz.
  const wallUTC = new Date(`${ymd}T${String(hour).padStart(2, "0")}:00:00Z`)
  const offsetMin = tzOffsetMinutes(timeZone, wallUTC)
  return new Date(wallUTC.getTime() - offsetMin * 60000)
}

async function getPublicHolidays(year: number, countryCode: string): Promise<string[]> {
  try {
    const res = await fetch(
      `https://date.nager.at/api/v3/PublicHolidays/${year}/${countryCode}`,
      { cache: "no-store" },
    )
    if (!res.ok) return []
    const data = (await res.json()) as Array<{ date: string }>
    return data.map((h) => h.date)
  } catch {
    return []
  }
}

function isWeekend(date: Date): boolean {
  const day = date.getDay()
  return day === 0 || day === 6
}

export async function getAvailableSlots(country: string): Promise<string[]> {
  if (!CAL_API_KEY) return []

  const tz = getTimezone(country)
  const countryCode = COUNTRY_CODES[country] || "CL"
  const year = new Date().getFullYear()
  const [holidays, holidaysNext] = await Promise.all([
    getPublicHolidays(year, countryCode),
    getPublicHolidays(year + 1, countryCode),
  ])
  const allHolidays = new Set([...holidays, ...holidaysNext])

  // Cal.com decide el "minimum booking notice" por su Event Type — no aplicamos
  // buffer manual aquí. Pedimos slots desde ahora; Cal.com filtra los inválidos.
  const now = new Date()
  const start = now
  const end = new Date(start.getTime() + 14 * 24 * 60 * 60 * 1000)

  const url =
    `${CAL_BASE}/slots/available?eventTypeId=${CAL_EVENT_TYPE_ID}` +
    `&startTime=${start.toISOString()}&endTime=${end.toISOString()}` +
    `&timeZone=${encodeURIComponent(tz)}`

  try {
    const res = await fetch(url, { headers: CAL_HEADERS, cache: "no-store" })
    if (!res.ok) {
      console.error("[calendar] slots/available error:", res.status, await res.text().catch(() => ""))
      return []
    }
    const data = (await res.json()) as { data?: { slots?: Record<string, Array<{ time: string }>> } }
    const slotsByDay = data.data?.slots || {}

    const valid: string[] = []
    for (const day of Object.keys(slotsByDay).sort()) {
      if (isWeekend(new Date(day + "T12:00:00Z"))) continue
      if (allHolidays.has(day)) continue
      for (const s of slotsByDay[day]) valid.push(s.time)
    }

    if (valid.length === 0) return []

    // Devuelve 3 slots: el primero, uno medio, y uno cercano al final
    const indices = [0, Math.floor(valid.length / 2), valid.length - 1]
    const unique = Array.from(new Set(indices.map((i) => valid[i])))
    return unique
  } catch (e) {
    console.error("[calendar] getAvailableSlots exception:", e)
    return []
  }
}

const DAYS_ES = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"]
const MONTHS_ES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"]
const DAYS_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
const MONTHS_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
const DAYS_PT = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"]
const MONTHS_PT = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"]

/** Offset (en minutos) de una zona horaria en un instante dado. */
function offsetEnMinutos(tz: string, d: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(d)
  const name = parts.find((p) => p.type === "timeZoneName")?.value || "GMT+0"
  const m = name.match(/GMT([+-]\d{1,2})(?::(\d{2}))?/)
  if (!m) return 0
  const hh = parseInt(m[1], 10)
  const mm = m[2] ? parseInt(m[2], 10) : 0
  return hh * 60 + (hh < 0 ? -mm : mm)
}

/**
 * Normaliza un slot ISO escrito por el MODELO: la HORA DE PARED manda.
 *
 * CASO QUE ORIGINA ESTO (Valeska / Tri-Stone, 28-jul): la tool ofreció slots
 * correctos (15:00/15:20/15:40 de Chile), la clienta eligió "15:40" y el
 * modelo construyó el slotIso A MANO como 2026-07-31T15:40:00-03:00 —
 * asumiendo el offset de VERANO de Chile. En julio Chile es -04, así que ese
 * string es el instante 14:40 local: el slot de las 14:40 también estaba
 * libre, la verificación dio "disponible_exacto" y la reunión nació una hora
 * antes de lo que la clienta confirmó.
 *
 * Regla: si el string declara un offset distinto al REAL de la zona en esa
 * fecha, la hora escrita (lo que el cliente leyó y confirmó) se reinterpreta
 * en la zona correcta. Los ISO en Z o sin offset (vienen de la tool de
 * slots, son instantes confiables) y los de offset correcto pasan intactos.
 */
export function normalizarSlotIso(iso: string, tz: string): string {
  const m = String(iso || "")
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})$/)
  if (!m) return iso
  const [, y, mo, d, h, mi, s, off] = m
  if (off === "Z") return iso
  const declarado = new Date(iso)
  if (isNaN(declarado.getTime())) return iso
  const offM = off.match(/([+-])(\d{2}):?(\d{2})/)
  const offDeclarado = offM ? (offM[1] === "-" ? -1 : 1) * (+offM[2] * 60 + +offM[3]) : 0
  const offReal = offsetEnMinutos(tz, declarado)
  if (offDeclarado === offReal) return iso
  const wallUtc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0))
  let instante = wallUtc - offReal * 60000
  // Segunda pasada por si la fecha cae justo en un cambio de horario.
  const offReal2 = offsetEnMinutos(tz, new Date(instante))
  if (offReal2 !== offReal) instante = wallUtc - offReal2 * 60000
  const normalizado = new Date(instante).toISOString()
  console.warn(
    `[calendar] slotIso con offset ${off} ≠ ${tz} (real ${offReal / -60 >= 0 ? "-" : "+"}${Math.abs(offReal / 60)}): ${iso} → ${normalizado} (la hora de pared manda)`,
  )
  return normalizado
}

function formatSlotLabel(iso: string, country: string, language = "es"): string {
  const tz = getTimezone(country)
  const d = new Date(iso)
  const dayName = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" })
    .format(d)
    .toLowerCase()
  const dayIndex = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"].indexOf(dayName)
  const dayNum = parseInt(new Intl.DateTimeFormat("en-US", { timeZone: tz, day: "numeric" }).format(d))
  const monthName = new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "long" })
    .format(d)
    .toLowerCase()
  const monthIndex = ["january","february","march","april","may","june","july","august","september","october","november","december"].indexOf(monthName)

  const timeStr = new Intl.DateTimeFormat("es-CL", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(d)

  if (language === "en") {
    return `${DAYS_EN[dayIndex]} ${dayNum} ${MONTHS_EN[monthIndex]} at ${timeStr} hrs`
  } else if (language === "pt") {
    return `${DAYS_PT[dayIndex]} ${dayNum} de ${MONTHS_PT[monthIndex]} às ${timeStr} hrs`
  }
  return `${DAYS_ES[dayIndex]} ${dayNum} de ${MONTHS_ES[monthIndex]} a las ${timeStr} hrs`
}

export function matchSlotFromMessage(message: string, pendingSlots: string[], tz: string): number | null {
  if (!message || pendingSlots.length === 0) return null
  const m = message.toLowerCase().trim()

  const ordinals: Record<string, number> = {
    "primero": 0, "primera": 0, "el primero": 0, "uno": 0, "1": 0, "el 1": 0,
    "segundo": 1, "segunda": 1, "el segundo": 1, "dos": 1, "2": 1, "el 2": 1,
    "tercero": 2, "tercera": 2, "el tercero": 2, "tres": 2, "3": 2, "el 3": 2,
  }
  for (const [key, idx] of Object.entries(ordinals)) {
    if (m === key || m.includes(` ${key} `) || m.endsWith(` ${key}`) || m.startsWith(`${key} `)) {
      if (idx < pendingSlots.length) return idx
    }
  }

  const daysInMessage: number[] = []
  DAYS_ES.forEach((d, i) => { if (m.includes(d)) daysInMessage.push(i) })
  if (daysInMessage.length > 0) {
    for (let i = 0; i < pendingSlots.length; i++) {
      const slotDate = new Date(pendingSlots[i])
      const slotDayName = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(slotDate).toLowerCase()
      const slotDayIndex = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"].indexOf(slotDayName)
      if (daysInMessage.includes(slotDayIndex)) return i
    }
  }

  const hourMatch = m.match(/(\d{1,2})(?:\s*hrs?|\s*h|:\d{2})?/)
  if (hourMatch) {
    const hour = parseInt(hourMatch[1])
    for (let i = 0; i < pendingSlots.length; i++) {
      const slotHour = parseInt(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false }).format(new Date(pendingSlots[i])))
      if (slotHour === hour) return i
    }
  }

  if (pendingSlots.length === 1) {
    if (/(sí|si|ok|dale|listo|vale|perfecto|confirmo|me sirve|me funciona)/i.test(m)) {
      return 0
    }
  }

  return null
}

/** Etiqueta legible de un slot ("martes 21 de julio a las 09:00 hrs"). */
export function etiquetaSlot(iso: string, country: string, language = "es"): string {
  return formatSlotLabel(iso, country, language)
}

/**
 * Calendario de los próximos N días ("vie 17-jul, sáb 18-jul, ...") para el
 * anclaje temporal del prompt. Motivo (bug 17-jul, agenda CO): el modelo
 * calcula MAL los días de la semana ("lunes 21" cuando el 21 es martes) y un
 * cliente que anota el día errado no llega a su reunión. Con la tabla en el
 * prompt no hay aritmética de calendario que hacer.
 */
export function calendarioProximosDias(timeZone: string, dias = 14): string {
  const fmt = new Intl.DateTimeFormat("es-CL", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
  })
  const out: string[] = []
  for (let i = 0; i < dias; i++) {
    const d = new Date(Date.now() + i * 24 * 60 * 60 * 1000)
    out.push(fmt.format(d))
  }
  return out.join(" · ")
}

export function formatSlotsForProspect(slots: string[], country: string, language = "es"): string {
  if (slots.length === 0) return ""
  return slots.map((s, i) => `${i + 1}. ${formatSlotLabel(s, country, language)}`).join("\n")
}

export async function getSlotsByPreference(
  preferredDate: Date,
  country: string,
  preferredHour?: number,
): Promise<string[]> {
  if (!CAL_API_KEY) return []

  const tz = getTimezone(country)
  const countryCode = COUNTRY_CODES[country] || "CL"
  const year = new Date().getFullYear()
  const [holidays, holidaysNext] = await Promise.all([
    getPublicHolidays(year, countryCode),
    getPublicHolidays(year + 1, countryCode),
  ])
  const allHolidays = new Set([...holidays, ...holidaysNext])

  // Cal.com decide el "minimum booking notice" — no aplicamos buffer manual.
  const now = new Date()
  const start = new Date(Math.max(now.getTime(), preferredDate.getTime() - 24 * 60 * 60 * 1000))
  const end = new Date(preferredDate.getTime() + 6 * 24 * 60 * 60 * 1000)

  const url =
    `${CAL_BASE}/slots/available?eventTypeId=${CAL_EVENT_TYPE_ID}` +
    `&startTime=${start.toISOString()}&endTime=${end.toISOString()}` +
    `&timeZone=${encodeURIComponent(tz)}`

  try {
    const res = await fetch(url, { headers: CAL_HEADERS, cache: "no-store" })
    if (!res.ok) return []
    const data = (await res.json()) as { data?: { slots?: Record<string, Array<{ time: string }>> } }
    const slotsByDay = data.data?.slots || {}

    const valid: string[] = []
    for (const day of Object.keys(slotsByDay).sort()) {
      if (isWeekend(new Date(day + "T12:00:00Z"))) continue
      if (allHolidays.has(day)) continue
      for (const s of slotsByDay[day]) valid.push(s.time)
    }
    if (valid.length === 0) return []

    if (preferredHour !== undefined) {
      const scored = valid.map((slot) => {
        const slotHour = parseInt(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false }).format(new Date(slot)))
        const distance = Math.abs(slotHour - preferredHour)
        return { slot, distance }
      })
      scored.sort((a, b) => a.distance - b.distance)
      return scored.slice(0, 3).map((s) => s.slot)
    }

    if (valid.length <= 3) return valid
    const indices = [0, Math.floor(valid.length / 2), valid.length - 1]
    return indices.map((i) => valid[i])
  } catch {
    return []
  }
}

export function parsePreferredTime(message: string): { date: Date; hour?: number } | null {
  // Stub legacy. V3 ya no la usa. V1/V2 podría seguir invocándola desde
  // vic-botmaker/route.ts; devolvemos null para no romper imports existentes.
  if (!message) return null
  return null
}

/** Persona (organizer u host) tal como viene en los payloads de bookings v2. */
type CalPerson = { name?: string; email?: string; displayEmail?: string }

/**
 * Email del ejecutivo asignado a un booking. Prioriza hosts[0] (en eventos de
 * team round-robin ES el host asignado; el organizer puede ser el dueño de la
 * cuenta de la API) y acepta displayEmail como fallback de email (Cal.com no
 * siempre manda ambos).
 */
function extractHostEmail(d?: { organizer?: CalPerson; hosts?: CalPerson[] }): string | undefined {
  const h = d?.hosts?.[0]
  return h?.email || h?.displayEmail || d?.organizer?.email || d?.organizer?.displayEmail || undefined
}

export async function bookMeeting(params: {
  slotIso: string
  prospectName: string
  prospectEmail: string
  language?: string
  timeZone?: string
  /**
   * Event type de Cal.com donde agendar (default: el chileno CAL_EVENT_TYPE_ID).
   *
   * NOTA (28-jul): NO existe forma de forzar un host dentro de un evento
   * round-robin por la API 2024-08-13 — se probó `teamMemberEmail` de primer
   * nivel con la key real y la API lo rechaza con 400 "property
   * teamMemberEmail should not exist" (solo existe dentro de `routing`, que
   * exige formularios de ruteo). El camino para "la reunión es del dueño de
   * la cotización" es agendar en el EVENT TYPE PERSONAL/managed del dueño,
   * pasando su eventTypeId aquí.
   */
  eventTypeId?: string
}): Promise<{ success: true; bookingId: string; meetingUrl?: string; organizerEmail?: string } | { success: false; error: string }> {
  if (!CAL_API_KEY) {
    return { success: false, error: "CAL_API_KEY no configurada en el entorno." }
  }

  const {
    prospectName,
    prospectEmail,
    language = "es",
    timeZone = "America/Santiago",
  } = params
  // La hora de pared manda: corrige offsets inventados por el modelo.
  const slotIso = normalizarSlotIso(params.slotIso, timeZone)

  const meetingGuest = (process.env.CAL_MEETING_GUEST_EMAIL || "egomez@geovictoria.com").trim()
  const body = {
    eventTypeId: Number(params.eventTypeId || CAL_EVENT_TYPE_ID),
    start: slotIso,
    attendee: { name: prospectName, email: prospectEmail, timeZone, language },
    guests: meetingGuest && meetingGuest !== prospectEmail ? [meetingGuest] : [],
    metadata: { source: "whatsapp_vicky_v3" },
  }

  try {
    const res = await fetch(`${CAL_BASE}/bookings`, {
      method: "POST",
      headers: CAL_HEADERS,
      body: JSON.stringify(body),
      cache: "no-store",
    })

    const data = (await res.json()) as {
      status?: string
      data?: {
        uid?: string
        meetingUrl?: string
        id?: number
        start?: string
        status?: string
        organizer?: CalPerson
        hosts?: CalPerson[]
      }
      error?: unknown
      message?: string
      statusCode?: number
    }

    const uid = data.data?.uid || data.data?.id
    const bookingStatus = data.data?.status
    if (!res.ok || data.status === "error" || data.statusCode || !uid) {
      const errMsg = data.message || JSON.stringify(data.error || data).slice(0, 300)
      console.error("[calendar] booking failed:", res.status, errMsg)
      return { success: false, error: errMsg }
    }
    if (bookingStatus && !["accepted", "pending"].includes(String(bookingStatus).toLowerCase())) {
      console.error("[calendar] booking unexpected status:", bookingStatus)
      return { success: false, error: `Booking status: ${bookingStatus}` }
    }
    console.log("[calendar] booking created:", uid, "status:", bookingStatus)

    let organizerEmail = extractHostEmail(data.data)

    // Refetch con reintento: en bookings de team round-robin la respuesta del
    // POST puede venir sin el email del host (o solo con displayEmail), y el
    // GET inmediato a veces llega antes de que el host quede materializado.
    // Sin este email, el Lead en Zoho cae al owner default (bug prueba CO 13-jul).
    for (let intento = 0; !organizerEmail && uid && intento < 2; intento++) {
      if (intento > 0) await new Promise((r) => setTimeout(r, 2000))
      try {
        const bookingRes = await fetch(`${CAL_BASE}/bookings/${uid}`, {
          headers: CAL_HEADERS,
          cache: "no-store",
        })
        if (bookingRes.ok) {
          const bookingData = (await bookingRes.json()) as {
            data?: { organizer?: CalPerson; hosts?: CalPerson[] }
          }
          organizerEmail = extractHostEmail(bookingData.data)
        }
      } catch {
        // Fallo silencioso — el Lead quedará con owner default
      }
    }
    if (!organizerEmail) {
      console.error(
        `[calendar] booking ${uid}: sin email de host — organizer/hosts:`,
        JSON.stringify({ organizer: data.data?.organizer, hosts: data.data?.hosts }).slice(0, 400),
      )
    }

    return {
      success: true,
      bookingId: String(uid),
      meetingUrl: data.data?.meetingUrl,
      organizerEmail,
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "error de red contactando Cal.com"
    console.error("[calendar] bookMeeting exception:", e)
    return { success: false, error: msg }
  }
}

/**
 * Reagenda un booking existente a un nuevo slot, MANTENIENDO el mismo host.
 * Usa el endpoint dedicado de Cal.com (POST /bookings/{uid}/reschedule), que NO
 * re-corre el Round Robin: conserva el ejecutivo asignado y cancela la reunión
 * vieja automáticamente. (Para garantizar el mismo host en un event type Round
 * Robin, este debe tener activado "reschedule with same round-robin host".)
 */
export async function rescheduleMeeting(params: {
  bookingUid: string
  newSlotIso: string
  reason?: string
}): Promise<
  | { success: true; bookingId: string; meetingUrl?: string; organizerEmail?: string; startIso: string }
  | { success: false; error: string }
> {
  if (!CAL_API_KEY) return { success: false, error: "CAL_API_KEY no configurada en el entorno." }
  const { bookingUid, newSlotIso, reason } = params

  try {
    const res = await fetch(`${CAL_BASE}/bookings/${encodeURIComponent(bookingUid)}/reschedule`, {
      method: "POST",
      headers: CAL_HEADERS,
      body: JSON.stringify({
        start: newSlotIso,
        reschedulingReason: reason || "Reagendado por el cliente vía WhatsApp",
      }),
      cache: "no-store",
    })

    const data = (await res.json()) as {
      status?: string
      data?: {
        uid?: string
        id?: number
        start?: string
        status?: string
        meetingUrl?: string
        organizer?: CalPerson
        hosts?: CalPerson[]
      }
      message?: string
      error?: unknown
      statusCode?: number
    }

    const uid = data.data?.uid || data.data?.id
    if (!res.ok || data.status === "error" || data.statusCode || !uid) {
      const errMsg = data.message || JSON.stringify(data.error || data).slice(0, 300)
      console.error("[calendar] reschedule failed:", res.status, errMsg)
      return { success: false, error: errMsg }
    }

    console.log("[calendar] reschedule ok:", bookingUid, "→", uid, "start:", data.data?.start)

    // El organizer de la respuesta del reschedule no es confiable (devuelve el
    // host viejo). Re-consultamos el booking nuevo para obtener el host REAL
    // asignado (Cal.com re-corre el round-robin al reagendar por API).
    let organizerEmail = extractHostEmail(data.data)
    try {
      const fresh = await fetch(`${CAL_BASE}/bookings/${uid}`, { headers: CAL_HEADERS, cache: "no-store" })
      if (fresh.ok) {
        const fd = (await fresh.json()) as {
          data?: { organizer?: CalPerson; hosts?: CalPerson[] }
        }
        organizerEmail = extractHostEmail(fd.data) || organizerEmail
      }
    } catch {
      // si falla el re-fetch, queda el de la respuesta (mejor que nada)
    }

    return {
      success: true,
      bookingId: String(uid),
      meetingUrl: data.data?.meetingUrl,
      organizerEmail,
      startIso: data.data?.start || newSlotIso,
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "error de red contactando Cal.com"
    console.error("[calendar] rescheduleMeeting exception:", e)
    return { success: false, error: msg }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Addendum V3: checkSlotAvailability para flujo cliente-propone
// ─────────────────────────────────────────────────────────────────────────────
// En V3 el cliente propone día/hora y Vicky verifica disponibilidad. Si el
// slot exacto no está, Vicky ofrece alternativas cercanas (no propone primero).
// Reusa COUNTRY_CODES, isWeekend y getPublicHolidays definidos arriba.
//
// Cal.com decide el "minimum booking notice" por su Event Type — no aplicamos
// validación local de cuán pronto puede ser la fecha. Solo rechazamos fechas
// pasadas (estrictamente menores a now). El resto lo decide Cal.com.

export type CheckSlotResult =
  | { ok: true; estado: "disponible_exacto"; slotIso: string }
  | { ok: true; estado: "alternativas_mismo_dia"; alternativas: string[] }
  | { ok: true; estado: "alternativas_dias_cercanos"; alternativas: string[] }
  | { ok: true; estado: "sin_disponibilidad" }
  | { ok: false; error: string }

const MATCH_TOLERANCE_MS_V3 = 15 * 60 * 1000 // ±15 min

async function fetchSlotsRawV3(
  startTime: Date,
  endTime: Date,
  tz: string,
  eventTypeId: string = CAL_EVENT_TYPE_ID,
): Promise<Record<string, Array<{ time: string }>>> {
  const url =
    `${CAL_BASE}/slots/available?eventTypeId=${eventTypeId}` +
    `&startTime=${startTime.toISOString()}&endTime=${endTime.toISOString()}` +
    `&timeZone=${encodeURIComponent(tz)}`
  const res = await fetch(url, { headers: CAL_HEADERS, cache: "no-store" })
  if (!res.ok) {
    console.error("[calendar v3] Cal.com slots error:", res.status, await res.text().catch(() => ""))
    return {}
  }
  const data = (await res.json()) as { data?: { slots?: Record<string, Array<{ time: string }>> } }
  return data.data?.slots || {}
}

async function filterValidSlotsV3(
  slotsByDay: Record<string, Array<{ time: string }>>,
  country: string,
): Promise<string[]> {
  const countryCode = COUNTRY_CODES[country] || "CL"
  const year = new Date().getFullYear()
  const [holidays, holidaysNext] = await Promise.all([
    getPublicHolidays(year, countryCode),
    getPublicHolidays(year + 1, countryCode),
  ])
  const allHolidays = new Set([...holidays, ...holidaysNext])

  const result: string[] = []
  for (const day of Object.keys(slotsByDay).sort()) {
    if (isWeekend(new Date(day + "T12:00:00Z"))) continue
    if (allHolidays.has(day)) continue
    for (const s of slotsByDay[day]) result.push(s.time)
  }
  return result
}

/**
 * Verifica si una fecha/hora propuesta por el cliente está disponible en Cal.com.
 * Tolerancia ±15 min para match exacto. Si no calza:
 *   - Busca alternativas el MISMO día → "alternativas_mismo_dia"
 *   - Si nada ese día, busca en los 5 días siguientes → "alternativas_dias_cercanos"
 *   - Si nada en la ventana → "sin_disponibilidad"
 *
 * Solo rechaza la propuesta si está estrictamente en el pasado. El minimum
 * booking notice lo decide Cal.com vía su Event Type config.
 */
export async function checkSlotAvailability(params: {
  slotIso: string
  country: string
  /** Event type de Cal.com a consultar (default: el chileno CAL_EVENT_TYPE_ID). */
  eventTypeId?: string
}): Promise<CheckSlotResult> {
  if (!CAL_API_KEY) {
    return { ok: false, error: "CAL_API_KEY no configurada en el entorno." }
  }

  const { country, eventTypeId = CAL_EVENT_TYPE_ID } = params
  const tz = getTimezone(country)
  // La hora de pared manda: corrige offsets inventados por el modelo, para
  // que la verificación y el booking hablen del MISMO instante que el
  // cliente confirmó.
  const slotIso = normalizarSlotIso(params.slotIso, tz)
  const propuesta = new Date(slotIso)
  if (isNaN(propuesta.getTime())) {
    return { ok: false, error: `slotIso no es una fecha ISO válida: ${slotIso}` }
  }
  const now = new Date()

  if (propuesta.getTime() < now.getTime()) {
    return {
      ok: false,
      error: "La fecha propuesta ya pasó. Propón una fecha futura.",
    }
  }

  try {
    const propuestaLocalDay = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(propuesta)
    const dayStart = new Date(propuestaLocalDay + "T00:00:00.000Z")
    const dayEnd = new Date(propuestaLocalDay + "T23:59:59.999Z")

    const slotsByDay = await fetchSlotsRawV3(dayStart, dayEnd, tz, eventTypeId)
    const sameDaySlots = await filterValidSlotsV3(slotsByDay, country)

    const exact = sameDaySlots.find(
      (s) => Math.abs(new Date(s).getTime() - propuesta.getTime()) <= MATCH_TOLERANCE_MS_V3,
    )
    if (exact) {
      return { ok: true, estado: "disponible_exacto", slotIso: exact }
    }

    if (sameDaySlots.length > 0) {
      const alternativasMismoDia = [...sameDaySlots]
        .sort(
          (a, b) =>
            Math.abs(new Date(a).getTime() - propuesta.getTime()) -
            Math.abs(new Date(b).getTime() - propuesta.getTime()),
        )
        .slice(0, 3)
      return { ok: true, estado: "alternativas_mismo_dia", alternativas: alternativasMismoDia }
    }

    const wideStart = new Date(
      Math.max(now.getTime(), propuesta.getTime() - 1 * 24 * 60 * 60 * 1000),
    )
    const wideEnd = new Date(propuesta.getTime() + 5 * 24 * 60 * 60 * 1000)
    const wideSlots = await fetchSlotsRawV3(wideStart, wideEnd, tz, eventTypeId)
    const allWideSlots = await filterValidSlotsV3(wideSlots, country)

    if (allWideSlots.length > 0) {
      const ordenados = [...allWideSlots].sort(
        (a, b) =>
          Math.abs(new Date(a).getTime() - propuesta.getTime()) -
          Math.abs(new Date(b).getTime() - propuesta.getTime()),
      )
      const usedDays = new Set<string>()
      const result: string[] = []
      for (const slot of ordenados) {
        if (result.length >= 3) break
        const day = slot.split("T")[0]
        if (!usedDays.has(day)) {
          result.push(slot)
          usedDays.add(day)
        }
      }
      return { ok: true, estado: "alternativas_dias_cercanos", alternativas: result }
    }

    return { ok: true, estado: "sin_disponibilidad" }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "error inesperado consultando Cal.com"
    console.error("[calendar v3] checkSlotAvailability exception:", e)
    return { ok: false, error: msg }
  }
}
