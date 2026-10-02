/**
 * ADMIN — campaña externa: contactos que atiende una persona desde Botmaker
 * (02-oct, campaña ACRIP Colombia de María Fernanda Gómez). Ver
 * lib/campana-externa.ts.
 *
 *   GET  ?key=<cron>&contact=<fono>                         → ¿está marcado?
 *   POST {campana, agente, contactos:[fono…], dias?, dry?}  → marca (dry por defecto)
 *   POST {contactos:[…], off:true}                          → desmarca
 *
 * El agente se verifica contra la lista de agentes de Botmaker ANTES de
 * marcar: si el correo no existe, el flujo de asignación degrada a "cualquier
 * agente de la cola" y el chat le caería a otra persona.
 */
import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"
import {
  campanaExternaDe,
  marcarCampanaExterna,
  desmarcarCampanaExterna,
  CAMPANA_EXTERNA_MAX_DIAS,
} from "@/lib/campana-externa"

export const dynamic = "force-dynamic"
export const maxDuration = 60

async function autorizado(req: Request): Promise<boolean> {
  const url = new URL(req.url)
  const dado =
    req.headers.get("x-cron-secret") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim() ||
    url.searchParams.get("key") ||
    ""
  if (!dado) return false
  const kv = await getFollowupCronSecret().catch(() => "")
  return dado === (process.env.CRON_SECRET || "").trim() || (Boolean(kv) && dado === kv)
}

const limpiar = (c: unknown) => String(c || "").replace(/\D/g, "")

export async function GET(req: Request): Promise<Response> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  const contact = limpiar(new URL(req.url).searchParams.get("contact"))
  if (!contact) return NextResponse.json({ ok: false, error: "falta contact" }, { status: 400 })
  return NextResponse.json({ ok: true, contact, marca: await campanaExternaDe(contact) })
}

export async function POST(req: Request): Promise<Response> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  const body = (await req.json().catch(() => ({}))) as {
    campana?: string
    agente?: string
    contactos?: unknown[]
    dias?: number
    dry?: boolean
    off?: boolean
    /** Línea de WhatsApp de la campaña (número o channelId). */
    linea?: string
  }
  const contactos = Array.from(new Set((body.contactos || []).map(limpiar).filter((c) => /^\d{10,13}$/.test(c))))
  if (!contactos.length) return NextResponse.json({ ok: false, error: "sin contactos válidos" }, { status: 400 })

  if (body.off) {
    for (const c of contactos) await desmarcarCampanaExterna(c).catch(() => {})
    return NextResponse.json({ ok: true, desmarcados: contactos.length })
  }

  const campana = String(body.campana || "").trim()
  const agente = String(body.agente || "").trim().toLowerCase()
  if (!campana || !agente) return NextResponse.json({ ok: false, error: "faltan campana y agente" }, { status: 400 })

  const { listarAgentes } = await import("@/lib/botmaker-agentes")
  const agentes = await listarAgentes().catch(() => [])
  const existe = agentes.find((a) => String(a.email || "").toLowerCase() === agente)
  if (!existe) {
    return NextResponse.json({ ok: false, error: `${agente} no existe como agente en Botmaker (${agentes.length} leídos)` }, { status: 400 })
  }

  const dias = Math.min(Math.max(Number(body.dias) || 30, 1), CAMPANA_EXTERNA_MAX_DIAS)
  const linea = String(body.linea || "").replace(/\D/g, "") || undefined
  const dry = body.dry !== false
  const yaMarcados: string[] = []
  for (const c of contactos) {
    const prev = await campanaExternaDe(c)
    if (prev) yaMarcados.push(`${c} (${prev.campana})`)
    if (!dry) await marcarCampanaExterna(c, campana, agente, dias, linea)
  }
  return NextResponse.json({
    ok: true,
    dry,
    campana,
    agente: { email: agente, nombre: existe.name, id: existe.id },
    dias,
    linea: linea || "(por prefijo)",
    contactos: contactos.length,
    yaMarcados,
  })
}
