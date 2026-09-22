/**
 * ADMIN — feriados por país en `vic_holidays` (15-sep, Perú Fase A).
 *
 * POR QUÉ EXISTE: los relojes hábiles (traspaso, calificación, campaña,
 * vigía del onboarding) leen `vic_holidays` y hasta hoy solo había feriados
 * de CHILE (32, cargados a mano el 10-sep por SQL). Sin filas para PE, un
 * feriado peruano cuenta como día hábil y Vicky entrega leads y manda toques
 * un 28 de julio. No existía forma de cargarlos sin acceso directo a la base.
 *
 * GET  ?key=&country=PE            → filas del país (o todas sin country)
 * POST { country, fechas: ["YYYY-MM-DD", …] }
 *      → inserta SOLO las que faltan (idempotente por país+fecha; no borra).
 *
 * Columnas reales de la tabla: `d` (fecha) y `country` (MAYÚSCULA, "CL").
 * Otras columnas se ignoran al insertar (solo se mandan d + country).
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"

export const dynamic = "force-dynamic"
export const maxDuration = 30

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()

async function autorizado(req: Request): Promise<boolean> {
  const secreto = await getFollowupCronSecret()
  const url = new URL(req.url)
  const auth = req.headers.get("authorization") || ""
  const entregado =
    req.headers.get("x-cron-secret") || (auth.startsWith("Bearer ") ? auth.slice(7) : "") || url.searchParams.get("key") || ""
  return Boolean(secreto) && entregado === secreto
}

function H(): Record<string, string> {
  return { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" }
}

async function filasDe(country: string): Promise<Array<Record<string, unknown>>> {
  const q = country ? `&country=ilike.${encodeURIComponent(country)}` : ""
  const r = await fetch(`${SUPABASE_URL}/rest/v1/vic_holidays?select=*${q}&order=d.asc&limit=1000`, { headers: H(), cache: "no-store" })
  if (!r.ok) throw new Error(`vic_holidays ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`)
  return (await r.json()) as Array<Record<string, unknown>>
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  if (!SUPABASE_URL || !SUPABASE_KEY) return NextResponse.json({ ok: false, error: "Supabase no configurado" }, { status: 503 })
  const country = (new URL(req.url).searchParams.get("country") || "").trim().toUpperCase()
  try {
    const filas = await filasDe(country)
    const porPais: Record<string, number> = {}
    for (const f of filas) {
      const p = String(f.country || "?").toUpperCase()
      porPais[p] = (porPais[p] || 0) + 1
    }
    return NextResponse.json({ ok: true, total: filas.length, porPais, filas })
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  if (!SUPABASE_URL || !SUPABASE_KEY) return NextResponse.json({ ok: false, error: "Supabase no configurado" }, { status: 503 })
  const body = (await req.json().catch(() => ({}))) as { country?: string; fechas?: unknown }
  const country = String(body.country || "").trim().toUpperCase()
  const fechas = Array.isArray(body.fechas)
    ? Array.from(new Set(body.fechas.map((f) => String(f || "").slice(0, 10)).filter((f) => /^\d{4}-\d{2}-\d{2}$/.test(f))))
    : []
  if (!/^[A-Z]{2}$/.test(country)) return NextResponse.json({ ok: false, error: "country debe ser código de 2 letras (CL, PE…)" }, { status: 400 })
  if (fechas.length === 0) return NextResponse.json({ ok: false, error: "fechas[] vacío o con formato distinto de YYYY-MM-DD" }, { status: 400 })
  try {
    const existentes = new Set((await filasDe(country)).map((f) => String(f.d || "").slice(0, 10)))
    const nuevas = fechas.filter((f) => !existentes.has(f))
    if (nuevas.length > 0) {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/vic_holidays`, {
        method: "POST",
        headers: { ...H(), Prefer: "return=minimal" },
        body: JSON.stringify(nuevas.map((d) => ({ d, country }))),
        cache: "no-store",
      })
      if (!r.ok) throw new Error(`insert ${r.status}: ${(await r.text().catch(() => "")).slice(0, 300)}`)
    }
    console.log(`[admin-holidays] ${country}: ${nuevas.length} insertadas, ${fechas.length - nuevas.length} ya existían`)
    return NextResponse.json({ ok: true, country, insertadas: nuevas, yaExistian: fechas.length - nuevas.length, total: existentes.size + nuevas.length })
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
