// In-process cache (warm instance reuse)
const _cache: { token?: string; expiresAt?: number } = {}

function getEnv(name: string) {
  return (process.env[name] || "").trim()
}

async function readTokenFromSupabase(): Promise<string | null> {
  const url = getEnv("SUPABASE_URL")
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY")
  if (!url || !key) return null
  try {
    const res = await fetch(
      `${url}/rest/v1/vic_kv?key=eq.zoho_access_token&expires_at=gt.${new Date().toISOString()}&select=value&limit=1`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: "no-store" }
    )
    const rows = await res.json() as Array<{ value: string }>
    return rows?.[0]?.value || null
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

export async function getZohoAccessToken(): Promise<string> {
  const now = Date.now()

  // 1. Cache en proceso (misma instancia)
  if (_cache.token && _cache.expiresAt && _cache.expiresAt - now > 2 * 60 * 1000) {
    return _cache.token
  }

  // 2. Cache persistente en Supabase (entre instancias)
  const cached = await readTokenFromSupabase()
  if (cached) {
    _cache.token = cached
    _cache.expiresAt = now + 50 * 60 * 1000
    return cached
  }

  // 3. Renovar token
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
