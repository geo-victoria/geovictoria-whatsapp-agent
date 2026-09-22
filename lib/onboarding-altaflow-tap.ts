/**
 * Tap del quick-reply "Crear mi cuenta" del alta (híbrido por ventana, 28-ago).
 *
 * UN SOLO LUGAR para Chile y Perú (21-sep): antes vivía inline en el webhook
 * chileno y el peruano no lo tenía — un +51 que tocaba el botón le hablaba al
 * agente como si fuera un mensaje más. El tap ES un mensaje del usuario
 * (abre la ventana de 24 h) y el bloque `#altaflow` del Bot Designer del bot
 * de la línea responde con el flow EN SESIÓN, así que Vicky CALLA para no
 * duplicar. Gate vic_kv por país (`alta_qr_intent` / `alta_qr_intent_pe`):
 * sin el bloque cableado, el mensaje sigue al agente (jamás un tap mudo).
 */

import { TEXTO_BOTON_ALTA_QR, gatesAltaPais, type PaisAlta } from "./onboarding/plantilla"

const BASE_AGENTE = () =>
  process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : "https://geovictoria-whatsapp-agent-git-vicky-v3-geo-victoria.vercel.app"

/** ¿El mensaje es exactamente el texto del botón? (sin tildes ni mayúsculas) */
export function esTapAltaQr(message: string): boolean {
  const norm = (s: string) =>
    s
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
  return norm(message) === norm(TEXTO_BOTON_ALTA_QR)
}

/** Prefill fresco del borrador (mismo endpoint que usa el Flow al abrir). */
export async function prefillAltaFlow(contact: string): Promise<Record<string, unknown>> {
  try {
    const { getFollowupCronSecret } = await import("./supabase-persistence-v3")
    const secreto = await getFollowupCronSecret()
    const r = await fetch(
      `${BASE_AGENTE()}/api/vic-onboarding-flow?key=${encodeURIComponent(secreto)}&contact=${contact}`,
      { cache: "no-store" },
    )
    return ((await r.json().catch(() => ({}))) as { prefill?: Record<string, unknown> }).prefill || {}
  } catch {
    return {}
  }
}

/**
 * Variables `alta_*` que interpola el bloque del Bot Designer. `conNombre`
 * suma `alta_nombre` (primer nombre del admin) para personalizar el mensaje
 * del bloque — se siembra en el kickoff vía #setvars.
 */
export function variablesAltaFlow(
  contact: string,
  prefill: Record<string, unknown>,
  conNombre = false,
): Record<string, string> {
  const v = (k: string) => String(prefill[k] ?? "")
  const vars: Record<string, string> = {
    alta_razon: v("razon_social"),
    alta_rut: v("rut_empresa"),
    alta_giro: v("giro"),
    alta_direccion: v("direccion"),
    alta_comuna: v("comuna"),
    alta_campos: String(prefill["mostrar_campos_empresa"] !== false),
    alta_fono: contact,
    // FLOW ÚNICO v5 (22-sep): las etiquetas por país viven en `data` de la
    // pantalla EMPRESA y el bloque #altaflow arranca ahí (sin pasar por el
    // endpoint), así que también viajan como variables. Sin ellas los labels
    // saldrían vacíos. Defaults = Chile.
    alta_etq_doc: v("etiqueta_documento") || "RUT",
    alta_etq_doc_ayuda: v("etiqueta_documento_ayuda") || "Ej: 76123456-0",
    alta_etq_zona: v("etiqueta_zona") || "Comuna",
  }
  if (conNombre) vars.alta_nombre = (v("admin_nombre").trim().split(/\s+/)[0] || "").trim()
  return vars
}

/**
 * Si el mensaje es el tap del botón y el gate del país está encendido:
 * dispara `#altaflow` con las variables frescas, deja el marcador en el
 * historial, abre el reloj de ventana y devuelve true (el webhook calla).
 * En cualquier otro caso devuelve false y el turno sigue su camino normal.
 */
export async function manejarTapAltaQr(contact: string, message: string, pais: PaisAlta): Promise<boolean> {
  if (!esTapAltaQr(message)) return false
  const { getKvValue, appendTurnV3, markUserActivity } = await import("./supabase-persistence-v3")
  const qrOn = ((await getKvValue(gatesAltaPais(pais).qr).catch(() => null)) || "").trim() === "on"
  if (!qrOn) return false
  console.log(`[alta-qr] tap quick-reply del alta de ${contact} (${pais}) — trigger #altaflow con variables frescas`)
  const { triggerBotmakerIntent } = await import("./botmaker-push-v3")
  const prefill = await prefillAltaFlow(contact)
  await triggerBotmakerIntent(contact, "#altaflow", variablesAltaFlow(contact, prefill)).catch(() => false)
  await appendTurnV3(contact, message, "[Le enviamos el formulario de alta por WhatsApp]", pais).catch(() => {})
  // El reloj de ventana (getLastUserAt) lee last_user_at, que solo lo toca
  // markUserActivity — sin esto, el resumen post-formulario creía la ventana
  // vencida aunque el tap la acababa de abrir (prueba 28-ago).
  await markUserActivity(contact, pais).catch(() => {})
  return true
}
