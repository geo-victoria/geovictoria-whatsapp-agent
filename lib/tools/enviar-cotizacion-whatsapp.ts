/**
 * Tool: enviar_cotizacion_whatsapp
 *
 * Manda el PDF de la cotización formal por el MISMO WhatsApp donde el cliente
 * está hablando, sin depender del correo.
 *
 * POR QUÉ (26-jul-2026): el correo con la cotización SÍ se entrega —lo
 * verificamos con 5 envíos de prueba por el stack productivo— pero cae en
 * Promociones (Gmail) o en Otros (Outlook), y el cliente que mira su bandeja
 * principal reporta "no me llegó". Entre junio y julio pasó con 10 contactos.
 * Peor: el registro de Zoho solo guarda status "sent", así que nadie puede
 * confirmarle nada. En vez de discutir dónde está el correo, se le entrega el
 * archivo por donde ya está conversando.
 */

import { getQuotePointers } from "@/lib/supabase-persistence-v3"
import { sendBotmakerMedia } from "@/lib/botmaker-push-v3"

export const enviarCotizacionWhatsappSchema = {
  name: "enviar_cotizacion_whatsapp",
  description:
    "Envía el PDF de la cotización formal por este mismo WhatsApp. Úsala cuando el cliente diga que NO le llegó el correo, cuando pida la cotización por WhatsApp, o cuando prefiera el archivo en vez del link. NO la uses para cotizaciones referenciales (esas no tienen PDF) ni antes de haber generado la formal. Copia el campo mensajeParaProspecto TAL CUAL: el archivo se envía aparte y ese texto lo acompaña.",
  input_schema: {
    type: "object" as const,
    properties: {
      quote_id: {
        type: "string" as const,
        description:
          "ID de la cotización formal a enviar. Omítelo para usar la más reciente de esta conversación.",
        maxLength: 80,
      },
    },
  },
}

export type EnviarCotizacionWhatsappResult =
  | { ok: true; mensajeParaProspecto: string }
  | { ok: false; error: string }

export async function enviarCotizacionWhatsapp(input: {
  quote_id?: string
  _contact?: string
}): Promise<EnviarCotizacionWhatsappResult> {
  const contact = String(input?._contact || "").trim()
  if (!contact) {
    return { ok: false, error: "No se pudo identificar el contacto de esta conversación." }
  }

  const punteros = await getQuotePointers(contact).catch(() => [])
  if (!punteros.length) {
    return {
      ok: false,
      error:
        "No hay una cotización formal en esta conversación. Genérala primero con generar_link_cotizadora.",
    }
  }

  const pedido = String(input?.quote_id || "").trim()
  const puntero = pedido ? punteros.find((p) => p.quoteId === pedido) : punteros[0]
  if (!puntero) {
    return { ok: false, error: `No encuentro la cotización ${pedido} en esta conversación.` }
  }
  if (!puntero.pdfUrl) {
    return {
      ok: false,
      error:
        "Esa cotización todavía no tiene PDF disponible. Ofrécele el link de aceptación mientras tanto.",
    }
  }

  // El nombre del archivo es lo que el cliente ve en WhatsApp: que diga de qué
  // empresa es, no "documento.pdf".
  const empresa = (puntero.empresa || "").trim().replace(/[^\p{L}\p{N} .-]/gu, "")
  const filename = empresa
    ? `Cotizacion GeoVictoria - ${empresa}.pdf`.slice(0, 100)
    : "Cotizacion GeoVictoria.pdf"

  const enviado = await sendBotmakerMedia(contact, puntero.pdfUrl, {
    filename,
    mimeType: "application/pdf",
  })

  if (!enviado) {
    return {
      ok: false,
      error:
        "No se pudo enviar el archivo por WhatsApp. NO le digas que se lo mandaste: ofrécele el link de la cotización.",
    }
  }

  return {
    ok: true,
    mensajeParaProspecto:
      "Te acabo de mandar la cotización acá mismo en PDF 📄 Así no dependes del correo. " +
      "Cualquier duda sobre lo que viene ahí, me dices.",
  }
}
