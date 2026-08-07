/**
 * CRON: GET /api/vic-zoho-calls-sync
 *
 * Espejo del módulo CALLS de Zoho hacia Supabase (pedido Lalo 07-ago:
 * "registrar los llamados de los ejecutivos en Supabase e identificar las
 * llamadas entre los ejecutivos y los clientes con proceso").
 *
 * Las llamadas TELEFÓNICAS (red celular) no pasan por el espejo de WhatsApp;
 * el registro real vive en Zoho (la app móvil de Zoho CRM las loguea desde el
 * celular del ejecutivo, y varias ya llegan así: "Outgoing call to X" con
 * duración). Este cron las trae incrementalmente (cursor por Modified_Time en
 * vic_kv) a vic_llamadas_zoho; la vista vic_llamadas_zoho_proceso las cruza
 * con los clientes con proceso de Vicky (kv zoho_lead_<fono> → conversación).
 */

import { NextResponse } from "next/server"
import { getKvValue, setKvValue } from "@/lib/supabase-persistence-v3"
import { getZohoAccessToken } from "@/lib/zoho-token"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim().replace(/\/$/, "")
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const CRON_SECRET = (process.env.CRON_SECRET || "").trim()
const ZOHO_API = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
const CURSOR_KEY = "zoho_calls_sync_cursor"

function authorized(req: Request): boolean {
  const url = new URL(req.url)
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim()
  const key = (url.searchParams.get("key") || "").trim()
  return Boolean(CRON_SECRET && (bearer === CRON_SECRET || key === CRON_SECRET))
}

type CallRow = {
  id?: string
  Subject?: string
  Call_Type?: string
  Call_Start_Time?: string
  Call_Duration?: string
  Modified_Time?: string
  Owner?: { id?: string; name?: string }
  Who_Id?: { id?: string; name?: string } | null
}

export async function GET(req: Request): Promise<Response> {
  if (!authorized(req)) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })

  // Cursor: desde la última sincronización (default: últimos 14 días).
  const cursor =
    ((await getKvValue(CURSOR_KEY).catch(() => null)) || "").trim() ||
    new Date(Date.now() - 14 * 24 * 3600_000).toISOString().replace(/\.\d{3}Z$/, "-00:00")

  const token = await getZohoAccessToken()
  const q =
    `select id, Subject, Call_Type, Call_Start_Time, Call_Duration, Modified_Time, Owner, Who_Id ` +
    `from Calls where Modified_Time >= '${cursor}' order by Modified_Time asc limit 200`
  const r = await fetch(`${ZOHO_API}/crm/v3/coql`, {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({ select_query: q }),
  })
  if (!r.ok && r.status !== 204) {
    return NextResponse.json({ ok: false, error: `COQL ${r.status}` }, { status: 502 })
  }
  const data = r.status === 204 ? { data: [] } : ((await r.json().catch(() => ({}))) as { data?: CallRow[] })
  const calls = data.data || []
  let guardadas = 0
  let ultimoModified = cursor

  for (const c of calls) {
    if (!c.id) continue
    if (c.Modified_Time && c.Modified_Time > ultimoModified) ultimoModified = c.Modified_Time
    const fila = {
      zoho_id: String(c.id),
      subject: c.Subject || null,
      tipo: c.Call_Type || null,
      inicio: c.Call_Start_Time || null,
      duracion: c.Call_Duration || null,
      owner_id: c.Owner?.id || null,
      owner_nombre: c.Owner?.name || null,
      who_id: c.Who_Id?.id || null,
      who_nombre: c.Who_Id?.name || null,
      sincronizado_at: new Date().toISOString(),
    }
    const up = await fetch(`${SUPABASE_URL}/rest/v1/vic_llamadas_zoho?on_conflict=zoho_id`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(fila),
    }).catch(() => null)
    if (up?.ok) guardadas++
  }

  if (calls.length > 0) await setKvValue(CURSOR_KEY, ultimoModified).catch(() => {})
  return NextResponse.json({ ok: true, traidas: calls.length, guardadas, cursor: ultimoModified })
}
