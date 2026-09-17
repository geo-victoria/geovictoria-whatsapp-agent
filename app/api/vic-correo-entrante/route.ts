/**
 * POST /api/vic-correo-entrante — entrada por PUSH de un correo de la casilla
 * de Vicky (Power Automate "When a new email arrives" → HTTP, Zoho Flow, o
 * reenvío manual). Body JSON:
 *   { messageId?, from, subject?, html? | body? | text?, receivedAt?, attachments?, dry?, forzar?, correos? }
 * `attachments` = la lista del desencadenador de Power Automate (Name /
 * ContentBytes / ContentType / IsInline / Size), la de Graph o
 * [{nombre, base64, tipo}]; también como string JSON. Imagen/PDF no-inline se
 * leen con visión como comprobante (17-sep).
 * Auth: header x-cron-secret (kv followup_cron_secret), Bearer/?key= CRON_SECRET,
 * o header x-correo-secret == env VICKY_CORREO_ENTRANTE_SECRET / kv correo_entrante_secret.
 *
 * Devuelve el veredicto de lib/pago-por-correo (no_es_aviso · registrado ·
 * ya_pagada · sin_cotizacion · ambiguo · monto_insuficiente · dry · error).
 * GET responde el uso.
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret, getKvValue } from "@/lib/supabase-persistence-v3"
import { procesarCorreoEntrante } from "@/lib/pago-por-correo"
import { normalizarAdjuntos } from "@/lib/aviso-banco"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const CRON_SECRET = (process.env.CRON_SECRET || "").trim()

async function authorized(req: Request): Promise<boolean> {
  const xcron = (req.headers.get("x-cron-secret") || "").trim()
  if (xcron) {
    const expected = await getFollowupCronSecret().catch(() => "")
    if (expected && xcron === expected) return true
  }
  const xcorreo = (req.headers.get("x-correo-secret") || "").trim()
  if (xcorreo) {
    const env = (process.env.VICKY_CORREO_ENTRANTE_SECRET || "").trim()
    const kv = env ? "" : String((await getKvValue("correo_entrante_secret").catch(() => null)) || "").trim()
    if ((env && xcorreo === env) || (kv && xcorreo === kv)) return true
  }
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim()
  const key = (new URL(req.url).searchParams.get("key") || "").trim()
  const dado = bearer || key
  if (!dado) return false
  if (CRON_SECRET && dado === CRON_SECRET) return true
  // Mismo patrón que el resto de los admin: el secreto de vic_kv también vale
  // como ?key= (los scripts de operación lo usan así).
  const kvSecret = await getFollowupCronSecret().catch(() => "")
  return Boolean(kvSecret && dado === kvSecret)
}

export async function GET(req: Request): Promise<Response> {
  if (!(await authorized(req))) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  return NextResponse.json({
    ok: true,
    uso: "POST {messageId?, from, subject?, html?|body?|text?, receivedAt?, attachments?, dry?, forzar?, correos?}",
    nota: "dry=true solo parsea y resuelve la cotización, no escribe nada.",
  })
}

export async function POST(req: Request): Promise<Response> {
  if (!(await authorized(req))) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  let body: Record<string, unknown> = {}
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ ok: false, error: "body JSON inválido" }, { status: 400 })
  }
  const from = String(body.from || (body.sender as { address?: string } | undefined)?.address || "").trim()
  if (!from) return NextResponse.json({ ok: false, error: "from requerido" }, { status: 400 })
  const html = String(body.html || body.body || "")
  const text = String(body.text || body.bodyPreview || "")
  const adjuntos = normalizarAdjuntos(body.attachments ?? body.adjuntos ?? body.Attachments)
  const r = await procesarCorreoEntrante(
    {
      messageId: String(body.messageId || body.internetMessageId || body.id || ""),
      from,
      subject: String(body.subject || ""),
      html: /<[a-z][\s\S]*>/i.test(html) ? html : undefined,
      text: /<[a-z][\s\S]*>/i.test(html) ? text : html || text,
      receivedAt: String(body.receivedAt || body.receivedDateTime || ""),
      adjuntos,
      fuente: "push",
    },
    { dry: body.dry === true || body.dry === "1", forzar: body.forzar === true || body.forzar === "1", correos: typeof body.correos === "boolean" ? body.correos : undefined },
  )
  return NextResponse.json({ ok: r.veredicto !== "error", adjuntosRecibidos: adjuntos.length, ...r }, { status: r.veredicto === "error" ? 502 : 200 })
}
