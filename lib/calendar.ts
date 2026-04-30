const CAL_API_KEY = (process.env.CAL_API_KEY || "").trim()
const CAL_EVENT_TYPE_ID = (process.env.CAL_EVENT_TYPE_ID || "5538437").trim()
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

function toDateStr(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function isWeekend(date: Date): boolean {
  const day = date.getDay()
  return day === 0 || day === 6
}

export async function getAvailableSlots(country: string): Promise<string[]> {
  const countryCode = COUNTRY_CODES[country] || "CL"
  const tz = getTimezone(country)

  const now = new Date()
  // Min start: 3 business hours from now (approx 3h)
  const minStart = new Date(now.getTime() + 3 * 60 * 60 * 1000)
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

  const validSlots: string[] = []
  const days = Object.keys(slotsByDay).sort()

  for (const day of days) {
    if (validSlots.length >= 3) break
    if (isWeekend(new Date(day + "T12:00:00Z"))) continue
    if (allHolidays.has(day)) continue

    const daySlots = slotsByDay[day]
    if (!daySlots?.length) continue

    // Take first available slot of the day
    const slot = daySlots[0]
    validSlots.push(slot.time)
  }

  return validSlots
}

export function formatSlotsForProspect(slots: string[], country: string, language = "es"): string {
  const tz = getTimezone(country)
  const formatted = slots.map((isoTime, i) => {
    const date = new Date(isoTime)
    const options: Intl.DateTimeFormatOptions = {
      timeZone: tz,
      weekday: "long",
      day: "numeric",
      month: "long",
      hour: "2-digit",
      minute: "2-digit",
    }
    const locale = language === "pt" ? "pt-BR" : language === "en" ? "en-US" : "es-CL"
    const label = date.toLocaleString(locale, options)
    return `${i + 1}. ${label}`
  })
  return formatted.join("\n")
}

export async function bookMeeting(params: {
  slotIso: string
  prospectName: string
  prospectEmail: string
  language?: string
  timeZone?: string
}): Promise<{ success: boolean; bookingId?: string; meetingUrl?: string; error?: string }> {
  const { slotIso, prospectName, prospectEmail, language = "es", timeZone = "America/Santiago" } = params

  const body = {
    eventTypeId: Number(CAL_EVENT_TYPE_ID),
    start: slotIso,
    attendee: {
      name: prospectName,
      email: prospectEmail,
      timeZone,
      language,
    },
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
    data?: { uid?: string; meetingUrl?: string; id?: number }
    error?: string
    message?: string
  }

  if (!res.ok || data.status === "error") {
    return { success: false, error: data.message || data.error || "Error al agendar" }
  }

  return {
    success: true,
    bookingId: data.data?.uid || String(data.data?.id || ""),
    meetingUrl: data.data?.meetingUrl,
  }
}
