/**
 * GET /api/vic-correo-vicky-cron — lee la casilla vicky@ por Microsoft Graph
 * y registra los avisos de transferencia de los bancos (lib/pago-por-correo).
 * Despachado por JOBS_HUERFANOS cada 10'.
 *
 * Params: ?dry=1 (no escribe) · ?horas=48 (ventana hacia atrás; default = desde
 * la última lectura, kv `correo_vicky_ultimo`, con piso 48 h) · ?max=50 ·
 * ?forzar=1 (reprocesa los ya marcados).
 * Auth: x-cron-secret (kv followup_cron_secret) o Bearer/?key= CRON_SECRET.
 *
 * Sin credenciales de Graph responde `estado: "sin_credenciales"` con las envs
 * que faltan: el camino alternativo es el push a /api/vic-correo-entrante.
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret, getKvValue, setKvValue } from "@/lib/supabase-persistence-v3"
import { credencialesGraph, listarCorreosVicky } from "@/lib/correo-vicky-graph"
import { procesarCorreoEntrante, type ResultadoCorreoPago } from "@/lib/pago-por-correo"

export const dynamic = "force-dynamic"
export const maxDuration = 120

const CRON_SECRET = (process.env.CRON_SECRET || "").trim()

async function authorized(req: Request): Promise<boolean> {
  const xcron = (req.headers.get("x-cron-secret") || "").trim()
  if (xcron) {
    const expected = await getFollowupCronSecret().catch(() => "")
    if (expected && xcron === expected) return true
  }
  if (CRON_SECRET) {
    const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim()
    if (bearer === CRON_SECRET) return true
    const key = (new URL(req.url).searchParams.get("key") || "").trim()
    if (key === CRON_SECRET) return true
  }
  return false
}

export async function GET(req: Request): Promise<Response> {
  if (!(await authorized(req))) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  const url = new URL(req.url)
  const dry = url.searchParams.get("dry") === "1"
  const forzar = url.searchParams.get("forzar") === "1"
  const max = Math.min(100, Math.max(1, Number(url.searchParams.get("max")) || 50))
  const horasParam = Number(url.searchParams.get("horas")) || 0

  const cred = await credencialesGraph()
  if (!cred) {
    return NextResponse.json({
      ok: true,
      estado: "sin_credenciales",
      faltan: ["MSGRAPH_TENANT_ID", "MSGRAPH_CLIENT_ID", "MSGRAPH_CLIENT_SECRET"],
      alternativa: "POST /api/vic-correo-entrante con cada correo (Power Automate / Zoho Flow)",
    })
  }

  const ultimo = String((await getKvValue("correo_vicky_ultimo").catch(() => null)) || "")
  const pisoMs = Date.now() - Math.max(1, horasParam || 48) * 3600_000
  const desdeMs = horasParam ? pisoMs : Math.min(Number.isFinite(Date.parse(ultimo)) ? Date.parse(ultimo) - 10 * 60_000 : pisoMs, pisoMs) || pisoMs
  const desdeIso = new Date(Math.max(desdeMs, Date.now() - 30 * 86400_000)).toISOString()

  const inicio = Date.now()
  let correos
  try {
    correos = await listarCorreosVicky({ desdeIso, max })
  } catch (e) {
    return NextResponse.json({ ok: false, estado: "error_graph", error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }

  const filas: Array<{ subject: string; from: string; receivedAt: string } & Partial<ResultadoCorreoPago>> = []
  const conteo: Record<string, number> = {}
  let masReciente = ultimo
  for (const m of correos) {
    if (Date.now() - inicio > 100_000) break
    const r = await procesarCorreoEntrante(
      { messageId: m.internetMessageId || m.id, from: m.from, subject: m.subject, html: m.html, receivedAt: m.receivedDateTime, fuente: "graph" },
      { dry, forzar },
    )
    conteo[r.veredicto] = (conteo[r.veredicto] || 0) + 1
    if (r.veredicto !== "no_es_aviso") filas.push({ subject: m.subject, from: m.from, receivedAt: m.receivedDateTime, ...r })
    if (!masReciente || Date.parse(m.receivedDateTime) > Date.parse(masReciente)) masReciente = m.receivedDateTime
  }
  if (!dry && masReciente && masReciente !== ultimo) await setKvValue("correo_vicky_ultimo", masReciente).catch(() => {})

  return NextResponse.json({ ok: true, dry, mailbox: cred.mailbox, desde: desdeIso, leidos: correos.length, conteo, filas, ms: Date.now() - inicio })
}
