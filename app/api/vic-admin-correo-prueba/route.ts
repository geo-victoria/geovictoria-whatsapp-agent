/**
 * Endpoint ADMIN: dispara los correos del onboarding a una casilla de prueba
 * SIN re-actuar el flujo completo (25-ago — iterar el copy de los correos de
 * bienvenida/instrucciones costaba rebobinar estado + conversación cada vez).
 *
 * POST auth cron: { tipo: "bienvenida" | "instrucciones" | "ambos",
 *                   email, nombre, apellido?, empresa? }
 * Solo manda CORREOS a la casilla indicada — no toca kv ni conversaciones.
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"

export const dynamic = "force-dynamic"
export const maxDuration = 30

const CRON_SECRET = (process.env.CRON_SECRET || "").trim()

async function autorizado(req: Request): Promise<boolean> {
  const url = new URL(req.url)
  const entregado =
    req.headers.get("x-cron-secret") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") ||
    url.searchParams.get("key") ||
    ""
  if (!entregado) return false
  const kv = await getFollowupCronSecret().catch(() => "")
  return entregado === CRON_SECRET || (Boolean(kv) && entregado === kv)
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  const body = (await req.json().catch(() => ({}))) as {
    tipo?: string
    email?: string
    nombre?: string
    apellido?: string
    empresa?: string
  }
  const tipo = (body.tipo || "ambos").toLowerCase()
  const email = (body.email || "").trim()
  if (!email) return NextResponse.json({ ok: false, error: "falta email" }, { status: 400 })
  const nombre = (body.nombre || "Eduardo").trim()
  const apellido = (body.apellido || "").trim()
  const empresa = (body.empresa || "PRUEBA VICKY ONBOARDING SPA").trim()

  const out: Record<string, unknown> = {}
  if (tipo === "bienvenida" || tipo === "ambos") {
    const { enviarCorreoBienvenidaSimulado } = await import("@/lib/alta-simulada")
    const r = await enviarCorreoBienvenidaSimulado({ nombre, apellido, email })
    out.bienvenida = r.ok
  }
  if (tipo === "instrucciones" || tipo === "ambos") {
    const { enviarCorreoInstruccionesOnboarding } = await import("@/lib/onboarding-correos")
    out.instrucciones = await enviarCorreoInstruccionesOnboarding({
      adminNombre: `${nombre} ${apellido}`.trim(),
      adminEmail: email,
      empresa,
    })
  }
  return NextResponse.json({ ok: true, ...out })
}
