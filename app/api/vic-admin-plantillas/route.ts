/**
 * ADMIN — Lector de plantillas HSM de Botmaker (solo lectura).
 *
 * Existe porque los CUERPOS de las plantillas de la matriz del loop
 * (LOOP_TPL_MATRIZ) viven solo en Botmaker/Meta: el repo conoce nombres y
 * variables (VARS_PLANTILLA, leídas a mano el 27-jul) pero no el texto real
 * que ve el cliente. Este endpoint proxea GET /v2.0/whatsapp/templates para
 * poder documentar y auditar los textos sin entrar al panel.
 *
 * GET ?line=<phoneLineNumber> (default: línea CL, misma resolución que
 * botmaker-push-v3) · ?q=<substring del nombre> (default "vicky") ·
 * ?raw=1 devuelve los items tal cual.
 *
 * Auth: Bearer/?key= CRON_SECRET o x-cron-secret == vic_kv.followup_cron_secret.
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const CRON_SECRET = (process.env.CRON_SECRET || "").trim()
const BM_TOKEN = (process.env.BOTMAKER_ACCESS_TOKEN || "").trim()

function lineaDefault(): string {
  const explicit = (process.env.BOTMAKER_CHANNEL_NUMBER || "").replace(/\D/g, "")
  if (explicit) return explicit
  const canal = (process.env.BOTMAKER_CHANNEL_V3 || "").trim()
  const m = canal.match(/(\d{6,})\s*$/)
  return m ? m[1] : ""
}

async function authorized(req: Request): Promise<boolean> {
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim()
  if (CRON_SECRET && bearer === CRON_SECRET) return true
  const key = (new URL(req.url).searchParams.get("key") || "").trim()
  if (CRON_SECRET && key === CRON_SECRET) return true
  const header = (req.headers.get("x-cron-secret") || "").trim()
  if (header) {
    const kv = await getFollowupCronSecret().catch(() => "")
    if (kv && header === kv) return true
  }
  return false
}

/** Primer campo string no vacío del item — el nombre del campo del cuerpo
 * varía según la versión de la API de Botmaker. */
function textoDe(t: Record<string, unknown>): string {
  for (const k of ["text", "message", "body", "content", "template", "htmlText"]) {
    const v = t[k]
    if (typeof v === "string" && v.trim()) return v
    if (v && typeof v === "object") {
      const inner = (v as Record<string, unknown>).text || (v as Record<string, unknown>).body
      if (typeof inner === "string" && inner.trim()) return inner
    }
  }
  return ""
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!(await authorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  if (!BM_TOKEN) return NextResponse.json({ error: "BOTMAKER_ACCESS_TOKEN no configurado" }, { status: 503 })
  const { searchParams } = new URL(req.url)
  const line = (searchParams.get("line") || "").replace(/\D/g, "") || lineaDefault()
  if (!line) return NextResponse.json({ error: "sin línea (BOTMAKER_CHANNEL_NUMBER/CHANNEL_V3)" }, { status: 503 })
  const q = (searchParams.get("q") ?? "vicky").toLowerCase()
  const raw = searchParams.get("raw") === "1"
  const res = await fetch(
    `https://api.botmaker.com/v2.0/whatsapp/templates?phoneLineNumber=${encodeURIComponent(line)}`,
    { headers: { "access-token": BM_TOKEN }, cache: "no-store" },
  )
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    return NextResponse.json({ error: `botmaker ${res.status}`, detalle: body.slice(0, 300) }, { status: 502 })
  }
  const data = (await res.json().catch(() => null)) as unknown
  const items: Array<Record<string, unknown>> = Array.isArray(data)
    ? (data as Array<Record<string, unknown>>)
    : Array.isArray((data as Record<string, unknown>)?.templates)
      ? ((data as Record<string, unknown>).templates as Array<Record<string, unknown>>)
      : Array.isArray((data as Record<string, unknown>)?.items)
        ? ((data as Record<string, unknown>).items as Array<Record<string, unknown>>)
        : []
  const filtrados = items.filter((t) => String(t.name || t.id || "").toLowerCase().includes(q))
  if (raw) return NextResponse.json({ line, total: items.length, plantillas: filtrados })
  return NextResponse.json({
    line,
    total: items.length,
    plantillas: filtrados.map((t) => ({
      name: String(t.name || t.id || ""),
      text: textoDe(t),
      keys: Object.keys(t),
    })),
  })
}

/**
 * POST — crear una plantilla HSM nueva (Lalo 11-ago, plantilla del toque
 * post-pago del doc "Regla general Vicky WhatsApp 3"). Proxy fino y
 * autenticado del POST /v2.0/whatsapp/templates de Botmaker: el body llega
 * del admin tal cual (así se puede iterar el formato sin redeploy), con dos
 * cinturones: el nombre DEBE partir con "vicky_" y la línea se resuelve
 * igual que el GET. La aprobación final la da Meta (queda "pending").
 */
export async function POST(req: Request): Promise<NextResponse> {
  if (!(await authorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  if (!BM_TOKEN) return NextResponse.json({ error: "BOTMAKER_ACCESS_TOKEN no configurado" }, { status: 503 })
  const body = (await req.json().catch(() => null)) as { line?: string; template?: Record<string, unknown> } | null
  const template = body?.template
  if (!template || typeof template !== "object") {
    return NextResponse.json({ error: "body.template requerido" }, { status: 400 })
  }
  const nombre = String(template.name || "")
  if (!/^vicky_[a-z0-9_]+$/.test(nombre)) {
    return NextResponse.json({ error: "template.name debe partir con 'vicky_' (solo minúsculas/números/_)" }, { status: 400 })
  }
  const line = String(body?.line || "").replace(/\D/g, "") || lineaDefault()
  if (!line) return NextResponse.json({ error: "sin línea (BOTMAKER_CHANNEL_NUMBER/CHANNEL_V3)" }, { status: 503 })
  const res = await fetch(`https://api.botmaker.com/v2.0/whatsapp/templates`, {
    method: "POST",
    headers: { "access-token": BM_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ ...template, phoneLineNumber: line }),
    cache: "no-store",
  })
  const texto = await res.text().catch(() => "")
  let json: unknown = null
  try { json = JSON.parse(texto) } catch { /* respuesta no-JSON: va cruda */ }
  return NextResponse.json(
    { ok: res.ok, status: res.status, botmaker: json ?? texto.slice(0, 800) },
    { status: res.ok ? 200 : 502 },
  )
}
