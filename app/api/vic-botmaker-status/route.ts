/**
 * Webhook de ESTADOS DE ENTREGA de Botmaker (notification-status).
 *
 * Caso real Marcela (17-jul): el toque 0 fue ACEPTADO por Botmaker pero Meta
 * no lo entregó (131049, cap de frecuencia de plantillas Marketing por
 * usuario receptor) — el fallo llega ASÍNCRONO y no lo veíamos: el lead
 * quedaba esperando 2 horas el correo de la cadencia.
 *
 * Qué hace: cuando llega un estado de entrega FALLIDA para un contacto con
 * cadencia outbound ACTIVA cuyo correo 1 aún no salió, ADELANTA el correo a
 * inmediato (retro-datando started_at 2h: el próximo tick del cron lo
 * dispara). Idempotente y conservador: cualquier otro evento solo se
 * registra.
 *
 * Además guarda el último payload en vic_kv (debug_last_status_payload) para
 * descubrir/ajustar el shape real que manda Botmaker sin redeployar.
 *
 * Auth: ?key=CRON_SECRET en la URL (Botmaker no permite headers custom en
 * todos los planes) o x-cron-secret == vic_kv.followup_cron_secret.
 *
 * CONFIGURAR EN BOTMAKER: suscribir el webhook de estados de notificación
 * (Notifications Engine → webhooks / o vía soporte) apuntando a:
 *   https://<host>/api/vic-botmaker-status?key=<CRON_SECRET>
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret, setKvValue } from "@/lib/supabase-persistence-v3"

export const dynamic = "force-dynamic"
export const maxDuration = 15

const CRON_SECRET = (process.env.CRON_SECRET || "").trim()
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()

const HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
}

async function authorized(req: Request): Promise<boolean> {
  const key = (new URL(req.url).searchParams.get("key") || "").trim()
  if (CRON_SECRET && key === CRON_SECRET) return true
  // Botmaker no permite headers custom: el secret de vic_kv también vale por
  // query param (04-ago, para poder suscribir el webhook sin conocer el env).
  if (key) {
    const expected = await getFollowupCronSecret().catch(() => "")
    if (expected && key === expected) return true
  }
  const xcron = (req.headers.get("x-cron-secret") || "").trim()
  if (xcron) {
    const expected = await getFollowupCronSecret().catch(() => "")
    if (expected && xcron === expected) return true
  }
  return false
}

/** Extrae recursivamente el primer valor string de las claves candidatas. */
function pick(obj: unknown, keys: string[]): string {
  if (!obj || typeof obj !== "object") return ""
  const rec = obj as Record<string, unknown>
  for (const k of keys) {
    const v = rec[k]
    if (typeof v === "string" && v.trim()) return v.trim()
    if (typeof v === "number") return String(v)
  }
  for (const v of Object.values(rec)) {
    if (v && typeof v === "object") {
      const found = pick(v, keys)
      if (found) return found
    }
  }
  return ""
}

export async function POST(req: Request): Promise<Response> {
  if (!(await authorized(req))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }
  const body = (await req.json().catch(() => ({}))) as unknown

  // Traza para calibrar el shape real de Botmaker (best-effort).
  await setKvValue(
    "debug_last_status_payload",
    JSON.stringify({ at: new Date().toISOString(), body }).slice(0, 4000),
  ).catch(() => {})

  const contact = pick(body, ["contactId", "contact", "phone", "phoneNumber", "to", "userId"]).replace(/\D/g, "")
  const status = pick(body, ["status", "event", "state", "deliveryStatus"]).toLowerCase()
  const reason = pick(body, ["reason", "error", "errorMessage", "detail", "description"])

  // Fallo de entrega: status de error, o el código 131049 (u otros 13xxxx de
  // Meta) en cualquier parte del payload.
  const fallo =
    /fail|error|undeliver|reject/.test(status) || /\b13\d{4}(\.0)?\b/.test(reason) || /\b131049\b/.test(JSON.stringify(body))

  if (!contact || !fallo) {
    return NextResponse.json({ ok: true, accion: "registrado", contact: contact || null, fallo })
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return NextResponse.json({ ok: false, error: "Supabase no configurado" }, { status: 503 })
  }

  // NÚMERO SIN WHATSAPP (131026 undeliverable — caso BE WISE 04-ago): no es
  // un cap temporal como el 131049, ese contacto JAMÁS recibirá WhatsApps.
  // Acuerdo con Marketing: el lead no se queda con Vicky — vuelve a un humano
  // (round-robin SDR) con nota, y el loop se cierra. El adelanto del correo
  // e1 (más abajo) corre igual: el email pasa a ser el único canal.
  const noEntregable =
    /undeliver/.test(`${status} ${reason.toLowerCase()}`) || /\b131026(\.0)?\b/.test(JSON.stringify(body))
  if (noEntregable) {
    try {
      const { getZohoAccessToken } = await import("@/lib/zoho-token")
      const token = await getZohoAccessToken()
      const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
      const s = await fetch(`${api}/crm/v3/Leads/search?phone=${contact}&converted=both&per_page=2`, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        cache: "no-store",
      })
      const lead = s.ok && s.status !== 204
        ? ((await s.json().catch(() => ({}))) as {
            data?: Array<{ id?: string; Owner?: { email?: string }; Converted_Deal?: { id?: string } | null }>
          }).data?.[0]
        : undefined
      const ownerBot = /vicky@|info@geovictoria/.test((lead?.Owner?.email || "").toLowerCase())
      if (lead?.id && !lead.Converted_Deal?.id && ownerBot) {
        const { reasignarLeadSdrInbound, agregarNotaLead } = await import("@/lib/zoho-leads")
        const r = await reasignarLeadSdrInbound(String(lead.id)).catch(() => null)
        await agregarNotaLead(
          String(lead.id),
          "Vicky: el número NO recibe WhatsApp",
          `Meta reportó "message undeliverable" (131026) para +${contact}: el número no tiene WhatsApp o no puede recibir mensajes. Vicky no puede atenderlo — contactar por teléfono o por el correo del lead.`,
        ).catch(() => false)
        console.warn(`[botmaker-status] ${contact} SIN WHATSAPP → lead ${lead.id} reasignado a ${r?.ownerEmail || "(falló)"} + loop cerrado`)
      }
    } catch { /* best-effort */ }
    await fetch(`${SUPABASE_URL}/rest/v1/vic_loop?contact=eq.${contact}&estado=eq.activo`, {
      method: "PATCH",
      headers: { ...HEADERS, Prefer: "return=minimal" },
      body: JSON.stringify({ estado: "cerrado", motivo_cierre: "wsp_no_entregable" }),
      cache: "no-store",
    }).catch(() => null)
  }

  // Cadencia outbound activa con e1 pendiente → adelantar el correo (started_at
  // retro-datado 2h; el filtro del cron (hrs >= 2) lo toma en el próximo tick).
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/vic_outbound_cadence?contact=eq.${contact}&status=eq.activa&e1_sent_at=is.null` +
      `&select=contact,started_at`,
    { headers: HEADERS, cache: "no-store" },
  ).catch(() => null)
  const rows = res?.ok ? (((await res.json().catch(() => [])) as Array<{ started_at: string }>) || []) : []

  if (rows.length === 0) {
    console.log(`[botmaker-status] fallo de entrega contact=${contact} sin cadencia e1 pendiente (${reason || status})`)
    return NextResponse.json({ ok: true, accion: "sin_cadencia_pendiente", contact })
  }

  const nuevoStart = new Date(Date.now() - 2 * 3600e3 - 60e3).toISOString()
  const patch = await fetch(
    `${SUPABASE_URL}/rest/v1/vic_outbound_cadence?contact=eq.${contact}&status=eq.activa&e1_sent_at=is.null`,
    {
      method: "PATCH",
      headers: { ...HEADERS, Prefer: "return=minimal" },
      body: JSON.stringify({ started_at: nuevoStart }),
      cache: "no-store",
    },
  ).catch(() => null)

  console.warn(
    `[botmaker-status] toque 0 NO ENTREGADO contact=${contact} (${reason || status}) → correo e1 adelantado a inmediato (ok=${!!patch?.ok})`,
  )
  return NextResponse.json({ ok: true, accion: "e1_adelantado", contact })
}
