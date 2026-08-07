/**
 * Login por CORREO + CÓDIGO para el dash de gestión (pedido Lalo 07-ago).
 *
 * Piloto en /oportunidades2 (proxy del cotizador con ?portal=correo): el
 * ejecutivo ingresa su correo corporativo, recibe un código de 6 dígitos por
 * email y recién con el código entra — la app sabe QUIÉN entró (identidad =
 * su ficha de usuario en Zoho) y solo le muestra SUS registros. Los correos
 * de VIC_DASH_ADMINS entran como "Administrador" (ven todo).
 *
 * Mecánica:
 *  - El correo debe pertenecer a un usuario ACTIVO de Zoho (misma fuente que
 *    nombres/teléfonos del resto del sistema). Nada de listas a mano.
 *  - Código: 6 dígitos, hash sha256 en vic_kv (TTL 10 min), máx 5 intentos,
 *    re-envío con rate limit de 60 s.
 *  - El correo del código sale por Zoho send_mail anclado a un registro
 *    interno (mismo canal probado de los correos de cobranza/traspaso).
 */

import { createHash } from "crypto"
import { getKvValue, setKvValue } from "@/lib/supabase-persistence-v3"
import { getZohoAccessToken } from "@/lib/zoho-token"

const ZOHO_API_DOMAIN = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
const FROM_EMAIL = (process.env.VICKY_FROM_EMAIL || "vicky@geovictoria.com").trim()
// Registro interno que ancla el send_mail (Zoho solo manda correos "sobre" un
// registro). Default: contacto interno de pruebas, creado por Vicky.
const MAIL_ANCHOR = (process.env.VIC_DASH_MAIL_ANCHOR || "Contacts/3525045000645054553").trim()
const ADMINS = (process.env.VIC_DASH_ADMINS || "egomez@geovictoria.com,rlewit@geovictoria.com")
  .toLowerCase()
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)

// ENTRADA DIRECTA SIN CÓDIGO (excepción operativa, Lalo 07-ago): correos a
// los que Zoho no puede enviarles el código porque están en su lista de
// REBOTADOS (caso pdiaz@: un bounce '5.1.8 UTF-8' de mayo quedó cacheado y
// Zoho rechaza todo envío a esa casilla). Entran con su identidad al tiro,
// sin verificación — sacar de esta lista apenas se limpie el rebote en Zoho
// (Configuración → Correo → direcciones rebotadas). Formato "email:Nombre".
const SIN_CODIGO = new Map(
  (process.env.VIC_DASH_SIN_CODIGO || "pdiaz@geovictoria.com:Paola Diaz")
    .split(",")
    .map((par) => {
      const [email, nombre] = par.split(":").map((x) => (x || "").trim())
      return [email.toLowerCase(), nombre || email] as [string, string]
    })
    .filter(([e]) => e),
)

export function entradaSinCodigo(email: string): string | null {
  return SIN_CODIGO.get(norm(email)) || null
}

const TTL_MIN = 10
const MAX_INTENTOS = 5

const norm = (email: string) => (email || "").trim().toLowerCase()
const hash = (s: string) => createHash("sha256").update(s).digest("hex")
const kvKey = (email: string) => `dash_code_${norm(email).replace(/[^a-z0-9@._-]/g, "")}`

export function esAdminCorreo(email: string): boolean {
  return ADMINS.includes(norm(email))
}

/** Usuario ACTIVO de Zoho por correo → nombre completo (identidad del dash). */
export async function usuarioZohoActivoPorEmail(email: string): Promise<{ nombre: string } | null> {
  const objetivo = norm(email)
  if (!objetivo || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(objetivo)) return null
  try {
    const token = await getZohoAccessToken()
    for (let page = 1; page <= 5; page++) {
      const r = await fetch(`${ZOHO_API_DOMAIN}/crm/v3/users?type=ActiveUsers&page=${page}&per_page=200`, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        cache: "no-store",
      })
      if (!r.ok) return null
      const data = (await r.json().catch(() => ({}))) as {
        users?: Array<{ email?: string; full_name?: string }>
        info?: { more_records?: boolean }
      }
      const match = (data.users || []).find((u) => norm(u.email || "") === objetivo)
      if (match) return { nombre: String(match.full_name || "").trim() || objetivo }
      if (!data.info?.more_records) break
    }
  } catch {
    /* cae al null */
  }
  return null
}

/** Genera y envía el código. Devuelve error legible si algo no calza. */
export async function pedirCodigoDash(email: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const correo = norm(email)
  // Los ADMINS entran aunque no sean usuarios de Zoho CRM (caso Lalo 07-ago:
  // egomez@ administra por la cuenta Admin y su correo personal no es usuario
  // del CRM — la validación lo bloqueaba a él mismo).
  const usuario = esAdminCorreo(correo)
    ? { nombre: "Administrador" }
    : await usuarioZohoActivoPorEmail(correo)
  if (!usuario) {
    return { ok: false, error: "Ese correo no corresponde a un usuario activo de GeoVictoria. Usa tu correo corporativo." }
  }
  // Rate limit de re-envío: 60 s entre códigos.
  const prev = await getKvValue(kvKey(correo)).catch(() => null)
  if (prev) {
    try {
      const p = JSON.parse(prev) as { at?: string }
      if (p.at && Date.now() - Date.parse(p.at) < 60_000) {
        return { ok: false, error: "Ya te enviamos un código hace menos de un minuto. Revisa tu correo (y spam)." }
      }
    } catch { /* código previo ilegible: se pisa */ }
  }
  const code = String(Math.floor(100000 + Math.random() * 900000))
  await setKvValue(
    kvKey(correo),
    JSON.stringify({ h: hash(`${correo}|${code}`), at: new Date().toISOString(), intentos: 0, nombre: usuario.nombre }),
  )
  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#2d3748;line-height:1.5">
<h2 style="color:#1a202c;margin:0 0 12px">Acceso a Gestión de oportunidades</h2>
<p>${usuario.nombre && usuario.nombre !== "Administrador" ? `${usuario.nombre.split(" ")[0]}, tu` : "Tu"} código de acceso es:</p>
<p style="font-size:30px;font-weight:700;letter-spacing:4px;color:#0284c7;margin:8px 0 16px">${code}</p>
<p>Vence en ${TTL_MIN} minutos. Si no lo pediste tú, ignora este correo.</p>
<p style="margin:24px 0 0;color:#718096">Vicky · GeoVictoria</p>
</body></html>`
  try {
    const token = await getZohoAccessToken()
    const res = await fetch(`${ZOHO_API_DOMAIN}/crm/v3/${MAIL_ANCHOR}/actions/send_mail`, {
      method: "POST",
      headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        data: [
          {
            from: { email: FROM_EMAIL },
            to: [{ email: correo }],
            subject: `Tu código de acceso: ${code} — Gestión de oportunidades`,
            content: html,
            mail_format: "html",
          },
        ],
      }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      console.error(`[dash-login] send_mail ${res.status} a ${correo}:`, body.slice(0, 250))
      return { ok: false, error: "No se pudo enviar el correo con el código. Reintenta en un minuto." }
    }
    console.log(`[dash-login] código enviado a ${correo}`)
    return { ok: true }
  } catch (e) {
    console.error("[dash-login] envío lanzó:", e instanceof Error ? e.message : e)
    return { ok: false, error: "No se pudo enviar el correo con el código. Reintenta en un minuto." }
  }
}

/** Verifica el código. Devuelve la identidad (nombre Zoho o Administrador). */
export async function verificarCodigoDash(
  email: string,
  codigo: string,
): Promise<{ ok: true; quien: string } | { ok: false; error: string }> {
  const correo = norm(email)
  const cod = (codigo || "").replace(/\D/g, "")
  const raw = await getKvValue(kvKey(correo)).catch(() => null)
  if (!raw) return { ok: false, error: "El código venció o no fue solicitado. Pide uno nuevo." }
  let data: { h?: string; intentos?: number; nombre?: string; at?: string }
  try {
    data = JSON.parse(raw)
  } catch {
    return { ok: false, error: "El código venció. Pide uno nuevo." }
  }
  // Vigencia: el TTL vive en el propio valor (setKvValue no maneja expiración).
  if (!data.at || Date.now() - Date.parse(data.at) > TTL_MIN * 60_000) {
    return { ok: false, error: "El código venció. Pide uno nuevo." }
  }
  if ((data.intentos || 0) >= MAX_INTENTOS) {
    return { ok: false, error: "Demasiados intentos. Pide un código nuevo." }
  }
  if (hash(`${correo}|${cod}`) !== data.h) {
    await setKvValue(kvKey(correo), JSON.stringify({ ...data, intentos: (data.intentos || 0) + 1 })).catch(() => {})
    return { ok: false, error: "Código incorrecto. Revísalo e inténtalo de nuevo." }
  }
  // Código correcto: se consume (un solo uso).
  await setKvValue(kvKey(correo), "").catch(() => {})
  const quien = esAdminCorreo(correo) ? "Administrador" : String(data.nombre || "").trim()
  if (!quien) return { ok: false, error: "No se pudo resolver tu identidad. Pide un código nuevo." }
  return { ok: true, quien }
}
