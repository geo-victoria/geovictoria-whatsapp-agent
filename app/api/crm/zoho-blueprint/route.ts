import { getZohoAccessToken } from '@/lib/zoho-token'
import { NextResponse } from "next/server"

function getEnv(name: string) {
  return (process.env[name] || "").trim()
}



// GET: obtener estado actual del Blueprint y transiciones disponibles
// POST: ejecutar una transición de Blueprint
export async function POST(request: Request) {
  try {
    const { recordId, module = "Leads", transitionId } = await request.json() as {
      recordId: string
      module?: string
      transitionId?: string
    }
    if (!recordId) return NextResponse.json({ error: "recordId requerido" }, { status: 400 })

    const token = await getZohoAccessToken()
    const apiDomain = getEnv("ZOHO_API_DOMAIN") || "https://www.zohoapis.com"

    // Si no hay transitionId, devolver las transiciones disponibles
    if (!transitionId) {
      const res = await fetch(`${apiDomain}/crm/v2/${module}/${recordId}/actions/blueprint`, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        cache: "no-store",
      })
      const data = await res.json()
      return NextResponse.json({ success: res.ok, data })
    }

    // Ejecutar la transición
    const res = await fetch(`${apiDomain}/crm/v2/${module}/${recordId}/actions/blueprint`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Zoho-oauthtoken ${token}` },
      body: JSON.stringify({ blueprint: [{ transition_id: transitionId, data: [{ id: recordId }] }] }),
      cache: "no-store",
    })
    const data = await res.json()
    return NextResponse.json({ success: res.ok, data })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error"
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
