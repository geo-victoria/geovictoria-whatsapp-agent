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
  // OJO: el org tiene ~400 usuarios y la API pagina de a 200 — buscar solo la
  // página 1 dejaba sin resolver a media organización (bug real: las SDR
  // Inbound estaban en la página 2 y la reasignación fallaba en silencio).
  try {
    for (let page = 1; page <= 5; page++) {
      const res = await fetch(
        `${apiDomain}/crm/v2/users?type=AllUsers&per_page=200&page=${page}`,
        {
          headers: { Authorization: `Zoho-oauthtoken ${token}` },
          cache: "no-store",
        },
      )
      if (!res.ok) return null
      const data = (await res.json()) as {
        users?: Array<{ id: string; email: string }>
        info?: { more_records?: boolean }
      }
      const match = (data?.users || []).find(
        (u) => u.email?.toLowerCase() === email.toLowerCase(),
      )
      if (match?.id) return match.id
      if (!data?.info?.more_records) return null
    }
    return null
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

/**
 * Actualiza el Lead_Status de un lead (diccionario acordado con Marketing
 * jul-2026: envío de mensaje = "2. Intento de contacto"; respuesta del cliente
 * = "3. Contactado"). Best-effort: nunca rompe el flujo.
 */
export async function updateZohoLeadStatus(
  leadId: string,
  status: string,
): Promise<{ success: boolean; error?: string }> {
  if (!leadId || !status) return { success: false, error: "leadId o status faltante" }
  try {
    const accessToken = await getZohoAccessToken()
    const apiDomain = getEnv("ZOHO_API_DOMAIN") || "https://www.zohoapis.com"
    const moduleName = getEnv("ZOHO_CRM_LEADS_MODULE") || "Leads"
    const res = await fetch(`${apiDomain}/crm/v2/${moduleName}/${leadId}`, {
      method: "PUT",
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
      body: JSON.stringify({ data: [{ Lead_Status: status }] }),
    })
    const data = (await res.json().catch(() => ({}))) as {
      data?: Array<{ status?: string; code?: string }>
    }
    if (!res.ok || data?.data?.[0]?.status !== "success") {
      // El Lead_Status del org vive dentro de un BLUEPRINT: el update directo
      // devuelve RECORD_IN_BLUEPRINT y hay que ejecutar la TRANSICIÓN cuyo
      // estado destino coincida con el pedido.
      if (data?.data?.[0]?.code === "RECORD_IN_BLUEPRINT") {
        return await ejecutarTransicionBlueprint(
          apiDomain,
          accessToken,
          moduleName,
          leadId,
          status,
        )
      }
      return { success: false, error: `Zoho update status ${res.status}` }
    }
    return { success: true }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "error actualizando status" }
  }
}

// Campos que las transiciones del blueprint exigen y su valor default para el
// contexto de Vicky (el cliente respondió el WhatsApp y está en conversación).
const BLUEPRINT_FIELD_DEFAULTS: Record<string, string> = {
  // Picklist "Pendiente para calificado" de la transición a "3. Contactado".
  Motivo_Calificado_no_convertido: "Falta información del cliente",
}

// Ejecuta la transición del blueprint del lead cuyo valor de destino calza con
// el status pedido (match exacto o por inclusión, ej. "3. Contactado").
async function ejecutarTransicionBlueprint(
  apiDomain: string,
  accessToken: string,
  moduleName: string,
  leadId: string,
  status: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const headers = {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      "Content-Type": "application/json",
    }
    const bpRes = await fetch(
      `${apiDomain}/crm/v2/${moduleName}/${leadId}/actions/blueprint`,
      { headers, cache: "no-store" },
    )
    if (!bpRes.ok) return { success: false, error: `blueprint GET ${bpRes.status}` }
    const bp = (await bpRes.json().catch(() => ({}))) as {
      blueprint?: {
        transitions?: Array<{
          id: string
          name?: string
          next_field_value?: string
          fields?: Array<{ api_name?: string }>
        }>
      }
    }
    const transitions = bp?.blueprint?.transitions || []
    const objetivo = status.toLowerCase()
    const match = transitions.find((t) => {
      const destino = (t.next_field_value || "").toLowerCase()
      const nombre = (t.name || "").toLowerCase()
      return destino === objetivo || destino.includes(objetivo) || objetivo.includes(destino) || nombre.includes(objetivo)
    })
    if (!match) {
      return {
        success: false,
        error: `sin transición hacia "${status}" (disponibles: ${transitions
          .map((t) => t.next_field_value || t.name)
          .join(", ")
          .slice(0, 150)})`,
      }
    }
    // Completar los campos que la transición exige con los defaults conocidos.
    const data: Record<string, string> = {}
    for (const f of match.fields || []) {
      const api = f?.api_name || ""
      if (api && BLUEPRINT_FIELD_DEFAULTS[api]) data[api] = BLUEPRINT_FIELD_DEFAULTS[api]
    }
    const exec = await fetch(
      `${apiDomain}/crm/v2/${moduleName}/${leadId}/actions/blueprint`,
      {
        method: "PUT",
        headers,
        cache: "no-store",
        body: JSON.stringify({ blueprint: [{ transition_id: match.id, data }] }),
      },
    )
    const execData = (await exec.json().catch(() => ({}))) as {
      code?: string
      status?: string
      message?: string
    }
    if (!exec.ok || (execData?.code && execData.code !== "SUCCESS")) {
      return {
        success: false,
        error: `blueprint PUT ${exec.status}: ${JSON.stringify(execData).slice(0, 150)}`,
      }
    }
    return { success: true }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "excepción blueprint" }
  }
}

// SDRs Inbound para la reasignación de lo que Vicky suelta (acuerdo con
// Marketing jul-2026). Formato "email:zohoUserId" — con el id directo no
// dependemos de la API de usuarios (400+ usuarios, paginada y con scope
// propio). Si falta el id, se resuelve por email como fallback.
const SDR_INBOUND = (
  process.env.VIC_SDR_INBOUND ||
  "aaraque@geovictoria.com:3525045000583802005,asepulveda@geovictoria.com:3525045000594735052"
)
  .split(",")
  .map((s) => {
    const [email, id] = s.split(":").map((x) => x.trim())
    return { email, id: id || "" }
  })
  .filter((s) => s.email)

/**
 * Reasigna un lead al siguiente SDR Inbound del round-robin (turno persistido
 * en vic_kv → equitativo entre invocaciones serverless). Devuelve a quién quedó.
 */
export async function reasignarLeadSdrInbound(
  leadId: string,
): Promise<{ success: boolean; ownerEmail?: string; error?: string }> {
  if (!leadId || SDR_INBOUND.length === 0) {
    return { success: false, error: "leadId faltante o sin SDRs configuradas" }
  }
  try {
    const { getKvValue, setKvValue } = await import("./supabase-persistence-v3")
    const last = parseInt((await getKvValue("sdr_inbound_rr").catch(() => null)) || "-1")
    const idx = (isNaN(last) ? 0 : last + 1) % SDR_INBOUND.length
    const sdr = SDR_INBOUND[idx]

    const accessToken = await getZohoAccessToken()
    const apiDomain = getEnv("ZOHO_API_DOMAIN") || "https://www.zohoapis.com"
    const moduleName = getEnv("ZOHO_CRM_LEADS_MODULE") || "Leads"
    const ownerId = sdr.id || (await resolveOwnerId(sdr.email, accessToken, apiDomain))
    if (!ownerId) return { success: false, error: `sin user_id para ${sdr.email}` }

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
    if (!res.ok || data?.data?.[0]?.status !== "success") {
      return {
        success: false,
        error: `PUT owner ${res.status}: ${JSON.stringify(data).slice(0, 200)}`,
      }
    }
    await setKvValue("sdr_inbound_rr", String(idx)).catch(() => {})
    return { success: true, ownerEmail: sdr.email }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "excepción reasignando" }
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
  /** Owner directo por Zoho user id (multi-país: SDRs CO). Gana sobre ownerEmail. */
  ownerId?: string
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
    const resolvedOwnerId =
      (input.ownerId || "").trim() ||
      (input.ownerEmail ? await resolveOwnerId(input.ownerEmail, accessToken, apiDomain) : null)
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
    // Teléfono: si el caller no lo pasó, cae al contacto de WhatsApp (siempre lo
    // hay en Vicky). Regla del equipo (jul-2026): ningún lead de Vicky sin fono.
    const phone = (input.telefono || "").trim() || (input.contactoWA || "").trim()
    if (phone) record.Phone = phone.startsWith("+") ? phone : `+${phone.replace(/\D/g, "")}`
    // País/Territorio: deducidos del fono si el caller no los dio. Regla del
    // equipo (jul-2026): los leads deben llegar con territorio para que las
    // assignment rules los repartan (los sin territorio quedaban huérfanos).
    const digits = phone.replace(/\D/g, "")
    const pais =
      sanitize(input.pais, 100) ||
      (digits.startsWith("56") ? "Chile" : digits.startsWith("57") ? "Colombia" : "")
    if (pais) record.Country = pais
    if (digits.startsWith("56") || pais.toLowerCase() === "chile") record.Territorio = "Chile"
    else if (digits.startsWith("57") || pais.toLowerCase() === "colombia") record.Territorio = "Colombia"
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
