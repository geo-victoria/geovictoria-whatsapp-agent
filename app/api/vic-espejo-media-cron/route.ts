/**
 * LECTOR DE MEDIA DEL ESPEJO (Lalo 21-ago, "quiero que los chats espejos
 * puedan leer los mismos medios que Vicky, archivos, fotos, audios").
 *
 * El worker del espejo YA DESCARGA la media de los WhatsApp de los vendedores
 * al bucket `wa-espejo` (241 imágenes, 343 audios, 165 documentos al 21-ago)
 * — pero nadie la LEÍA: media_texto llevaba 0 filas pobladas y por eso los
 * comprobantes de transferencia que llegan como foto al WhatsApp del
 * ejecutivo eran invisibles (ceguera estructural detectada el 20-ago).
 *
 * Este cron toma los mensajes con media sin leer y les aplica LOS MISMOS
 * lectores que usa Vicky en el chat: `describirImagen` (visión Haiku,
 * imagen y PDF — incluye extracción de monto/banco/fecha en comprobantes)
 * y `transcribirAudio` (ElevenLabs Scribe). El resultado queda en
 * `media_texto` + `media_leido_at`, consultable por las notas del espejo,
 * el candado v3 y cualquier auditoría de pagos.
 *
 * Reintentos: un fallo transitorio NO marca la fila; tras 3 intentos
 * (contador vic_kv `emr_<id>`, TTL 7d) se estampa "(ilegible)" para no
 * reintentar eternamente archivos rotos.
 *
 * Declarado en vercel.json Y en JOBS_HUERFANOS (regla del 10-ago: el
 * scheduler de Vercel corre contra master viejo — el despachador es quien
 * lo late de verdad).
 */

import { NextResponse } from "next/server"
import { describirImagen } from "@/lib/describe-image"
import { transcribirAudio } from "@/lib/transcribe-audio"
import { getFollowupCronSecret, getQuotePointers } from "@/lib/supabase-persistence-v3"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const CRON_SECRET = (process.env.CRON_SECRET || "").trim()
const BUCKET = "wa-espejo"
const MAX_TEXTO = 4000
const MAX_INTENTOS = 3

function hSb(): Record<string, string> {
  return { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" }
}

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

/** URL firmada (5 min) para que los lectores de Vicky descarguen del bucket. */
async function firmarUrl(path: string): Promise<string> {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${path}`, {
    method: "POST",
    headers: hSb(),
    body: JSON.stringify({ expiresIn: 300 }),
    cache: "no-store",
  })
  if (!r.ok) return ""
  const j = (await r.json().catch(() => ({}))) as { signedURL?: string }
  return j.signedURL ? `${SUPABASE_URL}/storage/v1${j.signedURL}` : ""
}

async function intentosDe(id: string): Promise<number> {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/vic_kv?key=eq.${encodeURIComponent(`emr_${id}`)}&select=value&limit=1`,
    { headers: hSb(), cache: "no-store" },
  ).catch(() => null)
  const rows = r?.ok ? ((await r.json().catch(() => [])) as Array<{ value?: string }>) : []
  return Number(rows[0]?.value || 0) || 0
}

async function marcarIntento(id: string, n: number): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/vic_kv?on_conflict=key`, {
    method: "POST",
    headers: { ...hSb(), Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      key: `emr_${id}`,
      value: String(n),
      expires_at: new Date(Date.now() + 7 * 86400e3).toISOString(),
    }),
    cache: "no-store",
  }).catch(() => undefined)
}

/**
 * COMPROBANTES EN EL ESPEJO (reparado 25-ago, caso Carlos/COT776): el lector
 * original del 07-ago (vic-wa-espejo-lector) marcaba Pagada + adjuntaba +
 * avisaba a cobranza, pero este cron (21-ago) lo reemplazó en el despachador
 * SIN portar ese branch — y al marcar media_leido_at le quitó las filas al
 * viejo. Ceguera reintroducida; acá vuelve la maquinaria completa.
 * Conservador: exige palabra de pago Y señal de monto/operación.
 */
function pareceComprobante(texto: string): boolean {
  return (
    /(comprobante|transferencia|transacci[oó]n|dep[oó]sito|abono|pago\s+(exitoso|realizado|enviado|recibido))/i.test(texto) &&
    /(\$\s?[\d.]{4,}|CLP|\bmonto\b|n[°º]?\s*(de\s*)?operaci[oó]n|n[°º]?\s*(de\s*)?transacci[oó]n)/i.test(texto)
  )
}

async function procesarComprobanteEspejo(
  f: { session_id?: string | null; telefono_chat?: string | null; media_path: string },
  texto: string,
): Promise<string> {
  const fono = (f.telefono_chat || "").replace(/\D/g, "")
  if (!fono) return "sin_telefono"
  const pointers = await getQuotePointers(fono).catch(() => [])
  const pointer = pointers[0]
  if (!pointer?.quoteId) return "sin_cotizacion_vigente"
  const { marcarCotizacionPagada } = await import("@/lib/tools/registrar-comprobante-transferencia")
  const { adjuntarComprobanteACotizacion } = await import("@/lib/comprobante-adjunto")
  const { enviarCorreoCobranza } = await import("@/lib/correo-cobranza")
  const { sincronizarHitoCrm } = await import("@/lib/crm-hitos")
  await marcarCotizacionPagada(pointer.quoteId).catch(() => false)
  const url = await firmarUrl(f.media_path).catch(() => "")
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
    detalle: `Comprobante detectado automáticamente en el WhatsApp del EJECUTIVO (espejo "${f.session_id || "?"}"). Texto leído del archivo:\n\n${texto.slice(0, 900)}`,
    comprobanteUrl: url || undefined,
    advertencia:
      "Llegó al WhatsApp del ejecutivo, no al canal de Vicky. La cotización quedó Pagada y el deal en Listo para Cierre por lectura automática — validar el abono en el banco.",
  }).catch(() => ({ ok: false }))
  console.log(`[espejo-media] comprobante de +${fono} → quote ${pointer.quoteId} Pagada + deal a piso 6`)
  return "crm_actualizado"
}

async function guardar(id: string, texto: string): Promise<boolean> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/vic_wa_espejo_mensajes?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { ...hSb(), Prefer: "return=minimal" },
    body: JSON.stringify({ media_texto: texto.slice(0, MAX_TEXTO), media_leido_at: new Date().toISOString() }),
    cache: "no-store",
  }).catch(() => null)
  return Boolean(r?.ok)
}

export async function GET(req: Request): Promise<Response> {
  if (!(await authorized(req))) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  const { searchParams } = new URL(req.url)
  const limit = Math.min(Math.max(Number(searchParams.get("limit") || 8) || 8, 1), 20)

  // REPROCESO MANUAL (?fila=<id>): re-lee una fila específica aunque ya esté
  // marcada como leída y corre el branch de comprobantes — para casos que el
  // cron procesó cuando este endpoint aún no sabía de comprobantes (ceguera
  // 21→25-ago). Devuelve además una URL firmada corta para revisión humana.
  // OJO: repetirlo duplica el adjunto en Zoho — usar una vez por fila.
  const filaId = (searchParams.get("fila") || "").trim()
  if (filaId) {
    const fr = await fetch(
      `${SUPABASE_URL}/rest/v1/vic_wa_espejo_mensajes?id=eq.${encodeURIComponent(filaId)}&select=id,tipo,media_path,media_mime,telefono_chat,session_id,from_me&limit=1`,
      { headers: hSb(), cache: "no-store" },
    )
    const fila = (((await fr.json().catch(() => [])) as Array<{
      id: string
      tipo: string
      media_path: string | null
      telefono_chat: string | null
      session_id: string | null
      from_me: boolean
    }>) || [])[0]
    const mediaPath = fila?.media_path || ""
    if (!fila || !mediaPath) return NextResponse.json({ ok: false, error: "fila sin media" }, { status: 404 })
    const url = await firmarUrl(mediaPath)
    if (!url) return NextResponse.json({ ok: false, error: "no se pudo firmar la media" }, { status: 500 })
    const texto = fila.tipo === "audio" ? await transcribirAudio(url) : await describirImagen(url)
    let resultado = ""
    if (texto.trim() && !fila.from_me && fila.tipo !== "audio" && pareceComprobante(texto)) {
      resultado = await procesarComprobanteEspejo(
        { session_id: fila.session_id, telefono_chat: fila.telefono_chat, media_path: mediaPath },
        texto,
      ).catch(() => "error_crm")
    }
    if (texto.trim()) await guardar(fila.id, (resultado ? `[comprobante:${resultado}] ` : "") + texto)
    const urlDescarga = await firmarUrl(mediaPath)
    return NextResponse.json({ ok: true, fila: fila.id, resultado: resultado || "sin_comprobante", texto: texto.slice(0, 1500), urlDescarga })
  }

  // Pendientes: media descargada, jamás leída. Los más NUEVOS primero — un
  // comprobante de ayer vale más que un sticker de julio; el backlog viejo
  // se drena igual con los ticks.
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/vic_wa_espejo_mensajes?select=id,tipo,media_path,media_mime,telefono_chat,autor,session_id,from_me&media_path=not.is.null&media_leido_at=is.null&tipo=in.(imagen,documento,audio)&order=recibido_at.desc&limit=${limit * 3}`,
    { headers: hSb(), cache: "no-store" },
  )
  if (!r.ok) return NextResponse.json({ ok: false, error: `supabase ${r.status}` }, { status: 500 })
  const filas = (await r.json().catch(() => [])) as Array<{
    id: string
    tipo: string
    media_path: string
    media_mime?: string | null
    telefono_chat?: string | null
    session_id?: string | null
    from_me?: boolean
  }>

  const out = { leidos: 0, ilegibles: 0, saltados: 0, comprobantes: 0, errores: [] as string[] }
  for (const f of filas) {
    if (out.leidos >= limit) break
    try {
      const intentos = await intentosDe(f.id)
      if (intentos >= MAX_INTENTOS) {
        // Archivo que nunca pudo leerse: se cierra para no reintentar eterno.
        if (await guardar(f.id, "(ilegible)")) out.ilegibles++
        continue
      }
      const url = await firmarUrl(f.media_path)
      if (!url) {
        await marcarIntento(f.id, intentos + 1)
        out.saltados++
        continue
      }
      const texto = f.tipo === "audio" ? await transcribirAudio(url) : await describirImagen(url)
      if (!texto.trim()) {
        await marcarIntento(f.id, intentos + 1)
        out.saltados++
        continue
      }
      // Comprobante de pago del CLIENTE (jamás archivos que envía el propio
      // ejecutivo) → cotización Pagada + adjunto + deal a piso 6 + cobranza.
      let resultadoCrm = ""
      if (!f.from_me && f.tipo !== "audio" && pareceComprobante(texto)) {
        resultadoCrm = await procesarComprobanteEspejo(f, texto).catch(() => "error_crm")
        if (resultadoCrm === "crm_actualizado") out.comprobantes++
      }
      if (await guardar(f.id, (resultadoCrm ? `[comprobante:${resultadoCrm}] ` : "") + texto)) out.leidos++
    } catch (e) {
      out.errores.push(`${f.id}: ${e instanceof Error ? e.message.slice(0, 60) : "err"}`)
    }
  }

  const quedanRes = await fetch(
    `${SUPABASE_URL}/rest/v1/vic_wa_espejo_mensajes?select=id&media_path=not.is.null&media_leido_at=is.null&tipo=in.(imagen,documento,audio)&limit=1`,
    { headers: { ...hSb(), Prefer: "count=exact" }, cache: "no-store" },
  ).catch(() => null)
  const quedan = Number((quedanRes?.headers.get("content-range") || "").split("/")[1] || -1)

  console.log(`[espejo-media] leidos=${out.leidos} ilegibles=${out.ilegibles} saltados=${out.saltados} quedan=${quedan}`)
  return NextResponse.json({ ok: true, ...out, quedan })
}
