/**
 * ADMIN: reenvío MANUAL de la plantilla post-llamada (Dapta) — para cumplir
 * retroactivamente lo prometido en una llamada cuando el postcall no pudo
 * (caso 01-sep: la tormenta de tokens de Zoho botó el descuento telefónico y
 * los 2 interesados de la tanda quedaron sin su envío).
 *
 * POST auth cron: { contact, nombre, quoteId, precioClp, pctExacto? }
 *   - pctExacto > 0 → primero comitea el descuento telefónico en el cotizador
 *     (mismo endpoint determinista del postcall); si falla, NO se envía la
 *     plantilla (jamás prometer un precio no registrado).
 *   - luego manda la plantilla vicky_cotizacion_actualizada_llamada con
 *     {nombre, precio, codigo /q/ firmado}.
 */

import crypto from "crypto"
import { NextResponse } from "next/server"
import { sendBotmakerTemplate } from "@/lib/botmaker-push-v3"
import { appendAssistantV3, getFollowupCronSecret } from "@/lib/supabase-persistence-v3"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const CRON_SECRET = (process.env.CRON_SECRET || "").trim()
const COTIZADORA_API_BASE = (process.env.COTIZADORA_API_BASE || "https://cotizacion.geovictoria.com").trim()
const VICKY_COTIZADORA_SECRET = (process.env.VICKY_COTIZADORA_SECRET || "").trim()
const TPL_POSTCALL = (process.env.POSTCALL_TEMPLATE || "vicky_cotizacion_actualizada_llamada").trim()

async function authorized(req: Request): Promise<boolean> {
  const xcron = (req.headers.get("x-cron-secret") || "").trim()
  if (xcron) {
    const expected = await getFollowupCronSecret().catch(() => "")
    if (expected && xcron === expected) return true
  }
  if (CRON_SECRET) {
    const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim()
    if (bearer === CRON_SECRET) return true
  }
  return false
}

export async function POST(req: Request): Promise<Response> {
  if (!(await authorized(req))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }
  const body = (await req.json().catch(() => ({}))) as {
    contact?: string
    nombre?: string
    quoteId?: string
    precioClp?: number
    pctExacto?: number
  }
  const contact = String(body.contact || "").replace(/\D/g, "")
  const quoteId = String(body.quoteId || "").trim()
  const precioClp = Number(body.precioClp || 0)
  if (!contact || !quoteId || !(precioClp > 0)) {
    return NextResponse.json({ ok: false, error: "faltan contact/quoteId/precioClp" }, { status: 400 })
  }
  if (!VICKY_COTIZADORA_SECRET) {
    return NextResponse.json({ ok: false, error: "sin VICKY_COTIZADORA_SECRET" }, { status: 500 })
  }

  // 1) Descuento comiteado ANTES de prometer (mismo flujo del postcall).
  const pct = Number(body.pctExacto || 0)
  if (pct > 0) {
    const r = await fetch(`${COTIZADORA_API_BASE}/api/quote-acceptance/aplicar-descuento-telefonico`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-vicky-secret": VICKY_COTIZADORA_SECRET },
      body: JSON.stringify({ quoteId, pctExacto: pct }),
      cache: "no-store",
    }).catch(() => null)
    const data = (await r?.json().catch(() => null)) as { ok?: boolean; error?: string } | null
    if (!r?.ok || !data?.ok) {
      return NextResponse.json(
        { ok: false, error: `descuento no comiteado (${data?.error || r?.status}); plantilla NO enviada` },
        { status: 502 },
      )
    }
  }

  // 2) Plantilla con el código /q/ firmado (mismo cálculo del postcall).
  const codigo = `${quoteId}-${crypto.createHmac("sha256", VICKY_COTIZADORA_SECRET).update(quoteId).digest("hex").slice(0, 10)}`
  const enviada = await sendBotmakerTemplate(contact, TPL_POSTCALL, {
    nombre: String(body.nombre || "de nuevo").trim(),
    precio: precioClp.toLocaleString("es-CL"),
    codigo,
  }).catch(() => false)
  if (enviada) {
    await appendAssistantV3(
      contact,
      `[REGISTRO INTERNO — no visible para el cliente] Se envió la plantilla post-llamada con la cotización ` +
        `(precio $${precioClp.toLocaleString("es-CL")}${pct > 0 ? `, descuento ${pct}% comiteado` : ""}) — ` +
        `cumplimiento retroactivo de lo prometido en la llamada de hoy.`,
    ).catch(() => {})
  }
  console.log(`[admin-postcall-plantilla] contact=${contact} quote=${quoteId} pct=${pct} enviada=${enviada}`)
  return NextResponse.json({ ok: enviada, contact, quoteId, pctAplicado: pct || 0, codigo })
}
