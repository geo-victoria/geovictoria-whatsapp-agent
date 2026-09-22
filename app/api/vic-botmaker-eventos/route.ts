/**
 * RECEPTOR DE EVENTOS DE MENSAJES DE BOTMAKER (08-ago, caso "Vicky muda").
 *
 * Respuesta a la pregunta de Lalo: "¿cómo nos enteramos DIRECTO desde
 * Botmaker?" — la acción de código NO corre cuando el chat está tomado por un
 * agente, pero Botmaker puede empujar TODOS los mensajes (entrantes y
 * salientes, en cualquier estado del chat) a un webhook de PLATAFORMA.
 *
 * CONFIGURAR EN BOTMAKER (consola → Integraciones → Webhooks, o vía soporte):
 * suscribir los eventos de mensajes apuntando a:
 *   https://<host>/api/vic-botmaker-eventos?key=<CRON_SECRET>
 *
 * Qué hace: guarda SIEMPRE el último payload en vic_kv
 * (debug_last_eventos_payload) para descubrir el shape real sin redeployar
 * (mismo truco que vic-botmaker-status), y persiste cada evento que parezca
 * mensaje de CLIENTE en vic_kv (`bmev_<hash>`, TTL 3 días). El cron
 * vic-mudos-cron los cruza contra vic_v3_messages: mensaje del cliente sin
 * gemelo procesado = Vicky muda → alerta. Con este webhook conectado, la
 * detección deja de depender del polling del feed.
 *
 * Auth: ?key=CRON_SECRET (o secreto operativo de vic_kv) o header
 * auth-bm-token (mismo token que el webhook de estados, 04-ago).
 */

import { NextResponse } from "next/server"
import { createHash } from "crypto"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"

export const dynamic = "force-dynamic"
export const maxDuration = 15

const CRON_SECRET = (process.env.CRON_SECRET || "").trim()
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim().replace(/\/$/, "")
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const BM_STATUS_TOKEN = (
  process.env.BOTMAKER_STATUS_TOKEN || "B3CADA7756B4561C5F97D065A52F0E98010C3633"
).trim()

const SB_HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
}

async function autorizado(req: Request): Promise<boolean> {
  const bmToken = (req.headers.get("auth-bm-token") || "").trim()
  if (BM_STATUS_TOKEN && bmToken && bmToken === BM_STATUS_TOKEN) return true
  const key = (new URL(req.url).searchParams.get("key") || "").trim()
  if (CRON_SECRET && key === CRON_SECRET) return true
  if (key) {
    const kvSecret = await getFollowupCronSecret().catch(() => "")
    if (kvSecret && key === kvSecret) return true
  }
  return false
}

async function kvUpsert(key: string, value: string, ttlMs?: number): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/vic_kv?on_conflict=key`, {
    method: "POST",
    headers: { ...SB_HEADERS, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      key,
      value,
      ...(ttlMs ? { expires_at: new Date(Date.now() + ttlMs).toISOString() } : {}),
    }),
  }).catch(() => {})
}

export async function POST(req: Request): Promise<Response> {
  if (!(await autorizado(req))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }
  const raw = await req.text().catch(() => "")
  // Shape aún desconocido: SIEMPRE guardar el último payload para calibrar.
  await kvUpsert("debug_last_eventos_payload", raw.slice(0, 8000))

  let body: Record<string, unknown> = {}
  try {
    body = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return NextResponse.json({ ok: true, nota: "payload no-JSON registrado" })
  }

  // Parseo tolerante de las formas conocidas de Botmaker: el mensaje puede
  // venir plano o dentro de message/data; el emisor en from/sender/direction.
  const m = (body.message || body.data || body) as Record<string, unknown>
  const from = String(m.from || m.sender || m.direction || body.from || "").toLowerCase()
  const contact = String(
    (m.chat as { contactId?: string } | undefined)?.contactId ||
      m.contactId ||
      body.contactId ||
      "",
  ).replace(/\D/g, "")
  const contenido = (m.content || {}) as { type?: string; text?: string }
  let texto = String(contenido.text || m.text || m.body || "").trim()
  if (texto.startsWith('{"button"')) {
    try {
      texto = `[botón] ${String((JSON.parse(texto) as { button?: string }).button || texto)}`
    } catch { /* crudo */ }
  }
  const fecha = String(m.creationTime || body.creationTime || new Date().toISOString())
  const canal = String((m.chat as { channelId?: string } | undefined)?.channelId || m.channelId || "")

  if (from.includes("user") && contact && texto) {
    const hash = createHash("sha1").update(`${contact}|${fecha}|${texto}`).digest("hex")
    await kvUpsert(
      `bmev_${hash}`,
      JSON.stringify({ contact, canal, fecha, texto: texto.slice(0, 300) }),
      3 * 24 * 3600e3,
    )
    return NextResponse.json({ ok: true, registrado: true })
  }
  return NextResponse.json({ ok: true, registrado: false })
}
