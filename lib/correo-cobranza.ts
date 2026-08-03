/**
 * Correo a cobranza cuando llega un pago por transferencia (petición Lalo
 * 03-ago): el comprobante que el cliente manda por WhatsApp deja de vivir solo
 * en la nota de Zoho y el aviso interno — cobranza recibe un correo con el
 * detalle (número de cotización, empresa, RUT, quién pagó, monto, banco,
 * fecha) y el link al comprobante cuando lo tenemos.
 *
 * Se envía vía Zoho send_mail SOBRE el registro de la cotización (mismo patrón
 * que el correo de cotización del cotizador), así queda en el historial de
 * Emails de la cotización. Best-effort: nunca lanza, y su falla no toca la
 * conversación con el cliente.
 */

import { getZohoAccessToken } from "./zoho-token"

const QUOTE_MODULE = (process.env.ZOHO_QUOTE_MODULE || "Cotizaciones_GeoVictoria").trim()
const ZOHO_API_DOMAIN = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
const FROM_EMAIL = (process.env.VICKY_FROM_EMAIL || "vicky@geovictoria.com").trim()
const COBRANZA_EMAIL = (process.env.COBRANZA_EMAIL || "cobranza@geovictoria.com").trim()

function esc(s: string): string {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

export type DatosCobranza = {
  quoteId: string
  numeroCotizacion?: string
  empresa?: string
  rut?: string
  comprador?: string
  telefono?: string
  monto?: string
  banco?: string
  fecha?: string
  detalle?: string
  comprobanteUrl?: string
  /** Nota extra para cobranza (ej. asociación cruzada de números). */
  advertencia?: string
}

export function buildCorreoCobranza(d: DatosCobranza): { subject: string; html: string } {
  const filas: Array<[string, string]> = [
    ["Cotización", d.numeroCotizacion || d.quoteId],
    ["Empresa", d.empresa || "-"],
    ["RUT", d.rut || "-"],
    ["Pagó / envió el comprobante", [d.comprador, d.telefono ? `+${d.telefono}` : ""].filter(Boolean).join(" · ") || "-"],
    ["Monto según comprobante", d.monto || "no legible"],
    ["Banco origen", d.banco || "-"],
    ["Fecha transferencia", d.fecha || "-"],
  ]
  const tabla = filas
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 14px 6px 0;color:#718096;white-space:nowrap;">${esc(k)}</td><td style="padding:6px 0;font-weight:600;">${esc(v)}</td></tr>`,
    )
    .join("")
  const html = `<!DOCTYPE html><html lang="es"><body style="font-family:Segoe UI,Arial,sans-serif;color:#2d3748;font-size:15px;line-height:1.6;">
<p>Llegó un pago por transferencia vía WhatsApp (Vicky):</p>
<table style="border-collapse:collapse;margin:8px 0 14px;">${tabla}</table>
${d.detalle ? `<p style="color:#4a5568;"><b>Detalle del comprobante:</b> ${esc(d.detalle)}</p>` : ""}
${
  d.comprobanteUrl
    ? `<p><a href="${esc(d.comprobanteUrl)}" style="color:#1a73e8;">Ver comprobante</a> (link temporal de WhatsApp — descargar al revisar)</p>`
    : `<p style="color:#4a5568;">El comprobante está en el chat de WhatsApp del contacto y su detalle en la nota de la cotización en Zoho.</p>`
}
${d.advertencia ? `<p style="color:#b7791f;"><b>⚠️ ${esc(d.advertencia)}</b></p>` : ""}
<p style="color:#4a5568;">La cotización <b>NO</b> fue marcada como pagada automáticamente: falta verificar el abono en el banco. Al cliente ya se le confirmó la recepción${d.comprobanteUrl || d.monto ? " y, si el comprobante era legible, se le habilitó la configuración (validación blanda)" : ""}.</p>
<p style="margin:26px 0 0;color:#4a5568;">Vicky · GeoVictoria</p>
</body></html>`
  return {
    subject: `Pago por transferencia — ${d.numeroCotizacion || "cotización"} · ${d.empresa || ""}`.trim(),
    html,
  }
}

export async function enviarCorreoCobranza(d: DatosCobranza): Promise<{ ok: boolean; error?: string }> {
  if (!d.quoteId) return { ok: false, error: "quoteId faltante" }
  try {
    const { subject, html } = buildCorreoCobranza(d)
    const token = await getZohoAccessToken()
    const res = await fetch(
      `${ZOHO_API_DOMAIN}/crm/v3/${QUOTE_MODULE}/${encodeURIComponent(d.quoteId)}/actions/send_mail`,
      {
        method: "POST",
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          "Content-Type": "application/json",
        },
        cache: "no-store",
        body: JSON.stringify({
          data: [
            {
              from: { email: FROM_EMAIL },
              to: [{ email: COBRANZA_EMAIL }],
              subject,
              content: html,
              mail_format: "html",
            },
          ],
        }),
      },
    )
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      console.error(`[cobranza-mail] send_mail ${res.status} quote=${d.quoteId}:`, body.slice(0, 300))
      return { ok: false, error: `${res.status}: ${body.slice(0, 250)}` }
    }
    console.log(`[cobranza-mail] enviado quote=${d.quoteId} a ${COBRANZA_EMAIL}`)
    return { ok: true }
  } catch (e) {
    console.error(`[cobranza-mail] excepción quote=${d.quoteId}:`, e)
    return { ok: false, error: e instanceof Error ? e.message : "excepción" }
  }
}
