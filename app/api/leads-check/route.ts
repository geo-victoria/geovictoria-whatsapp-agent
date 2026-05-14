import { NextResponse } from "next/server"

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const CRM_URL = (process.env.CRM_LEAD_WEBHOOK_URL || "").trim()
const WA_TOKEN = (process.env.WHATSAPP_ACCESS_TOKEN || "").trim()
const WA_PHONE_ID = (process.env.WHATSAPP_PHONE_NUMBER_ID || "").trim()

async function sendWhatsApp(to: string, text: string) {
  if (!WA_TOKEN || !WA_PHONE_ID) return
  await fetch(`https://graph.facebook.com/v22.0/${WA_PHONE_ID}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${WA_TOKEN}` },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text } }),
    cache: "no-store",
  }).catch(() => {})
}

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization")
  const cronSecret = (process.env.CRON_SECRET || "").trim()
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  if (!SUPABASE_URL || !SUPABASE_KEY || !CRM_URL) {
    return NextResponse.json({ error: "Not configured" }, { status: 500 })
  }

  const cutoff = new Date(Date.now() - 25 * 60 * 1000).toISOString() // 25 min de antigüedad

  // Buscar conversaciones con lead completo, sin Zoho ID, sin reunión agendada
  const res = await fetch(
    `https://${SUPABASE_URL.split("//")[1]}/rest/v1/vic_conversations?zoho_lead_id=is.null&meeting_booked=eq.false&updated_at=lt.${cutoff}&lead=not.is.null&is_support=eq.false&select=contact,lead,organizer_email`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, cache: "no-store" }
  )
  const rows = await res.json() as Array<{ contact: string; lead: Record<string, string>; organizer_email?: string }>

  if (!Array.isArray(rows) || rows.length === 0) {
    return NextResponse.json({ processed: 0 })
  }

  let created = 0
  let messaged = 0

  for (const row of rows) {
    const { contact, lead, organizer_email } = row
    if (!contact || !lead?.nombre) continue

    try {
      // Crear lead en Zoho
      const createRes = await fetch(CRM_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "lead_captured", contact, lead,
          source: "whatsapp_agent_vic_leads_check",
          ...(organizer_email ? { ownerEmail: organizer_email } : {}),
        }),
        cache: "no-store",
      })

      if (!createRes.ok) continue
      const data = await createRes.json() as { leadId?: string }
      const leadId = data?.leadId
      if (!leadId) continue

      // Actualizar zoho_lead_id en Supabase
      await fetch(`https://${SUPABASE_URL.split("//")[1]}/rest/v1/vic_conversations?contact=eq.${contact}`, {
        method: "PATCH",
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ zoho_lead_id: leadId }),
        cache: "no-store",
      })

      created++

      // Enviar mensaje de cierre al usuario (solo si tiene email = conversación real)
      if (lead.email || lead.correo) {
        const name = lead.nombre?.split(" ")[0] || ""
        const closing = `${name ? `Oye ${name}, n` : "N"}o te preocupes si no pudiste elegir un horario, no es necesario agendar una reunión para que te ayudemos 😊 Ya tenemos tus datos y un ejecutivo te contactará cuanto antes. ¡Hasta pronto!`
        await sendWhatsApp(contact, closing)
        messaged++
      }
    } catch { /* continuar con el siguiente */ }
  }

  console.log(`[leads-check] created=${created} messaged=${messaged}`)
  return NextResponse.json({ processed: rows.length, created, messaged })
}
