import { NextResponse } from "next/server"

const BM_TOKEN = (process.env.BOTMAKER_ACCESS_TOKEN || "").trim()
const BM_CHANNEL = "GeoVictoriaEspaol-whatsapp-56967308227"
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const ZOHO_BASE = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()

// ─── Zoho token ───────────────────────────────────────────────────────────────
async function getZohoToken() {
  const domain = (process.env.ZOHO_ACCOUNTS_DOMAIN || "https://accounts.zoho.com").trim()
  const res = await fetch(`${domain}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: (process.env.ZOHO_REFRESH_TOKEN || "").trim(),
      client_id: (process.env.ZOHO_CLIENT_ID || "").trim(),
      client_secret: (process.env.ZOHO_CLIENT_SECRET || "").trim(),
      grant_type: "refresh_token",
    }),
    cache: "no-store",
  })
  const d = await res.json()
  if (!d?.access_token) throw new Error("No Zoho token")
  return String(d.access_token)
}

// ─── Supabase helpers ─────────────────────────────────────────────────────────
async function supabaseQuery(sql: string) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${SUPABASE_URL.split(".")[0].split("//")[1]}/database/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SUPABASE_MANAGEMENT_KEY || "sbp_d89950a29512ce9051bc08d03a78cf66ee586b82"}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: sql }),
    cache: "no-store",
  })
  return res.json() as Promise<Array<Record<string, unknown>>>
}

async function getReengagementCount(contact: string, scenario: string): Promise<number> {
  const rows = await supabaseQuery(
    `SELECT COUNT(*) as cnt FROM vic_reengagement_log WHERE contact = '${contact}' AND scenario = '${scenario}'`
  )
  return Number(rows?.[0]?.cnt || 0)
}

async function logReengagement(contact: string, scenario: string, template: string, zohoId?: string, attempt?: number) {
  await supabaseQuery(
    `INSERT INTO vic_reengagement_log (contact, scenario, template, zoho_id, attempt_number) VALUES ('${contact}', '${scenario}', '${template}', ${zohoId ? `'${zohoId}'` : "NULL"}, ${attempt || 1})`
  )
}

// ─── Botmaker send ────────────────────────────────────────────────────────────
async function sendTemplate(phone: string, templateName: string): Promise<boolean> {
  const res = await fetch("https://api.botmaker.com/v2.0/notifications", {
    method: "POST",
    headers: {
      "access-token": BM_TOKEN,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      name: `reengagement_${templateName}_${Date.now()}`,
      intentIdOrName: templateName,
      channelId: BM_CHANNEL,
      contacts: [{ contactId: phone }],
    }),
    cache: "no-store",
  })
  return res.ok || res.status === 201
}

// ─── Zoho note ────────────────────────────────────────────────────────────────
async function createZohoNote(token: string, moduleType: string, recordId: string, title: string, content: string) {
  await fetch(`${ZOHO_BASE}/crm/v2/Notes`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Zoho-oauthtoken ${token}` },
    body: JSON.stringify({ data: [{ Note_Title: title, Note_Content: content, Parent_Id: recordId, "$se_module": moduleType }] }),
    cache: "no-store",
  })
}

// ─── Scenario 1: Lead sin reunión (48-240h sin Deal) ─────────────────────────
async function processLeadsSinReunion(token: string) {
  const since = new Date(Date.now() - 240 * 3600 * 1000).toISOString().split("T")[0]
  const until = new Date(Date.now() - 48 * 3600 * 1000).toISOString().split("T")[0]

  const res = await fetch(
    `${ZOHO_BASE}/crm/v2/Leads/search?criteria=((Canal:equals:WhatsApp)AND(Created_Time:between:${since},${until}))&fields=id,Phone,First_Name,Last_Name,Company&per_page=50`,
    { headers: { Authorization: `Zoho-oauthtoken ${token}` }, cache: "no-store" }
  )
  const data = await res.json()
  const leads = data?.data || []
  let sent = 0

  for (const lead of leads) {
    const phone = (lead.Phone || "").replace(/\D/g, "")
    if (!phone) continue

    // Verificar que no tenga Deal asociado
    const dealsRes = await fetch(
      `${ZOHO_BASE}/crm/v2/Leads/${lead.id}/Deals`,
      { headers: { Authorization: `Zoho-oauthtoken ${token}` }, cache: "no-store" }
    )
    const dealsData = await dealsRes.json()
    if ((dealsData?.data || []).length > 0) continue

    // Máximo 3 intentos
    const attempts = await getReengagementCount(phone, "sin_reunion")
    if (attempts >= 3) continue

    const ok = await sendTemplate(phone, "gv_vicky_sin_reunion_v2")
    if (!ok) continue

    const name = [lead.First_Name, lead.Last_Name].filter(Boolean).join(" ") || "Prospecto"
    const noteContent = `📱 Re-engagement WhatsApp enviado por Vicky\nTemplate: gv_vicky_sin_reunion_v2\nFecha: ${new Date().toLocaleString("es-CL", { timeZone: "America/Santiago" })}\nIntento: ${attempts + 1}/3\nMotivo: Lead sin reunión agendada`
    await createZohoNote(token, "Leads", lead.id, "WhatsApp Vicky - Seguimiento reunión", noteContent)
    await logReengagement(phone, "sin_reunion", "gv_vicky_sin_reunion_v2", lead.id, attempts + 1)
    sent++
  }

  return sent
}

// ─── Scenario 2: No-show (Deal Stage 1 con Event pasado 24-48h) ──────────────
async function processNoShows(token: string) {
  const since = new Date(Date.now() - 48 * 3600 * 1000).toISOString()
  const until = new Date(Date.now() - 24 * 3600 * 1000).toISOString()

  // Buscar Events del rango cuyo Deal está en Stage 1
  const eventsRes = await fetch(
    `${ZOHO_BASE}/crm/v2/Events/search?criteria=((Start_DateTime:between:${since},${until}))&fields=id,Event_Title,Start_DateTime,What_Id&per_page=50`,
    { headers: { Authorization: `Zoho-oauthtoken ${token}` }, cache: "no-store" }
  )
  const eventsData = await eventsRes.json()
  const events = eventsData?.data || []
  let sent = 0

  for (const event of events) {
    const dealId = event.What_Id?.id
    if (!dealId) continue

    // Verificar Stage del Deal
    const dealRes = await fetch(
      `${ZOHO_BASE}/crm/v2/Deals/${dealId}?fields=Stage,Contact_Name`,
      { headers: { Authorization: `Zoho-oauthtoken ${token}` }, cache: "no-store" }
    )
    const dealData = await dealRes.json()
    const deal = dealData?.data?.[0]
    if (!deal || deal.Stage !== "1. Trato Creado") continue

    // Obtener teléfono del Contact vinculado
    const contactId = deal.Contact_Name?.id
    if (!contactId) continue

    const contactRes = await fetch(
      `${ZOHO_BASE}/crm/v2/Contacts/${contactId}?fields=Phone,Mobile`,
      { headers: { Authorization: `Zoho-oauthtoken ${token}` }, cache: "no-store" }
    )
    const contactData = await contactRes.json()
    const contact = contactData?.data?.[0]
    const phone = ((contact?.Mobile || contact?.Phone || "").replace(/\D/g, ""))
    if (!phone) continue

    const attempts = await getReengagementCount(phone, "noshow")
    if (attempts >= 2) continue

    const ok = await sendTemplate(phone, "gv_vicky_noshow_v2")
    if (!ok) continue

    const noteContent = `📱 Re-engagement WhatsApp enviado por Vicky\nTemplate: gv_vicky_noshow_v2\nFecha: ${new Date().toLocaleString("es-CL", { timeZone: "America/Santiago" })}\nIntento: ${attempts + 1}/2\nMotivo: No se conectó a la reunión programada`
    await createZohoNote(token, "Deals", dealId, "WhatsApp Vicky - No-show reunión", noteContent)
    await logReengagement(phone, "noshow", "gv_vicky_noshow_v2", dealId, attempts + 1)
    sent++
  }

  return sent
}

// ─── Scenario 3: Reactivación (conversación sin lead >30 días) ───────────────
async function processReactivaciones() {
  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString()
  const rows = await supabaseQuery(
    `SELECT contact FROM vic_conversations WHERE zoho_lead_id IS NULL AND updated_at < '${cutoff}' AND contact IS NOT NULL`
  )

  let sent = 0
  for (const row of rows || []) {
    const phone = String(row.contact || "").replace(/\D/g, "")
    if (!phone) continue

    const attempts = await getReengagementCount(phone, "reactivacion")
    if (attempts >= 1) continue

    const ok = await sendTemplate(phone, "gv_vicky_retomar_v2")
    if (!ok) continue

    await logReengagement(phone, "reactivacion", "gv_vicky_retomar_v2", undefined, 1)
    sent++
  }

  return sent
}

// ─── Handler principal ────────────────────────────────────────────────────────
export async function GET(request: Request) {
  // Verificar que sea llamada autorizada (cron de Vercel o llamada manual)
  const authHeader = request.headers.get("authorization")
  const cronSecret = (process.env.CRON_SECRET || "").trim()
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const token = await getZohoToken()

    const [sinReunion, noShows, reactivaciones] = await Promise.allSettled([
      processLeadsSinReunion(token),
      processNoShows(token),
      processReactivaciones(),
    ])

    const result = {
      sin_reunion: sinReunion.status === "fulfilled" ? sinReunion.value : 0,
      noshow: noShows.status === "fulfilled" ? noShows.value : 0,
      reactivacion: reactivaciones.status === "fulfilled" ? reactivaciones.value : 0,
      ran_at: new Date().toISOString(),
    }

    console.log("[reengagement]", result)
    return NextResponse.json({ success: true, ...result })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error inesperado"
    console.error("[reengagement] error:", message)
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
