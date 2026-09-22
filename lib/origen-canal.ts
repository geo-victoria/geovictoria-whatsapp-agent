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
// SIN imports estáticos a propósito: lib/crm-hitos.ts y lib/agent-loop.ts
// importan este módulo y sus tests (node --test) cargan esos archivos directo —
// un import estático de supabase-persistence-v3 (que trae "@/…") los rompe.
// El kv se importa dinámicamente dentro de las funciones async.
async function getKvValue(key: string): Promise<string | null> {
  const m = await import("./supabase-persistence-v3")
  return m.getKvValue(key)
}

export const LEAD_SOURCE_META_DEFAULT = "Facebook"

/** ¿Es un contacto de la Graph API de Meta (Messenger/Instagram)? PURO. */
export function esContactoMeta(contact: string): boolean {
  return /^(FB|IG)\./i.test(String(contact || "").trim())
}

/** PSID/IGSID crudo de un contacto Meta ("FB.123" → "123"), o "" si no lo es. PURO. */
export function psidDe(contact: string): string {
  const m = /^(?:FB|IG)\.(\d{5,})$/i.exec(String(contact || "").trim())
  return m ? m[1] : ""
}

/** ¿El contacto pertenece a la operación CHILENA? Teléfono +56 o contacto de
 * Meta (la página de Messenger/Instagram es GeoVictoria Chile). PURO.
 * Reemplaza a los `startsWith("56")` donde la pregunta real es "¿es CL?". */
export function esContactoCL(contact: string): boolean {
  const c = String(contact || "").trim()
  if (esContactoMeta(c)) return true
  const d = c.replace(/\D/g, "")
  return d.startsWith("56") && d.length >= 11
}

/** Celular chileno escrito por el cliente en un texto ("+56 9 1234 5678",
 * "912345678", "56912345678"): devuelve "569XXXXXXXX" o "". PURO. */
export function capturarCelularCL(texto: string): string {
  const t = String(texto || "")
  const m = /(?:\+?56\s?)?(?:\(?0?9\)?[\s.-]?)(\d[\s.-]?){8}/.exec(t)
  if (!m) return ""
  const d = m[0].replace(/\D/g, "")
  const nueve = d.length >= 9 ? d.slice(-9) : ""
  if (!/^9\d{8}$/.test(nueve)) return ""
  return `56${nueve}`
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

/**
 * TELÉFONO DECLARADO POR UN CONTACTO META (Lalo 15-sep: "que se declare, se
 * valide y se guarde en Phone"). El PSID sigue siendo la identidad del chat;
 * el WhatsApp que el cliente entrega queda como ALIAS: kv `telefono_meta_<FB.x>`
 * = 569…, `meta_psid_<569…>` = FB.x y `origen_canal_<569…>` = meta (así lo que
 * nazca bajo el número conserva la fuente Facebook).
 */
export async function telefonoAliasDe(contact: string): Promise<string> {
  if (!esContactoMeta(contact)) return ""
  return ((await getKvValue(`telefono_meta_${String(contact).trim()}`).catch(() => null)) || "").trim()
}

export async function guardarTelefonoMeta(contact: string, fono: string): Promise<void> {
  const c = String(contact || "").trim()
  const f = String(fono || "").replace(/\D/g, "")
  if (!esContactoMeta(c) || !/^569\d{8}$/.test(f)) return
  const { setKvValue } = await import("./supabase-persistence-v3")
  await setKvValue(`telefono_meta_${c}`, f)
  await setKvValue(`meta_psid_${f}`, c)
  await setKvValue(`origen_canal_${f}`, "meta")
}
