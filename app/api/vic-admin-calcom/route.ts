/**
 * Endpoint ADMIN: GET /api/vic-admin-calcom
 *
 * Lista los teams, sus miembros y los event types del Cal.com de la cuenta
 * (usando el CAL_API_KEY del servidor, que en Vercel es sensitive y no se
 * puede leer desde fuera). Uso: encontrar/verificar el event type del equipo
 * de COLOMBIA para configurar CAL_EVENT_TYPE_ID_CO sin buscarlo a mano.
 *
 * Auth: x-cron-secret == vic_kv.followup_cron_secret (mismo esquema admin
 * que vic-admin-botmaker-channels).
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"

export const dynamic = "force-dynamic"
export const maxDuration = 30

const CAL_API_KEY = (process.env.CAL_API_KEY || "").trim()
const CAL_BASE = "https://api.cal.com/v2"

async function cal(path: string, version = "2024-08-13"): Promise<unknown> {
  const res = await fetch(`${CAL_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${CAL_API_KEY}`,
      "cal-api-version": version,
      "Content-Type": "application/json",
    },
    cache: "no-store",
  })
  const data = await res.json().catch(() => ({}))
  return { status: res.status, data }
}

export async function GET(req: Request): Promise<Response> {
  const xcron = (req.headers.get("x-cron-secret") || "").trim()
  const expected = await getFollowupCronSecret().catch(() => "")
  if (!expected || xcron !== expected) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }
  if (!CAL_API_KEY) {
    return NextResponse.json({ ok: false, error: "CAL_API_KEY no configurada" }, { status: 503 })
  }

  // Teams de la cuenta + memberships + event types de cada team. El endpoint
  // de event types de team usa la versión 2024-06-14 de la API.
  const teams = (await cal("/teams")) as { status: number; data?: { data?: Array<{ id: number; name: string }> } }
  const teamList = teams.data?.data || []
  const detalle = await Promise.all(
    teamList.map(async (t) => ({
      team: t,
      miembros: await cal(`/teams/${t.id}/memberships`),
      eventTypes: await cal(`/teams/${t.id}/event-types`, "2024-06-14"),
    })),
  )

  // También los event types personales del dueño de la API key (por si el
  // chileno 3188650 vive ahí).
  const propios = await cal("/event-types", "2024-06-14")

  return NextResponse.json({ ok: true, teams: detalle, propios })
}
