import { NextResponse } from "next/server"

function getEnv(name: string) {
  return (process.env[name] || "").trim()
}

async function getZohoAccessToken() {
  const accountsDomain = getEnv("ZOHO_ACCOUNTS_DOMAIN") || "https://accounts.zoho.com"
  const res = await fetch(`${accountsDomain}/oauth/v2/token`, {
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
  const data = await res.json()
  if (!data?.access_token) throw new Error("No Zoho token")
  return String(data.access_token)
}

export async function POST(request: Request) {
  try {
    const { moduleType, recordId, title, content } = await request.json() as {
      moduleType: "Leads" | "Deals" | "Contacts"
      recordId: string
      title: string
      content: string
    }

    if (!recordId || !content) {
      return NextResponse.json({ success: false, error: "recordId y content requeridos" }, { status: 400 })
    }

    const accessToken = await getZohoAccessToken()
    const apiDomain = getEnv("ZOHO_API_DOMAIN") || "https://www.zohoapis.com"

    const res = await fetch(`${apiDomain}/crm/v2/Notes`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Zoho-oauthtoken ${accessToken}`,
      },
      body: JSON.stringify({
        data: [{
          Note_Title: title || "WhatsApp Vicky",
          Note_Content: content,
          Parent_Id: recordId,
          "$se_module": moduleType || "Leads",
        }],
      }),
      cache: "no-store",
    })

    const data = await res.json()
    const status = data?.data?.[0]?.code
    const noteId = data?.data?.[0]?.details?.id

    return NextResponse.json({
      success: status === "SUCCESS",
      noteId,
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
