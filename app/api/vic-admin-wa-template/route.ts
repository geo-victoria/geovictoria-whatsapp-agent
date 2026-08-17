/**
 * Endpoint ADMIN: plantillas de WhatsApp en Botmaker.
 *
 * Existe porque el token de Botmaker vive en el env del agente y no se puede
 * leer desde fuera; sin esto, crear una plantilla exige pegarle el secreto a
 * alguien o hacerlo a mano en el panel.
 *
 *   GET  ?key=<cron>&listar=1[&contiene=]   → plantillas existentes (para copiar
 *                                             botName/locale/línea exactos)
 *   POST ?key=<cron>                        → crea la plantilla con el body tal
 *                                             cual lo pide la API de Botmaker
 *
 * La creación NO se puede deshacer sola: WhatsApp la deja en revisión y el
 * estado vuelve APPROVED / REJECTED / *_PENDING. Por eso el POST exige
 * `confirmo=1` además de la clave.
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const BM_TOKEN = (process.env.BOTMAKER_ACCESS_TOKEN || "").trim()
const CRON_SECRET = (process.env.CRON_SECRET || "").trim()
const BASE = "https://api.botmaker.com/v2.0/whatsapp/templates"

async function autorizado(req: Request): Promise<boolean> {
  const key = (new URL(req.url).searchParams.get("key") || "").trim()
  if (!key) return false
  const kv = await getFollowupCronSecret().catch(() => "")
  return key === CRON_SECRET || (Boolean(kv) && key === kv)
}

export async function GET(req: Request): Promise<Response> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  if (!BM_TOKEN) return NextResponse.json({ ok: false, error: "sin BOTMAKER_ACCESS_TOKEN" }, { status: 500 })

  const sp = new URL(req.url).searchParams
  const r = await fetch(BASE, {
    headers: { "access-token": BM_TOKEN, Accept: "application/json" },
    cache: "no-store",
  })
  const cuerpo = await r.text().catch(() => "")
  let data: unknown = null
  try {
    data = JSON.parse(cuerpo)
  } catch {
    return NextResponse.json({ ok: false, status: r.status, crudo: cuerpo.slice(0, 600) })
  }

  const lista = Array.isArray(data) ? data : (data as { templates?: unknown[] })?.templates || []
  const filtro = (sp.get("contiene") || "").trim().toLowerCase()
  const filas = (lista as Array<Record<string, unknown>>)
    .map((t) => ({
      name: String(t.name || ""),
      state: String(t.state || ""),
      locale: String(t.locale || ""),
      category: String(t.category || ""),
      botName: String(t.botName || ""),
      lineas: Array.isArray(t.phoneLinesNumbers) ? t.phoneLinesNumbers : [],
      botones: Array.isArray(t.buttons) ? (t.buttons as Array<Record<string, unknown>>).map((b) => `${b.type}:${b.text}`) : [],
    }))
    .filter((t) => !filtro || t.name.toLowerCase().includes(filtro))

  return NextResponse.json({ ok: r.ok, status: r.status, n: filas.length, plantillas: filas })
}

export async function POST(req: Request): Promise<Response> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  if (!BM_TOKEN) return NextResponse.json({ ok: false, error: "sin BOTMAKER_ACCESS_TOKEN" }, { status: 500 })
  const sp = new URL(req.url).searchParams
  if (sp.get("confirmo") !== "1") {
    return NextResponse.json({ ok: false, error: "falta confirmo=1" }, { status: 400 })
  }

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== "object") {
    return NextResponse.json({ ok: false, error: "body inválido" }, { status: 400 })
  }

  const r = await fetch(BASE, {
    method: "POST",
    headers: {
      "access-token": BM_TOKEN,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    cache: "no-store",
  })
  const cuerpo = await r.text().catch(() => "")
  let data: unknown = null
  try {
    data = JSON.parse(cuerpo)
  } catch {
    data = cuerpo.slice(0, 800)
  }
  return NextResponse.json({ ok: r.ok, status: r.status, respuesta: data })
}
