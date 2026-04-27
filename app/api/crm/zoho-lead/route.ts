import { NextResponse } from "next/server"

type LeadPayload = {
  type?: string
  contact?: string
  lead?: {
    nombre?: string
    empresa?: string
    cargo?: string
    correo?: string
    telefono?: string
    pais?: string
    ciudad?: string
    trabajadores?: string
    necesidad?: string
    idioma?: string
    agendar_reunion?: string
    fecha_propuesta?: string
    sistema_actual?: string
  }
  conversation?: Array<{
    role?: string
    content?: string
    at?: string
  }>
}

function getEnv(name: string) {
  return (process.env[name] || "").trim()
}

function splitName(fullName?: string) {
  const clean = (fullName || "").trim()
  if (!clean) return { firstName: "", lastName: "Prospecto" }
  const parts = clean.split(/\s+/)
  if (parts.length === 1) return { firstName: "", lastName: parts[0] }
  return {
    firstName: parts.slice(0, -1).join(" "),
    lastName: parts.slice(-1).join(" "),
  }
}

function buildTranscript(conversation: LeadPayload["conversation"]) {
  const rows = Array.isArray(conversation) ? conversation : []
  return rows
    .map((m) => {
      const role = m?.role === "assistant" ? "Vic" : "Prospecto"
      const at = typeof m?.at === "string" ? m.at : ""
      const content = typeof m?.content === "string" ? m.content : ""
      return `${at} | ${role}: ${content}`
    })
    .join("\n")
    .slice(0, 32000)
}

async function getZohoAccessToken() {
  const accountsDomain = getEnv("ZOHO_ACCOUNTS_DOMAIN") || "https://accounts.zoho.com"
  const clientId = getEnv("ZOHO_CLIENT_ID")
  const clientSecret = getEnv("ZOHO_CLIENT_SECRET")
  const refreshToken = getEnv("ZOHO_REFRESH_TOKEN")

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Faltan credenciales OAuth de Zoho CRM")
  }

  const response = await fetch(`${accountsDomain}/oauth/v2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
    cache: "no-store",
  })

  const payload = await response.json()
  if (!response.ok || !payload?.access_token) {
    throw new Error(`No se pudo obtener access token Zoho: ${JSON.stringify(payload).slice(0, 400)}`)
  }

  return String(payload.access_token)
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as LeadPayload
    const lead = body.lead || {}
    const names = splitName(lead.nombre)
    const transcript = buildTranscript(body.conversation)

    const accessToken = await getZohoAccessToken()
    const apiDomain = getEnv("ZOHO_API_DOMAIN") || "https://www.zohoapis.com"
    const moduleName = getEnv("ZOHO_CRM_LEADS_MODULE") || "Leads"

    const record = {
      First_Name: names.firstName,
      Last_Name: names.lastName,
      Company: (lead.empresa || "Prospecto WhatsApp").slice(0, 200),
      Email: (lead.correo || "").trim() || undefined,
      Phone: (lead.telefono || "").trim() || undefined,
      Country: (lead.pais || "").trim() || undefined,
      City: (lead.ciudad || "").trim() || undefined,
      Description: [
        `Canal: WhatsApp`,
        `Necesidad: ${lead.necesidad || ""}`,
        `Cargo: ${lead.cargo || ""}`,
        `Trabajadores: ${lead.trabajadores || ""}`,
        `Sistema actual: ${lead.sistema_actual || ""}`,
        `Idioma: ${lead.idioma || ""}`,
        `Agendar reunión: ${lead.agendar_reunion || ""}`,
        `Fecha propuesta: ${lead.fecha_propuesta || ""}`,
        `Contacto WA: ${body.contact || ""}`,
        ``,
        `--- Conversación ---`,
        transcript,
      ]
        .join("\n")
        .trim()
        .slice(0, 32000),
    }

    const createResponse = await fetch(`${apiDomain}/crm/v2/${moduleName}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Zoho-oauthtoken ${accessToken}`,
      },
      body: JSON.stringify({
        data: [record],
        trigger: ["workflow"],
      }),
      cache: "no-store",
    })

    const createBody = await createResponse.json()
    const status = createBody?.data?.[0]?.status || ""
    const details = createBody?.data?.[0]?.details || {}
    const leadId = details?.id || null

    return NextResponse.json(
      {
        success: createResponse.ok && status === "success",
        zohoStatus: createResponse.status,
        zohoResult: status,
        leadId,
        details,
      },
      { status: createResponse.ok ? 200 : 502 },
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error inesperado"
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      Allow: "OPTIONS, POST",
    },
  })
}
