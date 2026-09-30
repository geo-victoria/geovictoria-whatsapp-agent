/**
 * TERCER token de Zoho: Zoho Analytics en SOLO LECTURA (30-sep, Lalo "¿y si
 * actualizamos el scope? me interesa saber si este gráfico tiene toda la
 * data"). Analytics es otro producto con otra API
 * (analyticsapi.zoho.com/restapi/v2) y otros scopes; el token del CRM no la
 * alcanza. Mismo patrón que el de archivos: grant nuevo desde el Self Client
 * (api-console.zoho.com) con `ZohoAnalytics.metadata.read,ZohoAnalytics.data.read`,
 * canjeado por POST /api/vic-admin-zoho-canje {code, modo:"analytics"}, que lo
 * prueba contra /orgs y guarda el refresh en vic_kv `zoho_analytics_refresh_token`
 * y el id de organización en `zoho_analytics_org_id`. El token del CRM no se toca.
 */

const env = (k: string) => (process.env[k] || "").trim()
const _cache: { token?: string; refresh?: string; expiresAt?: number } = {}

export const KV_ANALYTICS_REFRESH = "zoho_analytics_refresh_token"
export const KV_ANALYTICS_ORG = "zoho_analytics_org_id"
export const SCOPES_ANALYTICS = ["ZohoAnalytics.metadata.read", "ZohoAnalytics.data.read"]
export const analyticsApi = () => env("ZOHO_ANALYTICS_API") || "https://analyticsapi.zoho.com/restapi/v2"

async function kv(key: string): Promise<string> {
  const m = await import("./supabase-persistence-v3")
  return ((await m.getKvValue(key).catch(() => null)) || "").trim()
}

export async function refreshTokenAnalytics(): Promise<string> {
  return env("ZOHO_ANALYTICS_REFRESH_TOKEN") || (await kv(KV_ANALYTICS_REFRESH))
}

export async function orgIdAnalytics(): Promise<string> {
  return env("ZOHO_ANALYTICS_ORG_ID") || (await kv(KV_ANALYTICS_ORG))
}

export async function getZohoAnalyticsToken(): Promise<string | null> {
  const refresh = await refreshTokenAnalytics()
  if (!refresh || !env("ZOHO_CLIENT_ID") || !env("ZOHO_CLIENT_SECRET")) return null
  const now = Date.now()
  if (_cache.token && _cache.refresh === refresh && (_cache.expiresAt || 0) - now > 120_000) return _cache.token
  const domain = env("ZOHO_ACCOUNTS_DOMAIN") || "https://accounts.zoho.com"
  const r = await fetch(`${domain}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: env("ZOHO_CLIENT_ID"), client_secret: env("ZOHO_CLIENT_SECRET") }),
    cache: "no-store",
  }).catch(() => null)
  const j = (await r?.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string }
  if (!r?.ok || !j.access_token) {
    console.warn(`[zoho-analytics] refresh falló ${r?.status}: ${j?.error || ""}`)
    return null
  }
  _cache.token = j.access_token
  _cache.refresh = refresh
  _cache.expiresAt = now + Math.max(300, Number(j.expires_in || 3600) - 120) * 1000
  return j.access_token
}

/**
 * GET de SOLO LECTURA a la API de Analytics. `ruta` empieza con "/"
 * (ej. "/workspaces/<wid>/views/<vid>"). Devuelve status + cuerpo (JSON si
 * se puede, texto si no — el export de datos puede venir en CSV).
 */
export async function analyticsGet(
  ruta: string,
  opts: { token?: string; orgId?: string } = {},
): Promise<{ status: number; json?: unknown; texto?: string }> {
  const token = opts.token || (await getZohoAnalyticsToken())
  if (!token) return { status: 0, texto: "sin token de Analytics (falta el canje)" }
  const orgId = opts.orgId ?? (await orgIdAnalytics())
  const headers: Record<string, string> = { Authorization: `Zoho-oauthtoken ${token}` }
  if (orgId) headers["ZANALYTICS-ORGID"] = orgId
  const r = await fetch(`${analyticsApi()}${ruta}`, { headers, cache: "no-store" }).catch(() => null)
  if (!r) return { status: 0, texto: "sin respuesta de Analytics" }
  const texto = await r.text().catch(() => "")
  try {
    return { status: r.status, json: JSON.parse(texto) }
  } catch {
    return { status: r.status, texto }
  }
}
