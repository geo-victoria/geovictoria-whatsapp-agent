import { NextResponse } from "next/server"

function getEnv(name: string) {
  return (process.env[name] || "").trim()
}

async function getZohoAccessToken() {
  const res = await fetch(`${getEnv("ZOHO_ACCOUNTS_DOMAIN") || "https://accounts.zoho.com"}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: getEnv("ZOHO_REFRESH_TOKEN"),
      client_id: getEnv("ZOHO_CLIENT_ID"),
      client_secret: getEnv("ZOHO_CLIENT_SECRET"),
      grant_type: "refresh_token",
    }),
    cache: "no-store",
  })
  const d = await res.json()
  if (!d?.access_token) throw new Error("No Zoho token")
  return String(d.access_token)
}

const MODULE = "VictorIA_Dapta_Whatsapp"
const API_DOMAIN = () => getEnv("ZOHO_API_DOMAIN") || "https://www.zohoapis.com"

export async function POST(request: Request) {
  try {
    const body = await request.json() as {
      action: "create" | "update"
      sessionId?: string
      contact?: string
      nombre?: string
      empresa?: string
      email?: string
      canal?: string
      etapa?: string
      score?: number
      transcript?: string
      zohoLeadId?: string
      appointmentBooked?: boolean
      sessionNumber?: number
      durationSeconds?: number
      botmakerChatId?: string
    }

    const token = await getZohoAccessToken()

    if (body.action === "create") {
      const nameParts = (body.nombre || "").trim().split(" ")
      const firstName = nameParts.slice(0, -1).join(" ") || nameParts[0] || ""
      const lastName = nameParts.length > 1 ? nameParts.slice(-1)[0] : ""
      const displayName = body.nombre
        ? `${body.nombre}${body.empresa ? ` - ${body.empresa}` : ""}`
        : `WA ${body.contact}`

      const record: Record<string, unknown> = {
        Name: displayName,
        Canal_Interacci_n: body.canal || "WhatsApp/Vicky",
        Tel_fono_Contacto: body.contact,
        Etapa_Funnel: body.etapa || "iniciada",
        N_mero_Intento: body.sessionNumber || 1,
        appointment_booked: false,
      }
      if (firstName) record.first_name = firstName
      if (lastName) record.last_name = lastName
      if (body.empresa) record.company = body.empresa
      if (body.email) record.Email = body.email
      if (body.botmakerChatId) {
        record.ID_Agente_Dapta = body.botmakerChatId
        record.Botmaker_Chat_URL = `https://go.botmaker.com/#/conversations/${body.botmakerChatId}`
      }

      const res = await fetch(`${API_DOMAIN()}/crm/v2/${MODULE}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Zoho-oauthtoken ${token}` },
        body: JSON.stringify({ data: [record] }),
        cache: "no-store",
      })
      const data = await res.json()
      const sessionId = data?.data?.[0]?.details?.id || null
      return NextResponse.json({ success: !!sessionId, sessionId })
    }

    if (body.action === "update" && body.sessionId) {
      const record: Record<string, unknown> = { id: body.sessionId }

      if (body.etapa) record.Etapa_Funnel = body.etapa
      if (body.score !== undefined) record.Score_Vicky = body.score
      if (body.appointmentBooked !== undefined) record.appointment_booked = body.appointmentBooked
      if (body.nombre) {
        const parts = body.nombre.trim().split(" ")
        record.first_name = parts.slice(0, -1).join(" ") || parts[0]
        if (parts.length > 1) record.last_name = parts.slice(-1)[0]
      }
      if (body.empresa) record.company = body.empresa
      if (body.email) record.Email = body.email
      if (body.durationSeconds !== undefined) record.Duraci_n_en_Segundos = body.durationSeconds
      if (body.transcript) record.Transcripci_n_Llamada = body.transcript.slice(0, 32000)
      if (body.zohoLeadId) {
        record.Lead_Contactado = { id: body.zohoLeadId }
      }

      const res = await fetch(`${API_DOMAIN()}/crm/v2/${MODULE}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Zoho-oauthtoken ${token}` },
        body: JSON.stringify({ data: [record] }),
        cache: "no-store",
      })
      const data = await res.json()
      const status = data?.data?.[0]?.status
      return NextResponse.json({ success: status === "success" })
    }

    return NextResponse.json({ error: "action requerido" }, { status: 400 })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error"
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
