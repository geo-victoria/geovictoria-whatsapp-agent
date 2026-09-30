/**
 * ORIGEN DE ANUNCIO — clic a WhatsApp de Meta Ads (Lalo 30-sep).
 *
 * Cuando el cliente llega a Vicky tocando un anuncio "Clic a WhatsApp", Meta
 * manda en el PRIMER mensaje un bloque `referral` (source_id = id del anuncio,
 * source_type "ad", source_url, headline, body, ctwa_clid = id del clic). La
 * acción de código de Botmaker lo reenvía en el mismo POST del webhook como
 * `referral`. Acá:
 *   1. se guarda en vic_kv `origen_anuncio_<fono>` SOLO la primera vez (el
 *      primer anuncio que trajo a la persona manda; mensajes siguientes ni otro
 *      anuncio lo pisan) — en segundo plano, jamás toca la respuesta;
 *   2. al crear el lead, createZohoLead lo lee: Lead_Source "Meta Ads",
 *      Meta_Ad_ID, Medium "whatsapp_ads", Campaign = headline y el id del clic
 *      en Meta_Click_ID (campo creado el 30-sep; vic_kv `meta_click_field` /
 *      env VICKY_META_CLICK_FIELD lo cambian);
 *   3. si el lead ya existía (formulario, otro canal) se completan SOLO los
 *      campos vacíos — un Lead_Source que ya traía origen no se pisa.
 * El deal hereda el Lead_Source del lead al convertir (el cotizador ya lo hace).
 *
 * SIN imports estáticos (mismo motivo que origen-canal.ts: lo cargan tests con
 * node --test y zoho-leads lo importa).
 */

async function kvGet(key: string): Promise<string | null> {
  const m = await import("./supabase-persistence-v3")
  return m.getKvValue(key)
}
async function kvSet(key: string, value: string): Promise<void> {
  const m = await import("./supabase-persistence-v3")
  await m.setKvValue(key, value)
}

export type OrigenAnuncio = {
  sourceId: string
  sourceType: string
  sourceUrl: string
  headline: string
  body: string
  ctwaClid: string
  at: string
}

/** Valor real del picklist Lead_Source (display "Meta Ads"). */
export const LEAD_SOURCE_META_ADS = "16. Meta Ads"
export const MEDIUM_META_ADS = "whatsapp_ads"
/** Campo de texto creado en Leads el 30-sep (id 3525045000667467572); kv `meta_click_field` o env lo cambian ("-" lo apaga). */
export const CAMPO_CLIC_DEFAULT = "Meta_Click_ID"

const str = (v: unknown, max = 500) => (v === undefined || v === null ? "" : String(v).trim().slice(0, max))

/**
 * Normaliza el referral tal como venga (camelCase de nuestra acción de código,
 * snake_case crudo de Meta, o anidado en `referral`/`ad`). Devuelve null si no
 * hay nada que identifique un anuncio. PURO.
 */
export function normalizarReferral(raw: unknown, ahoraIso = new Date().toISOString()): OrigenAnuncio | null {
  if (!raw) return null
  let r: unknown = raw
  if (typeof r === "string") {
    try { r = JSON.parse(r) } catch { return null }
  }
  if (!r || typeof r !== "object") return null
  const o = r as Record<string, unknown>
  const inner = (o.referral && typeof o.referral === "object" ? o.referral : o) as Record<string, unknown>
  const g = (...ks: string[]) => {
    for (const k of ks) {
      const v = str(inner[k])
      if (v) return v
    }
    return ""
  }
  const origen: OrigenAnuncio = {
    sourceId: g("sourceId", "source_id", "adId", "ad_id"),
    sourceType: g("sourceType", "source_type") || "",
    sourceUrl: g("sourceUrl", "source_url"),
    headline: g("headline"),
    body: g("body"),
    ctwaClid: g("ctwaClid", "ctwa_clid", "clickId", "click_id"),
    at: ahoraIso,
  }
  // Solo anuncios: un referral de otro tipo (post orgánico) no es Meta Ads.
  const tipo = origen.sourceType.toLowerCase()
  if (tipo && tipo !== "ad") return null
  if (!origen.sourceId && !origen.ctwaClid) return null
  return origen
}

const fonoDe = (contact: string) => String(contact || "").replace(/\D/g, "")
const llave = (fono: string) => `origen_anuncio_${fono}`

/** Guarda el origen si el contacto aún no tiene uno. Best-effort, no lanza. */
export async function guardarOrigenAnuncio(contact: string, raw: unknown): Promise<"guardado" | "ya_existia" | "sin_referral" | "error"> {
  try {
    const origen = normalizarReferral(raw)
    if (!origen) return "sin_referral"
    const fono = fonoDe(contact)
    if (!fono) return "sin_referral"
    const previo = await kvGet(llave(fono)).catch(() => null)
    if (previo) return "ya_existia"
    await kvSet(llave(fono), JSON.stringify(origen))
    console.log(`[origen-anuncio] ${fono} anuncio=${origen.sourceId || "-"} clic=${origen.ctwaClid ? "si" : "no"}`)
    return "guardado"
  } catch (e) {
    console.warn("[origen-anuncio] guardar:", e instanceof Error ? e.message : e)
    return "error"
  }
}

export async function leerOrigenAnuncio(contact: string): Promise<OrigenAnuncio | null> {
  const fono = fonoDe(contact)
  if (!fono) return null
  try {
    const v = await kvGet(llave(fono))
    if (!v) return null
    const o = JSON.parse(v) as OrigenAnuncio
    return o && (o.sourceId || o.ctwaClid) ? o : null
  } catch {
    return null
  }
}

/** api_name del campo de Leads para el id del clic ("" = no existe aún). */
export async function campoClicMeta(): Promise<string> {
  const kv = ((await kvGet("meta_click_field").catch(() => null)) || "").trim()
  return kv || (process.env.VICKY_META_CLICK_FIELD || "").trim() || CAMPO_CLIC_DEFAULT
}

/** Campos de Zoho que aporta el origen. PURO. */
export function camposDeOrigen(o: OrigenAnuncio, campoClic = ""): Record<string, string> {
  const c: Record<string, string> = { Lead_Source: LEAD_SOURCE_META_ADS, Medium: MEDIUM_META_ADS }
  if (o.sourceId) c.Meta_Ad_ID = o.sourceId.slice(0, 255)
  if (o.headline) c.Campaign = o.headline.slice(0, 255)
  if (campoClic && campoClic !== "-" && o.ctwaClid) c[campoClic] = o.ctwaClid.slice(0, 255)
  return c
}

/**
 * Sobre un lead EXISTENTE: solo lo que está vacío. PURO.
 * `actual` = valores del lead en Zoho (null/"" = vacío).
 */
export function camposFaltantes(actual: Record<string, unknown>, deseados: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(deseados)) {
    const a = actual[k]
    const vacio = a === null || a === undefined || String(a).trim() === "" || String(a).trim() === "-None-"
    if (vacio && v) out[k] = v
  }
  return out
}

/** Completa un lead existente con el origen (solo campos vacíos). Best-effort. */
export async function completarLeadConOrigen(leadId: string, contact: string): Promise<Record<string, string> | null> {
  try {
    const o = await leerOrigenAnuncio(contact)
    if (!o || !leadId) return null
    const deseados = camposDeOrigen(o, await campoClicMeta())
    const { getZohoAccessToken } = await import("./zoho-token")
    const token = await getZohoAccessToken()
    const api = (process.env.ZOHO_API_DOMAIN || "").trim() || "https://www.zohoapis.com"
    const campos = Object.keys(deseados).join(",")
    const r = await fetch(`${api}/crm/v8/Leads/${leadId}?fields=${campos}`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      cache: "no-store",
    })
    if (r.status !== 200) return null
    const j = (await r.json().catch(() => ({}))) as { data?: Array<Record<string, unknown>> }
    const actual = j.data?.[0]
    if (!actual) return null
    const faltan = camposFaltantes(actual, deseados)
    if (!Object.keys(faltan).length) return {}
    const put = await fetch(`${api}/crm/v8/Leads/${leadId}`, {
      method: "PUT",
      headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
      // Regla trigger (21-ago): toda escritura a Leads lleva blueprint.
      body: JSON.stringify({ data: [faltan], trigger: ["blueprint"] }),
      cache: "no-store",
    })
    if (!put.ok) {
      console.warn(`[origen-anuncio] completar ${leadId} ${put.status}: ${(await put.text().catch(() => "")).slice(0, 200)}`)
      return null
    }
    console.log(`[origen-anuncio] lead ${leadId} completado: ${Object.keys(faltan).join(",")}`)
    return faltan
  } catch (e) {
    console.warn("[origen-anuncio] completar:", e instanceof Error ? e.message : e)
    return null
  }
}
