/**
 * Endpoint ADMIN: GET /api/vic-admin-botmaker-channels
 *
 * Lista los canales del workspace de Botmaker (id, plataforma, número) usando
 * el BOTMAKER_ACCESS_TOKEN del servidor. Uso: obtener el channelId de una
 * línea nueva (ej. la de Colombia) sin buscarlo a mano en la consola, y
 * verificar que comparte workspace/token con la línea chilena.
 *
 * Auth: x-cron-secret == vic_kv.followup_cron_secret (mismo esquema admin).
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"

export const dynamic = "force-dynamic"
export const maxDuration = 30

const BM_TOKEN = (process.env.BOTMAKER_ACCESS_TOKEN || "").trim()

export async function GET(req: Request): Promise<Response> {
  const xcron = (req.headers.get("x-cron-secret") || "").trim()
  const expected = await getFollowupCronSecret().catch(() => "")
  if (!expected || xcron !== expected) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }
  if (!BM_TOKEN) {
    return NextResponse.json({ ok: false, error: "BOTMAKER_ACCESS_TOKEN no configurado" }, { status: 503 })
  }
  const res = await fetch("https://api.botmaker.com/v2.0/channels", {
    headers: { "access-token": BM_TOKEN, Accept: "application/json" },
    cache: "no-store",
  })
  const data = await res.json().catch(() => ({}))
  return NextResponse.json({ ok: res.ok, status: res.status, data })
}
