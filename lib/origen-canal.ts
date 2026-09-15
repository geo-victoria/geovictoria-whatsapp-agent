/**
 * ORIGEN DEL CONTACTO POR CANAL — Messenger / Instagram (Lalo 15-sep).
 *
 * Los contactos que entran por la Graph API de Meta no son teléfonos: llegan
 * como `FB.<psid>` (Messenger) o `IG.<igsid>` (Instagram). Todo registro que
 * Vicky cree en Zoho a partir de ellos (lead, y por herencia del convert el
 * deal y el contacto) debe llevar Lead_Source = "Facebook" (orden de Lalo
 * 15-sep; "Meta" y "Facebook" se barajaron, quedó Facebook).
 *
 * OJO PICKLIST: al 15-sep el picklist Lead_Source de Leads/Deals/Contacts
 * tiene "Meta" y "16. Meta Ads" pero NO "Facebook" — Zoho rechaza valores
 * fuera del picklist. Por eso el valor efectivo sale de vic_kv
 * `lead_source_meta` (o env VICKY_LEAD_SOURCE_META) con default "Facebook":
 * mientras el valor no exista en Zoho, la kv se deja en "Meta"; al agregarlo
 * al picklist se vacía la kv y sale "Facebook" sin deploy.
 *
 * Cuando el contacto de Meta entregue su WhatsApp y el caso pase a vivir bajo
 * el TELÉFONO (ancla de toda la tubería), la marca kv `origen_canal_<fono>`
 * = "meta" conserva la fuente para lo que se cree después con ese número.
 */
import { getKvValue } from "./supabase-persistence-v3"

export const LEAD_SOURCE_META_DEFAULT = "Facebook"

/** ¿Es un contacto de la Graph API de Meta (Messenger/Instagram)? PURO. */
export function esContactoMeta(contact: string): boolean {
  return /^(FB|IG)\./i.test(String(contact || "").trim())
}

/** Canal de un contacto Meta. PURO. */
export function canalMetaDe(contact: string): "messenger" | "instagram" | null {
  const c = String(contact || "").trim()
  if (/^FB\./i.test(c)) return "messenger"
  if (/^IG\./i.test(c)) return "instagram"
  return null
}

/** Valor de Lead_Source para lo que nazca de Meta (kv → env → default). */
export async function leadSourceMeta(): Promise<string> {
  const kv = ((await getKvValue("lead_source_meta").catch(() => null)) || "").trim()
  return kv || (process.env.VICKY_LEAD_SOURCE_META || "").trim() || LEAD_SOURCE_META_DEFAULT
}

/**
 * Lead_Source que corresponde a un contacto, o null si es un contacto normal
 * (ahí manda el default de cada emisor: ZOHO_DEFAULT_LEAD_SOURCE / VICKY_LEAD_SOURCE).
 * Reconoce el contacto Meta por prefijo y el teléfono "aliado" por la marca
 * kv `origen_canal_<fono>`.
 */
export async function leadSourceParaContacto(contact: string): Promise<string | null> {
  const c = String(contact || "").trim()
  if (!c) return null
  if (esContactoMeta(c)) return leadSourceMeta()
  const fono = c.replace(/\D/g, "")
  if (!fono) return null
  const origen = ((await getKvValue(`origen_canal_${fono}`).catch(() => null)) || "").trim().toLowerCase()
  if (origen === "meta" || origen === "facebook" || origen === "instagram") return leadSourceMeta()
  return null
}
