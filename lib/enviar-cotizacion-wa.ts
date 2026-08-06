/**
 * Envío de una cotización por el WhatsApp de Vicky: PDF como ARCHIVO + link de
 * la aceptación online (botón "Enviar por WhatsApp" de Zoho, Lalo 06-ago).
 *
 * Dos caminos según la ventana de 24h de Meta:
 *  - ABIERTA: sale de inmediato (texto con el link + PDF adjunto).
 *  - CERRADA: sale la plantilla `vicky_loop_pago` y queda un PENDIENTE en
 *    vic_kv (`cot_wa_pendiente_<fono>`); cuando el cliente responde, el
 *    webhook consume el pendiente y el paquete completo sale solo.
 */

import { sendBotmakerMessage, sendBotmakerMedia, sendBotmakerTemplate } from "@/lib/botmaker-push-v3"
import { appendAssistantV3, getKvValue, setKvValue } from "@/lib/supabase-persistence-v3"
import { getZohoAccessToken, renovarZohoAccessToken } from "@/lib/zoho-token"

const ZOHO_API_DOMAIN = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
const QUOTE_MODULE = (process.env.ZOHO_QUOTE_MODULE || "Cotizaciones_GeoVictoria").trim()

type DatosCotizacion = {
  telefono: string
  pdfUrl: string
  acceptanceUrl: string
  numero: string
  empresa: string
  nombreContacto: string
}

export async function datosDeCotizacion(quoteId: string): Promise<DatosCotizacion | null> {
  const token = await getZohoAccessToken()
  // v3 exige `fields` en el GET de registro único (sin él responde 400).
  const campos =
    "Tel_fono_Contacto,PDF_URL,URL_Aceptacion_Web,Numero_Cotizacion,Name,Cuenta_Asociada,Contacto_Asociado"
  const url = `${ZOHO_API_DOMAIN}/crm/v3/${QUOTE_MODULE}/${quoteId}?fields=${campos}`
  let res = await fetch(url, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
    cache: "no-store",
  })
  if (res.status === 401) {
    // Token del caché revocado antes de su vencimiento → acuñar uno nuevo.
    const fresco = await renovarZohoAccessToken()
    res = await fetch(url, {
      headers: { Authorization: `Zoho-oauthtoken ${fresco}` },
      cache: "no-store",
    })
  }
  const cuerpo = await res.text().catch(() => "")
  let quote: Record<string, unknown> | undefined
  try {
    quote = (JSON.parse(cuerpo) as { data?: Array<Record<string, unknown>> })?.data?.[0]
  } catch {
    quote = undefined
  }
  if (!quote) {
    console.error(`[cot-wa] Zoho ${res.status} para quote ${quoteId}: ${cuerpo.slice(0, 300)}`)
    return null
  }
  return {
    telefono: String(quote.Tel_fono_Contacto || "").replace(/\D/g, ""),
    pdfUrl: String(quote.PDF_URL || "").trim(),
    acceptanceUrl: String(quote.URL_Aceptacion_Web || "").trim(),
    numero: String(quote.Numero_Cotizacion || "").trim(),
    empresa:
      String((quote.Cuenta_Asociada as { name?: string } | null)?.name || "").trim() ||
      String(quote.Name || "").trim(),
    nombreContacto: String((quote.Contacto_Asociado as { name?: string } | null)?.name || "")
      .trim()
      .split(/\s+/)[0],
  }
}

/** Envía el paquete (texto con link + PDF adjunto). Requiere ventana abierta. */
export async function enviarPaqueteCotizacion(
  d: DatosCotizacion,
  quoteId: string,
): Promise<{ ok: boolean; textoEnviado: boolean; pdfEnviado: boolean }> {
  const texto =
    `${d.nombreContacto ? `${d.nombreContacto}, te` : "Te"} comparto tu cotización ${d.numero ? `${d.numero} ` : ""}de GeoVictoria` +
    `${d.empresa ? ` para ${d.empresa}` : ""} 🙌\n\n` +
    `Aquí la revisas, aceptas y pagas en línea:\n${d.acceptanceUrl}\n\n` +
    `${d.pdfUrl ? "Te adjunto también el PDF. " : ""}Cualquier duda o ajuste, me escribes por aquí 😊`

  const textoEnviado = await sendBotmakerMessage(d.telefono, texto)
  const pdfEnviado = d.pdfUrl
    ? await sendBotmakerMedia(d.telefono, d.pdfUrl, {
        filename: `Cotizacion_GeoVictoria_${d.numero || quoteId}.pdf`,
        mimeType: "application/pdf",
      })
    : false
  if (textoEnviado) await appendAssistantV3(d.telefono, texto).catch(() => {})
  return { ok: textoEnviado || pdfEnviado, textoEnviado, pdfEnviado }
}

/** Deja el pendiente y dispara la plantilla de re-apertura de ventana. */
export async function programarEnvioConPlantilla(
  d: DatosCotizacion,
  quoteId: string,
): Promise<boolean> {
  const okTpl = await sendBotmakerTemplate(d.telefono, "vicky_loop_pago", {
    ...(d.nombreContacto ? { nombre: d.nombreContacto } : {}),
  })
  if (!okTpl) return false
  await setKvValue(`cot_wa_pendiente_${d.telefono}`, quoteId).catch(() => {})
  return true
}

/**
 * Consumo del pendiente al llegar un mensaje del cliente (lo llama el webhook,
 * fire-and-forget): si este contacto tenía un envío de cotización esperando la
 * re-apertura de ventana, sale ahora. El flag se limpia ANTES de enviar para
 * que dos mensajes seguidos no dupliquen el paquete.
 */
export async function consumirCotizacionPendiente(contact: string): Promise<void> {
  const fono = (contact || "").replace(/\D/g, "")
  if (!fono) return
  const key = `cot_wa_pendiente_${fono}`
  const quoteId = ((await getKvValue(key).catch(() => null)) || "").trim()
  if (!quoteId) return
  await setKvValue(key, "").catch(() => {})
  const datos = await datosDeCotizacion(quoteId).catch(() => null)
  if (!datos || !datos.telefono) return
  await enviarPaqueteCotizacion(datos, quoteId).catch(() => {})
  console.log(`[cot-wa] pendiente consumido: quote=${quoteId} contact=${fono}`)
}
