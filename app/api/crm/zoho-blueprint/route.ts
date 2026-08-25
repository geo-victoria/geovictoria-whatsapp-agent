import { getZohoAccessToken } from '@/lib/zoho-token'
import { NextResponse } from "next/server"

function getEnv(name: string) {
  return (process.env[name] || "").trim()
}



// GET: obtener estado actual del Blueprint y transiciones disponibles
// POST: ejecutar una transición de Blueprint
export async function POST(request: Request) {
  try {
    const { recordId, module = "Leads", transitionId, fields, key } = await request.json() as {
      recordId: string
      module?: string
      transitionId?: string
      /** Campos mandatorios de la transición (van DENTRO del data del PUT). */
      fields?: Record<string, unknown>
      key?: string
    }
    // Auth cron (25-ago): el endpoint estaba abierto — ejecuta transiciones de
    // blueprint, eso jamás puede quedar público.
    const esperado = getEnv("CRON_SECRET")
    const entregado = (key || request.headers.get("x-cron-secret") || "").trim()
    if (!esperado || entregado !== esperado) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 })
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
      body: JSON.stringify({ blueprint: [{ transition_id: transitionId, ...(fields && Object.keys(fields).length ? { data: fields } : {}) }] }),
      cache: "no-store",
    })
    const data = await res.json()
    return NextResponse.json({ success: res.ok, data })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error"
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
