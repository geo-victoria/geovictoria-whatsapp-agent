/**
 * Búsqueda multi-identificador en Zoho CRM para identidad progresiva del prospect.
 *
 * Diferente a zoho-lookup.ts (que busca por teléfono y devuelve un único resultado
 * con análisis de actividad), esta función busca por múltiples identificadores
 * (RUT empresa, email, teléfono) en paralelo en Accounts, Contacts y Leads,
 * deduplica resultados y los devuelve con jerarquía de confianza.
 *
 * Jerarquía de confianza:
 *   - RUT empresa  → máxima (Account.RUT_Empresa, Lead.RUT_Empresa)
 *   - Email        → alta   (Contact.Email, Lead.Email)
 *   - Teléfono     → media  (Contact.Phone/Mobile, Account.Phone, Lead.Phone)
 *
 * Filtra Leads ya convertidos.
 */

import { getZohoAccessToken } from "./zoho-token"

function getEnv(name: string): string {
  return (process.env[name] || "").trim()
}

export type ProspectMatch = {
  modulo: "Account" | "Contact" | "Lead"
  id: string
  nombre_para_mostrar: string
  matched_by: "rut_empresa" | "email" | "telefono"
  confianza: "maxima" | "alta" | "media"
  datos_extra?: {
    rut_empresa?: string
    email?: string
    email_registrado?: string
    telefono?: string
    telefono_registrado?: string
    cuenta_padre_id?: string
    cuenta_padre_nombre?: string
    full_name?: string
  }
}

export type SearchProspectInput = {
  telefono?: string
  email?: string
  rutEmpresa?: string
}

export type SearchProspectResult = {
  ok: true
  matches: ProspectMatch[]
  resumen: string
}

// ── Normalizadores ──
/**
 * Genera variantes razonables de un RUT chileno para tolerar distintos
 * formatos de almacenamiento en CRM.
 *
 * Para "18.435.922-7" genera:
 *   - "18.435.922-7"  (formato oficial: puntos + guion)
 *   - "184359227"     (compacto: sin nada)
 *   - "18435922-7"    (sin puntos, con guion) ← común en muchos CRMs
 *   - "18.435.922-7"  (canónico, igual al primero si vino así)
 *
 * Cubre el caso donde el RUT está almacenado en cualquiera de estos
 * formatos en distintos registros de Zoho.
 */
function getRutVariants(rut: string): string[] {
  if (!rut) return []
  const raw = rut.trim()
  if (!raw) return []
  // Compactar: solo dígitos y la K final, sin puntos ni guion
  const compact = raw.replace(/[.\s-]/g, "").toUpperCase()
  if (compact.length < 2) return [raw]

  const cuerpo = compact.slice(0, -1) // ej. "18435922"
  const dv = compact.slice(-1)        // ej. "7" o "K"

  // Insertar puntos cada 3 dígitos desde la derecha en el cuerpo
  const cuerpoConPuntos = cuerpo.replace(/\B(?=(\d{3})+(?!\d))/g, ".")

  const variantes = [
    raw,                            // tal como vino
    compact,                        // "184359227"
    `${cuerpo}-${dv}`,              // "18435922-7"
    `${cuerpoConPuntos}-${dv}`,     // "18.435.922-7"
  ]
  // DV "K": agrega variantes en minúscula por si quedó guardado como "k".
  if (dv === "K") {
    variantes.push(`${cuerpo}k`, `${cuerpo}-k`, `${cuerpoConPuntos}-k`)
  }
  return Array.from(new Set(variantes)).filter(Boolean)
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

function normalizePhone(phone: string): string {
  return phone.trim()
}

// ── Fetch con auth Zoho ──
async function zohoFetch(path: string): Promise<Response | null> {
  try {
    const apiDomain = getEnv("ZOHO_API_DOMAIN") || "https://www.zohoapis.com"
    const token = await getZohoAccessToken()
    return await fetch(`${apiDomain}${path}`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      cache: "no-store",
    })
  } catch {
    return null
  }
}

// ── Helpers de query Zoho search API ──
type ZohoRecord = Record<string, unknown>

async function searchModule(
  module: string,
  criteria: string,
  fields: string,
): Promise<ZohoRecord[]> {
  const path = `/crm/v3/${module}/search?criteria=${encodeURIComponent(
    criteria,
  )}&fields=${encodeURIComponent(fields)}&per_page=5`
  const res = await zohoFetch(path)
  if (!res || !res.ok) return []
  try {
    const data = (await res.json()) as { data?: ZohoRecord[] }
    return data?.data || []
  } catch {
    return []
  }
}

// ── Verificar si un Lead está convertido ──
async function isLeadConverted(leadId: string): Promise<boolean> {
  const res = await zohoFetch(`/crm/v3/Leads/${leadId}`)
  if (!res || !res.ok) return false
  try {
    const data = (await res.json()) as { data?: ZohoRecord[] }
    const record = data?.data?.[0]
    return record?.["$converted"] === true
  } catch {
    return false
  }
}

async function filterOutConvertedLeads(leads: ZohoRecord[]): Promise<ZohoRecord[]> {
  const results: ZohoRecord[] = []
  for (const lead of leads) {
    const id = String(lead.id || "")
    if (!id) continue
    const converted = await isLeadConverted(id)
    if (!converted) results.push(lead)
  }
  return results
}

// ── Buscadores por identificador ──
async function findAccountsByRut(rutEmpresa: string): Promise<ZohoRecord[]> {
  if (!rutEmpresa) return []
  const variants = getRutVariants(rutEmpresa)
  if (variants.length === 0) return []

  const all: ZohoRecord[] = []
  const seen = new Set<string>()
  for (const v of variants) {
    const rows = await searchModule(
      "Accounts",
      `(RUT_Empresa:equals:${v})`,
      "id,Account_Name,RUT_Empresa,Phone",
    )
    for (const r of rows) {
      const id = String(r.id || "")
      if (id && !seen.has(id)) {
        seen.add(id)
        all.push(r)
      }
    }
  }
  return all
}

async function findLeadsByRut(rutEmpresa: string): Promise<ZohoRecord[]> {
  if (!rutEmpresa) return []
  const variants = getRutVariants(rutEmpresa)
  if (variants.length === 0) return []

  const all: ZohoRecord[] = []
  const seen = new Set<string>()
  for (const v of variants) {
    const rows = await searchModule(
      "Leads",
      `(RUT_Empresa:equals:${v})`,
      "id,Full_Name,Company,Email,Phone,RUT_Empresa",
    )
    for (const r of rows) {
      const id = String(r.id || "")
      if (id && !seen.has(id)) {
        seen.add(id)
        all.push(r)
      }
    }
  }
  return all
}

async function findContactsByEmail(email: string): Promise<ZohoRecord[]> {
  if (!email) return []
  const emailNorm = normalizeEmail(email)
  return await searchModule(
    "Contacts",
    `(Email:equals:${emailNorm})`,
    "id,Full_Name,Email,Phone,Mobile,Account_Name",
  )
}

async function findLeadsByEmail(email: string): Promise<ZohoRecord[]> {
  if (!email) return []
  const emailNorm = normalizeEmail(email)
  return await searchModule(
    "Leads",
    `(Email:equals:${emailNorm})`,
    "id,Full_Name,Company,Email,Phone,RUT_Empresa",
  )
}

async function findContactsByPhone(phone: string): Promise<ZohoRecord[]> {
  if (!phone) return []
  const phoneNorm = normalizePhone(phone)
  return await searchModule(
    "Contacts",
    `(Phone:equals:${phoneNorm})or(Mobile:equals:${phoneNorm})`,
    "id,Full_Name,Email,Phone,Mobile,Account_Name",
  )
}

async function findAccountsByPhone(phone: string): Promise<ZohoRecord[]> {
  if (!phone) return []
  const phoneNorm = normalizePhone(phone)
  return await searchModule(
    "Accounts",
    `(Phone:equals:${phoneNorm})`,
    "id,Account_Name,RUT_Empresa,Phone",
  )
}

async function findLeadsByPhone(phone: string): Promise<ZohoRecord[]> {
  if (!phone) return []
  const phoneNorm = normalizePhone(phone)
  return await searchModule(
    "Leads",
    `(Phone:equals:${phoneNorm})`,
    "id,Full_Name,Company,Email,Phone,RUT_Empresa",
  )
}

// ── Constructores de match ──
function accountMatch(
  acc: ZohoRecord,
  matched_by: ProspectMatch["matched_by"],
  confianza: ProspectMatch["confianza"],
): ProspectMatch {
  return {
    modulo: "Account",
    id: String(acc.id),
    nombre_para_mostrar: String(acc.Account_Name || "(sin nombre)"),
    matched_by,
    confianza,
    datos_extra: {
      rut_empresa: acc.RUT_Empresa ? String(acc.RUT_Empresa) : undefined,
      telefono_registrado: acc.Phone ? String(acc.Phone) : undefined,
    },
  }
}

function contactMatch(
  c: ZohoRecord,
  matched_by: ProspectMatch["matched_by"],
  confianza: ProspectMatch["confianza"],
): ProspectMatch {
  const accName = c.Account_Name as Record<string, string> | undefined
  return {
    modulo: "Contact",
    id: String(c.id),
    nombre_para_mostrar: String(c.Full_Name || "(sin nombre)"),
    matched_by,
    confianza,
    datos_extra: {
      email: c.Email ? String(c.Email) : undefined,
      telefono: c.Phone ? String(c.Phone) : c.Mobile ? String(c.Mobile) : undefined,
      cuenta_padre_id: accName?.id ? String(accName.id) : undefined,
      cuenta_padre_nombre: accName?.name ? String(accName.name) : undefined,
    },
  }
}

function leadMatch(
  lead: ZohoRecord,
  matched_by: ProspectMatch["matched_by"],
  confianza: ProspectMatch["confianza"],
): ProspectMatch {
  return {
    modulo: "Lead",
    id: String(lead.id),
    nombre_para_mostrar: String(lead.Company || lead.Full_Name || "(sin nombre)"),
    matched_by,
    confianza,
    datos_extra: {
      email: lead.Email ? String(lead.Email) : undefined,
      rut_empresa: lead.RUT_Empresa ? String(lead.RUT_Empresa) : undefined,
      telefono_registrado: lead.Phone ? String(lead.Phone) : undefined,
      full_name: lead.Full_Name ? String(lead.Full_Name) : undefined,
    },
  }
}

// ── Dedupe y orden ──
function dedupeMatches(matches: ProspectMatch[]): ProspectMatch[] {
  const orderConfianza: Record<ProspectMatch["confianza"], number> = {
    maxima: 3,
    alta: 2,
    media: 1,
  }
  const orderModulo: Record<ProspectMatch["modulo"], number> = {
    Account: 3,
    Contact: 2,
    Lead: 1,
  }

  const byKey = new Map<string, ProspectMatch>()
  for (const m of matches) {
    const key = `${m.modulo}:${m.id}`
    const existing = byKey.get(key)
    if (!existing || orderConfianza[m.confianza] > orderConfianza[existing.confianza]) {
      byKey.set(key, m)
    }
  }

  return Array.from(byKey.values())
    .sort((a, b) => {
      const dc = orderConfianza[b.confianza] - orderConfianza[a.confianza]
      if (dc !== 0) return dc
      return orderModulo[b.modulo] - orderModulo[a.modulo]
    })
    .slice(0, 5)
}

// ── Función principal ──
export async function searchProspectByIdentifiers(
  args: SearchProspectInput,
): Promise<SearchProspectResult> {
  const telefono = args.telefono?.trim() || ""
  const email = args.email?.trim().toLowerCase() || ""
  const rutEmpresa = args.rutEmpresa?.trim() || ""

  const matches: ProspectMatch[] = []

  // ── Máxima: RUT empresa ──
  if (rutEmpresa) {
    const accs = await findAccountsByRut(rutEmpresa)
    accs.forEach((acc) => matches.push(accountMatch(acc, "rut_empresa", "maxima")))

    const leads = await findLeadsByRut(rutEmpresa)
    const leadsActivos = await filterOutConvertedLeads(leads)
    leadsActivos.forEach((lead) => matches.push(leadMatch(lead, "rut_empresa", "maxima")))
  }

  // ── Alta: email ──
  if (email) {
    const contacts = await findContactsByEmail(email)
    contacts.forEach((c) => matches.push(contactMatch(c, "email", "alta")))

    const leads = await findLeadsByEmail(email)
    const leadsActivos = await filterOutConvertedLeads(leads)
    leadsActivos.forEach((lead) => matches.push(leadMatch(lead, "email", "alta")))
  }

  // ── Media: teléfono ──
  if (telefono) {
    const contacts = await findContactsByPhone(telefono)
    contacts.forEach((c) => matches.push(contactMatch(c, "telefono", "media")))

    const accs = await findAccountsByPhone(telefono)
    accs.forEach((acc) => matches.push(accountMatch(acc, "telefono", "media")))

    const leads = await findLeadsByPhone(telefono)
    const leadsActivos = await filterOutConvertedLeads(leads)
    leadsActivos.forEach((lead) => matches.push(leadMatch(lead, "telefono", "media")))
  }

  const deduped = dedupeMatches(matches)

  let resumen: string
  if (deduped.length === 0) {
    resumen = "Sin coincidencias en Zoho."
  } else {
    const porModulo = deduped.reduce<Record<string, number>>((acc, m) => {
      acc[m.modulo] = (acc[m.modulo] || 0) + 1
      return acc
    }, {})
    const partes = Object.entries(porModulo).map(
      ([k, v]) => `${v} ${k}${v > 1 ? "s" : ""}`,
    )
    resumen = `Encontradas ${deduped.length} coincidencia${
      deduped.length > 1 ? "s" : ""
    }: ${partes.join(", ")}.`
  }

  return { ok: true, matches: deduped, resumen }
}
