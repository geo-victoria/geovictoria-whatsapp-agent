/**
 * NOTAS QUE ESPERAN A QUE NAZCA LA IMPLEMENTACIÓN (14-sep, caso Peggi / BCA
 * EQUIPAMIENTOS).
 *
 * Hay contexto que el equipo conoce ANTES de que exista la implementación y
 * que el implementador necesita el día uno: Peggi es cliente vigente a través
 * de Nuboox, va a darles de baja y quiere partir de cero en GeoVictoria pero
 * MIGRANDO su data. Si eso no queda escrito, a la implementación llega una
 * empresa "nueva" y nadie sabe que hay data que traer.
 *
 * `sincronizarInsightImplementacion` ya escribe el insight de la conversación,
 * pero eso resume lo que el CLIENTE dijo en el chat. Esto es distinto: es una
 * instrucción que deja el equipo, en sus palabras, y que se adjunta apenas la
 * implementación exista — sin que nadie tenga que estar mirando.
 *
 * Si la implementación YA existe, se escribe al tiro.
 */

import { getKvValue, setKvValue } from "./supabase-persistence-v3"
import { claveCapacitacion } from "./onboarding/fase"

const CLAVE = (c: string) => `onb_nota_imp_${c.replace(/\D/g, "")}`

export type NotaPendiente = { titulo: string; texto: string; at: string }

async function leer(contact: string): Promise<NotaPendiente[]> {
  const crudo = await getKvValue(CLAVE(contact)).catch(() => null)
  if (!crudo) return []
  try {
    const v = JSON.parse(crudo)
    return Array.isArray(v) ? (v as NotaPendiente[]) : []
  } catch {
    return []
  }
}

/** Escribe la nota en la implementación. Devuelve el id de la nota creada. */
async function crearNota(impId: string, titulo: string, texto: string): Promise<string | null> {
  const { getZohoAccessToken } = await import("./zoho-token")
  const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
  const token = await getZohoAccessToken()
  const r = await fetch(`${api}/crm/v3/Implementaciones/${impId}/Notes`, {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({ data: [{ Note_Title: titulo.slice(0, 120), Note_Content: texto.slice(0, 32000) }] }),
  }).catch(() => null)
  const b = (await r?.json().catch(() => ({}))) as { data?: Array<{ code?: string; details?: { id?: string } }> }
  const fila = b?.data?.[0]
  return fila?.code === "SUCCESS" ? fila?.details?.id || null : null
}

/**
 * Deja una nota para la implementación del contacto. Si ya existe, la escribe
 * de inmediato; si no, queda en cola y sale cuando la implementación nazca.
 */
export async function dejarNotaPendienteImp(
  contact: string,
  titulo: string,
  texto: string,
): Promise<{ ok: boolean; escrita: boolean; impId?: string; error?: string }> {
  const c = contact.replace(/\D/g, "")
  if (!c || !titulo.trim() || !texto.trim()) return { ok: false, escrita: false, error: "faltan datos" }
  try {
    const crudo = await getKvValue(claveCapacitacion(c)).catch(() => null)
    const cap = crudo ? (JSON.parse(crudo) as { implementacionId?: string }) : null
    if (cap?.implementacionId) {
      const id = await crearNota(cap.implementacionId, titulo, texto)
      if (id) return { ok: true, escrita: true, impId: cap.implementacionId }
      return { ok: false, escrita: false, error: "Zoho rechazó la nota" }
    }
    const cola = await leer(c)
    cola.push({ titulo, texto, at: new Date().toISOString() })
    await setKvValue(CLAVE(c), JSON.stringify(cola))
    return { ok: true, escrita: false }
  } catch (e) {
    return { ok: false, escrita: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Vuelca a la implementación recién creada todo lo que quedó en cola.
 * Best-effort: jamás tumba al llamador.
 */
export async function adjuntarNotasPendientes(contact: string, impId: string): Promise<number> {
  const c = contact.replace(/\D/g, "")
  try {
    const cola = await leer(c)
    if (!cola.length) return 0
    let escritas = 0
    for (const n of cola) {
      const id = await crearNota(impId, n.titulo, n.texto)
      if (id) escritas++
    }
    // Solo se vacía si salieron todas: lo que no se pudo escribir se reintenta.
    if (escritas === cola.length) await setKvValue(CLAVE(c), "").catch(() => {})
    if (escritas) console.log(`[nota-imp] ${c}: ${escritas} nota(s) del equipo adjuntadas a ${impId}`)
    return escritas
  } catch (e) {
    console.warn(`[nota-imp] ${c}:`, e instanceof Error ? e.message : String(e))
    return 0
  }
}
