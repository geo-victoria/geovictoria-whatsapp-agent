/**
 * ADMIN — dejar una nota para la implementación de un contacto (14-sep).
 *
 * POST {contact, titulo, texto}  · auth cron (x-cron-secret o ?key=)
 * Si la implementación ya existe, la nota se escribe al tiro; si todavía no
 * nace (el cliente aún no paga o no completa el alta), queda en cola y se
 * adjunta sola cuando nazca. GET ?key=&contact= muestra lo que hay en cola.
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret, getKvValue } from "@/lib/supabase-persistence-v3"
import { dejarNotaPendienteImp } from "@/lib/nota-implementacion-pendiente"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const CRON_SECRET = (process.env.CRON_SECRET || "").trim()

async function autorizado(req: Request): Promise<boolean> {
  const url = new URL(req.url)
  const auth = req.headers.get("authorization") || ""
  const entregado =
    req.headers.get("x-cron-secret") ||
    (auth.startsWith("Bearer ") ? auth.slice(7) : "") ||
    url.searchParams.get("key") ||
    ""
  if (!entregado) return false
  if (CRON_SECRET && entregado === CRON_SECRET) return true
  const kv = await getFollowupCronSecret().catch(() => "")
  return Boolean(kv) && entregado === kv
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  const b = (await req.json().catch(() => ({}))) as { contact?: string; titulo?: string; texto?: string }
  const contact = String(b.contact || "").replace(/\D/g, "")
  if (!contact) return NextResponse.json({ ok: false, error: "falta contact" }, { status: 400 })
  const r = await dejarNotaPendienteImp(contact, String(b.titulo || ""), String(b.texto || ""))
  return NextResponse.json({ ...r, contact })
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  const contact = (new URL(req.url).searchParams.get("contact") || "").replace(/\D/g, "")
  if (!contact) return NextResponse.json({ ok: false, error: "falta contact" }, { status: 400 })
  const crudo = await getKvValue(`onb_nota_imp_${contact}`).catch(() => null)
  let cola: unknown[] = []
  try { cola = crudo ? JSON.parse(crudo) : [] } catch { cola = [] }
  return NextResponse.json({ ok: true, contact, enCola: Array.isArray(cola) ? cola.length : 0, cola })
}
