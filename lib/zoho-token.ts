// In-process cache (warm instance reuse)
const _cache: { token?: string; expiresAt?: number } = {}

function getEnv(name: string) {
  return (process.env[name] || "").trim()
}

/**
 * Devuelve el token cacheado JUNTO CON SU VENCIMIENTO REAL.
 *
 * Antes devolvía solo el string, y quien lo llamaba le inventaba 50 minutos de
 * vida contados desde ese instante. Ver getZohoAccessToken para el destrozo
 * que eso causaba.
 */
async function readTokenFromSupabase(): Promise<{ token: string; expiresAt: number } | null> {
  const url = getEnv("SUPABASE_URL")
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY")
  if (!url || !key) return null
  try {
    const res = await fetch(
      `${url}/rest/v1/vic_kv?key=eq.zoho_access_token&expires_at=gt.${new Date().toISOString()}&select=value,expires_at&limit=1`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: "no-store" }
    )
    const rows = await res.json() as Array<{ value: string; expires_at: string }>
    const row = rows?.[0]
    if (!row?.value) return null
    const expiresAt = Date.parse(row.expires_at)
    if (!Number.isFinite(expiresAt)) return null
    return { token: row.value, expiresAt }
  } catch { return null }
}

async function saveTokenToSupabase(token: string): Promise<void> {
  const url = getEnv("SUPABASE_URL")
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY")
  if (!url || !key) return
  const expiresAt = new Date(Date.now() + 55 * 60 * 1000).toISOString()
  try {
    await fetch(`${url}/rest/v1/vic_kv?on_conflict=key`, {
      method: "POST",
      headers: {
        apikey: key, Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify([{ key: "zoho_access_token", value: token, expires_at: expiresAt }]),
      cache: "no-store",
    })
  } catch { /* ignorar */ }
}

/**
 * Renovación FORZADA: ignora ambos cachés y acuña un token nuevo contra Zoho.
 * Para el camino de recuperación tras un 401 INVALID_TOKEN — Zoho revoca los
 * access tokens más viejos cuando conviven más de 10 vivos por refresh token
 * (agente + cotizador + conectores acuñan del mismo), así que un token del
 * caché puede morir ANTES de su expires_at.
 */
export async function renovarZohoAccessToken(): Promise<string> {
  _cache.token = undefined
  _cache.expiresAt = undefined
  return refrescarToken(Date.now())
}

export async function getZohoAccessToken(): Promise<string> {
  const now = Date.now()

  // 1. Cache en proceso (misma instancia)
  if (_cache.token && _cache.expiresAt && _cache.expiresAt - now > 2 * 60 * 1000) {
    return _cache.token
  }

  // 2. Cache persistente en Supabase (entre instancias).
  //
  // CASO REAL (27-jul 14:19, Andirent +573112895086): la reunión se creó en
  // Cal.com y crear el Lead en Zoho devolvió 401 INVALID_TOKEN. Siete minutos
  // antes, otra función del mismo deploy había hecho un update de Lead sin
  // problema con el MISMO token. No era el refresh token: era este caché.
  //
  // El bug: se tomaba el token de Supabase y se le estampaba `now + 50 min`
  // de vida en el caché de proceso, sin mirar cuánto le quedaba de verdad. La
  // query filtra `expires_at > now()`, así que puede devolver un token con 10
  // segundos de vida — y la instancia lo daba por bueno durante 50 minutos
  // más. Como cada función serverless (vic-botmaker-v3, vic-botmaker-co, los
  // crons) tiene su propio caché en memoria y sus propias instancias
  // calientes, el resultado era intermitente y sin patrón: una función con
  // token fresco funcionando al lado de otra sirviendo uno muerto. De ahí que
  // pareciera "un problema de Colombia" cuando no tenía nada de colombiano.
  //
  // Ahora se respeta el vencimiento REAL. Si le quedan menos de 2 minutos, se
  // ignora y se renueva.
  const cached = await readTokenFromSupabase()
  if (cached && cached.expiresAt - now > 2 * 60 * 1000) {
    _cache.token = cached.token
    _cache.expiresAt = cached.expiresAt
    return cached.token
  }

  // 3. Renovar token
  return refrescarToken(now)
}

/**
 * Refresco FORZADO, saltándose ambos cachés (proceso y Supabase).
 *
 * CASO REAL (17-ago ~13:00 UTC): Zoho REVOCÓ un access token ~1,5 h antes de
 * su vencimiento declarado (probable tope de tokens vivos por refresh token —
 * el cotizador y el agente comparten credenciales). getZohoAccessToken confía
 * en el expires_at guardado, así que TODO el agente quedó ciego a Zoho por
 * más de una hora (dash sin aceptadas/pagadas, crm-hitos mudo) sin
 * auto-repararse. Regla nueva: cuando un caller reciba 401 de Zoho, llama
 * esto UNA vez y reintenta — el refresco además repara el kv para el resto
 * de los consumidores.
 */
export async function getZohoAccessTokenFresco(): Promise<string> {
  return refrescarToken(Date.now())
}

async function refrescarToken(now: number): Promise<string> {
  const domain = getEnv("ZOHO_ACCOUNTS_DOMAIN") || "https://accounts.zoho.com"
  const res = await fetch(`${domain}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: getEnv("ZOHO_REFRESH_TOKEN"),
      client_id: getEnv("ZOHO_CLIENT_ID"),
      client_secret: getEnv("ZOHO_CLIENT_SECRET"),
      grant_type: "refresh_token",
    }),
    cache: "no-store",
  })

  const data = await res.json()
  if (!data?.access_token) {
    throw new Error(`No se pudo obtener access token Zoho: ${JSON.stringify(data).slice(0, 400)}`)
  }

  const token = String(data.access_token)
  _cache.token = token
  _cache.expiresAt = now + 55 * 60 * 1000
  saveTokenToSupabase(token).catch(() => {}) // fire-and-forget

  return token
}
