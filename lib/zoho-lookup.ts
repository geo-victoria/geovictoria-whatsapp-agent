import { getZohoAccessToken } from './zoho-token'

function getEnv(name: string) {
  return (process.env[name] || "").trim()
}

type ZohoOwner = {
  name: string
  email: string
  phone?: string
}

export type ZohoLookupResult = {
  found: boolean
  type?: "lead" | "deal"
  recordId?: string
  status?: string
  isActive: boolean
  isClient?: boolean
  owner?: ZohoOwner
  prospectName?: string
  prospectEmail?: string
  empresa?: string
}

// Statuses/stages that mark a record as inactive (case-insensitive substring match)
const INACTIVE_LEAD_KEYWORDS = ["lost", "junk", "not interested", "converted", "perdido", "no interesa", "descartado", "no_contactado", "cerrado"]
const CLOSED_DEAL_KEYWORDS = ["closed won", "closed lost", "ganado", "perdido", "cerrado"]
const WON_DEAL_KEYWORDS = ["closed won", "ganado"]

function isLeadActive(status: string): boolean {
  const s = status.toLowerCase()
  return !INACTIVE_LEAD_KEYWORDS.some(kw => s.includes(kw))
}

function isDealActive(stage: string): boolean {
  const s = stage.toLowerCase()
  return !CLOSED_DEAL_KEYWORDS.some(kw => s.includes(kw))
}

function isDealWon(stage: string): boolean {
  const s = stage.toLowerCase()
  return WON_DEAL_KEYWORDS.some(kw => s.includes(kw))
}

async function getOwnerPhone(ownerId: string, token: string, apiDomain: string): Promise<string | undefined> {
  if (!ownerId) return undefined
  try {
    const res = await fetch(`${apiDomain}/crm/v2/users/${ownerId}`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      cache: "no-store",
    })
    if (!res.ok) return undefined
    const data = await res.json()
    return (data?.users?.[0]?.phone as string | undefined) || undefined
  } catch {
    return undefined
  }
}

export async function lookupZohoByPhone(phone: string): Promise<ZohoLookupResult> {
  const apiDomain = getEnv("ZOHO_API_DOMAIN") || "https://www.zohoapis.com"

  let token: string
  try {
    token = await getZohoAccessToken()
  } catch {
    return { found: false, isActive: false }
  }

  const normalized = "+" + phone.replace(/\D/g, "")

  // 1. Search Leads by phone
  try {
    const res = await fetch(
      `${apiDomain}/crm/v3/Leads/search?criteria=(Phone:equals:${encodeURIComponent(normalized)})&fields=id,First_Name,Last_Name,Lead_Status,Owner,Email,Company&per_page=1`,
      { headers: { Authorization: `Zoho-oauthtoken ${token}` }, cache: "no-store" },
    )
    if (res.ok) {
      const data = await res.json()
      const lead = (data?.data as Array<Record<string, unknown>> | undefined)?.[0]
      if (lead) {
        const status = (lead.Lead_Status as string) || ""
        const ownerObj = lead.Owner as Record<string, string> | undefined
        const ownerName = ownerObj?.name || ""
        const ownerEmail = ownerObj?.email || ""
        const ownerId = ownerObj?.id || ""
        const active = isLeadActive(status)
        const ownerPhone = ownerEmail ? await getOwnerPhone(ownerId, token, apiDomain) : undefined

        return {
          found: true,
          type: "lead",
          recordId: lead.id as string,
          status,
          isActive: active,
          isClient: false,
          owner: ownerEmail ? { name: ownerName, email: ownerEmail, phone: ownerPhone } : undefined,
          prospectName: [lead.First_Name, lead.Last_Name].filter(Boolean).join(" ").trim() || undefined,
          prospectEmail: (lead.Email as string) || undefined,
          empresa: (lead.Company as string) || undefined,
        }
      }
    }
  } catch { /* continue to Contact/Deal search */ }

  // 2. Search Contacts by phone → then Deals
  try {
    const contactRes = await fetch(
      `${apiDomain}/crm/v3/Contacts/search?criteria=(Phone:equals:${encodeURIComponent(normalized)})&fields=id,First_Name,Last_Name,Email,Account_Name&per_page=1`,
      { headers: { Authorization: `Zoho-oauthtoken ${token}` }, cache: "no-store" },
    )
    if (contactRes.ok) {
      const contactData = await contactRes.json()
      const contact = (contactData?.data as Array<Record<string, unknown>> | undefined)?.[0]
      if (contact) {
        const dealRes = await fetch(
          `${apiDomain}/crm/v3/Contacts/${contact.id}/Deals?fields=id,Deal_Name,Stage,Owner&sort_by=Modified_Time&sort_order=desc&per_page=1`,
          { headers: { Authorization: `Zoho-oauthtoken ${token}` }, cache: "no-store" },
        )
        if (dealRes.ok) {
          const dealData = await dealRes.json()
          const deal = (dealData?.data as Array<Record<string, unknown>> | undefined)?.[0]
          if (deal) {
            const stage = (deal.Stage as string) || ""
            const ownerObj = deal.Owner as Record<string, string> | undefined
            const ownerName = ownerObj?.name || ""
            const ownerEmail = ownerObj?.email || ""
            const ownerId = ownerObj?.id || ""
            const active = isDealActive(stage)
            const client = isDealWon(stage)
            const ownerPhone = ownerEmail ? await getOwnerPhone(ownerId, token, apiDomain) : undefined

            const accountName = contact.Account_Name
            const empresa = typeof accountName === "string"
              ? accountName
              : (accountName as Record<string, string> | undefined)?.name || undefined

            return {
              found: true,
              type: "deal",
              recordId: deal.id as string,
              status: stage,
              isActive: active,
              isClient: client,
              owner: ownerEmail ? { name: ownerName, email: ownerEmail, phone: ownerPhone } : undefined,
              prospectName: [contact.First_Name, contact.Last_Name].filter(Boolean).join(" ").trim() || undefined,
              prospectEmail: (contact.Email as string) || undefined,
              empresa,
            }
          }
        }
      }
    }
  } catch { /* no record found */ }

  return { found: false, isActive: false }
}

// Template IDs (created in Zoho CRM)
export const ZOHO_TEMPLATE_LEAD = "3525045000628201067"   // "Re-contacto Lead via WhatsApp - Vicky"
export const ZOHO_TEMPLATE_DEAL = "3525045000628170097"   // "Re-contacto Deal via WhatsApp - Vicky"

export async function sendZohoTemplateEmail(
  recordId: string,
  recordType: "lead" | "deal",
  templateId: string,
): Promise<void> {
  const apiDomain = getEnv("ZOHO_API_DOMAIN") || "https://www.zohoapis.com"
  let token: string
  try {
    token = await getZohoAccessToken()
  } catch {
    return
  }
  const module = recordType === "lead" ? "Leads" : "Deals"
  await fetch(`${apiDomain}/crm/v3/${module}/${recordId}/actions/send_mail`, {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      data: [{
        from: { user_name: "Vicky IA GeoVictoria", email: "noreply@geovictoria.com" },
        reply_to: { user_name: "Vicky IA GeoVictoria", email: "noreply@geovictoria.com" },
        template: { id: templateId },
      }],
    }),
    cache: "no-store",
  }).catch(() => {})
}
