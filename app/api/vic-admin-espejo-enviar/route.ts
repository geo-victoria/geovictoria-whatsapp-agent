/**
 * ADMIN — encolar un TEXTO o una IMAGEN para que el espejo de una sesión de
 * PRUEBA lo mande desde ese WhatsApp real (05-sep, orden de Lalo: "hazlo para
 * que tú mismo pruebes el flujo end to end").
 *
 * Es la misma cola `wa_envio_<session>_*` que usa el editor para los PDF; el
 * worker (workers/wa-espejo) despacha los tipos texto/imagen SOLO para las
 * sesiones listadas en vic_kv `wa_envio_libre_sesiones` (hoy `egomez`). Acá se
 * repite esa guarda para que ni siquiera se encole a una sesión que no sea de
 * prueba: la ampliación no alcanza a los ejecutivos.
 *
 * POST { session, to, tipo: "texto"|"imagen", text?, caption?, image_base64?, image_url?, mimetype? }
 *   → { ok, job }          (job = clave kv; el worker la marca enviando/enviado/error)
 * GET  ?job=<clave>        → estado del trabajo
 *
 * Auth: x-cron-secret / Bearer / ?key= = secreto de cron.
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret, getKvValue, setKvValue } from "@/lib/supabase-persistence-v3"

export const dynamic = "force-dynamic"
export const maxDuration = 15

async function autorizado(req: Request): Promise<boolean> {
  const secreto = await getFollowupCronSecret()
  const url = new URL(req.url)
  const auth = req.headers.get("authorization") || ""
  const entregado =
    req.headers.get("x-cron-secret") || (auth.startsWith("Bearer ") ? auth.slice(7) : "") || url.searchParams.get("key") || ""
  return Boolean(secreto) && entregado === secreto
}

async function sesionesLibres(): Promise<string[]> {
  return ((await getKvValue("wa_envio_libre_sesiones")) || "").split(",").map((x) => x.trim()).filter(Boolean)
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  const job = (new URL(req.url).searchParams.get("job") || "").trim()
  if (!/^wa_envio_[a-z0-9_]+_\d+$/i.test(job)) return NextResponse.json({ ok: false, error: "job inválido" }, { status: 400 })
  const raw = (await getKvValue(job).catch(() => "")) || ""
  let estado: unknown = null
  try { estado = raw ? JSON.parse(raw) : null } catch { estado = raw }
  return NextResponse.json({ ok: true, job, estado })
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  const b = (await req.json().catch(() => ({}))) as {
    session?: string; to?: string; tipo?: string; text?: string; caption?: string
    image_base64?: string; image_url?: string; mimetype?: string
  }
  const session = String(b.session || "").trim().toLowerCase()
  const to = String(b.to || "").replace(/\D/g, "")
  const tipo = String(b.tipo || "texto").trim()
  if (!/^[a-z0-9_]+$/.test(session)) return NextResponse.json({ ok: false, error: "session inválida" }, { status: 400 })
  if (!/^\d{9,15}$/.test(to)) return NextResponse.json({ ok: false, error: "to inválido" }, { status: 400 })
  if (tipo !== "texto" && tipo !== "imagen") return NextResponse.json({ ok: false, error: "tipo debe ser texto|imagen" }, { status: 400 })
  const libres = await sesionesLibres()
  if (!libres.includes(session)) {
    return NextResponse.json({ ok: false, error: `sesión ${session} no está en wa_envio_libre_sesiones` }, { status: 403 })
  }
  if (tipo === "texto" && !String(b.text || "").trim()) return NextResponse.json({ ok: false, error: "falta text" }, { status: 400 })
  if (tipo === "imagen" && !b.image_base64 && !b.image_url) return NextResponse.json({ ok: false, error: "falta image_base64 o image_url" }, { status: 400 })
  if (b.image_base64 && b.image_base64.length > 900_000) return NextResponse.json({ ok: false, error: "imagen demasiado grande (máx ~650 KB)" }, { status: 413 })

  const job = `wa_envio_${session}_${Date.now()}`
  const valor = {
    tipo, to, status: "pendiente", at: new Date().toISOString(), origen: "vic-admin-espejo-enviar",
    ...(tipo === "texto" ? { text: String(b.text).trim() } : {}),
    ...(tipo === "imagen" ? { caption: String(b.caption || ""), mimetype: String(b.mimetype || "image/png"), ...(b.image_base64 ? { image_base64: b.image_base64 } : {}), ...(b.image_url ? { image_url: b.image_url } : {}) } : {}),
  }
  await setKvValue(job, JSON.stringify(valor))
  console.log(`[espejo-enviar] encolado ${job} (${tipo} → +${to})`)
  return NextResponse.json({ ok: true, job })
}
