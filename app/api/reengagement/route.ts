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
async function sendTemplate(phone: string, templateName: string, nombre?: string): Promise<boolean> {
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
      contacts: [{ contactId: phone, ...(nombre ? { variables: { nombre } } : {}) }],
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

    const name = [lead.First_Name, lead.Last_Name].filter(Boolean).join(" ") || "Prospecto"
    const ok = await sendTemplate(phone, "gv_vicky_sin_reunion_v3", lead.First_Name || undefined)
    if (!ok) continue

    const noteContent = `📱 Re-engagement WhatsApp enviado por Vicky\nTemplate: gv_vicky_sin_reunion_v3\nFecha: ${new Date().toLocaleString("es-CL", { timeZone: "America/Santiago" })}\nIntento: ${attempts + 1}/3\nMotivo: Lead sin reunión agendada`
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

    const ok = await sendTemplate(phone, "gv_vicky_noshow_v3", contact?.firstName || undefined)
    if (!ok) continue

    const noteContent = `📱 Re-engagement WhatsApp enviado por Vicky\nTemplate: gv_vicky_noshow_v3\nFecha: ${new Date().toLocaleString("es-CL", { timeZone: "America/Santiago" })}\nIntento: ${attempts + 1}/2\nMotivo: No se conectó a la reunión programada`
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

    const ok = await sendTemplate(phone, "gv_vicky_retomar_v3")
    if (!ok) continue

    await logReengagement(phone, "reactivacion", "gv_vicky_retomar_v3", undefined, 1)
    sent++
  }

  return sent
}

// ─── Conciliación Supabase → Zoho VictorIA ───────────────────────────────────
async function processConsolidacionZoho(token: string): Promise<number> {
  // Buscar conversaciones sin registro en VictorIA (sin zoho_session_id)
  // que tengan al menos 30 minutos de antigüedad
  const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString()
  const supabaseUrl = (SUPABASE_URL).trim()
  const supabaseKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
  if (!supabaseUrl || !supabaseKey) return 0

  const res = await fetch(
    `https://${supabaseUrl.split("//")[1]}/rest/v1/vic_conversations?zoho_session_id=is.null&updated_at=lt.${cutoff}&select=contact,lead,zoho_lead_id,session_number,session_started_at,meeting_booked&limit=50`,
    { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` }, cache: "no-store" }
  )
  const conversations = await res.json() as Array<Record<string, unknown>>
  if (!Array.isArray(conversations) || conversations.length === 0) return 0

  const apiDomain = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
  let synced = 0

  for (const conv of conversations) {
    const contact = String(conv.contact || "")
    if (!contact) continue

    const lead = conv.lead as Record<string, unknown> | null
    const zohoLeadId = conv.zoho_lead_id as string | null
    const meetingBooked = Boolean(conv.meeting_booked)

    // Buscar si ya existe en Zoho por teléfono (evita duplicados)
    const searchRes = await fetch(
      `${apiDomain}/crm/v2/VictorIA_Dapta_Whatsapp/search?criteria=((Tel_fono_Contacto:equals:${contact}))&fields=id&per_page=1`,
      { headers: { Authorization: `Zoho-oauthtoken ${token}` }, cache: "no-store" }
    )
    const searchData = await searchRes.json()
    let sessionId: string | null = searchData?.data?.[0]?.id || null

    if (!sessionId) {
      // Crear nuevo registro
      const nombre = String(lead?.nombre || "")
      const nameParts = nombre.trim().split(" ")
      const etapa = meetingBooked ? "reunion_agendada" : zohoLeadId ? "lead_capturado" : "iniciada"
      const record: Record<string, unknown> = {
        Name: nombre ? `${nombre}${lead?.empresa ? ` - ${lead.empresa}` : ""}` : `WA ${contact}`,
        Canal_Interacci_n: "WhatsApp/Vicky",
        Tel_fono_Contacto: contact,
        Etapa_Funnel: etapa,
        N_mero_Intento: Number(conv.session_number) || 1,
        appointment_booked: meetingBooked,
      }
      if (nameParts.length > 1) { record.first_name = nameParts.slice(0, -1).join(" "); record.last_name = nameParts.slice(-1)[0] }
      else if (nameParts[0]) record.first_name = nameParts[0]
      if (lead?.empresa) record.company = String(lead.empresa)
      if (lead?.email || lead?.correo) record.Email = String(lead?.email || lead?.correo)
      if (zohoLeadId) record.Lead_Contactado = { id: zohoLeadId }

      const createRes = await fetch(`${apiDomain}/crm/v2/VictorIA_Dapta_Whatsapp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Zoho-oauthtoken ${token}` },
        body: JSON.stringify({ data: [record] }),
        cache: "no-store",
      })
      const createData = await createRes.json()
      sessionId = createData?.data?.[0]?.details?.id || null
    }

    if (sessionId) {
      // Guardar zoho_session_id en Supabase
      await fetch(`https://${supabaseUrl.split("//")[1]}/rest/v1/vic_conversations?contact=eq.${contact}`, {
        method: "PATCH",
        headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ zoho_session_id: sessionId }),
        cache: "no-store",
      })
      synced++
    }
  }

  return synced
}

// ─── Crear leads en Zoho para contactos sin zoho_lead_id (ghost users) ──────
async function processLeadsSinZoho(): Promise<number> {
  const supabaseUrl = SUPABASE_URL.trim()
  const supabaseKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
  const crmUrl = (process.env.CRM_LEAD_WEBHOOK_URL || "").trim()
  if (!supabaseUrl || !supabaseKey || !crmUrl) return 0

  const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString()
  const res = await fetch(
    `https://${supabaseUrl.split("//")[1]}/rest/v1/vic_conversations?zoho_lead_id=is.null&updated_at=lt.${cutoff}&lead=not.is.null&select=contact,lead&limit=50`,
    { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` }, cache: "no-store" }
  )
  const rows = await res.json() as Array<{ contact: string; lead: Record<string, unknown> }>
  if (!Array.isArray(rows) || rows.length === 0) return 0

  let created = 0
  for (const row of rows) {
    const contact = String(row.contact || "")
    const lead = row.lead
    if (!contact || !lead?.nombre) continue

    try {
      const createRes = await fetch(crmUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "lead_captured", contact, lead, source: "whatsapp_agent_vic_cron" }),
        cache: "no-store",
      })
      if (!createRes.ok) continue
      const data = await createRes.json() as { leadId?: string }
      const leadId = data?.leadId
      if (!leadId) continue

      await fetch(`https://${supabaseUrl.split("//")[1]}/rest/v1/vic_conversations?contact=eq.${contact}`, {
        method: "PATCH",
        headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ zoho_lead_id: leadId }),
        cache: "no-store",
      })
      created++
    } catch { /* continuar con el siguiente */ }
  }
  return created
}

// ─── Vincular Lead_Contactado en registros VictorIA existentes ───────────────
async function processVictoriaLeadLinks(token: string): Promise<number> {
  const supabaseUrl = SUPABASE_URL.trim()
  const supabaseKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
  if (!supabaseUrl || !supabaseKey) return 0

  // Conversaciones que tienen ambos IDs — el link en Zoho podría estar faltando
  const res = await fetch(
    `https://${supabaseUrl.split("//")[1]}/rest/v1/vic_conversations?zoho_session_id=not.null&zoho_lead_id=not.null&select=zoho_session_id,zoho_lead_id&limit=100`,
    { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` }, cache: "no-store" }
  )
  const rows = await res.json() as Array<{ zoho_session_id: string; zoho_lead_id: string }>
  if (!Array.isArray(rows) || rows.length === 0) return 0

  const apiDomain = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
  let linked = 0

  // Actualizar en lote de 10 para no saturar la API de Zoho
  const chunks = Array.from({ length: Math.ceil(rows.length / 10) }, (_, i) => rows.slice(i * 10, i * 10 + 10))
  for (const chunk of chunks) {
    const data = chunk.map(r => ({ id: r.zoho_session_id, Lead_Contactado: { id: r.zoho_lead_id } }))
    const putRes = await fetch(`${apiDomain}/crm/v2/VictorIA_Dapta_Whatsapp`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Zoho-oauthtoken ${token}` },
      body: JSON.stringify({ data }),
      cache: "no-store",
    })
    const putData = await putRes.json()
    linked += (putData?.data || []).filter((d: any) => d?.status === "success").length
  }

  return linked
}

// ─── Reporte diario WhatsApp ──────────────────────────────────────────────────
async function sendReporteDiario(): Promise<void> {
  const accessToken = (process.env.WHATSAPP_ACCESS_TOKEN || "").trim()
  const phoneNumberId = (process.env.WHATSAPP_PHONE_NUMBER_ID || "").trim()
  const reportPhone = (process.env.VICKY_REPORT_PHONE || "56944668823").trim()
  const supabaseUrl = SUPABASE_URL.trim()
  const supabaseKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
  if (!accessToken || !phoneNumberId || !supabaseUrl || !supabaseKey) return

  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  yesterday.setHours(0, 0, 0, 0)
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)

  const res = await fetch(
    `https://${supabaseUrl.split("//")[1]}/rest/v1/vic_evaluations?created_at=gte.${yesterday.toISOString()}&created_at=lt.${todayStart.toISOString()}&select=contact,evaluation,created_at&limit=200`,
    { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` }, cache: "no-store" }
  )
  const evals = await res.json() as Array<{ contact: string; evaluation: { score_total: number; lead_capturado: boolean; reunion_agendada: boolean; punto_de_quiebre: string | null; resumen: string } }>
  if (!Array.isArray(evals) || evals.length === 0) return

  const total = evals.length
  const avgScore = Math.round(evals.reduce((s, e) => s + (e.evaluation?.score_total || 0), 0) / total)
  const leads = evals.filter(e => e.evaluation?.lead_capturado).length
  const reuniones = evals.filter(e => e.evaluation?.reunion_agendada).length
  const problematicas = evals.filter(e => (e.evaluation?.score_total || 0) < 50)

  const fecha = yesterday.toLocaleDateString("es-CL", { weekday: "long", day: "numeric", month: "long" })

  const lines = [
    `📊 *Reporte Vicky — ${fecha}*`,
    ``,
    `Conversaciones: ${total} | Leads: ${leads} | Reuniones: ${reuniones} | Score prom: ${avgScore}/100`,
  ]

  if (problematicas.length > 0) {
    lines.push(``, `🔴 *Conversaciones problemáticas (score < 50):*`)
    for (const p of problematicas.slice(0, 5)) {
      const score = p.evaluation?.score_total || 0
      const quiebre = p.evaluation?.punto_de_quiebre || "sin datos"
      lines.push(`• ${p.contact} — score ${score}`)
      lines.push(`  _${quiebre}_`)
    }
    if (problematicas.length > 5) lines.push(`  ...y ${problematicas.length - 5} más`)
  } else {
    lines.push(``, `✅ Sin conversaciones problemáticas ayer`)
  }

  const mensaje = lines.join("\n")

  await fetch(`https://graph.facebook.com/v22.0/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: reportPhone,
      type: "text",
      text: { body: mensaje },
    }),
    cache: "no-store",
  })
}

// ─── Handler principal ────────────────────────────────────────────────────────
export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization")
  const cronSecret = (process.env.CRON_SECRET || "").trim()
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const token = await getZohoToken()

    const [sinReunion, noShows, reactivaciones, consolidacion, victoriaLinks, leadsSinZoho] = await Promise.allSettled([
      processLeadsSinReunion(token),
      processNoShows(token),
      processReactivaciones(),
      processConsolidacionZoho(token),
      processVictoriaLeadLinks(token),
      processLeadsSinZoho(),
    ])

    sendReporteDiario().catch(() => {})

    const result = {
      sin_reunion: sinReunion.status === "fulfilled" ? sinReunion.value : 0,
      noshow: noShows.status === "fulfilled" ? noShows.value : 0,
      reactivacion: reactivaciones.status === "fulfilled" ? reactivaciones.value : 0,
      consolidacion_zoho: consolidacion.status === "fulfilled" ? consolidacion.value : 0,
      victoria_links: victoriaLinks.status === "fulfilled" ? victoriaLinks.value : 0,
      leads_sin_zoho: leadsSinZoho.status === "fulfilled" ? leadsSinZoho.value : 0,
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
