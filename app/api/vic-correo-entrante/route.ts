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

import { NextResponse, after } from "next/server"
import { getFollowupCronSecret, getKvValue, setKvValue } from "@/lib/supabase-persistence-v3"
import { procesarCorreoEntrante } from "@/lib/pago-por-correo"
import { normalizarAdjuntos } from "@/lib/aviso-banco"

export const dynamic = "force-dynamic"
export const maxDuration = 300

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

// RASTRO DE CADA LLAMADA (24-sep, Power Automate avisó 14 fallas en la semana
// y los logs de Vercel no alcanzaban): contador por día + la última llamada +
// cada falla con su causa, en vic_kv. Nunca rompe la respuesta.
function hoyCL(): string {
  return new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10)
}
async function rastro(tipo: "ok" | "fallo", datos: Record<string, unknown>): Promise<void> {
  try {
    const dia = hoyCL()
    const kc = `correo_entrante_n_${dia}`
    const prev = JSON.parse(String((await getKvValue(kc).catch(() => null)) || "{}")) as Record<string, number>
    const clave = String(datos.veredicto || tipo)
    prev[clave] = (prev[clave] || 0) + 1
    prev.total = (prev.total || 0) + 1
    await setKvValue(kc, JSON.stringify(prev))
    const reg = JSON.stringify({ at: new Date().toISOString(), tipo, ...datos })
    await setKvValue("correo_entrante_ultimo", reg)
    if (tipo === "fallo") await setKvValue(`correo_entrante_fallo_${Date.now()}`, reg)
  } catch {
    /* el rastro jamás tumba el endpoint */
  }
}

// Power Automate cuenta como FALLA todo lo que no sea 2xx y además espera la
// respuesta ~2 min: con visión de adjuntos + Zoho una pasada puede pasar los
// 60 s. Por eso (24-sep): (1) lo que viene de Power Automate se ACEPTA al tiro
// (202) y se procesa después de responder; (2) un cuerpo ilegible o un error
// de contenido responde 200 con ok:false y queda en vic_kv — reintentar lo
// mismo no lo arregla y solo suma fallas. dry / sincrono=true siguen
// respondiendo el veredicto en la misma llamada (operación manual).
export async function POST(req: Request): Promise<Response> {
  if (!(await authorized(req))) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  const bruto = await req.text().catch(() => "")
  let body: Record<string, unknown> = {}
  try {
    body = JSON.parse(bruto) as Record<string, unknown>
  } catch (e) {
    const detalle = { error: "body JSON inválido", bytes: bruto.length, inicio: bruto.slice(0, 300), parse: (e as Error).message }
    console.error(`[correo-entrante] ${detalle.error} bytes=${bruto.length} ${detalle.parse}`)
    await rastro("fallo", detalle)
    return NextResponse.json({ ok: false, ...detalle }, { status: 200 })
  }
  const sincrono = body.dry === true || body.dry === "1" || body.sincrono === true || body.sincrono === "1"
  if (sincrono) return procesar(body, bruto.length)
  after(async () => {
    await procesar(body, bruto.length).catch(() => {})
  })
  return NextResponse.json({ ok: true, aceptado: true, bytes: bruto.length }, { status: 202 })
}

async function procesar(body: Record<string, unknown>, bytes: number): Promise<Response> {
  try {
    return await procesarInterno(body, bytes)
  } catch (e) {
    const detalle = { error: (e as Error).message, from: String(body.from || ""), subject: String(body.subject || "").slice(0, 80), bytes }
    console.error(`[correo-entrante] excepción: ${detalle.error}`)
    await rastro("fallo", detalle)
    return NextResponse.json({ ok: false, ...detalle }, { status: 200 })
  }
}

async function procesarInterno(body: Record<string, unknown>, bytes: number): Promise<Response> {
  const from = String(body.from || (body.sender as { address?: string } | undefined)?.address || "").trim()
  if (!from) {
    await rastro("fallo", { error: "from requerido", subject: String(body.subject || "").slice(0, 80), bytes })
    return NextResponse.json({ ok: false, error: "from requerido" }, { status: 200 })
  }
  const html = String(body.html || body.body || "")
  const text = String(body.text || body.bodyPreview || "")
  const rawAdj = body.attachments ?? body.adjuntos ?? body.Attachments
  const adjuntos = normalizarAdjuntos(rawAdj)
  // Rastro de la FORMA con que llega el campo (Power Automate manda [] con
  // "Incluir datos adjuntos" en No; un token entre comillas llega como string).
  const formaAdj =
    rawAdj === undefined ? "ausente"
    : Array.isArray(rawAdj) ? `array(${rawAdj.length})${rawAdj.length ? ` keys=${Object.keys((rawAdj[0] as Record<string, unknown>) || {}).join("|")}` : ""}`
    : typeof rawAdj === "string" ? `string(${rawAdj.length}) inicio=${JSON.stringify(rawAdj.slice(0, 60))}`
    : typeof rawAdj
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
  console.log(
    `[correo-entrante] from=${from} subject="${String(body.subject || "").slice(0, 60)}" adjuntos=${adjuntos.length} (campo: ${formaAdj})` +
      (adjuntos.length ? ` [${adjuntos.map((a) => `${a.nombre}|${a.tipo || "?"}|${a.bytes}b${a.inline ? "|inline" : ""}`).join(", ")}]` : "") +
      ` → ${r.veredicto}${r.origen ? ` (${r.origen})` : ""}${r.numero ? ` ${r.numero}` : ""}`,
  )
  await rastro(r.veredicto === "error" ? "fallo" : "ok", {
    veredicto: r.veredicto,
    from,
    subject: String(body.subject || "").slice(0, 80),
    adjuntos: adjuntos.length,
    campoAdjuntos: formaAdj,
    bytes,
    ...(r.veredicto === "error" ? { detalle: String((r as { detalle?: unknown }).detalle || "").slice(0, 300) } : {}),
  })
  return NextResponse.json({ ok: r.veredicto !== "error", adjuntosRecibidos: adjuntos.length, ...r }, { status: 200 })
}
