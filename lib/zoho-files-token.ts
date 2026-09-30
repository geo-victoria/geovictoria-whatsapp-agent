/**
 * SEGUNDO token de Zoho, con scope ZohoFiles (30-sep). El token principal
 * (ZOHO_REFRESH_TOKEN) nació sin ese scope y no se toca: subir un archivo a un
 * campo `fileupload` (Planilla_equipos del ticket ST, Planilla_de_Ingreso de
 * la IMP) exige `POST /crm/v3/files`, que responde OAUTH_SCOPE_MISMATCH con
 * el principal. Mientras `ZOHO_FILES_REFRESH_TOKEN` no exista, todo llamador
 * cae al camino de siempre (adjunto en la related list Attachments, que sí
 * funciona) — este módulo devuelve null y nadie se cae.
 *
 * Emisión del token (lado Lalo): self-client en api-console.zoho.com con los
 * 9 scopes del principal + ZohoFiles.files.ALL, guardado como
 * ZOHO_FILES_REFRESH_TOKEN en Vercel (agente y cotizador). Verificación:
 * GET /api/vic-admin-zoho-scope?key=<cron>&cual=files.
 */

const _cache: { token?: string; expiresAt?: number } = {}
const env = (k: string) => (process.env[k] || "").trim()

export function filesTokenConfigurado(): boolean {
  return Boolean(env("ZOHO_FILES_REFRESH_TOKEN") && env("ZOHO_CLIENT_ID") && env("ZOHO_CLIENT_SECRET"))
}

export async function getZohoFilesToken(): Promise<string | null> {
  if (!filesTokenConfigurado()) return null
  const now = Date.now()
  if (_cache.token && _cache.expiresAt && _cache.expiresAt - now > 2 * 60 * 1000) return _cache.token
  const domain = env("ZOHO_ACCOUNTS_DOMAIN") || "https://accounts.zoho.com"
  try {
    const res = await fetch(`${domain}/oauth/v2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: env("ZOHO_FILES_REFRESH_TOKEN"),
        client_id: env("ZOHO_CLIENT_ID"),
        client_secret: env("ZOHO_CLIENT_SECRET"),
      }),
      cache: "no-store",
    })
    const j = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string }
    if (!res.ok || !j.access_token) {
      console.warn(`[zoho-files] refresh falló ${res.status}: ${j.error || ""}`)
      return null
    }
    _cache.token = j.access_token
    _cache.expiresAt = now + Math.max(300, Number(j.expires_in || 3600) - 120) * 1000
    return j.access_token
  } catch (e) {
    console.warn("[zoho-files] refresh:", e instanceof Error ? e.message : e)
    return null
  }
}

/**
 * Sube un archivo a Zoho Files (`POST /crm/v3/files`) y devuelve su file_id
 * para un campo fileupload (`[{ file_id }]`). null si no hay token o falla.
 */
export async function subirArchivoZohoFiles(buf: Buffer | ArrayBuffer, filename: string, mime = "application/octet-stream"): Promise<string | null> {
  const token = await getZohoFilesToken()
  if (!token) return null
  const api = env("ZOHO_API_DOMAIN") || "https://www.zohoapis.com"
  try {
    const form = new FormData()
    form.append("file", new Blob([buf as BlobPart], { type: mime }), filename)
    const up = await fetch(`${api}/crm/v3/files`, { method: "POST", headers: { Authorization: `Zoho-oauthtoken ${token}` }, body: form, cache: "no-store" })
    const uj = (await up.json().catch(() => ({}))) as { data?: Array<{ details?: { id?: string }; code?: string; message?: string }> }
    const id = uj?.data?.[0]?.details?.id || ""
    if (!up.ok || !id) {
      console.warn(`[zoho-files] subida falló ${up.status}: ${JSON.stringify(uj).slice(0, 200)}`)
      return null
    }
    return id
  } catch (e) {
    console.warn("[zoho-files] subida:", e instanceof Error ? e.message : e)
    return null
  }
}
