/**
 * Lector de la casilla vicky@geovictoria.com por Microsoft Graph (app-only).
 *
 * Credenciales (env o vic_kv, en ese orden):
 *   MSGRAPH_TENANT_ID / kv msgraph_tenant_id
 *   MSGRAPH_CLIENT_ID / kv msgraph_client_id
 *   MSGRAPH_CLIENT_SECRET / kv msgraph_client_secret
 *   VICKY_MAILBOX (default vicky@geovictoria.com)
 * La app de Entra necesita el permiso de APLICACIÓN Mail.Read (idealmente
 * acotado a esta casilla con una Application Access Policy). Sin credenciales
 * el cron responde `sin_credenciales` y el camino alternativo es el push a
 * /api/vic-correo-entrante (Power Automate / Zoho Flow reenviando cada correo).
 */

import { getKvValue } from "@/lib/supabase-persistence-v3"

export type CorreoGraph = {
  id: string
  internetMessageId: string
  subject: string
  from: string
  receivedDateTime: string
  html: string
  hasAttachments: boolean
}

async function cred(env: string, kv: string): Promise<string> {
  const e = (process.env[env] || "").trim()
  if (e) return e
  return String((await getKvValue(kv).catch(() => null)) || "").trim()
}

export async function credencialesGraph(): Promise<{ tenant: string; clientId: string; secret: string; mailbox: string } | null> {
  const [tenant, clientId, secret] = await Promise.all([
    cred("MSGRAPH_TENANT_ID", "msgraph_tenant_id"),
    cred("MSGRAPH_CLIENT_ID", "msgraph_client_id"),
    cred("MSGRAPH_CLIENT_SECRET", "msgraph_client_secret"),
  ])
  const mailbox = (process.env.VICKY_MAILBOX || "vicky@geovictoria.com").trim()
  if (!tenant || !clientId || !secret) return null
  return { tenant, clientId, secret, mailbox }
}

let tokenCache: { token: string; exp: number } | null = null

export async function tokenGraph(): Promise<string> {
  if (tokenCache && tokenCache.exp > Date.now() + 60_000) return tokenCache.token
  const c = await credencialesGraph()
  if (!c) throw new Error("sin credenciales de Microsoft Graph")
  const body = new URLSearchParams({
    client_id: c.clientId,
    client_secret: c.secret,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  })
  const r = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(c.tenant)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  })
  const j = (await r.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string }
  if (!r.ok || !j.access_token) throw new Error(`token Graph ${r.status}: ${j.error || ""} ${j.error_description || ""}`.trim())
  tokenCache = { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3000) * 1000 }
  return j.access_token
}

/**
 * Adjuntos de un correo (Graph `fileAttachment`: name, contentType, size,
 * isInline, contentBytes en base64). Devuelve [] si algo falla.
 */
export async function adjuntosDeCorreo(messageId: string): Promise<Array<{ name: string; contentType: string; size: number; isInline: boolean; contentBytes: string }>> {
  const c = await credencialesGraph()
  if (!c || !messageId) return []
  try {
    const token = await tokenGraph()
    const url =
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(c.mailbox)}/messages/${encodeURIComponent(messageId)}/attachments` +
      `?$select=name,contentType,size,isInline,contentBytes&$top=10`
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(25000) })
    const j = (await r.json().catch(() => ({}))) as { value?: Array<Record<string, unknown>>; error?: { code?: string; message?: string } }
    if (!r.ok) {
      console.warn(`[correo-vicky] adjuntos ${r.status}: ${j.error?.code || ""} ${j.error?.message || ""}`.trim())
      return []
    }
    return (j.value || [])
      .filter((a) => typeof a.contentBytes === "string" && a.contentBytes)
      .map((a) => ({
        name: String(a.name || "adjunto"),
        contentType: String(a.contentType || ""),
        size: Number(a.size) || 0,
        isInline: Boolean(a.isInline),
        contentBytes: String(a.contentBytes),
      }))
  } catch (e) {
    console.warn("[correo-vicky] adjuntos excepción:", e instanceof Error ? e.message : e)
    return []
  }
}

/** Correos del Inbox recibidos desde `desdeIso` (más nuevos primero). */
export async function listarCorreosVicky(opts: { desdeIso: string; max?: number }): Promise<CorreoGraph[]> {
  const c = await credencialesGraph()
  if (!c) throw new Error("sin credenciales de Microsoft Graph")
  const token = await tokenGraph()
  const top = Math.min(100, Math.max(1, Number(opts.max) || 50))
  const filtro = `receivedDateTime ge ${new Date(opts.desdeIso).toISOString()}`
  const url =
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(c.mailbox)}/mailFolders/inbox/messages` +
    `?$filter=${encodeURIComponent(filtro)}&$orderby=receivedDateTime%20desc&$top=${top}` +
    `&$select=id,subject,from,receivedDateTime,internetMessageId,body,hasAttachments`
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.body-content-type="html"' },
    cache: "no-store",
    signal: AbortSignal.timeout(25000),
  })
  const j = (await r.json().catch(() => ({}))) as {
    value?: Array<{ id: string; subject?: string; from?: { emailAddress?: { address?: string } }; receivedDateTime?: string; internetMessageId?: string; body?: { content?: string }; hasAttachments?: boolean }>
    error?: { code?: string; message?: string }
  }
  if (!r.ok) throw new Error(`Graph ${r.status}: ${j.error?.code || ""} ${j.error?.message || ""}`.trim())
  return (j.value || []).map((m) => ({
    id: m.id,
    internetMessageId: String(m.internetMessageId || ""),
    subject: String(m.subject || ""),
    from: String(m.from?.emailAddress?.address || ""),
    receivedDateTime: String(m.receivedDateTime || ""),
    html: String(m.body?.content || ""),
    hasAttachments: Boolean(m.hasAttachments),
  }))
}
