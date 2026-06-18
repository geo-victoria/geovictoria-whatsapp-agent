/**
 * Helper para crear Leads en Zoho CRM desde Vicky V3.
 *
 * Diferencia operativa CLAVE con respecto al ownerEmail:
 *   - Si NO se pasa ownerEmail → Owner = vicky default → entra a TÓMBOLA.
 *   - Si SÍ se pasa ownerEmail → resuelve user_id por email → asigna directo (NO tómbola).
 *
 * Usado por:
 *   - registrar_solicitud_callback (sin ownerEmail → tómbola)
 *   - agendar_reunion (con ownerEmail = organizerEmail Cal.com → directo)
 */

import { getZohoAccessToken } from "./zoho-token"

function getEnv(name: string): string {
  return (process.env[name] || "").trim()
}

function splitName(fullName?: string): { firstName: string; lastName: string } {
  const clean = (fullName || "").trim()
  if (!clean) return { firstName: "", lastName: "Prospecto" }
  const parts = clean.split(/\s+/)
  if (parts.length === 1) return { firstName: "", lastName: parts[0] }
  return {
    firstName: parts.slice(0, -1).join(" "),
    lastName: parts.slice(-1).join(" "),
  }
}

function mapRangoEmpleados(trabajadores?: string | number): string | undefined {
  const raw = typeof trabajadores === "number" ? String(trabajadores) : trabajadores || ""
  const n = parseInt(raw.replace(/\D/g, ""))
  if (isNaN(n) || n <= 0) return undefined
  if (n <= 19) return "1 - 19"
  if (n <= 49) return "20 - 49"
  if (n <= 99) return "50 - 99"
  if (n <= 199) return "100 - 199"
  if (n <= 499) return "200 - 499"
  if (n <= 999) return "500 - 999"
  if (n <= 1999) return "1000 - 1999"
  if (n <= 2999) return "2000 - 2999"
  if (n <= 4999) return "3000 - 4999"
  return "5000 o más"
}

function mapProductoSolucion(necesidad?: string): string | undefined {
  if (!necesidad) return undefined
  const n = necesidad.toLowerCase()
  if (n.includes("acceso")) return "Control de acceso"
  if (n.includes("comedor")) return "Servicio de  comedor"
  if (n.includes("asistencia")) return "Control de Asistencia"
  return undefined
}

function sanitize(text: string | undefined, maxLen = 200): string {
  if (!text) return ""
  return text.replace(/[^\x20-\x7EÀ-ɏ -ÿ\n]/g, " ").slice(0, maxLen).trim()
}

function buildTranscript(
  conversation?: Array<{ role?: string; content?: string; at?: string }>,
): string {
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

async function resolveOwnerId(
  email: string,
  token: string,
  apiDomain: string,
): Promise<string | null> {
  try {
    const res = await fetch(`${apiDomain}/crm/v2/users?type=AllUsers`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      cache: "no-store",
    })
    if (!res.ok) return null
    const data = (await res.json()) as { users?: Array<{ id: string; email: string }> }
    const users = data?.users || []
    const match = users.find((u) => u.email?.toLowerCase() === email.toLowerCase())
    return match?.id || null
  } catch {
    return null
  }
}

/**
 * Actualiza el Owner de un Lead existente (al reagendar con cambio de host).
 * Resuelve el user_id por email; si no lo encuentra, NO toca el owner (evita
 * dejarlo en un id inválido). Best-effort: nunca rompe el flujo de reagendar.
 */
export async function updateZohoLeadOwner(
  leadId: string,
  ownerEmail: string,
): Promise<{ success: boolean; error?: string }> {
  if (!leadId || !ownerEmail) return { success: false, error: "leadId u ownerEmail faltante" }
  try {
    const accessToken = await getZohoAccessToken()
    const apiDomain = getEnv("ZOHO_API_DOMAIN") || "https://www.zohoapis.com"
    const moduleName = getEnv("ZOHO_CRM_LEADS_MODULE") || "Leads"

    const ownerId = await resolveOwnerId(ownerEmail, accessToken, apiDomain)
    if (!ownerId) return { success: false, error: `No se resolvió user_id para ${ownerEmail}` }

    const res = await fetch(`${apiDomain}/crm/v2/${moduleName}/${leadId}`, {
      method: "PUT",
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
      body: JSON.stringify({ data: [{ Owner: { id: ownerId } }] }),
    })
    const data = (await res.json().catch(() => ({}))) as {
      data?: Array<{ status?: string; code?: string; message?: string }>
    }
    const status = data?.data?.[0]?.status
    if (!res.ok || status !== "success") {
      return { success: false, error: `Zoho update owner: ${JSON.stringify(data).slice(0, 200)}` }
    }
    return { success: true }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "error actualizando owner del lead" }
  }
}

export type CreateZohoLeadInput = {
  nombre?: string
  empresa?: string
  email?: string
  telefono?: string
  cargo?: string
  pais?: string
  ciudad?: string
  trabajadores?: string | number
  necesidad?: string
  idioma?: string
  reunionAgendada?: boolean
  preferenciaHorario?: string
  sistemaActual?: string
  contactoWA?: string
  ownerEmail?: string
  conversacion?: Array<{ role?: string; content?: string; at?: string }>
}

export type CreateZohoLeadResult =
  | {
      success: true
      leadId: string
      entraATombola: boolean
      ownerEmail: string
    }
  | {
      success: false
      error: string
    }

const VICKY_DEFAULT_OWNER_EMAIL = "vicky@geovictoria.com"

// Id de Vicky en Zoho. Los leads SIN reunión deben quedar SIEMPRE con este
// owner (entran a tómbola). No se usa ZOHO_CRM_OWNER_ID para evitar que una
// variable de entorno mal configurada los redirija a otra persona.
const VICKY_OWNER_ID = "3525045000484500876"

export async function createZohoLead(input: CreateZohoLeadInput): Promise<CreateZohoLeadResult> {
  try {
    const names = splitName(input.nombre)
    const transcript = buildTranscript(input.conversacion)

    const accessToken = await getZohoAccessToken()
    const apiDomain = getEnv("ZOHO_API_DOMAIN") || "https://www.zohoapis.com"
    const moduleName = getEnv("ZOHO_CRM_LEADS_MODULE") || "Leads"

    // Si hay reunión agendada → owner = host (ownerEmail resuelto).
    // Si NO → owner = Vicky SIEMPRE (tómbola), ignorando ZOHO_CRM_OWNER_ID.
    const resolvedOwnerId = input.ownerEmail
      ? await resolveOwnerId(input.ownerEmail, accessToken, apiDomain)
      : null
    const ownerId = resolvedOwnerId || VICKY_OWNER_ID
    const entraATombola = !resolvedOwnerId

    const trabajadoresNum =
      typeof input.trabajadores === "number"
        ? input.trabajadores
        : parseInt(String(input.trabajadores || "").replace(/\D/g, ""))

    const record: Record<string, unknown> = {
      First_Name: sanitize(names.firstName, 100),
      Last_Name: sanitize(names.lastName, 100) || "Prospecto",
      Company: sanitize(input.empresa, 200) || "Prospecto WhatsApp",
      Canal: "WhatsApp",
      Lead_Source: getEnv("ZOHO_DEFAULT_LEAD_SOURCE") || "SEO",
      Owner: { id: ownerId },
    }

    const email = (input.email || "").trim()
    if (email) record.Email = email
    const phone = (input.telefono || "").trim()
    if (phone) record.Phone = phone
    const pais = sanitize(input.pais, 100)
    if (pais) record.Country = pais
    const ciudad = sanitize(input.ciudad, 100)
    if (ciudad) record.City = ciudad

    const productoSolucion = mapProductoSolucion(input.necesidad)
    if (productoSolucion) record.Producto_Soluci_n = productoSolucion

    const rangoEmpleados = mapRangoEmpleados(input.trabajadores)
    if (rangoEmpleados) record.Rango_de_Empleados = rangoEmpleados

    if (!isNaN(trabajadoresNum) && trabajadoresNum > 0) {
      record.N_Empleados_que_marcan = trabajadoresNum
    }

    record.Comentario = [
      `Necesidad: ${input.necesidad || ""}`,
      `Cargo: ${input.cargo || ""}`,
      `Trabajadores: ${input.trabajadores ?? ""}`,
      `Sistema actual: ${input.sistemaActual || ""}`,
      `Idioma: ${input.idioma || ""}`,
      `Reunión agendada: ${input.reunionAgendada === true ? "true" : input.reunionAgendada === false ? "false" : ""}`,
      `Preferencia horario: ${input.preferenciaHorario || ""}`,
      `Contacto WA: ${input.contactoWA || ""}`,
    ]
      .filter((line) => line.split(":")[1]?.trim())
      .join("\n")
      .trim()

    const createResponse = await fetch(`${apiDomain}/crm/v2/${moduleName}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Zoho-oauthtoken ${accessToken}`,
      },
      body: JSON.stringify({ data: [record], trigger: ["workflow"] }),
      cache: "no-store",
    })

    const createBody = (await createResponse.json()) as {
      data?: Array<{ status?: string; details?: { id?: string }; message?: string; code?: string }>
    }
    const status = createBody?.data?.[0]?.status || ""
    const details = createBody?.data?.[0]?.details || {}
    const leadId = details?.id || null

    if (!createResponse.ok || status !== "success" || !leadId) {
      const errMsg =
        createBody?.data?.[0]?.message ||
        createBody?.data?.[0]?.code ||
        `Zoho devolvió status ${createResponse.status}`
      console.error("[zoho-leads] Error creando Lead:", JSON.stringify(createBody).slice(0, 500))
      return { success: false, error: errMsg }
    }

    if (transcript) {
      fetch(`${apiDomain}/crm/v2/Notes`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Zoho-oauthtoken ${accessToken}`,
        },
        body: JSON.stringify({
          data: [
            {
              Note_Title: "Transcripción WhatsApp Vicky",
              Note_Content: transcript,
              Parent_Id: leadId,
              $se_module: moduleName,
            },
          ],
        }),
        cache: "no-store",
      }).catch(() => {})
    }

    return {
      success: true,
      leadId,
      entraATombola,
      ownerEmail: input.ownerEmail || VICKY_DEFAULT_OWNER_EMAIL,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error inesperado en createZohoLead"
    console.error("[zoho-leads] Exception:", error)
    return { success: false, error: message }
  }
}
