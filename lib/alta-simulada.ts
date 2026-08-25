/**
 * SIMULACIÓN del alta por API (Lalo 25-ago, "quiero simular la creación de
 * empresa por api, para eso simulemos este correo").
 *
 * Mientras la API de Nicolás esté caída (exists/create → 500 desde el 24-ago),
 * el piloto necesita ver la experiencia COMPLETA del alta exitosa: cuenta
 * "creada" al instante + el correo de bienvenida que la plataforma le manda al
 * administrador con su contraseña temporal (réplica del correo real de
 * no-reply@geovictoria.com, visto en el alta del 02-ago).
 *
 * DOBLE CANDADO — esto jamás puede tocar a un cliente real:
 *   1. vic_kv `alta_simulada` = "on" (interruptor global, apagable al tiro);
 *   2. el contacto debe estar en el PILOTO (vic_kv `onboarding_piloto`) — el
 *      caller (onboarding-canal) solo consulta la simulación tras ese chequeo.
 * La contraseña del correo es FALSA (no abre nada): si por algún resquicio
 * llegara donde no debe, el login simplemente falla.
 *
 * El correo sale por el mismo canal probado del dash-login: Zoho send_mail
 * anclado al contacto interno, from vicky@ (no-reply@ no es spoofeable desde
 * Zoho — diferencia conocida y aceptada para la simulación).
 */

import { randomBytes } from "node:crypto"
import { getZohoAccessToken } from "./zoho-token"

const ZOHO_API_DOMAIN = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
const FROM_EMAIL = (process.env.VICKY_FROM_EMAIL || "vicky@geovictoria.com").trim()
const MAIL_ANCHOR = (process.env.VIC_DASH_MAIL_ANCHOR || "Contacts/3525045000645054553").trim()

/** Contraseña temporal FALSA con la pinta de las reales (v3QSDtQm?RA*T67U). */
export function passwordSimulada(): string {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789"
  const simbolos = "?*!#"
  const bytes = randomBytes(16)
  let out = ""
  for (let i = 0; i < 14; i++) out += abc[bytes[i] % abc.length]
  // Un símbolo en medio, como las que genera la plataforma.
  const pos = 6 + (bytes[14] % 4)
  return out.slice(0, pos) + simbolos[bytes[15] % simbolos.length] + out.slice(pos)
}

function esc(s: string): string {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/** Réplica del correo de bienvenida de la plataforma (alta real del 02-ago). */
export async function enviarCorreoBienvenidaSimulado(admin: {
  nombre: string
  apellido: string
  email: string
}): Promise<{ ok: boolean; password: string }> {
  const password = passwordSimulada()
  const nombreCompleto = `${admin.nombre} ${admin.apellido}`.trim()
  const html = `<!DOCTYPE html><html lang="es"><body style="font-family:Georgia,serif;color:#2d3748;font-size:15px;line-height:1.7;margin:0;padding:24px;">
<div style="max-width:560px;margin:0 auto;text-align:center;">
  <p style="font-size:22px;color:#1a7ec2;margin:8px 0 2px;font-family:Segoe UI,Arial,sans-serif;"><b>GeoVictoria</b></p>
  <p style="font-size:10px;letter-spacing:2px;color:#a0aec0;margin:0 0 22px;font-family:Segoe UI,Arial,sans-serif;">GESTIÓN DE ASISTENCIA</p>
  <div style="background:#dbe6f1;border-radius:8px;padding:14px;margin:0 0 22px;">
    <b style="font-size:17px;color:#2d3748;">¡Bienvenido, ${esc(nombreCompleto)}!</b>
  </div>
  <p style="text-align:left;">Tu cuenta ha sido creada exitosamente.</p>
  <p style="text-align:left;">Ya puedes iniciar sesión con tu correo registrado.</p>
  <p style="text-align:center;margin:22px 0;"><b>Tu contraseña temporal es: ${esc(password)}</b></p>
  <p style="font-size:11px;color:#718096;margin-top:34px;">No responda a este correo. Comprobante generado automáticamente por GeoVictoria.</p>
  <p style="font-size:10px;color:#a0aec0;">Simulación de prueba del piloto Vicky Onboarding — esta contraseña no abre ninguna cuenta.</p>
</div>
</body></html>`

  try {
    const token = await getZohoAccessToken()
    const res = await fetch(`${ZOHO_API_DOMAIN}/crm/v3/${MAIL_ANCHOR}/actions/send_mail`, {
      method: "POST",
      headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        data: [
          {
            from: { email: FROM_EMAIL },
            to: [{ email: admin.email, user_name: nombreCompleto || admin.email }],
            subject: "¡Bienvenido a GeoVictoria! Tu cuenta ha sido creada",
            content: html,
            mail_format: "html",
          },
        ],
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      console.warn(`[alta-simulada] send_mail ${res.status} a ${admin.email}: ${body.slice(0, 200)}`)
      return { ok: false, password }
    }
    return { ok: true, password }
  } catch (e) {
    console.warn("[alta-simulada] correo falló:", e instanceof Error ? e.message : e)
    return { ok: false, password }
  }
}
