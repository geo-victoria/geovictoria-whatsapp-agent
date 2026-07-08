/**
 * Correos de la cadencia outbound, enviados vía Zoho CRM (send_mail sobre el
 * registro del Lead): salen como vicky@geovictoria.com y quedan en el historial
 * de Emails del lead — mismo patrón que las notificaciones del cotizador.
 *
 * Los textos son los del playbook de prospección (docs/playbook-prospeccion-
 * outbound.md): empujan de vuelta al WhatsApp de Vicky. Best-effort siempre.
 */

import { getZohoAccessToken } from "./zoho-token"

const FROM_EMAIL = (process.env.VICKY_FROM_EMAIL || "vicky@geovictoria.com").trim()
// Línea conversacional de Vicky (Botmaker) — CTA de retorno de los correos.
const WA_LINK = "https://wa.me/56967308227"

function esc(s: string): string {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function shell(cuerpo: string): string {
  return `<!DOCTYPE html><html lang="es"><body style="font-family:Segoe UI,Arial,sans-serif;color:#2d3748;font-size:15px;line-height:1.6;">
${cuerpo}
<p style="margin:26px 0 0;color:#4a5568;">Vicky · GeoVictoria</p>
</body></html>`
}

function botonWhatsApp(texto: string): string {
  return `<p style="margin:18px 0;"><a href="${WA_LINK}" style="background:#25D366;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block;">${texto}</a></p>`
}

export function buildCorreoCadencia(
  touch: "e1" | "e2" | "e3",
  nombre: string,
  empresa: string,
): { subject: string; html: string } {
  const n = esc(nombre || "")
  const e = esc(empresa || "tu empresa")
  if (touch === "e1") {
    return {
      subject: "Tu cotización GeoVictoria está a un mensaje de distancia",
      html: shell(`<p>Hola ${n},</p>
<p>Recibimos tu solicitud de cotización para <b>${e}</b> — gracias por el interés 🙌. Te escribí también por WhatsApp para armarla al tiro: son 2 minutos y sales con el valor exacto para tu equipo.</p>
${botonWhatsApp("Armar mi cotización por WhatsApp")}
<p style="color:#4a5568;">Somos la plataforma de control de asistencia certificada por la Dirección del Trabajo que usan más de 6.000 empresas. Sin permanencia mínima.</p>`),
    }
  }
  if (touch === "e2") {
    return {
      subject: `${nombre ? `${nombre}, tu` : "Tu"} cotización sigue lista para armar`,
      html: shell(`<p>Hola ${n},</p>
<p>Sigo teniendo pendiente tu cotización para <b>${e}</b>. Te cuento lo que resuelve GeoVictoria desde el día uno:</p>
<ul style="padding-left:20px;">
  <li><b>Adiós planillas y libro de firmas</b>: la asistencia se registra sola (app, web o reloj).</li>
  <li><b>Reportes que se arman solos</b>: atrasos, horas extras y ausencias en un clic.</li>
  <li><b>Cumples la normativa DT</b> sin esfuerzo, con certificación oficial.</li>
</ul>
<p>Armarla toma 2 minutos por WhatsApp:</p>
${botonWhatsApp("Retomar mi cotización")}`),
    }
  }
  return {
    subject: "Dejamos tu cotización guardada",
    html: shell(`<p>Hola ${n},</p>
<p>No te quiero llenar la casilla: este es mi último correo por ahora 😊.</p>
<p>Tu solicitud para <b>${e}</b> queda guardada — cuando el momento sea el correcto, me escribes por WhatsApp y la armamos al tiro, sin partir de cero.</p>
${botonWhatsApp("Retomar cuando quieras")}
<p>¡Que te vaya muy bien!</p>`),
  }
}

/**
 * Envía un correo al lead desde su registro en Zoho (from = vicky@). Devuelve
 * { ok } y, si Zoho rechaza, el detalle del error — nunca lanza.
 */
export async function sendLeadEmail(
  leadId: string,
  toEmail: string,
  subject: string,
  html: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!leadId || !toEmail) return { ok: false, error: "leadId o email faltante" }
  try {
    const token = await getZohoAccessToken()
    const apiDomain = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
    const res = await fetch(
      `${apiDomain}/crm/v3/Leads/${encodeURIComponent(leadId)}/actions/send_mail`,
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
              to: [{ email: toEmail }],
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
      console.error(`[lead-mail] send_mail ${res.status} lead=${leadId}:`, body.slice(0, 300))
      return { ok: false, error: `${res.status}: ${body.slice(0, 250)}` }
    }
    return { ok: true }
  } catch (e) {
    console.error(`[lead-mail] excepción lead=${leadId}:`, e)
    return { ok: false, error: e instanceof Error ? e.message : "excepción" }
  }
}
