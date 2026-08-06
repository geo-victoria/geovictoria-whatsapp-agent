/**
 * Endpoint ADMIN: POST /api/vic-admin-enviar-cotizacion-wa
 *
 * Botón "Enviar por WhatsApp" de la cotización en Zoho (Deluge, pedido Lalo
 * 06-ago): Vicky le envía al cliente el PDF como ARCHIVO + el link de la
 * aceptación online, por la línea de WhatsApp de Vicky.
 *
 * Lee todo de la cotización en Zoho (teléfono, PDF_URL, URL_Aceptacion_Web,
 * número, empresa). Requiere ventana de 24h abierta (texto/media libre); si
 * Meta la tiene cerrada, el envío falla y se responde claro para que la
 * ejecutiva use el camino de plantilla.
 *
 * Body: { "quoteId": "<id Zoho>" }
 * Auth: x-cron-secret == vic_kv.followup_cron_secret, o ?key=/Bearer CRON_SECRET.
 */

import { NextResponse } from "next/server"
import { sendBotmakerMessage, sendBotmakerMedia } from "@/lib/botmaker-push-v3"
import { appendAssistantV3, getFollowupCronSecret } from "@/lib/supabase-persistence-v3"
import { getZohoAccessToken } from "@/lib/zoho-token"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const CRON_SECRET = (process.env.CRON_SECRET || "").trim()
const ZOHO_API_DOMAIN = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
const QUOTE_MODULE = (process.env.ZOHO_QUOTE_MODULE || "Cotizaciones_GeoVictoria").trim()

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

export async function POST(req: Request): Promise<Response> {
  if (!(await authorized(req))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }
  const body = (await req.json().catch(() => ({}))) as { quoteId?: string }
  const quoteId = (body.quoteId || "").trim()
  if (!quoteId) {
    return NextResponse.json({ ok: false, error: "Falta quoteId" }, { status: 400 })
  }

  const token = await getZohoAccessToken()
  const res = await fetch(`${ZOHO_API_DOMAIN}/crm/v3/${QUOTE_MODULE}/${quoteId}`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
    cache: "no-store",
  })
  const quote = ((await res.json().catch(() => null)) as {
    data?: Array<Record<string, unknown>>
  } | null)?.data?.[0]
  if (!quote) {
    return NextResponse.json({ ok: false, error: "Cotización no encontrada en Zoho" }, { status: 404 })
  }

  const telefono = String(quote.Tel_fono_Contacto || "").replace(/\D/g, "")
  const pdfUrl = String(quote.PDF_URL || "").trim()
  const acceptanceUrl = String(quote.URL_Aceptacion_Web || "").trim()
  const numero = String(quote.Numero_Cotizacion || "").trim()
  const empresa =
    String((quote.Cuenta_Asociada as { name?: string } | null)?.name || "").trim() ||
    String(quote.Name || "").trim()
  const contacto = String((quote.Contacto_Asociado as { name?: string } | null)?.name || "")
    .trim()
    .split(/\s+/)[0]

  if (!telefono) return NextResponse.json({ ok: false, error: "La cotización no tiene teléfono de contacto" }, { status: 400 })
  if (!acceptanceUrl) return NextResponse.json({ ok: false, error: "La cotización no tiene URL de aceptación" }, { status: 400 })

  const texto =
    `${contacto ? `${contacto}, te` : "Te"} comparto tu cotización ${numero ? `${numero} ` : ""}de GeoVictoria` +
    `${empresa ? ` para ${empresa}` : ""} 🙌\n\n` +
    `Aquí la revisas, aceptas y pagas en línea:\n${acceptanceUrl}\n\n` +
    `Te adjunto también el PDF. Cualquier duda o ajuste, me escribes por aquí 😊`

  const okTexto = await sendBotmakerMessage(telefono, texto)
  const okPdf = pdfUrl
    ? await sendBotmakerMedia(telefono, pdfUrl, {
        filename: `Cotizacion_GeoVictoria_${numero || quoteId}.pdf`,
        mimeType: "application/pdf",
      })
    : false

  if (!okTexto && !okPdf) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Botmaker rechazó el envío — lo más probable es que la ventana de 24h esté cerrada (el cliente no escribe hace más de un día). Pídele a Vicky que lo contacte por plantilla o espera a que el cliente escriba.",
      },
      { status: 502 },
    )
  }

  // Queda en el historial de la conversación para que Vicky tenga contexto.
  await appendAssistantV3(telefono, texto).catch(() => {})

  return NextResponse.json({ ok: true, telefono, textoEnviado: okTexto, pdfEnviado: okPdf, sinPdf: !pdfUrl })
}
