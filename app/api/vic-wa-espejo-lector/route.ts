/**
 * CRON: GET /api/vic-wa-espejo-lector
 *
 * Lector de media del espejo de WhatsApp de los ejecutivos (pedido Lalo
 * 07-ago: "los WhatsApp de ejecutivos conectados a Railway deben poder leer
 * audios e imágenes, para leer los comprobantes de pago").
 *
 * El worker wa-espejo (Railway) sube imágenes/audios/documentos al bucket
 * privado `wa-espejo` y deja media_path en vic_wa_espejo_mensajes. Este cron
 * toma las filas sin leer y las convierte a texto:
 *   - imagen/documento (fotos de comprobantes, PDFs) → describirImagen
 *     (visión Claude: descripción fiel + texto extraído — montos, fechas,
 *     N° de operación).
 *   - audio (notas de voz) → transcribirAudio (ElevenLabs Scribe).
 * El resultado queda en media_texto; el dashboard y cualquier consumidor del
 * espejo leen el contenido como si fuera texto del chat.
 *
 * Best-effort y barato: procesa hasta `limit` por corrida (default 8), las
 * ilegibles quedan marcadas para no reintentarlas infinito.
 */

import { NextResponse } from "next/server"
import { describirImagen } from "@/lib/describe-image"
import { transcribirAudio } from "@/lib/transcribe-audio"
import { getFollowupCronSecret, getQuotePointers } from "@/lib/supabase-persistence-v3"
import { marcarCotizacionPagada } from "@/lib/tools/registrar-comprobante-transferencia"
import { adjuntarComprobanteACotizacion } from "@/lib/comprobante-adjunto"
import { enviarCorreoCobranza } from "@/lib/correo-cobranza"
import { sincronizarHitoCrm } from "@/lib/crm-hitos"

export const dynamic = "force-dynamic"
export const maxDuration = 120

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim().replace(/\/$/, "")
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const CRON_SECRET = (process.env.CRON_SECRET || "").trim()

const H = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }

async function authorized(req: Request): Promise<boolean> {
  const url = new URL(req.url)
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim()
  const key = (url.searchParams.get("key") || "").trim()
  if (CRON_SECRET && (bearer === CRON_SECRET || key === CRON_SECRET)) return true
  const xcron = (req.headers.get("x-cron-secret") || "").trim()
  if (xcron || key) {
    const expected = await getFollowupCronSecret().catch(() => "")
    if (expected && (xcron === expected || key === expected)) return true
  }
  return false
}

/** URL firmada temporal del bucket privado (describir/transcribir hacen fetch sin headers). */
async function signedUrl(path: string): Promise<string> {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/wa-espejo/${path}`, {
    method: "POST",
    headers: { ...H, "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({ expiresIn: 600 }),
  })
  if (!r.ok) return ""
  const data = (await r.json().catch(() => ({}))) as { signedURL?: string }
  return data.signedURL ? `${SUPABASE_URL}/storage/v1${data.signedURL}` : ""
}

type Fila = {
  id: number
  tipo: string
  media_path: string
  session_id: string
  telefono_chat: string | null
  from_me: boolean
}

/** ¿El texto leído parece un comprobante de pago? Conservador: exige palabra
 * de pago Y señal de monto/operación — un menú fotografiado no debe marcar
 * nada como pagado. */
function pareceComprobante(texto: string): boolean {
  return (
    /(comprobante|transferencia|transacci[oó]n|dep[oó]sito|abono|pago\s+(exitoso|realizado|enviado|recibido))/i.test(texto) &&
    /(\$\s?[\d.]{4,}|CLP|\bmonto\b|n[°º]?\s*(de\s*)?operaci[oó]n|n[°º]?\s*(de\s*)?transacci[oó]n)/i.test(texto)
  )
}

/**
 * Comprobante detectado en el WhatsApp de un EJECUTIVO (orden Lalo 07-ago):
 * la cotización vigente del contacto queda "Pagada", el deal sube a
 * "6. Listo para Cierre" (hito aceptada, vía Blueprint y con los candados de
 * crm-hitos), el archivo queda adjunto en la cotización y finanzas recibe el
 * correo de cobranza para validar el abono. Todo best-effort: nada de esto
 * toca la conversación del cliente.
 */
async function procesarComprobanteEspejo(f: Fila, texto: string): Promise<string> {
  const fono = (f.telefono_chat || "").replace(/\D/g, "")
  if (!fono) return "sin_telefono"
  const pointers = await getQuotePointers(fono).catch(() => [])
  const pointer = pointers[0]
  if (!pointer?.quoteId) return "sin_cotizacion_vigente"
  await marcarCotizacionPagada(pointer.quoteId).catch(() => false)
  const url = await signedUrl(f.media_path).catch(() => "")
  if (url) {
    await adjuntarComprobanteACotizacion(pointer.quoteId, url, `comprobante-espejo-${fono}`).catch(() => ({ ok: false }))
  }
  await sincronizarHitoCrm(fono, "aceptada", {}).catch(() => undefined)
  await enviarCorreoCobranza({
    quoteId: pointer.quoteId,
    empresa: pointer.empresa,
    rut: pointer.rut,
    telefono: fono,
    monto: "ver comprobante adjunto",
    detalle: `Comprobante detectado automáticamente en el WhatsApp del EJECUTIVO (espejo "${f.session_id}"). Texto leído del archivo:\n\n${texto.slice(0, 900)}`,
    comprobanteUrl: url || undefined,
    advertencia:
      "Llegó al WhatsApp del ejecutivo, no al canal de Vicky. La cotización quedó Pagada y el deal en Listo para Cierre por lectura automática — validar el abono en el banco.",
  }).catch(() => ({ ok: false }))
  console.log(`[wa-espejo-lector] comprobante de +${fono} → quote ${pointer.quoteId} Pagada + deal a piso 6`)
  return "crm_actualizado"
}

export async function GET(req: Request): Promise<Response> {
  if (!(await authorized(req))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }
  const limit = Math.min(
    Math.max(parseInt(new URL(req.url).searchParams.get("limit") || "8", 10) || 8, 1),
    25,
  )
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/vic_wa_espejo_mensajes` +
      `?media_path=not.is.null&media_texto=is.null&es_grupo=eq.false&select=id,tipo,media_path,session_id,telefono_chat,from_me` +
      `&order=enviado_at.desc&limit=${limit}`,
    { headers: H, cache: "no-store" },
  )
  const filas = ((await r.json().catch(() => [])) || []) as Fila[]

  let leidas = 0
  let ilegibles = 0
  let comprobantes = 0
  for (const f of filas) {
    let texto = ""
    try {
      const url = await signedUrl(f.media_path)
      if (url) {
        texto =
          f.tipo === "audio"
            ? await transcribirAudio(url)
            : await describirImagen(url) // imagen y documento (PDF)
      }
    } catch (e) {
      console.warn(`[wa-espejo-lector] fila ${f.id} falló:`, e instanceof Error ? e.message : e)
    }
    // Sin texto → se marca ilegible (no reintentar infinito; el archivo queda
    // en Storage por si un humano quiere verlo).
    const valor = texto.trim() || "(no se pudo leer el archivo)"
    if (texto.trim()) leidas++
    else ilegibles++
    // Comprobante de pago del CLIENTE (nunca archivos que envía el propio
    // ejecutivo) → actualiza cotización y deal.
    let resultadoCrm = ""
    if (texto.trim() && !f.from_me && f.tipo !== "audio" && pareceComprobante(texto)) {
      resultadoCrm = await procesarComprobanteEspejo(f, texto).catch(() => "error_crm")
      if (resultadoCrm === "crm_actualizado") comprobantes++
    }
    await fetch(`${SUPABASE_URL}/rest/v1/vic_wa_espejo_mensajes?id=eq.${f.id}`, {
      method: "PATCH",
      headers: { ...H, "Content-Type": "application/json" },
      body: JSON.stringify({
        media_texto: (resultadoCrm ? `[comprobante:${resultadoCrm}] ` : "") + valor.slice(0, 8000),
        media_leido_at: new Date().toISOString(),
      }),
    }).catch(() => {})
  }

  return NextResponse.json({ ok: true, pendientes: filas.length, leidas, ilegibles, comprobantes })
}
