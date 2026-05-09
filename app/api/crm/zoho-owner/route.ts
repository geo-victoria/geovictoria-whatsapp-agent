import { NextResponse } from "next/server"

function getEnv(name: string) {
  return (process.env[name] || "").trim()
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
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
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

async function getZohoUserIdByEmail(email: string, accessToken: string): Promise<string | null> {
  const apiDomain = getEnv("ZOHO_API_DOMAIN") || "https://www.zohoapis.com"
  const res = await fetch(`${apiDomain}/crm/v2/users?type=ActiveUsers`, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    cache: "no-store",
  })

  if (!res.ok) return null

  const data = await res.json() as { users?: Array<{ id: string; email: string }> }
  const user = (data.users || []).find((u) => u.email.toLowerCase() === email.toLowerCase())
  return user?.id ?? null
}

export async function POST(request: Request) {
  try {
    const { leadId, ownerEmail } = await request.json() as { leadId?: string; ownerEmail?: string }

    if (!leadId || !ownerEmail) {
      return NextResponse.json({ success: false, error: "leadId y ownerEmail son requeridos" }, { status: 400 })
    }

    const accessToken = await getZohoAccessToken()
    const ownerId = await getZohoUserIdByEmail(ownerEmail, accessToken)

    if (!ownerId) {
      return NextResponse.json({ success: false, error: `Usuario no encontrado en Zoho: ${ownerEmail}` }, { status: 404 })
    }

    const apiDomain = getEnv("ZOHO_API_DOMAIN") || "https://www.zohoapis.com"
    const moduleName = getEnv("ZOHO_CRM_LEADS_MODULE") || "Leads"

    const res = await fetch(`${apiDomain}/crm/v2/${moduleName}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Zoho-oauthtoken ${accessToken}`,
      },
      body: JSON.stringify({
        data: [{ id: leadId, Owner: { id: ownerId } }],
      }),
      cache: "no-store",
    })

    const body = await res.json()
    const status = body?.data?.[0]?.status

    return NextResponse.json({
      success: res.ok && status === "success",
      ownerId,
      ownerEmail,
      zohoStatus: status,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error inesperado"
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { Allow: "OPTIONS, POST" } })
}
