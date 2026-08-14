/**
 * Endpoint ADMIN: POST /api/vic-admin-adjuntar-comprobante
 *
 * Adjunta el comprobante de transferencia (imagen/PDF que el cliente mandó
 * por WhatsApp) al registro de la cotización en Zoho. Para rescates de pagos
 * que llegaron antes de que el flujo lo hiciera solo (03-ago).
 *
 * Body: { quoteId: string, mediaUrl?: string, contact?: string, horas?: number }
 *  - Con contenidoBase64: sube el archivo tal cual (comprobantes que el
 *    equipo tiene en su teléfono o correo, sin URL pública — Lalo 14-ago).
 *  - Con mediaUrl: descarga y adjunta esa URL.
 *  - Sin ninguno: busca el último archivo entrante del contacto en la API de
 *    Botmaker (ventana `horas`, default 6) y adjunta ese.
 *
 * Auth: header x-cron-secret == vic_kv.followup_cron_secret, o ?key=/Bearer ==
 * CRON_SECRET. Mismo modelo que el resto de endpoints admin.
 */

import { NextResponse } from "next/server"
import {
  adjuntarComprobanteACotizacion,
  adjuntarComprobanteBase64,
  mediaEntranteRecienteDebug,
} from "@/lib/comprobante-adjunto"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const CRON_SECRET = (process.env.CRON_SECRET || "").trim()

async function authorized(req: Request): Promise<boolean> {
  const xcron = (req.headers.get("x-cron-secret") || "").trim()
  if (xcron) {
    const expected = await getFollowupCronSecret().catch(() => "")
    if (expected && xcron === expected) return true
  }
  if (CRON_SECRET) {
    const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim()
    if (bearer === CRON_SECRET) return true
    const key = (new URL(req.url).searchParams.get("key") || "").trim()
    if (key === CRON_SECRET) return true
  }
  return false
}

export async function POST(req: Request): Promise<Response> {
  if (!(await authorized(req))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }
  let body: {
    quoteId?: string
    contenidoBase64?: string
    nombreArchivo?: string
    contentType?: string
    mediaUrl?: string
    contact?: string
    horas?: number
    desdeIso?: string
    hastaIso?: string
  } = {}
  try {
    body = (await req.json()) as typeof body
  } catch {
    return NextResponse.json({ ok: false, error: "body JSON inválido" }, { status: 400 })
  }
  const quoteId = (body.quoteId || "").trim()
  if (!quoteId) {
    return NextResponse.json({ ok: false, error: "quoteId requerido" }, { status: 400 })
  }
  // Archivo subido directo (sin URL pública): el camino de los comprobantes
  // que viven en el teléfono del ejecutivo o en el correo de finanzas.
  const base64 = (body.contenidoBase64 || "").trim()
  if (base64) {
    const r = await adjuntarComprobanteBase64(
      quoteId,
      base64,
      (body.nombreArchivo || "").trim() || "comprobante-transferencia.pdf",
      (body.contentType || "").trim() || "application/pdf",
    )
    return NextResponse.json(r, { status: r.ok ? 200 : 502 })
  }
  let mediaUrl = (body.mediaUrl || "").trim()
  let creationTime = ""
  if (!mediaUrl) {
    const contact = (body.contact || "").trim().replace(/\D/g, "")
    if (!contact) {
      return NextResponse.json(
        { ok: false, error: "contenidoBase64, mediaUrl o contact requerido" },
        { status: 400 },
      )
    }
    const bm = await mediaEntranteRecienteDebug(contact, Number(body.horas) || 6, {
      desdeIso: (body.desdeIso || "").trim() || undefined,
      hastaIso: (body.hastaIso || "").trim() || undefined,
    })
    if (!bm.top?.url) {
      return NextResponse.json(
        {
          ok: false,
          error: "no se encontró media entrante del contacto en Botmaker",
          diagnostico: {
            totalItems: bm.totalItems,
            delContacto: bm.delContacto,
            conMedia: bm.conMedia,
            kesMuestra: bm.kesMuestra,
            muestra: bm.muestra,
          },
        },
        { status: 404 },
      )
    }
    mediaUrl = bm.top.url
    creationTime = bm.top.creationTime
  }
  const resultado = await adjuntarComprobanteACotizacion(
    quoteId,
    mediaUrl,
    `comprobante-transferencia-${(body.contact || "").replace(/\D/g, "") || "cliente"}`,
  )
  return NextResponse.json(
    { ...resultado, mediaUrl, ...(creationTime ? { creationTime } : {}) },
    { status: resultado.ok ? 200 : 502 },
  )
}
