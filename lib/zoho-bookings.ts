/**
 * ZOHO BOOKINGS — cliente propio, aislado del CRM (Lalo, 03-sep).
 *
 * POR QUÉ UN CLIENTE APARTE. Agendar la capacitación necesita scopes de
 * Bookings, y el refresh token del CRM no los tiene: usarlo daría
 * OAUTH_SCOPE_MISMATCH (el mismo error que hoy impide adjuntar el PDF a los
 * correos). Regenerar el token del CRM con scopes nuevos era la opción
 * riesgosa —si sale mal se cae Vicky entera—, así que se creó una aplicación
 * Server-based SEPARADA en api-console, con su propio Client ID y Secret.
 * Cualquier problema acá no puede tocar al CRM: son credenciales distintas.
 *
 * FAIL-SAFE: sin credenciales la habilidad simplemente NO EXISTE. Nada de
 * prometerle al cliente una capacitación que después no se agenda — la
 * lección de las 20 promesas incumplidas de esta semana.
 */

const BASE = "https://www.zohoapis.com/bookings/v1/json"
const ACCOUNTS = "https://accounts.zoho.com/oauth/v2/token"

const env = (n: string) => (process.env[n] || "").trim()

/** ¿Está configurado? Si no, quien llame debe abstenerse de prometer nada. */
export function bookingsConfigurado(): boolean {
  return Boolean(env("ZOHO_BOOKINGS_CLIENT_ID") && env("ZOHO_BOOKINGS_CLIENT_SECRET") && env("ZOHO_BOOKINGS_REFRESH_TOKEN"))
}

// Caché en memoria por instancia: el access token vive ~1 h y pedir uno nuevo
// en cada llamada es lo que provocó la tormenta de "Access Denied" del 01-sep
// (tope de refrescos por martillar la renovación).
const cache: { token?: string; hasta?: number } = {}

export async function accessTokenBookings(): Promise<string> {
  if (cache.token && cache.hasta && Date.now() < cache.hasta) return cache.token
  if (!bookingsConfigurado()) return ""
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: env("ZOHO_BOOKINGS_CLIENT_ID"),
    client_secret: env("ZOHO_BOOKINGS_CLIENT_SECRET"),
    refresh_token: env("ZOHO_BOOKINGS_REFRESH_TOKEN"),
  })
  try {
    const r = await fetch(ACCOUNTS, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      cache: "no-store",
    })
    const d = (await r.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string }
    if (!d.access_token) {
      console.warn(`[bookings] no se pudo renovar el token: ${d.error || r.status}`)
      return ""
    }
    cache.token = d.access_token
    cache.hasta = Date.now() + Math.max(60, (d.expires_in || 3600) - 300) * 1000
    return cache.token
  } catch (e) {
    console.warn("[bookings] excepción renovando token:", e instanceof Error ? e.message : e)
    return ""
  }
}

async function api(path: string, params: Record<string, string> = {}): Promise<unknown> {
  const token = await accessTokenBookings()
  if (!token) return null
  const qs = new URLSearchParams(params).toString()
  const r = await fetch(`${BASE}/${path}${qs ? `?${qs}` : ""}`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
    cache: "no-store",
  })
  if (!r.ok) {
    console.warn(`[bookings] ${path} → ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`)
    return null
  }
  return r.json().catch(() => null)
}

/** Espacios de trabajo (workspaces) de la cuenta. */
export function fetchWorkspaces(): Promise<unknown> {
  return api("workspaces")
}

/** Servicios de un workspace: de acá salen los service_id del "Curso 1". */
export function fetchServicios(workspaceId: string): Promise<unknown> {
  return api("services", { workspace_id: workspaceId })
}

/** Relatores (staff) de un servicio — Diego e Ignacio. */
export function fetchStaff(serviceId: string): Promise<unknown> {
  return api("staffs", { service_id: serviceId })
}

/** Horarios disponibles de un servicio para una fecha (dd-MMM-yyyy). */
export function fetchDisponibilidad(serviceId: string, fecha: string, staffId?: string): Promise<unknown> {
  return api("availableslots", { service_id: serviceId, selected_date: fecha, ...(staffId ? { staff_id: staffId } : {}) })
}
