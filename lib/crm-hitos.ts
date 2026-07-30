/**
 * Sincronización determinista Zoho CRM ← hitos de la conversación de Vicky
 * (Lalo, 30-jul-2026). Regla de marketing: NUNCA crear deals directos — todo
 * deal nace de un LEAD CONVERTIDO. Diccionario de hitos → etapa (piso):
 *
 *   intención comercial        → deal nace en "1. Trato Creado"
 *   reunión realizada          → piso "2. Primera Reunion Realizada"
 *   discovery sin preform      → piso "3. En Levantamiento"
 *   preform visto en adelante  → piso "4. Propuesta Enviada / En Negociación"
 *   aceptada o pagada          → piso "6. Listo para Cierre"
 *   onboarding terminado       → piso "7. Implementando"
 *
 * EL STAGE NUNCA RETROCEDE: cada hito es un PISO; el deal sube a
 * max(etapa actual, piso) vía transiciones Blueprint (cada deal tiene SU
 * blueprint — hay dos en CL — así que siempre GET sus transitions primero, y
 * los campos mandatorios van DENTRO del data del PUT).
 *
 * EL DATO PUEDE NACER EN DOS LADOS (por eso la resolución va primero):
 *   - ENTRANTE: la conversación parte en WhatsApp → no existe nada en Zoho →
 *     se crea el lead y se convierte con deal en el piso del hito.
 *   - SALIENTE: el lead nació en el CRM y NOSOTROS iniciamos la conversación
 *     (asignación del lead) → el lead YA existe → se reutiliza tal cual, se
 *     respeta a su dueño y solo se avanza (status/etapa hacia arriba).
 *
 * Reglas duras:
 *   - Lead de un dueño HUMANO (SDR) → no se convierte ni se toca su gestión:
 *     solo sube Lead_Status (nunca baja) y queda nota. (Regla anti-pisoteo.)
 *   - Contacto existente sin lead (cliente actual) → no se crea nada (evita
 *     duplicar personas); se registra para revisión.
 *   - Teléfonos de prueba (VICKY_TELEFONOS_PRUEBA) → no crean registros.
 *   - Todo best-effort: un fallo acá JAMÁS afecta el turno de la conversación.
 *
 * Flag: VICKY_CRM_HITOS_ENABLED (apagado por defecto).
 */

export type Hito =
  | "intencion"
  | "reunion_realizada"
  | "discovery"
  | "preform"
  | "aceptada"
  | "onboarding_listo"

/** Piso de etapa del deal que garantiza cada hito. */
export const PISO_POR_HITO: Record<Hito, string> = {
  intencion: "1. Trato Creado",
  reunion_realizada: "2. Primera Reunion Realizada",
  discovery: "3. En Levantamiento",
  preform: "4. Propuesta Enviada / En Negociación",
  aceptada: "6. Listo para Cierre",
  onboarding_listo: "7. Implementando",
}

/**
 * Orden del pipeline para la regla "nunca retrocede". "Cierre Perdido" es
 * terminal: un deal perdido no se resucita automáticamente.
 */
const ORDEN_ETAPA: Record<string, number> = {
  "1. Trato Creado": 1,
  "2. Primera Reunion Realizada": 2,
  "3. En Levantamiento": 3,
  "4. Propuesta Enviada / En Negociación": 4,
  "5. Piloto": 5,
  "6. Listo para Cierre": 6,
  "7. Implementando": 7,
  "8. Facturando": 8,
}

/**
 * Decide a qué etapa debe moverse un deal dado su etapa actual y el piso del
 * hito. null = no tocar (ya está en o sobre el piso, o está en un estado
 * fuera del pipeline como "Cierre Perdido").
 */
export function etapaObjetivo(actual: string, piso: string): string | null {
  const a = ORDEN_ETAPA[actual]
  const p = ORDEN_ETAPA[piso]
  if (!a || !p) return null
  return a < p ? piso : null
}

/**
 * Hito que implica el ÉXITO de cada tool de Vicky. El preform es
 * cotizar_referencial (el precio mostrado en el chat); las tools de agenda y
 * callback demuestran intención pero no precio; el comprobante de
 * transferencia es aceptación de la cotización.
 */
export const HITO_POR_TOOL: Record<string, Hito> = {
  cotizar_referencial: "preform",
  consultar_descuento_referencial: "preform",
  consultar_siguiente_descuento: "preform",
  aplicar_siguiente_descuento: "preform",
  actualizar_cotizacion: "preform",
  enviar_cotizacion_whatsapp: "preform",
  generar_link_cotizadora: "intencion",
  consultar_disponibilidad_horario: "intencion",
  agendar_reunion: "intencion",
  reagendar_reunion: "intencion",
  registrar_solicitud_callback: "intencion",
  registrar_comprobante_transferencia: "aceptada",
}

/** Orden de Lead_Status para subir sin pisar (nunca hacia abajo). */
const ORDEN_LEAD_STATUS: Record<string, number> = {
  "1. No contactado": 1,
  "2. Intento de contacto": 2,
  "3. Contactado": 3,
  "4. Calificado": 4,
}

/** Lead_Status mínimo que implica cada hito (todos son conversación activa). */
const STATUS_POR_HITO: Partial<Record<Hito, string>> = {
  intencion: "4. Calificado",
  discovery: "4. Calificado",
  preform: "4. Calificado",
  aceptada: "4. Calificado",
}

const VICKY_OWNER_ID = "3525045000484500876"
const HOY_MAS_30 = () => new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10)

function getEnv(name: string): string {
  return (process.env[name] || "").trim()
}

function habilitado(): boolean {
  return getEnv("VICKY_CRM_HITOS_ENABLED") === "on"
}

/** Teléfonos internos de prueba: jamás crean registros (caso HuelleroCompany). */
function esTelefonoDePrueba(contact: string): boolean {
  const lista = getEnv("VICKY_TELEFONOS_PRUEBA")
    .split(",")
    .map((t) => t.replace(/\D/g, ""))
    .filter(Boolean)
  const clean = (contact || "").replace(/\D/g, "")
  return lista.includes(clean)
}

function territorioDeContacto(contact: string): "Chile" | "Colombia" | "México" | null {
  const c = (contact || "").replace(/\D/g, "")
  if (c.startsWith("56")) return "Chile"
  if (c.startsWith("57")) return "Colombia"
  if (c.startsWith("52")) return "México"
  return null
}

type ZohoHeaders = { Authorization: string; "Content-Type": string }

async function zohoHeaders(): Promise<{ h: ZohoHeaders; api: string }> {
  // Import dinámico: mantiene este módulo importable por los tests puros
  // (node --test sin resolución de extensiones de Next).
  const { getZohoAccessToken } = await import("./zoho-token")
  const token = await getZohoAccessToken()
  return {
    h: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
    api: getEnv("ZOHO_API_DOMAIN") || "https://www.zohoapis.com",
  }
}

type LeadEncontrado = {
  id: string
  ownerId: string
  status: string
  company: string
  empleados: number
  convertido: boolean
  dealId: string | null
  contactId: string | null
}

/**
 * RESOLUCIÓN por teléfono — el corazón de los dos orígenes del dato. Busca en
 * Leads (convertidos incluidos) y devuelve lo que hay; si no hay lead, mira
 * Contacts para detectar clientes actuales.
 */
async function resolverPorTelefono(contact: string): Promise<
  | { tipo: "lead"; lead: LeadEncontrado }
  | { tipo: "contacto_sin_lead"; contactId: string }
  | { tipo: "nada" }
> {
  const { h, api } = await zohoHeaders()
  const fono = contact.replace(/\D/g, "")
  const res = await fetch(
    `${api}/crm/v3/Leads/search?phone=${encodeURIComponent(fono)}&converted=both&per_page=5`,
    { headers: h, cache: "no-store" },
  )
  if (res.ok && res.status !== 204) {
    const data = (await res.json().catch(() => ({}))) as {
      data?: Array<{
        id?: string
        Owner?: { id?: string }
        Lead_Status?: string
        Company?: string
        N_Empleados_que_marcan?: number
        Converted_Deal?: { id?: string } | null
        Converted_Contact?: { id?: string } | null
        Converted_Account?: { id?: string } | null
      }>
    }
    const l = data?.data?.[0]
    if (l?.id) {
      const convertido = Boolean(l.Converted_Account?.id || l.Converted_Contact?.id || l.Converted_Deal?.id)
      return {
        tipo: "lead",
        lead: {
          id: String(l.id),
          ownerId: String(l.Owner?.id || ""),
          status: String(l.Lead_Status || ""),
          company: String(l.Company || ""),
          empleados: Number(l.N_Empleados_que_marcan) || 0,
          convertido,
          dealId: l.Converted_Deal?.id ? String(l.Converted_Deal.id) : null,
          contactId: l.Converted_Contact?.id ? String(l.Converted_Contact.id) : null,
        },
      }
    }
  }
  const resC = await fetch(
    `${api}/crm/v3/Contacts/search?phone=${encodeURIComponent(fono)}&per_page=2`,
    { headers: h, cache: "no-store" },
  )
  if (resC.ok && resC.status !== 204) {
    const data = (await resC.json().catch(() => ({}))) as { data?: Array<{ id?: string }> }
    if (data?.data?.[0]?.id) return { tipo: "contacto_sin_lead", contactId: String(data.data[0].id) }
  }
  return { tipo: "nada" }
}

/** Deal vivo del contacto (para leads convertidos sin Converted_Deal). */
async function dealVivoDelContacto(contactId: string): Promise<{ id: string; stage: string } | null> {
  const { h, api } = await zohoHeaders()
  const res = await fetch(`${api}/crm/v3/coql`, {
    method: "POST",
    headers: h,
    cache: "no-store",
    body: JSON.stringify({
      select_query: `select id, Stage from Deals where Contact_Name = ${contactId} and Stage != 'Cierre Perdido' order by Modified_Time desc limit 1`,
    }),
  })
  if (!res.ok || res.status === 204) return null
  const text = await res.text().catch(() => "")
  if (!text.trim()) return null
  try {
    const d = JSON.parse(text) as { data?: Array<{ id: string; Stage: string }> }
    return d?.data?.[0] ? { id: d.data[0].id, stage: d.data[0].Stage } : null
  } catch {
    return null
  }
}

/**
 * Sube el Lead_Status al piso del hito (nunca hacia abajo, nunca pisa un
 * status mayor puesto por un SDR).
 */
async function subirLeadStatus(lead: LeadEncontrado, hito: Hito): Promise<void> {
  const objetivo = STATUS_POR_HITO[hito]
  if (!objetivo) return
  const actual = ORDEN_LEAD_STATUS[lead.status] || 0
  const meta = ORDEN_LEAD_STATUS[objetivo] || 0
  if (actual >= meta) return
  const { updateZohoLeadStatus } = await import("./zoho-leads")
  const r = await updateZohoLeadStatus(lead.id, objetivo)
  if (!r.success) console.warn(`[crm-hitos] lead ${lead.id} status→${objetivo} falló: ${r.error}`)
}

/**
 * Convierte el lead con deal naciendo en la etapa del piso (regla de
 * marketing: el deal SIEMPRE nace de la conversión). Owner del deal = owner
 * del lead — en el caso saliente respeta la asignación hecha en el CRM.
 * Maneja cuenta duplicada reconvirtiendo con Accounts:{id}.
 */
async function convertirConDeal(
  lead: LeadEncontrado,
  contact: string,
  piso: string,
): Promise<string | null> {
  const { h, api } = await zohoHeaders()
  const territorio = territorioDeContacto(contact) || "Chile"
  const empleados = lead.empleados || 1
  const deal = {
    Deal_Name: `${lead.company || "Prospecto WhatsApp"} (Control de Asistencia)`,
    Stage: piso,
    Pipeline: "Standard (Standard)",
    Territorio: territorio,
    Tombola: "Mantener propietario",
    Sector: "20. Servicios",
    Monda_del_trato: territorio === "Colombia" ? "COP" : territorio === "México" ? "MXN" : "UF",
    Producto_Soluci_n: "Control de Asistencia",
    Tipo_de_Cobro: empleados <= 10 ? "Mensual fijo" : "Por usuario",
    N_Empleados_que_marcan: empleados,
    Closing_Date: HOY_MAS_30(),
    Owner: { id: lead.ownerId || VICKY_OWNER_ID },
    Description: `Deal creado automáticamente por Vicky al detectar el hito en la conversación de WhatsApp (+${contact.replace(/\D/g, "")}).`,
  }
  const convertir = async (accountId?: string) => {
    const body = {
      data: [
        {
          overwrite: false,
          notify_lead_owner: false,
          notify_new_entity_owner: false,
          ...(accountId ? { Accounts: { id: accountId } } : {}),
          Deals: deal,
        },
      ],
    }
    const res = await fetch(`${api}/crm/v3/Leads/${lead.id}/actions/convert`, {
      method: "POST",
      headers: h,
      cache: "no-store",
      body: JSON.stringify(body),
    })
    return (await res.json().catch(() => ({}))) as {
      data?: Array<{
        code?: string
        Deals?: { id?: string }
        details?: { duplicate_record?: { id?: string } }
        duplicate_record?: { id?: string }
      }>
    }
  }
  let r = await convertir()
  let fila = r?.data?.[0]
  if (fila?.code !== "SUCCESS") {
    const dupId = fila?.duplicate_record?.id || fila?.details?.duplicate_record?.id
    if (dupId) {
      r = await convertir(String(dupId))
      fila = r?.data?.[0]
    }
  }
  if (fila?.code === "SUCCESS" && fila?.Deals?.id) {
    console.log(`[crm-hitos] lead ${lead.id} convertido → deal ${fila.Deals.id} en "${piso}"`)
    return String(fila.Deals.id)
  }
  console.warn(`[crm-hitos] convert de ${lead.id} falló: ${JSON.stringify(r).slice(0, 250)}`)
  return null
}

/**
 * Avanza el deal hasta el piso vía transiciones Blueprint (máx. 3 saltos).
 * Los campos mandatorios de cada transición se completan con los valores del
 * propio deal (releídos) — la lección del backfill: van DENTRO del data.
 */
async function avanzarDealHasta(dealId: string, piso: string): Promise<void> {
  const { h, api } = await zohoHeaders()
  for (let salto = 0; salto < 3; salto++) {
    const bpRes = await fetch(`${api}/crm/v3/Deals/${dealId}/actions/blueprint`, {
      headers: h,
      cache: "no-store",
    })
    if (!bpRes.ok) return
    const bp = (await bpRes.json().catch(() => ({}))) as {
      blueprint?: {
        process_info?: { field_value?: string }
        transitions?: Array<{
          id: string
          next_field_value?: string
          fields?: Array<{ api_name?: string; mandatory?: boolean }>
        }>
      }
    }
    const actual = bp?.blueprint?.process_info?.field_value || ""
    const objetivo = etapaObjetivo(actual, piso)
    if (!objetivo) return
    // La transición que más avance sin pasarse del piso.
    const candidatas = (bp?.blueprint?.transitions || [])
      .filter((t) => {
        const orden = ORDEN_ETAPA[t.next_field_value || ""]
        return orden && orden > (ORDEN_ETAPA[actual] || 0) && orden <= (ORDEN_ETAPA[piso] || 0)
      })
      .sort((a, b) => (ORDEN_ETAPA[b.next_field_value || ""] || 0) - (ORDEN_ETAPA[a.next_field_value || ""] || 0))
    const trans = candidatas[0]
    if (!trans) {
      console.warn(`[crm-hitos] deal ${dealId}: sin transición de "${actual}" hacia "${piso}"`)
      return
    }
    // Los mandatorios de la transición se llenan con los valores del deal.
    const dRes = await fetch(
      `${api}/crm/v3/Deals/${dealId}?fields=Contact_Name,Producto_Soluci_n,Tipo_de_Cobro,Monda_del_trato,N_Empleados_que_marcan,M_todo_de_carga_de_informaci_n`,
      { headers: h, cache: "no-store" },
    )
    const dBody = (await dRes.json().catch(() => ({}))) as {
      data?: Array<Record<string, unknown>>
    }
    const dealActual = dBody?.data?.[0] || {}
    const data: Record<string, unknown> = {}
    for (const f of trans.fields || []) {
      const api_name = f?.api_name || ""
      if (!api_name) continue
      const valor = dealActual[api_name]
      if (valor !== null && valor !== undefined && valor !== "") data[api_name] = valor
      // Default seguro para el único mandatorio sin valor natural en Vicky:
      // la carga por Excel no dispara automatizaciones hacia el cliente.
      else if (api_name === "M_todo_de_carga_de_informaci_n") data[api_name] = "Planilla Excel (proceso manual)"
    }
    const exec = await fetch(`${api}/crm/v3/Deals/${dealId}/actions/blueprint`, {
      method: "PUT",
      headers: h,
      cache: "no-store",
      body: JSON.stringify({ blueprint: [{ transition_id: trans.id, data }] }),
    })
    const execBody = (await exec.json().catch(() => ({}))) as { code?: string }
    if (!exec.ok || execBody?.code !== "SUCCESS") {
      console.warn(
        `[crm-hitos] deal ${dealId}: transición a "${trans.next_field_value}" falló: ${JSON.stringify(execBody).slice(0, 200)}`,
      )
      return
    }
    console.log(`[crm-hitos] deal ${dealId}: "${actual}" → "${trans.next_field_value}"`)
    if (trans.next_field_value === piso) return
  }
}

const TITULO_NOTA_TRANSCRIPCION = "Transcripción WhatsApp Vicky"

/**
 * NOTA VIVA de transcripción en el deal (pedido Lalo 30-jul): una sola nota
 * por deal, que se ACTUALIZA con la conversación completa en cada hito — no
 * se acumulan copias. (El PDF adjunto queda para el barrido batch: en
 * serverless no hay renderer.) Best-effort.
 */
async function actualizarNotaTranscripcion(dealId: string, contact: string): Promise<void> {
  try {
    const { fetchHistoryV3 } = await import("./supabase-persistence-v3")
    const historia = await fetchHistoryV3(contact, 200)
    if (!historia.length) return
    const transcript = historia
      .map((m) => {
        const rol = m.role === "assistant" ? "Vicky" : "Cliente"
        const at = (m as { at?: string }).at || ""
        return `${at} | ${rol}: ${m.content || ""}`
      })
      .join("\n")
      .slice(0, 30000)
    const { h, api } = await zohoHeaders()
    const res = await fetch(
      `${api}/crm/v3/Deals/${dealId}/Notes?fields=Note_Title&per_page=50`,
      { headers: h, cache: "no-store" },
    )
    let notaId: string | null = null
    if (res.ok && res.status !== 204) {
      const data = (await res.json().catch(() => ({}))) as {
        data?: Array<{ id?: string; Note_Title?: string }>
      }
      notaId =
        data?.data?.find((n) => (n.Note_Title || "").startsWith(TITULO_NOTA_TRANSCRIPCION))?.id ||
        null
    }
    if (notaId) {
      await fetch(`${api}/crm/v3/Notes/${notaId}`, {
        method: "PUT",
        headers: h,
        cache: "no-store",
        body: JSON.stringify({ data: [{ Note_Content: transcript }] }),
      })
    } else {
      await fetch(`${api}/crm/v3/Notes`, {
        method: "POST",
        headers: h,
        cache: "no-store",
        body: JSON.stringify({
          data: [
            {
              Note_Title: TITULO_NOTA_TRANSCRIPCION,
              Note_Content: transcript,
              Parent_Id: dealId,
              $se_module: "Deals",
            },
          ],
        }),
      })
    }
  } catch (e) {
    console.warn(`[crm-hitos] nota transcripción deal ${dealId} falló:`, e instanceof Error ? e.message : e)
  }
}

// Guard por instancia: el mismo (contacto, hito) no se re-procesa en el mismo
// proceso serverless. Zoho igual queda consistente si se repite (todo es
// idempotente hacia arriba), esto solo ahorra llamadas.
const procesados = new Set<string>()

/**
 * Punto de entrada: sincroniza el CRM con un hito detectado en la
 * conversación. Best-effort — loguea y nunca lanza.
 */
export async function sincronizarHitoCrm(contact: string, hito: Hito): Promise<void> {
  try {
    if (!habilitado()) return
    const clean = (contact || "").replace(/\D/g, "")
    if (!clean || esTelefonoDePrueba(clean)) return
    const key = `${clean}:${hito}`
    if (procesados.has(key)) return
    procesados.add(key)

    const piso = PISO_POR_HITO[hito]
    const res = await resolverPorTelefono(clean)

    if (res.tipo === "contacto_sin_lead") {
      // Cliente actual sin lead: no se crea nada (evita duplicar personas).
      console.log(`[crm-hitos] ${clean}: contacto existente ${res.contactId} sin lead — hito "${hito}" solo registrado en log`)
      return
    }

    if (res.tipo === "nada") {
      // ENTRANTE puro: el dato nace en la conversación → lead nuevo por el
      // camino existente (tómbola u owner según el flujo que ya rige) y
      // conversión inmediata con deal en el piso del hito.
      const { createZohoLead } = await import("./zoho-leads")
      const creado = await createZohoLead({ contactoWA: clean, telefono: clean })
      if (!creado.success) {
        console.warn(`[crm-hitos] ${clean}: no se pudo crear lead (${creado.error})`)
        return
      }
      const lead: LeadEncontrado = {
        id: creado.leadId,
        ownerId: "",
        status: "",
        company: "",
        empleados: 0,
        convertido: false,
        dealId: null,
        contactId: null,
      }
      await subirLeadStatus(lead, hito)
      const dealId = await convertirConDeal(lead, clean, piso)
      if (!dealId) console.warn(`[crm-hitos] ${clean}: lead ${creado.leadId} quedó sin convertir`)
      else await actualizarNotaTranscripcion(dealId, clean)
      return
    }

    // Hay lead (caso SALIENTE o entrante repetido).
    const lead = res.lead
    const esDeVicky = !lead.ownerId || lead.ownerId === VICKY_OWNER_ID

    if (!lead.convertido) {
      await subirLeadStatus(lead, hito)
      if (!esDeVicky && getEnv("VICKY_CRM_HITOS_CONVERTIR_AJENOS") !== "on") {
        // Lead de un humano: no se pisa su gestión — solo status y nota.
        const { agregarNotaLead } = await import("./zoho-leads")
        await agregarNotaLead(
          lead.id,
          `Vicky: hito "${hito}" en WhatsApp`,
          `Vicky detectó el hito "${hito}" conversando con este lead por WhatsApp. Según el diccionario correspondería un deal en "${piso}"; no se creó automáticamente porque el lead tiene dueño humano.`,
        ).catch(() => false)
        return
      }
      const dealNuevo = await convertirConDeal(lead, clean, piso)
      if (dealNuevo) await actualizarNotaTranscripcion(dealNuevo, clean)
      return
    }

    // Lead ya convertido: ubicar el deal y subirlo al piso.
    let dealId = lead.dealId
    if (!dealId && lead.contactId) {
      const deal = await dealVivoDelContacto(lead.contactId)
      dealId = deal?.id || null
    }
    if (!dealId) {
      console.log(`[crm-hitos] ${clean}: lead ${lead.id} convertido sin deal vivo — hito "${hito}" sin destino`)
      return
    }
    await avanzarDealHasta(dealId, piso)
    await actualizarNotaTranscripcion(dealId, clean)
  } catch (e) {
    console.warn("[crm-hitos] excepción:", e instanceof Error ? e.message : e)
  }
}
