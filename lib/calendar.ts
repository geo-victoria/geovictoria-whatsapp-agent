import * as chrono from "chrono-node"

const CAL_API_KEY = (process.env.CAL_API_KEY || "").trim()
const CAL_EVENT_TYPE_ID = (process.env.CAL_EVENT_TYPE_ID || "3188650").trim()
const CAL_BASE = "https://api.cal.com/v2"
const CAL_HEADERS = {
  Authorization: `Bearer ${CAL_API_KEY}`,
  "cal-api-version": "2024-08-13",
  "Content-Type": "application/json",
}

// Country name → IANA timezone
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

// Country name → ISO 3166-1 alpha-2 (for holidays API)
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

async function getPublicHolidays(year: number, countryCode: string): Promise<string[]> {
  try {
    const res = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${year}/${countryCode}`, {
      cache: "no-store",
    })
    if (!res.ok) return []
    const data = await res.json() as Array<{ date: string }>
    return data.map((h) => h.date) // "2026-01-01" format
  } catch {
    return []
  }
}

function isWeekend(date: Date): boolean {
  const day = date.getDay()
  return day === 0 || day === 6
}

export async function getAvailableSlots(country: string): Promise<string[]> {
  const countryCode = COUNTRY_CODES[country] || "CL"
  const tz = getTimezone(country)

  const now = new Date()
  // Min start: 25h from now — ensures slots are always bookable by Cal.com
  const minStart = new Date(now.getTime() + 25 * 60 * 60 * 1000)
  const end = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000) // 2 weeks ahead

  const year = now.getFullYear()
  const nextYear = year + 1
  const [holidays, holidaysNext] = await Promise.all([
    getPublicHolidays(year, countryCode),
    getPublicHolidays(nextYear, countryCode),
  ])
  const allHolidays = new Set([...holidays, ...holidaysNext])

  const res = await fetch(
    `${CAL_BASE}/slots/available?eventTypeId=${CAL_EVENT_TYPE_ID}&startTime=${minStart.toISOString()}&endTime=${end.toISOString()}&timeZone=${encodeURIComponent(tz)}`,
    { headers: CAL_HEADERS, cache: "no-store" }
  )

  if (!res.ok) {
    console.error("[calendar] Cal.com slots error:", await res.text())
    return []
  }

  const data = await res.json() as { data?: { slots?: Record<string, Array<{ time: string }>> } }
  const slotsByDay = data.data?.slots || {}

  const validDays: Array<{ day: string; slots: Array<{ time: string }> }> = []
  const days = Object.keys(slotsByDay).sort()

  for (const day of days) {
    if (isWeekend(new Date(day + "T12:00:00Z"))) continue
    if (allHolidays.has(day)) continue
    const daySlots = slotsByDay[day]
    if (!daySlots?.length) continue
    validDays.push({ day, slots: daySlots })
    if (validDays.length >= 3) break
  }

  if (validDays.length === 0) return []

  // Si hay 3 días distintos, tomar el primer slot de cada uno
  if (validDays.length >= 3) {
    return validDays.slice(0, 3).map(d => d.slots[0].time)
  }

  // Si hay menos de 3 días, completar con slots adicionales del mismo día
  const result: string[] = []
  for (const { slots } of validDays) {
    for (const s of slots) {
      if (result.length >= 3) break
      if (!result.includes(s.time)) result.push(s.time)
    }
    if (result.length >= 3) break
  }
  return result
}

// Detecta qué slot eligió el usuario usando número explícito o lenguaje natural (chrono-node)
export function matchSlotFromMessage(message: string, pendingSlots: string[], _tz: string): number | null {
  const lower = message.toLowerCase()

  // Selección por número explícito
  if (/\b1\b|primer[ao]/.test(lower) && pendingSlots[0]) return 1
  if (/\b2\b|segund[ao]/.test(lower) && pendingSlots[1]) return 2
  if (/\b3\b|tercer[ao]/.test(lower) && pendingSlots[2]) return 3

  // Si el mensaje es una pregunta, dejarlo al LLM ("¿puedes el martes?", "¿tienes el jueves?")
  if (message.includes("?") || /\b(puedes|tienes|hay|puede|tiene|podrías|podría)\b/i.test(lower)) {
    return null
  }

  // Parseo de lenguaje natural con chrono-node en español
  const parsed = chrono.es.parse(message, new Date(), { forwardDate: true })
  if (!parsed.length) return null

  const referenceDate = parsed[0].start.date()

  // Encontrar el slot más cercano al tiempo de referencia
  let bestIndex = -1
  let bestDiffMs = Infinity

  for (let i = 0; i < pendingSlots.length; i++) {
    const diffMs = Math.abs(new Date(pendingSlots[i]).getTime() - referenceDate.getTime())
    if (diffMs < bestDiffMs) {
      bestDiffMs = diffMs
      bestIndex = i
    }
  }

  // Retornar si está dentro de 72 horas del tiempo de referencia
  if (bestIndex >= 0 && bestDiffMs <= 72 * 60 * 60 * 1000) return bestIndex + 1

  return null
}

const DAYS_ES = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"]
const MONTHS_ES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"]
const DAYS_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
const MONTHS_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
const DAYS_PT = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"]
const MONTHS_PT = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"]

function formatSlotLabel(isoTime: string, tz: string, language: string): string {
  const date = new Date(isoTime)
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short", day: "numeric", month: "numeric",
    hour: "numeric", minute: "2-digit", hour12: false,
  }).formatToParts(date)

  const get = (type: string) => parts.find(p => p.type === type)?.value || ""
  const dow = new Date(date.toLocaleString("en-US", { timeZone: tz })).getDay()
  const month = parseInt(get("month")) - 1
  const day = get("day")
  const hour = get("hour").padStart(2, "0")
  const min = get("minute")

  if (language === "en") {
    return `${DAYS_EN[dow]} ${MONTHS_EN[month]} ${day} at ${hour}:${min}`
  }
  if (language === "pt") {
    return `${DAYS_PT[dow]}, ${day} de ${MONTHS_PT[month]} às ${hour}h${min !== "00" ? min : ""}`
  }
  return `${DAYS_ES[dow]} ${day} de ${MONTHS_ES[month]} a las ${hour}:${min} hrs`
}

export function formatSlotsForProspect(slots: string[], country: string, language = "es"): string {
  const tz = getTimezone(country)
  const bullets = ["•", "•", "•"]
  return slots.map((isoTime, i) => `${bullets[i]} ${formatSlotLabel(isoTime, tz, language)}`).join("\n")
}

export async function bookMeeting(params: {
  slotIso: string
  prospectName: string
  prospectEmail: string
  language?: string
  timeZone?: string
}): Promise<{ success: boolean; bookingId?: string; meetingUrl?: string; organizerEmail?: string; error?: string }> {
  const { slotIso, prospectName, prospectEmail, language = "es", timeZone = "America/Santiago" } = params

  const meetingGuest = (process.env.CAL_MEETING_GUEST_EMAIL || "egomez@geovictoria.com").trim()
  const body = {
    eventTypeId: Number(CAL_EVENT_TYPE_ID),
    start: slotIso,
    attendee: {
      name: prospectName,
      email: prospectEmail,
      timeZone,
      language,
    },
    guests: meetingGuest && meetingGuest !== prospectEmail ? [meetingGuest] : [],
    metadata: {
      source: "whatsapp_vicky",
    },
  }

  const res = await fetch(`${CAL_BASE}/bookings`, {
    method: "POST",
    headers: CAL_HEADERS,
    body: JSON.stringify(body),
    cache: "no-store",
  })

  const data = await res.json() as {
    status?: string
    data?: {
      uid?: string
      meetingUrl?: string
      id?: number
      start?: string
      status?: string
      organizer?: { name?: string; email?: string }
      hosts?: Array<{ name?: string; email?: string }>
    }
    error?: unknown
    message?: string
    statusCode?: number
  }

  // Consideramos éxito solo si hay uid y el booking no quedó en estado inválido
  const uid = data.data?.uid || data.data?.id
  const bookingStatus = data.data?.status
  if (!res.ok || data.status === "error" || data.statusCode || !uid) {
    const errMsg = data.message || JSON.stringify(data.error || data).slice(0, 200)
    console.error("[calendar] booking failed:", res.status, errMsg)
    return { success: false, error: errMsg }
  }
  if (bookingStatus && !["accepted", "pending"].includes(String(bookingStatus).toLowerCase())) {
    console.error("[calendar] booking unexpected status:", bookingStatus)
    return { success: false, error: `Booking status: ${bookingStatus}` }
  }
  console.log("[calendar] booking created:", uid, "status:", bookingStatus)

  const organizerEmail =
    data.data?.organizer?.email ||
    data.data?.hosts?.[0]?.email ||
    undefined

  return {
    success: true,
    bookingId: String(uid),
    meetingUrl: data.data?.meetingUrl,
    organizerEmail,
  }
}
