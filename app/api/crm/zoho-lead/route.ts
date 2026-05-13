import { NextResponse } from "next/server"

type LeadPayload = {
  type?: string
  contact?: string
  ownerEmail?: string
  lead?: {
    nombre?: string
    empresa?: string
    cargo?: string
    email?: string
    correo?: string
    telefono?: string
    pais?: string
    ciudad?: string
    trabajadores?: string
    necesidad?: string
    idioma?: string
    reunion_agendada?: boolean | string
    agendar_reunion?: string
    preferencia_horario?: string
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

// Maps number of employees to Zoho Rango_de_Empleados picklist value
function mapRangoEmpleados(trabajadores?: string): string | undefined {
  const n = parseInt((trabajadores || "").replace(/\D/g, ""))
  if (isNaN(n) || n <= 0) return undefined
  if (n <= 19)   return "1 - 19"
  if (n <= 49)   return "20 - 49"
  if (n <= 99)   return "50 - 99"
  if (n <= 199)  return "100 - 199"
  if (n <= 499)  return "200 - 499"
  if (n <= 999)  return "500 - 999"
  if (n <= 1999) return "1000 - 1999"
  if (n <= 2999) return "2000 - 2999"
  if (n <= 4999) return "3000 - 4999"
  return "5000 o más"
}

// Maps Vicky's product descriptions to Zoho picklist actual_values
function mapProductoSolucion(necesidad?: string): string | undefined {
  if (!necesidad) return undefined
  const n = necesidad.toLowerCase()
  if (n.includes("acceso")) return "Control de acceso"
  if (n.includes("comedor")) return "Servicio de  comedor" // double space is intentional — CRM typo
  if (n.includes("asistencia")) return "Control de Asistencia"
  return undefined
}

function sanitize(text: string | undefined, maxLen = 200): string {
  if (!text) return ""
  return text.replace(/[^\x20-\x7EÀ-ɏ -ÿ\n]/g, " ").slice(0, maxLen).trim()
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

async function getBotmakerChatUrl(phone: string): Promise<string | null> {
  const bmToken = getEnv("BOTMAKER_ACCESS_TOKEN")
  if (!bmToken || !phone) return null
  try {
    const normalized = phone.replace(/\D/g, "")
    const res = await fetch("https://api.botmaker.com/v2.0/chats?limit=200", {
      headers: { "access-token": bmToken, Accept: "application/json" },
      cache: "no-store",
    })
    if (!res.ok) return null
    const data = await res.json()
    const items = (data?.items || []) as Array<{ chat: { chatId: string; contactId: string } }>
    const match = items.find((item) => (item?.chat?.contactId || "").replace(/\D/g, "") === normalized)
    if (match?.chat?.chatId) return `https://go.botmaker.com/#/chats/${match.chat.chatId}`
  } catch { /* ignorar */ }
  return null
}

async function resolveOwnerId(email: string, token: string, apiDomain: string): Promise<string | null> {
  try {
    const res = await fetch(`${apiDomain}/crm/v2/users?type=AllUsers`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      cache: "no-store",
    })
    if (!res.ok) return null
    const data = await res.json()
    const users = (data?.users || []) as Array<{ id: string; email: string }>
    const match = users.find((u) => u.email?.toLowerCase() === email.toLowerCase())
    return match?.id || null
  } catch {
    return null
  }
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

    // Resolver owner y URL de Botmaker en paralelo
    const vickyOwnerId = getEnv("ZOHO_CRM_OWNER_ID") || "3525045000484500876"
    const [resolvedOwnerId, botmakerChatUrl] = await Promise.all([
      body.ownerEmail ? resolveOwnerId(body.ownerEmail, accessToken, apiDomain) : Promise.resolve(null),
      getBotmakerChatUrl(body.contact || ""),
    ])
    const ownerId = resolvedOwnerId || vickyOwnerId

    const record = {
      First_Name: sanitize(names.firstName, 100),
      Last_Name: sanitize(names.lastName, 100) || "Prospecto",
      Company: sanitize(lead.empresa, 200) || "Prospecto WhatsApp",
      Email: (lead.email || lead.correo || "").trim() || undefined,
      Phone: (lead.telefono || "").trim() || undefined,
      Country: sanitize(lead.pais, 100) || undefined,
      City: sanitize(lead.ciudad, 100) || undefined,
      Canal: "WhatsApp",
      Lead_Source: getEnv("ZOHO_DEFAULT_LEAD_SOURCE") || "SEO",
      ...(mapProductoSolucion(lead.necesidad) ? { Producto_Soluci_n: mapProductoSolucion(lead.necesidad) } : {}),
      ...(mapRangoEmpleados(lead.trabajadores) ? { Rango_de_Empleados: mapRangoEmpleados(lead.trabajadores) } : {}),
      ...(lead.trabajadores ? { N_Empleados_que_marcan: parseInt((lead.trabajadores).replace(/\D/g, "")) || undefined } : {}),
      Comentario: [
        `Necesidad: ${lead.necesidad || ""}`,
        `Cargo: ${lead.cargo || ""}`,
        `Trabajadores: ${lead.trabajadores || ""}`,
        `Sistema actual: ${lead.sistema_actual || ""}`,
        `Idioma: ${lead.idioma || ""}`,
        `Reunión agendada: ${lead.reunion_agendada ?? lead.agendar_reunion ?? ""}`,
        `Preferencia horario: ${lead.preferencia_horario || lead.fecha_propuesta || ""}`,
        `Contacto WA: ${body.contact || ""}`,
        transcript ? `\n--- Transcripción ---\n${transcript}` : "",
      ]
        .filter(Boolean)
        .join("\n")
        .trim(),
      Conversaci_n_Botmaker: botmakerChatUrl || undefined,
      Owner: { id: ownerId },
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
