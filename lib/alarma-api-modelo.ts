/**
 * ALARMA DE LA API DEL MODELO (26-sep, causa de la ráfaga del 22-sep): entre
 * las 14:33 y las 16:14 CL la API de Anthropic rechazó TODAS las llamadas con
 * "You have reached your specified API usage limits" (tope de gasto mensual de
 * la cuenta) y Vicky respondió "tuve un problema procesando tu mensaje" a 26
 * clientes sin que nadie se enterara. Ahora un error de límite, cuota o
 * autenticación de la API dispara un correo inmediato (1 cada 30 min máx.).
 *
 * Best-effort: jamás lanza.
 */

const MAIL_ANCHOR = (process.env.VIC_DASH_MAIL_ANCHOR || "Contacts/3525045000645054553").trim()
const FROM_EMAIL = (process.env.VICKY_FROM_EMAIL || "vicky@geovictoria.com").trim()
const DESTINOS = (process.env.VICKY_ALARMA_API_TO || process.env.VICKY_CIERRE_TO || "egomez@geovictoria.com,rlewit@geovictoria.com")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)

/** ¿El error viene de la cuenta de la API (límite de gasto, cuota, credencial) y no del turno? */
export function esErrorDeCuentaApi(err: unknown): string {
  const txt = err instanceof Error ? `${err.message}` : String(err || "")
  if (/usage limits|spend(ing)? limit|credit balance|billing/i.test(txt)) return "limite_gasto"
  if (/rate_limit_error|rate limit/i.test(txt)) return "rate_limit"
  if (/authentication_error|invalid x-api-key|permission_error/i.test(txt)) return "credencial"
  return ""
}

export async function alarmarErrorApiModelo(err: unknown, contact: string): Promise<void> {
  try {
    const tipo = esErrorDeCuentaApi(err)
    if (!tipo || tipo === "rate_limit") return
    const { getKvValue, setKvValue } = await import("./supabase-persistence-v3")
    const previo = String((await getKvValue(`alarma_api_modelo_${tipo}`).catch(() => null)) || "")
    const ms = Date.parse(previo)
    if (Number.isFinite(ms) && Date.now() - ms < 30 * 60_000) return
    await setKvValue(`alarma_api_modelo_${tipo}`, new Date().toISOString()).catch(() => {})
    const detalle = (err instanceof Error ? err.message : String(err)).slice(0, 400)
    const titulo =
      tipo === "limite_gasto"
        ? "🚨 Vicky está MUDA: la API de Anthropic alcanzó el límite de gasto de la cuenta"
        : "🚨 Vicky está MUDA: la API de Anthropic rechaza la credencial"
    const qhacer =
      tipo === "limite_gasto"
        ? "Subir el límite de gasto (Usage limits) en console.anthropic.com para el workspace de Vicky. Mientras tanto cada cliente que escriba recibe un mensaje de error."
        : "Revisar la API key de Vicky (ANTHROPIC_API_KEY en Vercel) y el workspace en console.anthropic.com."
    const { avisarEquipoInterno } = await import("./alerta-interna")
    await avisarEquipoInterno(`${titulo}\nÚltimo contacto afectado: +${contact}\n${qhacer}\nError: ${detalle}`).catch(() => false)
    const { getZohoAccessToken } = await import("./zoho-token")
    const token = await getZohoAccessToken()
    const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
    const html =
      `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#1f2937">` +
      `<p><strong>${titulo}</strong></p><p>${qhacer}</p>` +
      `<p>Último contacto afectado: +${contact}</p>` +
      `<p style="color:#6b7280;font-size:12px">${detalle.replace(/</g, "&lt;")}</p></div>`
    await fetch(`${api}/crm/v3/${MAIL_ANCHOR}/actions/send_mail`, {
      method: "POST",
      headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        data: [
          {
            from: { email: FROM_EMAIL },
            to: DESTINOS.map((email) => ({ email })),
            subject: titulo,
            content: html,
            mail_format: "html",
          },
        ],
      }),
    }).catch(() => null)
    console.error(`[alarma-api] ${tipo}: correo enviado a ${DESTINOS.join(", ")}`)
  } catch {
    // no-op
  }
}
