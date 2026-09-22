/**
 * RELAY DE CARGA del padrón SII (10-ago). Las nóminas públicas del SII
 * (domicilios y actividades económicas) se preprocesan FUERA (una fila por
 * RUT) y se bombean por acá en lotes; este endpoint solo las escribe en
 * Supabase con la service key del deployment — el mismo patrón de acceso de
 * todos los crons. Idempotente: on_conflict(rut) ignora duplicados, así que
 * re-bombear un lote no duplica nada.
 *
 * POST /api/vic-admin-sii-load  { tabla: "dom"|"giro", filas: string[][] }
 * Auth: x-cron-secret == vic_kv.followup_cron_secret, o Bearer/?key=CRON_SECRET.
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const CRON_SECRET = (process.env.CRON_SECRET || "").trim()
const MAX_FILAS = 8000

async function authorized(req: Request): Promise<boolean> {
  const xcron = (req.headers.get("x-cron-secret") || "").trim()
  if (xcron) {
    const expected = await getFollowupCronSecret().catch(() => "")
    if (expected && xcron === expected) return true
  }
  if (CRON_SECRET) {
    const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim()
    if (bearer === CRON_SECRET) return true
  }
  return false
}

export async function POST(req: Request): Promise<Response> {
  if (!(await authorized(req))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return NextResponse.json({ ok: false, error: "Supabase no configurado" }, { status: 503 })
  }
  const body = (await req.json().catch(() => null)) as { tabla?: string; filas?: string[][] } | null
  const tabla = body?.tabla
  const filas = Array.isArray(body?.filas) ? body!.filas! : []
  if ((tabla !== "dom" && tabla !== "giro" && tabla !== "base") || !filas.length || filas.length > MAX_FILAS) {
    return NextResponse.json({ ok: false, error: "tabla dom|giro|base y 1..8000 filas" }, { status: 400 })
  }
  const destino =
    tabla === "dom"
      ? "vic_empresas_cl_domicilio"
      : tabla === "giro"
        ? "vic_empresas_cl_giro"
        : "vic_empresas_cl"
  const conRut = filas.filter((f) => /^\d{6,9}$/.test(String(f[0] || "")))
  const payload =
    tabla === "dom"
      ? conRut.map((f) => ({ rut: Number(f[0]), direccion: f[1] || null, comuna: f[2] || null, region: f[3] || null, ciudad: f[4] || null }))
      : tabla === "giro"
        ? conRut.map((f) => ({ rut: Number(f[0]), codigo: f[1] || null, giro: f[2] || null, n_actividades: Number(f[3] || 1) }))
        : // base = vic_empresas_cl (re-carga UTF-8 limpia de la razón social;
          // la carga original venía con mojibake latin-1: "COMPAÃIA")
          conRut.map((f) => ({
            rut: Number(f[0]),
            dv: f[1] || null,
            razon_social: f[2] || null,
            subtipo: f[3] ? Number(f[3]) : null,
            inicio_giro: f[4] || null,
            termino_giro: f[5] || null,
          }))
  // merge-duplicates: el conflicto por rut ACTUALIZA la fila — así la
  // re-carga corrige en el lugar (la pasada con mojibake queda pisada).
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${destino}?on_conflict=rut`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(payload),
    cache: "no-store",
  })
  if (!r.ok) {
    const detalle = await r.text().catch(() => "")
    return NextResponse.json({ ok: false, error: `${r.status}: ${detalle.slice(0, 200)}` }, { status: 502 })
  }
  return NextResponse.json({ ok: true, tabla, recibidas: filas.length, validas: payload.length })
}
