/**
 * CORREO DE INSTRUCCIONES DE INGRESO post-alta (Lalo 25-ago: "esto debería
 * automáticamente crear la empresa, entregar instrucciones para ingresar y
 * enviar el correo con la contraseña — busca referencias en las plantillas
 * GeoAvanzado de Zoho").
 *
 * Referencia: plantilla Zoho "IMP-2026_GeoAvanzado - Bienvenida y presentación
 * GENERICA SMB estándar" (id 3525045000655001095) — misma estructura (saludo,
 * pasos de ingreso, Manual del Administrador, acompañamiento) ADAPTADA al
 * flujo del alta por chat: aquí la contraseña temporal SÍ llega por correo de
 * la plataforma (no aplica el "olvidaste tu clave" del flujo GeoAvanzado), y
 * firma VICKY — el agente de onboarding no presenta personas (regla 26-jul).
 *
 * Se envía automático tras el alta EXITOSA (real por API o simulada), al
 * correo del administrador. Best-effort: jamás bloquea el alta.
 * Canal probado: Zoho send_mail anclado al contacto interno (mismo del dash).
 */

import { getZohoAccessToken } from "./zoho-token"

const ZOHO_API_DOMAIN = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
const FROM_EMAIL = (process.env.VICKY_FROM_EMAIL || "vicky@geovictoria.com").trim()
const MAIL_ANCHOR = (process.env.VIC_DASH_MAIL_ANCHOR || "Contacts/3525045000645054553").trim()
// Manual vigente: el mismo que linkea la plantilla GeoAvanzado (override por env).
const MANUAL_URL = (
  process.env.VICKY_MANUAL_ADMIN_URL ||
  "https://7742864.fs1.hubspotusercontent-na1.net/hubfs/7742864/Manual_Usuario_GeoVictoria_Demogva21082026.pdf"
).trim()
const LOGIN_URL = (process.env.VICKY_PLATAFORMA_LOGIN_URL || "https://advanced.geovictoria.com").trim()

function esc(s: string): string {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/**
 * DÓNDE QUEDA COLGADO EL CORREO (Lalo 15-sep, caso COTEL: "no lo veo en el
 * timeline de la implementación"). `send_mail` de Zoho exige un registro
 * ancla y el correo aparece en la lista Emails DE ESE registro. Hasta hoy todo
 * salía anclado al contacto interno de pruebas del dash (MAIL_ANCHOR), así que
 * el correo de bienvenida del cliente quedaba junto a los cierres diarios y
 * las alertas, en un contacto que nadie mira. Ahora el ancla se elige por
 * envío: la IMPLEMENTACIÓN cuando ya existe (es donde el relator mira), el
 * CONTACTO del cliente como respaldo, y el ancla de pruebas solo si no hay
 * ninguno de los dos.
 */
export type AnclaCorreo = string // "Implementaciones/<id>" | "Contacts/<id>"

/** kv: el correo de bienvenida de un contacto se manda UNA vez. */
export const claveCorreoBienvenida = (contact: string) => `onb_correo_bienvenida_${contact.replace(/\D/g, "")}`

/** Bienvenida + instrucciones de ingreso, estilo GeoAvanzado, firmada por Vicky. */
export async function enviarCorreoInstruccionesOnboarding(
  datos: {
    adminNombre: string
    adminEmail: string
    empresa: string
  },
  opts: { ancla?: AnclaCorreo } = {},
): Promise<boolean> {
  const ancla = (opts.ancla || MAIL_ANCHOR).replace(/^\/+|\/+$/g, "")
  const nombre = esc(datos.adminNombre || "")
  const html = `<!DOCTYPE html><html lang="es"><body style="margin:0;padding:0;background:#f3f6f9;font-family:Arial,Helvetica,sans-serif;color:#434343;font-size:14px;line-height:20px;">
<div style="max-width:600px;margin:0 auto;padding:24px 16px;">
  <div style="background:#ffffff;border:1px solid #e8eef4;border-radius:14px;padding:28px;">
    <p style="font-size:20px;color:#1a7ec2;margin:0 0 4px;"><b>GeoVictoria</b></p>
    <p style="font-size:10px;letter-spacing:2px;color:#a0aec0;margin:0 0 20px;">GESTIÓN DE ASISTENCIA</p>
    <h2 style="font-size:18px;line-height:24px;color:#2f2f2f;margin:0 0 12px;">¡Bienvenido/a ${nombre}!</h2>
    <p style="margin:0 0 12px;">La cuenta de <b>${esc(datos.empresa)}</b> ya está creada en GeoVictoria 🎉 Estoy feliz de acompañarte en esta etapa: mi objetivo es que uses la plataforma con seguridad y autonomía desde el primer día.</p>
    <p style="margin:0 0 8px;"><b>Para ingresar son 3 pasos:</b></p>
    <p style="margin:0 0 4px;">1&nbsp;&nbsp;Revisa tu correo: te llegó un mensaje de <b>no-reply@geovictoria.com</b> con tu contraseña temporal (si no aparece, mira en Promociones o Spam).</p>
    <p style="margin:0 0 4px;">2&nbsp;&nbsp;Entra a <a href="${LOGIN_URL}" style="color:#1a7ec2;">advanced.geovictoria.com</a> con tu correo y esa contraseña.</p>
    <p style="margin:0 0 16px;">3&nbsp;&nbsp;Cambia la contraseña por una tuya — y tu cuenta queda operativa.</p>
    <div style="background:#eef5fb;border-radius:10px;padding:14px 16px;margin:0 0 16px;">
      <p style="margin:0 0 6px;"><b>Tu manual, siempre contigo</b></p>
      <p style="margin:0 0 10px;">Revisa el Manual del Administrador y resuelve tus dudas cuando quieras, a tu ritmo.</p>
      <a href="${MANUAL_URL}" style="background:#1a7ec2;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;display:inline-block;">Manual del Administrador</a>
    </div>
    <p style="margin:0 0 12px;">Si en cualquier momento necesitas apoyo, escríbeme con confianza por el mismo WhatsApp donde hemos conversado. ¡Estoy aquí para ayudarte!</p>
    <p style="margin:18px 0 0;color:#4a5568;">Vicky · GeoVictoria<br/><a href="https://www.geovictoria.com" style="color:#1a7ec2;">www.geovictoria.com</a></p>
  </div>
</div>
</body></html>`

  const payload = JSON.stringify({
    data: [
      {
        from: { email: FROM_EMAIL },
        to: [{ email: datos.adminEmail, user_name: datos.adminNombre || datos.adminEmail }],
        subject: "¡Bienvenido a GeoVictoria! Así ingresas a tu cuenta",
        content: html,
        mail_format: "html",
      },
    ],
  })
  try {
    const token = await getZohoAccessToken()
    const enviar = async (desde: string): Promise<boolean> => {
      const res = await fetch(`${ZOHO_API_DOMAIN}/crm/v3/${desde}/actions/send_mail`, {
        method: "POST",
        headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
        body: payload,
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      })
      if (res.ok) return true
      const body = await res.text().catch(() => "")
      console.warn(`[onboarding-correos] instrucciones ${res.status} desde ${desde} a ${datos.adminEmail}: ${body.slice(0, 200)}`)
      return false
    }
    if (await enviar(ancla)) return true
    // El ancla elegida no aceptó el envío (módulo sin correo, id inválido…):
    // el cliente no puede quedarse sin instrucciones por dónde se cuelga el
    // correo — cae al ancla de siempre y se deja rastro de que cayó.
    if (ancla !== MAIL_ANCHOR.replace(/^\/+|\/+$/g, "")) {
      console.warn(`[onboarding-correos] reintento desde el ancla por defecto para ${datos.adminEmail}`)
      return await enviar(MAIL_ANCHOR)
    }
    return false
  } catch (e) {
    console.warn("[onboarding-correos] instrucciones falló:", e instanceof Error ? e.message : e)
    return false
  }
}

/**
 * Manda la bienvenida UNA sola vez por contacto, leyendo admin y empresa del
 * borrador del alta. Devuelve qué pasó; si ya se había mandado, no repite.
 * El ancla la decide el llamador (implementación recién creada, o contacto).
 */
export async function enviarBienvenidaDesdeBorrador(
  contact: string,
  opts: { ancla?: AnclaCorreo; motivo?: string } = {},
): Promise<{ enviado: boolean; yaEstaba?: boolean; ancla?: string; error?: string }> {
  const { getKvValue, setKvValue } = await import("./supabase-persistence-v3")
  const { claveBorrador } = await import("./onboarding/fase")
  const c = contact.replace(/\D/g, "")
  const previo = await getKvValue(claveCorreoBienvenida(c)).catch(() => null)
  if (previo) return { enviado: false, yaEstaba: true }
  const raw = await getKvValue(claveBorrador(c)).catch(() => null)
  let b: { empresa?: { nombre?: string }; admin?: { nombre?: string; apellido?: string; email?: string } } | null = null
  try {
    b = raw ? (JSON.parse(raw) as typeof b) : null
  } catch {
    b = null
  }
  const email = String(b?.admin?.email || "").trim()
  if (!email) return { enviado: false, error: "sin correo de administrador en el borrador" }
  const ancla = (opts.ancla || MAIL_ANCHOR).replace(/^\/+|\/+$/g, "")
  const ok = await enviarCorreoInstruccionesOnboarding(
    {
      adminNombre: `${b?.admin?.nombre || ""} ${b?.admin?.apellido || ""}`.trim(),
      adminEmail: email,
      empresa: String(b?.empresa?.nombre || ""),
    },
    { ancla },
  )
  if (ok) {
    await setKvValue(
      claveCorreoBienvenida(c),
      JSON.stringify({ at: new Date().toISOString(), ancla, motivo: opts.motivo || "", email }),
    ).catch(() => {})
  }
  return { enviado: ok, ancla }
}
