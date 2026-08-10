/**
 * DIAGNÓSTICO Cal.com (10-ago): ¿podemos dirigir la agenda al dueño que
 * sorteó la tómbola SIN crear un event type por ejecutivo?
 *
 * El 28-jul se probó `teamMemberEmail` en el POST de booking y la API lo
 * rechazó (400). Desde entonces Cal fue agregando capacidades; antes de
 * pedirle al equipo que cree 9 eventos a mano conviene re-probar, y de paso
 * dejar a la vista qué event types y miembros existen hoy.
 *
 * GET ?key=<secret>            → event types del equipo + miembros
 * GET ?key=<secret>&slots=<email>[&event=<id>]
 *     → prueba si los SLOTS se pueden filtrar por ejecutivo (solo LECTURA:
 *       no agenda nada, no manda invitaciones).
 *
 * Auth: ?key=CRON_SECRET o el secreto operativo de vic_kv.
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"

export const dynamic = "force-dynamic"
export const maxDuration = 30

const CAL_API_KEY = (process.env.CAL_API_KEY || "").trim()
const CAL_EVENT_TYPE_ID = (process.env.CAL_EVENT_TYPE_ID || "3188650").trim()
const CRON_SECRET = (process.env.CRON_SECRET || "").trim()
const BASE = "https://api.cal.com/v2"

const H = { Authorization: `Bearer ${CAL_API_KEY}`, "Content-Type": "application/json" }

async function autorizado(req: Request): Promise<boolean> {
  const key = (new URL(req.url).searchParams.get("key") || "").trim()
  if (CRON_SECRET && key === CRON_SECRET) return true
  if (key) {
    const kv = await getFollowupCronSecret().catch(() => "")
    if (kv && key === kv) return true
  }
  return false
}

async function get(path: string, version?: string): Promise<{ status: number; body: unknown }> {
  const r = await fetch(`${BASE}${path}`, {
    headers: version ? { ...H, "cal-api-version": version } : H,
    cache: "no-store",
  })
  const txt = await r.text().catch(() => "")
  let body: unknown = txt.slice(0, 4000)
  try {
    body = JSON.parse(txt)
  } catch { /* texto crudo */ }
  return { status: r.status, body }
}

export async function GET(req: Request): Promise<Response> {
  if (!(await autorizado(req))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }
  if (!CAL_API_KEY) {
    return NextResponse.json({ ok: false, error: "CAL_API_KEY no configurada" }, { status: 500 })
  }
  const sp = new URL(req.url).searchParams

  // ── Prueba de disponibilidad POR EJECUTIVO (solo lectura) ──
  const email = (sp.get("slots") || "").trim()
  if (email) {
    const evento = (sp.get("event") || CAL_EVENT_TYPE_ID).trim()
    // Ventana configurable (?dias=30): un evento sin horario asignado da 0
    // slots SIEMPRE; uno con "notice period" largo recién aparece más lejos.
    const dias = Math.min(60, Math.max(2, Number(sp.get("dias") || 6)))
    const desdeDias = Math.min(dias - 1, Number(sp.get("desde") || 1))
    const desde = new Date(Date.now() + desdeDias * 24 * 3600e3).toISOString().slice(0, 10)
    const hasta = new Date(Date.now() + dias * 24 * 3600e3).toISOString().slice(0, 10)
    const qs = `eventTypeId=${encodeURIComponent(evento)}&start=${desde}&end=${hasta}&timeZone=America/Santiago`
    const [sinFiltro, conMiembro, conUsername] = await Promise.all([
      get(`/slots?${qs}`, "2024-09-04"),
      get(`/slots?${qs}&teamMemberEmail=${encodeURIComponent(email)}`, "2024-09-04"),
      get(`/slots?${qs}&username=${encodeURIComponent(email.split("@")[0])}`, "2024-09-04"),
    ])
    const contar = (b: unknown): number => {
      try {
        const data = (b as { data?: Record<string, unknown[]> })?.data || {}
        return Object.values(data).reduce((n, arr) => n + (Array.isArray(arr) ? arr.length : 0), 0)
      } catch {
        return -1
      }
    }
    return NextResponse.json({
      ok: true,
      prueba: "¿se pueden filtrar los slots por ejecutivo?",
      evento,
      email,
      sin_filtro: { status: sinFiltro.status, slots: contar(sinFiltro.body) },
      con_teamMemberEmail: { status: conMiembro.status, slots: contar(conMiembro.body), body: conMiembro.status >= 400 ? conMiembro.body : undefined },
      con_username: { status: conUsername.status, slots: contar(conUsername.body), body: conUsername.status >= 400 ? conUsername.body : undefined },
      lectura:
        "Si con_teamMemberEmail responde 200 y su número de slots DIFIERE del sin_filtro, la disponibilidad ya se puede pedir por ejecutivo y no hacen falta 9 eventos para el paso de disponibilidad.",
    })
  }

  // ── ¿Quién tiene CALENDARIO CONECTADO? (pregunta de Lalo 10-ago) ──
  // Sin calendario conectado, Cal cree que la persona está 100% libre y
  // Vicky ofrece horas ya ocupadas. Se consultan las vías conocidas de la
  // API v2; se devuelven todas para ver cuál responde en este plan.
  if (sp.get("calendarios")) {
    const [conectados, destinos, teamCals] = await Promise.all([
      get(`/calendars`),
      get(`/destination-calendars`),
      get(`/teams/${encodeURIComponent(sp.get("teamId") || "")}/calendars`),
    ])
    return NextResponse.json({
      ok: true,
      pregunta: "¿qué calendarios están realmente conectados?",
      calendars: { status: conectados.status, body: conectados.body },
      destination_calendars: { status: destinos.status, body: destinos.body },
      team_calendars: { status: teamCals.status, body: teamCals.body },
      nota:
        "La API key es de UNA cuenta: /calendars devuelve los calendarios de ESA cuenta, no los de cada miembro. Si el equipo necesita el detalle por persona, el camino seguro es la prueba de slots por ejecutivo (?slots=email): sin calendario conectado la agenda aparece 100% libre.",
    })
  }

  // ── Inventario: event types y miembros del equipo ──
  const [ets, etsTeam, memberships] = await Promise.all([
    get(`/event-types`, "2024-06-14"),
    get(`/event-types?teamId=${encodeURIComponent(sp.get("teamId") || "")}`, "2024-06-14"),
    get(`/memberships`),
  ])
  const resumirEts = (b: unknown) => {
    try {
      const arr = ((b as { data?: unknown[] })?.data || []) as Array<Record<string, unknown>>
      return arr.map((e) => ({
        id: e.id,
        slug: e.slug,
        title: e.title,
        schedulingType: e.schedulingType,
        hosts: Array.isArray(e.hosts) ? (e.hosts as unknown[]).length : undefined,
        teamId: e.teamId,
      }))
    } catch {
      return b
    }
  }
  return NextResponse.json({
    ok: true,
    event_types_personales: { status: ets.status, items: resumirEts(ets.body) },
    event_types_equipo: { status: etsTeam.status, items: resumirEts(etsTeam.body) },
    memberships: { status: memberships.status, body: memberships.body },
    evento_default_vicky: CAL_EVENT_TYPE_ID,
  })
}
