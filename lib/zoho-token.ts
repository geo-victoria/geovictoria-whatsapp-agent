const store = globalThis as unknown as {
  __zohoToken?: { token: string; expiresAt: number }
}

function getEnv(name: string) {
  return (process.env[name] || "").trim()
}

export async function getZohoAccessToken(): Promise<string> {
  const now = Date.now()

  // Reusar token si aún es válido (con 2 min de margen)
  if (store.__zohoToken && store.__zohoToken.expiresAt - now > 2 * 60 * 1000) {
    return store.__zohoToken.token
  }

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

  // Zoho tokens duran 3600s — cacheamos por 55 min
  store.__zohoToken = {
    token: String(data.access_token),
    expiresAt: now + 55 * 60 * 1000,
  }

  return store.__zohoToken.token
}
