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

/**
 * Datos frescos que la conversación entrega en el MISMO acto del hito (Lalo
 * 30-jul: "si aparece la empresa, actualizarla; si aparece un correo,
 * actualizarlo"). La fuente es el INPUT de la tool: cuando Vicky llama
 * generar_link_cotizadora ya extrajo empresa/RUT/correo del chat — no hay que
 * re-minarlos. Se aplican SOLO sobre campos vacíos o placeholder (regla
 * anti-pisoteo: jamás sobreescribir gestión humana).
 */
export type DatosConversacion = {
  nombre?: string
  empresa?: string
  email?: string
  rut?: string
  empleados?: number
}

/**
 * Número de empleados desde lo que DIJO el cliente o trajo el formulario: los
 * >50 llegan casi siempre como texto ("entre 200 y 400", "200 - 499
 * empleados", "300 aprox", "más de 100") y el Number() estricto los
 * descartaba — el deal nacía con N=1 y la tómbola de deals lo sorteaba en el
 * tramo SMB (casos VDZ/Bodegas San Francisco/VITAPRO, orden de Lalo 06-ago:
 * los >50 deben caer SÍ O SÍ en su tramo real de la regla). Regla: se toma el
 * PISO del rango (primer número); "más de X" cuenta como X+1.
 */
export function parseEmpleados(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.round(v)
  const s = String(v ?? "").trim()
  if (!s) return undefined
  const m = s.match(/\d[\d.]*/)
  if (!m) return undefined
  const n = Math.round(Number(m[0].replace(/\.(?=\d{3}\b)/g, "")))
  if (!Number.isFinite(n) || n <= 0 || n > 100000) return undefined
  const masDe = /(m[áa]s\s+de|sobre|arriba\s+de|\+\s*$|superior(?:es)?\s+a)/i.test(
    s.slice(0, (m.index || 0) + m[0].length + 2),
  )
  return masDe ? n + 1 : n
}

export function datosDeToolInput(toolName: string, input: unknown): DatosConversacion {
  const i = (input || {}) as Record<string, unknown>
  const txt = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined)
  switch (toolName) {
    case "cotizar_referencial":
      return { empleados: parseEmpleados(i.userCount) }
    case "generar_link_cotizadora":
    case "actualizar_cotizacion":
      return {
        empresa: txt(i.empresa),
        email: txt(i.contactoEmail),
        rut: txt(i.rutEmpresa),
        nombre: txt(i.contactoNombre) || txt(i.contacto),
      }
    case "agendar_reunion":
    case "reagendar_reunion":
      return {
        nombre: txt(i.prospectName),
        email: txt(i.prospectEmail),
        empresa: txt(i.empresa),
        empleados: parseEmpleados(i.trabajadores),
      }
    case "registrar_solicitud_callback":
      return {
        nombre: txt(i.nombre),
        empresa: txt(i.empresa),
        email: txt(i.email),
        empleados: parseEmpleados(i.trabajadores),
      }
    // Derivación >50 (Lalo 06-ago): el lead/deal debe nacer con TODOS los
    // datos para caer en el tramo correcto de la tómbola de deals.
    case "derivar_a_soporte":
      return {
        nombre: txt(i.nombre),
        empresa: txt(i.empresa),
        email: txt(i.email),
        empleados: parseEmpleados(i.trabajadores),
      }
    default:
      return {}
  }
}

/** Company/nombre de relleno que cuentan como "vacío" para el enriquecimiento. */
function esPlaceholder(valor: string): boolean {
  return !valor || /por identificar|prospecto whatsapp|no identificado|sin empresa|tu empresa/i.test(valor)
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
// Dueños "del bot": el usuario Vicky y los interinos por país. Ninguno cuenta
// como gestión humana — son marcadores de "sin dueño real" (fix gemelos
// 03-ago: heredarlos dejaba el deal fuera de la tómbola).
const INTERINOS = new Set([
  VICKY_OWNER_ID,
  "3525045000000211283", // Eddyluz (ex-interina CL)
  "3525045000203758005", // Gordillo (interino CO)
  "3525045000308323003", // Yahel (interina MX)
])

// SDRs Inbound de Colombia (acuerdo equipo CO 04-ago: Gordillo/Valeria): en CO
// el LEAD sin cotización lo posee el SDR (Galindo y cía), y al emitir la formal
// el DEAL pasa al EJECUTIVO (Gordillo). Por eso un lead de un SDR CO NO se
// hereda al deal: es un handoff SDR→ejecutivo, no gestión que preservar.
const SDR_CO_IDS = new Set([
  "3525045000613817111", // Eddy Galindo
  "3525045000619732095", // Guerrero
  "3525045000639899035", // Quiroga
])

/** ¿El dueño del lead es un HUMANO REAL cuya gestión se hereda al deal? No lo
 * son los interinos ni —en Colombia— los SDR (esos entregan el deal al
 * ejecutivo al cotizar). */
function heredaGestionAlDeal(ownerId: string, territorio: string): boolean {
  if (!ownerId || INTERINOS.has(ownerId)) return false
  if (territorio === "Colombia" && SDR_CO_IDS.has(ownerId)) return false
  return true
}
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

function territorioDeContacto(contact: string): "Chile" | "Colombia" | "México" | "Perú" | null {
  const c = (contact || "").replace(/\D/g, "")
  if (c.startsWith("56")) return "Chile"
  if (c.startsWith("57")) return "Colombia"
  if (c.startsWith("52")) return "México"
  // Perú (Fase 1b, 05-ago): sin este caso, un +51 caía al default "Chile" en
  // la creación del deal (Territorio y moneda equivocados).
  if (c.startsWith("51")) return "Perú"
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
  email: string
  lastName: string
  rut: string
  ultimaActividad: string
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
  // Candado vic_kv primero: el search de Zoho tarda ~2 min en indexar leads
  // nuevos y esa ventana producía duplicados (caso SYDA 28-jul). El candado
  // apunta directo al id, con GET inmediato y sin lag.
  try {
    const { getKvValue } = await import("./supabase-persistence-v3")
    const idCandado = (await getKvValue(`zoho_lead_${fono}`)) || ""
    // "creando:<ts>" = reserva anti-carrera de createZohoLead, no un id.
    if (idCandado && !idCandado.startsWith("creando:")) {
      const rDirecto = await fetch(
        `${api}/crm/v3/Leads/${idCandado}?fields=Owner,Lead_Status,Company,N_Empleados_que_marcan,Email,Last_Name,RUT_Empresa,Last_Activity_Time,Converted_Deal,Converted_Contact,Converted_Account`,
        { headers: h, cache: "no-store" },
      )
      if (rDirecto.ok) {
        const l = ((await rDirecto.json().catch(() => ({}))) as { data?: Array<Record<string, unknown>> }).data?.[0]
        if (l?.id) {
          const g = (k: string) => (l[k] as { id?: string } | null)?.id
          return {
            tipo: "lead",
            lead: {
              id: String(l.id),
              ownerId: String((l.Owner as { id?: string })?.id || ""),
              status: String(l.Lead_Status || ""),
              company: String(l.Company || ""),
              empleados: Number(l.N_Empleados_que_marcan) || 0,
              email: String(l.Email || ""),
              lastName: String(l.Last_Name || ""),
              rut: String(l.RUT_Empresa || ""),
              ultimaActividad: String(l.Last_Activity_Time || ""),
              convertido: Boolean(g("Converted_Account") || g("Converted_Contact") || g("Converted_Deal")),
              dealId: g("Converted_Deal") ? String(g("Converted_Deal")) : null,
              contactId: g("Converted_Contact") ? String(g("Converted_Contact")) : null,
            },
          }
        }
      }
    }
  } catch { /* sin candado, sigue el search normal */ }
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
        Email?: string
        Last_Name?: string
        RUT_Empresa?: string
        Last_Activity_Time?: string
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
          email: String(l.Email || ""),
          lastName: String(l.Last_Name || ""),
          rut: String(l.RUT_Empresa || ""),
          ultimaActividad: String(l.Last_Activity_Time || ""),
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
 * Reglas de re-contacto de Dave (doc Proceso de Gestión de Leads, 30-jul):
 * encendible por env VICKY_REGLAS_RECONTACTO_ENABLED=on o por vic_kv
 * `reglas_recontacto_enabled`=on (encendido/apagado al instante sin deploy,
 * mismo patrón que traspaso_v2_enabled).
 */
async function reglasRecontactoActivas(): Promise<boolean> {
  if (getEnv("VICKY_REGLAS_RECONTACTO_ENABLED") === "on") return true
  try {
    const { getKvValue } = await import("./supabase-persistence-v3")
    return ((await getKvValue("reglas_recontacto_enabled")) || "").trim() === "on"
  } catch {
    return false
  }
}

/**
 * Candado CRUZADO hito↔cotización (fix duplicados 04-ago: Lotus Pet, CYE
 * Clima, Spacio Creativo, Distribuidora MV, Artespectáculo). Hay DOS puertas
 * que crean deals para el mismo teléfono — este módulo (por hito de
 * conversación) y create-from-vicky en el cotizador (por emisión de la
 * formal) — y no se veían entre sí: el índice de búsqueda de Zoho tarda en
 * reflejar registros de hace segundos, así que cada puerta creaba su propio
 * deal (11 segundos de diferencia en Lotus Pet). Ambas escriben en vic_kv
 * `deal_fono_<fono>` APENAS su deal existe y consultan ANTES de crear: la
 * que llega segunda REUSA ese deal (le sube el piso) en vez de duplicarlo.
 * TTL 6 h — pasada la ventana, la búsqueda normal de Zoho ya ve todo.
 */
const DEAL_KV_TTL_MS = 6 * 60 * 60 * 1000

async function dealActivoEnKv(fono: string): Promise<string | null> {
  try {
    const { getKvValue } = await import("./supabase-persistence-v3")
    const raw = await getKvValue(`deal_fono_${fono}`)
    if (!raw) return null
    const v = JSON.parse(raw) as { at?: string; dealId?: string }
    if (!v?.dealId || !v.at || Date.now() - Date.parse(v.at) > DEAL_KV_TTL_MS) return null
    return String(v.dealId)
  } catch {
    return null
  }
}

async function registrarDealEnKv(fono: string, dealId: string, origen: string): Promise<void> {
  try {
    const { setKvValue } = await import("./supabase-persistence-v3")
    await setKvValue(
      `deal_fono_${fono}`,
      JSON.stringify({ at: new Date().toISOString(), dealId, origen }),
    )
  } catch {
    /* best-effort */
  }
}

/**
 * Enriquecimiento ADITIVO del lead con los datos frescos de la conversación:
 * solo campos vacíos o placeholder — jamás pisa un dato existente (gestión de
 * SDR incluida). Devuelve el lead con los valores efectivos post-update para
 * que la conversión use la empresa/empleados reales.
 */
async function enriquecerLead(lead: LeadEncontrado, datos: DatosConversacion): Promise<LeadEncontrado> {
  const campos: Record<string, unknown> = {}
  if (datos.empresa && esPlaceholder(lead.company)) campos.Company = datos.empresa.slice(0, 200)
  if (datos.email && !lead.email) campos.Email = datos.email
  if (datos.rut && !lead.rut) campos.RUT_Empresa = datos.rut
  if (datos.empleados && !lead.empleados) campos.N_Empleados_que_marcan = datos.empleados
  if (datos.nombre && esPlaceholder(lead.lastName)) {
    const partes = datos.nombre.trim().split(/\s+/)
    campos.Last_Name = partes.length > 1 ? partes.slice(-1)[0] : partes[0]
    if (partes.length > 1) campos.First_Name = partes.slice(0, -1).join(" ")
  }
  if (!Object.keys(campos).length) return lead
  try {
    const { h, api } = await zohoHeaders()
    const r = await fetch(`${api}/crm/v3/Leads`, {
      method: "PUT",
      headers: h,
      cache: "no-store",
      body: JSON.stringify({
        data: [{ id: lead.id, ...campos }],
        skip_feature_execution: [{ name: "assignment_rules" }],
      }),
    })
    const d = (await r.json().catch(() => ({}))) as { data?: Array<{ code?: string }> }
    if (d?.data?.[0]?.code === "SUCCESS") {
      console.log(`[crm-hitos] lead ${lead.id} enriquecido: ${Object.keys(campos).join(", ")}`)
      return {
        ...lead,
        company: (campos.Company as string) || lead.company,
        email: (campos.Email as string) || lead.email,
        rut: (campos.RUT_Empresa as string) || lead.rut,
        empleados: (campos.N_Empleados_que_marcan as number) || lead.empleados,
        lastName: (campos.Last_Name as string) || lead.lastName,
      }
    }
  } catch (e) {
    console.warn(`[crm-hitos] enriquecer ${lead.id} falló:`, e instanceof Error ? e.message : e)
  }
  return lead
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
 * IDENTIDAD COMERCIAL mínima para crear DEAL y CUENTA (exigencia del equipo
 * comercial, Lalo 31-jul): nombre de empresa real o RUT. Sin identidad, el
 * hito queda registrado en el LEAD (status + nota + transcripción) y la
 * conversión espera al dato — que suele llegar uno o dos mensajes después
 * (el prompt ahora pregunta la empresa en la calificación). Mata de raíz los
 * deals "Prospecto WhatsApp" y la cuenta compartida donde convergían todos
 * los anónimos (7 deals de 6 empresas distintas bajo una misma cuenta).
 */
function tieneIdentidadComercial(lead: LeadEncontrado, datos: DatosConversacion): boolean {
  const empresa = [datos.empresa, lead.company].find((v) => v && !esPlaceholder(v))
  return Boolean(empresa || datos.rut || lead.rut)
}

/** Regla de asignación de Deals en Zoho (Lalo, 31-jul): TODO deal que Vicky
 * crea sin dueño humano heredado pasa por la tómbola del equipo — la regla
 * "Tómbola Deals 2026 Chile" (lar_id en el PUT). CO/MX aún sin regla (se
 * suman por env). Si la regla falla, el deal conserva el interino del país:
 * jamás queda en la bandeja de nadie. */
const TOMBOLA_DEALS_POR_TERRITORIO: Record<string, string> = {
  Chile: (process.env.VICKY_PTV_TOMBOLA_DEALS_CL || "3525045000595568541").trim(),
  Colombia: (process.env.VICKY_PTV_TOMBOLA_DEALS_CO || "").trim(),
  "México": (process.env.VICKY_PTV_TOMBOLA_DEALS_MX || "").trim(),
}

/** Notificación de traspaso (Lalo 31-jul): tras el sorteo, el template
 * "Traspaso Deal Global 2024" sale al dueño sorteado con copia a Victoria
 * Luna — la misma alerta del workflow de Zoho, gatillada por API porque el
 * sorteo ocurre DESPUÉS del create (el workflow on-create no la ve). */
const TPL_TRASPASO_DEAL = (process.env.VICKY_TPL_TRASPASO_DEAL || "3525045000389574614").trim()
const CC_TRASPASO_DEAL = (process.env.VICKY_TRASPASO_CC || "vluna@geovictoria.com").trim()

export async function notificarTraspasoDeal(dealId: string): Promise<void> {
  try {
    const { h, api } = await zohoHeaders()
    const g = await fetch(`${api}/crm/v3/Deals/${dealId}?fields=Owner,Territorio`, { headers: h, cache: "no-store" })
    if (!g.ok) return
    const fila = ((await g.json().catch(() => ({}))) as {
      data?: Array<{ Owner?: { email?: string }; Territorio?: string }>
    }).data?.[0]
    const owner = fila?.Owner
    if (!owner?.email) return
    // La copia a Victoria Luna es SOLO CHILE (Lalo 31-jul): CO y MX siguen
    // con sus reglas antiguas — el dueño recibe su aviso, sin CC.
    const esChile = /chile/i.test(String(fila?.Territorio || "")) || !fila?.Territorio
    const { correoEntregable } = await import("./correo-alias")
    const destino = await correoEntregable(owner.email)
    await fetch(`${api}/crm/v3/Deals/${dealId}/actions/send_mail`, {
      method: "POST",
      headers: h,
      cache: "no-store",
      body: JSON.stringify({
        data: [{
          from: { email: "vicky@geovictoria.com" },
          to: [{ email: destino }],
          ...(esChile && CC_TRASPASO_DEAL ? { cc: [{ email: CC_TRASPASO_DEAL }] } : {}),
          template: { id: TPL_TRASPASO_DEAL },
        }],
      }),
    })
  } catch (e) {
    console.warn(`[crm-hitos] notificarTraspasoDeal falló:`, e instanceof Error ? e.message : e)
  }
}

async function aplicarTombolaDeals(dealId: string, territorio: string): Promise<void> {
  const regla = TOMBOLA_DEALS_POR_TERRITORIO[territorio] || ""
  if (!regla) return
  try {
    const { h, api } = await zohoHeaders()
    const res = await fetch(`${api}/crm/v3/Deals`, {
      method: "PUT",
      headers: h,
      cache: "no-store",
      body: JSON.stringify({ data: [{ id: dealId }], lar_id: regla }),
    })
    if (!res.ok) {
      console.warn(`[crm-hitos] tómbola de deals falló (${res.status}) para ${dealId} — conserva el interino`)
      return
    }
    // El dueño sorteado se entera al instante (con copia a Victoria).
    await notificarTraspasoDeal(dealId)
  } catch (e) {
    console.warn(`[crm-hitos] tómbola de deals lanzó:`, e instanceof Error ? e.message : e)
  }
}

/**
 * Convierte el lead con deal naciendo en la etapa del piso (regla de
 * marketing: el deal SIEMPRE nace de la conversión). Owner del deal: dueño
 * humano del lead lo hereda (gestión intocable); sin dueño humano, el deal
 * nace con el interino del país y pasa por la TÓMBOLA de Zoho (Lalo 31-jul).
 * Maneja cuenta duplicada reconvirtiendo con Accounts:{id}.
 */
async function convertirConDeal(
  lead: LeadEncontrado,
  contact: string,
  piso: string,
  // Reunión agendada (Lalo 06-ago): el owner se FUERZA al host de la reunión
  // — mata la carrera lead-reasignado-vs-hito que mandó el deal de VDZ a la
  // tómbola mientras el cliente conocía a Aleydis.
  ownerForzadoId?: string,
): Promise<string | null> {
  const { h, api } = await zohoHeaders()
  const territorio = territorioDeContacto(contact) || "Chile"
  // Sin dato real, el N NO se inventa (Lalo 06-ago): el default 1 mandaba
  // empresas de 500 al tramo SMB de la tómbola de deals (casos VDZ/Bodegas
  // San Francisco/VITAPRO).
  const empleados = lead.empleados || 0
  // CHILE SIN NÚMERO = oportunidad NO calificada (Lalo 06-ago): no nace deal.
  // Con reunión agendada, el LEAD se fuerza al host (él califica en la
  // reunión); sin reunión, vuelve a la tómbola de leads de Aracelli/Aleydis,
  // que califican y ahí recién el deal nace en su tramo real. Dueño humano
  // previo no se pisa: esa gestión ya tiene responsable.
  if (territorio === "Chile" && empleados <= 0) {
    if (ownerForzadoId) {
      await fetch(`${api}/crm/v3/Leads`, {
        method: "PUT",
        headers: h,
        cache: "no-store",
        body: JSON.stringify({
          data: [{ id: lead.id, Owner: { id: ownerForzadoId } }],
          skip_feature_execution: [{ name: "assignment_rules" }],
        }),
      }).catch(() => {})
      console.log(
        `[crm-hitos] +${contact}: hito sin N° de trabajadores CON reunión — deal NO creado; lead ${lead.id} forzado al host de la reunión`,
      )
    } else if (!heredaGestionAlDeal(lead.ownerId, territorio)) {
      const { reasignarLeadCalificacionCL } = await import("./zoho-leads")
      const r = await reasignarLeadCalificacionCL(lead.id).catch(() => null)
      console.log(
        `[crm-hitos] +${contact}: hito sin N° de trabajadores — deal NO creado; lead ${lead.id} → tómbola de calificación (${r?.ownerEmail || "sin asignar"})`,
      )
    } else {
      console.log(
        `[crm-hitos] +${contact}: hito sin N° de trabajadores — deal NO creado; lead ${lead.id} sigue con su dueño humano`,
      )
    }
    return null
  }
  const deal = {
    Deal_Name: `${lead.company || "Prospecto WhatsApp"} (Control de Asistencia)`,
    Stage: piso,
    Pipeline: "Standard (Standard)",
    Territorio: territorio,
    Tombola: "Mantener propietario",
    Sector: "19. Servicios",
    // Moneda por territorio. OJO Perú: el picklist de Zoho usa "SOL" (no
    // "PEN") — verificado contra el metadata del campo el 05-ago.
    Monda_del_trato:
      territorio === "Colombia" ? "COP" : territorio === "México" ? "MXN" : territorio === "Perú" ? "SOL" : "UF",
    Producto_Soluci_n: "Control de Asistencia",
    Tipo_de_Cobro: empleados > 0 && empleados <= 10 ? "Mensual fijo" : "Por usuario",
    ...(empleados > 0 ? { N_Empleados_que_marcan: empleados } : {}),
    Closing_Date: HOY_MAS_30(),
    // Dueño humano del lead → lo hereda el deal. Sin dueño humano:
    // - Territorio CON regla de tómbola (Chile): el deal nace a nombre del
    //   USUARIO VICKY y la tómbola lo sortea al instante. Si el sorteo falla,
    //   queda visiblemente en Vicky (Lalo 04-ago: con Eddyluz-interina era
    //   imposible distinguir "sorteo cayó en Eddy" de "sorteo nunca corrió").
    // - Territorio SIN regla (CO/MX): interino del país como siempre — ahí el
    //   interino ES el dueño real y Vicky-user sería la bandeja de nadie.
    // CO — REGLA EQUIPO (Lalo 05-ago): el deal de un hito NO-formal (preform,
    // reunión, discovery) nace con Eddy Galindo (SDR fijo) y SE QUEDA con él
    // hasta el final (sin cambios de propietario — la formal NO lo traspasa).
    // Solo los registros que la formal CREA nacen con Gordillo.
    Owner: {
      id: heredaGestionAlDeal(lead.ownerId, territorio)
        ? lead.ownerId
        : TOMBOLA_DEALS_POR_TERRITORIO[territorio]
          ? VICKY_OWNER_ID
          : ({ Colombia: "3525045000613817111", "México": "3525045000308323003", "Perú": "3525045000323383015" } as Record<string, string>)[territorio] || VICKY_OWNER_ID,
    },
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
        details?: { duplicate_record?: { id?: string }; Deals?: { id?: string } }
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
  // BUG CAZADO 04-ago (el origen del sesgo de Eddyluz que reportó Victoria):
  // Zoho devuelve los IDs de la conversión DENTRO de details ({code:"SUCCESS",
  // details:{Deals:{id},Contacts:{id},Accounts:{id}}}), y este código los
  // buscaba en la raíz — todo convert exitoso caía al camino de "falló", el
  // deal quedaba creado con la interina y la tómbola JAMÁS corría.
  const dealCreado = fila?.Deals?.id || fila?.details?.Deals?.id
  if (fila?.code === "SUCCESS" && dealCreado) {
    console.log(`[crm-hitos] lead ${lead.id} convertido → deal ${dealCreado} en "${piso}"`)
    // REUNIÓN MANDA (Lalo 06-ago): con reunión agendada el deal se fuerza al
    // HOST — una sola cara ante el cliente. Gana sobre tómbola y traspaso.
    if (ownerForzadoId) {
      await fetch(`${api}/crm/v3/Deals`, {
        method: "PUT",
        headers: h,
        cache: "no-store",
        body: JSON.stringify({
          data: [{ id: String(dealCreado), Owner: { id: ownerForzadoId } }],
          skip_feature_execution: [{ name: "assignment_rules" }],
        }),
      }).catch(() => {})
      console.log(`[crm-hitos] deal ${dealCreado} forzado al host de la reunión (${ownerForzadoId})`)
      await notificarTraspasoDeal(String(dealCreado)).catch(() => {})
      await registrarDealEnKv(contact.replace(/\D/g, ""), String(dealCreado), "hito")
      return String(dealCreado)
    }
    const heredaDuenoHumano = heredaGestionAlDeal(lead.ownerId, territorio)
    // TRASPASO VIGENTE MANDA (caso Ana/Daniela 04-ago): si el contacto tiene
    // vic_ptv activo, al cliente YA se le presentó ese ejecutivo (con nombre,
    // correo y WhatsApp) — sortear el deal a otra persona rompe la promesa.
    // El deal se asigna directo al ejecutivo del traspaso, sin tómbola.
    // EXCEPTO COLOMBIA (regla equipo 05-ago, caso Jotapartes): el deal de un
    // hito no-formal nace y SE QUEDA con Galindo — un vic_ptv del TTV viejo
    // (Gordillo, muchas veces ni siquiera presentado al cliente) no lo pisa.
    let asignadoPorTraspaso = false
    if (!heredaDuenoHumano && territorio !== "Colombia") {
      try {
        const { vendedorTraspasado } = await import("./loop-v2")
        const v = await vendedorTraspasado(contact.replace(/\D/g, ""))
        if (v?.zohoId) {
          await fetch(`${api}/crm/v3/Deals`, {
            method: "PUT",
            headers: h,
            cache: "no-store",
            body: JSON.stringify({
              data: [{ id: String(dealCreado), Owner: { id: v.zohoId } }],
              skip_feature_execution: [{ name: "assignment_rules" }],
            }),
          })
          asignadoPorTraspaso = true
          console.log(`[crm-hitos] deal ${dealCreado} asignado al ejecutivo del traspaso vigente (${v.email})`)
          await notificarTraspasoDeal(String(dealCreado)).catch(() => {})
        }
      } catch { /* sin traspaso vigente, sigue el flujo normal */ }
    }
    if (!asignadoPorTraspaso) {
      if (!heredaDuenoHumano) {
        // MODELO 06-ago (Lalo): en Chile el deal ≤50 nace y ESPERA en el
        // usuario Vicky (la interina oficial) — SIN sorteo y SIN notificación.
        // La asignación al vendedor va de la mano con los relojes de traspaso
        // (120/15/10 min hábiles): asignarEnZoho del cron sortea el deal con
        // la regla de Zoho recién cuando la conversación se traspasa (caso
        // Rodrigo/Neumasport: el sorteo en caliente lo alertaba apenas el
        // cliente veía el precio). Los >50 SÍ se sortean al nacer (doc
        // Rodrigo 30-jul: deal + tómbola en el acto — no tienen relojes).
        if (territorio === "Chile" && empleados > 0 && empleados <= 50) {
          console.log(
            `[crm-hitos] deal ${dealCreado} (${empleados} empleados) queda en Vicky — sorteo y notificación al traspaso, no en caliente`,
          )
        } else {
          await aplicarTombolaDeals(String(dealCreado), territorio)
        }
      } else {
        // Dueño humano heredado (caso Paola/Agrícola Vaticano 04-ago): sin
        // tómbola no salía NINGUNA notificación y el deal nacía en silencio —
        // el dueño se enteraba por casualidad. El correo directo va igual.
        await notificarTraspasoDeal(String(dealCreado)).catch(() => {})
      }
    }
    await registrarDealEnKv(contact.replace(/\D/g, ""), String(dealCreado), "hito")
    return String(dealCreado)
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
export async function actualizarNotaTranscripcion(dealId: string, contact: string): Promise<void> {
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
/**
 * Tools que YA crean su propio lead adentro (agendar/callback): el hook jamás
 * debe crear otro — si el resolver no lo encuentra (lag de indexación), se
 * espera al cron. Los duplicados Catalina/Mayra del 30-jul nacieron de esta
 * carrera.
 */
export const TOOLS_QUE_CREAN_SU_LEAD = new Set([
  "agendar_reunion",
  "reagendar_reunion",
  "registrar_solicitud_callback",
])

export async function sincronizarHitoCrm(
  contact: string,
  hito: Hito,
  datos: DatosConversacion = {},
  opts: { noCrear?: boolean; ownerForzadoEmail?: string } = {},
): Promise<void> {
  try {
    if (!habilitado()) return
    const clean = (contact || "").replace(/\D/g, "")
    if (!clean || esTelefonoDePrueba(clean)) return
    // Host de reunión → id de usuario Zoho (Lalo 06-ago: con reunión, el
    // owner del deal/lead se fuerza al host). Resolución best-effort.
    let ownerForzadoId = ""
    if (opts.ownerForzadoEmail) {
      const { resolveOwnerId } = await import("./zoho-leads")
      const { getZohoAccessToken } = await import("./zoho-token")
      ownerForzadoId =
        (await resolveOwnerId(
          opts.ownerForzadoEmail,
          await getZohoAccessToken(),
          getEnv("ZOHO_API_DOMAIN") || "https://www.zohoapis.com",
        ).catch(() => "")) || ""
    }
    // La clave del guard incluye los datos: el mismo hito con información
    // NUEVA (apareció la empresa, llegó el correo) sí se re-procesa.
    const key = `${clean}:${hito}:${JSON.stringify(datos)}`
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
      // Candado cruzado: si la OTRA puerta (emisión de la formal) acaba de
      // crear lead+deal para este fono, la búsqueda de Zoho aún no los ve —
      // crear acá duplicaba lead Y deal. Se reusa el deal y solo sube el piso.
      const dealCruzado = await dealActivoEnKv(clean)
      if (dealCruzado) {
        console.log(`[crm-hitos] ${clean}: deal ${dealCruzado} recién creado por la otra puerta (candado kv) — hito "${hito}" solo sube el piso, sin lead ni deal nuevos`)
        await avanzarDealHasta(dealCruzado, piso)
        await actualizarNotaTranscripcion(dealCruzado, clean)
        return
      }
      if (opts.noCrear) {
        console.log(`[crm-hitos] ${clean}: la tool crea su propio lead — no se duplica (se reconcilia en el próximo barrido)`)
        return
      }
      // ENTRANTE puro (hito sin tool de derivación): lead nuevo con DUEÑO
      // INTERINO POR PAÍS (Lalo 30-jul) — la tómbola de Zoho no corre en
      // creaciones por API y la tómbola definitiva de Victoria aún no existe;
      // sin esto quedaban a nombre del usuario Vicky, en la bandeja de nadie.
      // Los callbacks y reuniones NO pasan por acá: el callback entra a la
      // tómbola de Zoho y la reunión hereda el owner que define Cal.com.
      const territorio = territorioDeContacto(clean)
      const esCO = territorio === "Colombia"
      const OWNER_INTERINO: Record<string, string> = {
        Chile: "3525045000000211283", // Eddyluz Mujica
        Colombia: "3525045000203758005", // Alejandro Gordillo (solo fallback)
        "México": "3525045000308323003", // Yahel Segura
        // Perú: Mónica Mendoza — NO es interina sino la ejecutiva única real
        // (sin tómbola), por eso NO está en INTERINOS: su gestión SÍ se
        // hereda al deal.
        "Perú": "3525045000323383015",
      }
      const { createZohoLead } = await import("./zoho-leads")
      const creado = await createZohoLead({
        contactoWA: clean,
        telefono: clean,
        nombre: datos.nombre,
        empresa: datos.empresa,
        email: datos.email,
        trabajadores: datos.empleados,
        // CO: el lead SIN cotización lo posee el SDR Inbound (acuerdo equipo CO
        // 04-ago: Gordillo/Valeria) — se asigna abajo por round-robin, no acá.
        // Si más tarde emite formal, el deal pasa al ejecutivo (heredaGestion).
        ownerId: esCO ? undefined : territorio ? OWNER_INTERINO[territorio] : undefined,
      })
      if (!creado.success) {
        console.warn(`[crm-hitos] ${clean}: no se pudo crear lead (${creado.error})`)
        return
      }
      if (esCO) {
        const { reasignarLeadSdrInboundCO } = await import("./zoho-leads")
        await reasignarLeadSdrInboundCO(creado.leadId).catch(() => {})
      }
      const lead: LeadEncontrado = {
        id: creado.leadId,
        ownerId: "",
        status: "",
        company: datos.empresa || "",
        empleados: datos.empleados || 0,
        email: datos.email || "",
        lastName: datos.nombre || "",
        rut: "",
        ultimaActividad: "",
        convertido: false,
        dealId: null,
        contactId: null,
      }
      await subirLeadStatus(lead, hito)
      if (!tieneIdentidadComercial(lead, datos)) {
        console.log(`[crm-hitos] ${clean}: hito "${hito}" sin empresa/RUT — lead ${creado.leadId} espera identidad para convertir (deal pendiente)`)
        return
      }
      const dealId = await convertirConDeal(lead, clean, piso, ownerForzadoId || undefined)
      if (!dealId) console.warn(`[crm-hitos] ${clean}: lead ${creado.leadId} quedó sin convertir`)
      else await actualizarNotaTranscripcion(dealId, clean)
      return
    }

    // Hay lead (caso SALIENTE o entrante repetido). Primero el enriquecimiento
    // aditivo: cualquier dato nuevo de la conversación entra a campos vacíos.
    const lead = await enriquecerLead(res.lead, datos)
    // "De Vicky" = usuario Vicky O interinos por país (04-ago): la interina es
    // marcador de "sin dueño real", no gestión — tratarla como humana dejaba
    // sus leads sin convertir (backfill de los 14 forzados a Eddyluz).
    // Y en COLOMBIA también los SDR Inbound (fix 05-ago): el lead sin
    // cotización vive con el SDR POR DISEÑO, y el hito de cotización ES el
    // handoff SDR→ejecutivo — el lead debe convertirse (el deal no hereda al
    // SDR: heredaGestionAlDeal lo excluye y el dueño sale del mapa CO).
    // Tratarlo como "dueño humano" dejaba los leads SDR CO sin convertir nunca.
    const esSdrCO =
      territorioDeContacto(clean) === "Colombia" && SDR_CO_IDS.has(lead.ownerId)
    const esDeVicky = !lead.ownerId || INTERINOS.has(lead.ownerId) || esSdrCO

    // ── Reglas de re-contacto (doc David 30-jul) — detrás de sub-flag ──
    // Reglas 2/5: registro activo → RE-NOTIFICAR al dueño, sin crear nada.
    // Regla 3: "No Calificado" <3 meses → se re-trabaja el mismo lead;
    //          >3 meses → lead NUEVO en etapa 1 (excepción legítima al dedup).
    // Todo por el canal trasero: jamás toca la conversación.
    if (await reglasRecontactoActivas()) {
      if (!lead.convertido && !esDeVicky) {
        if (/no calificado/i.test(lead.status)) {
          const tresMeses = 90 * 864e5
          const viejo = lead.ultimaActividad && Date.now() - Date.parse(lead.ultimaActividad) > tresMeses
          if (viejo) {
            // >3 meses: renace como lead nuevo (regla 3b). Se libera el
            // candado para que la creación proceda.
            const { setKvValue } = await import("./supabase-persistence-v3")
            await setKvValue(`zoho_lead_${clean}`, "").catch(() => {})
            const { createZohoLead } = await import("./zoho-leads")
            const nuevo = await createZohoLead({
              contactoWA: clean, telefono: clean, nombre: datos.nombre,
              empresa: datos.empresa, email: datos.email, trabajadores: datos.empleados,
            })
            if (nuevo.success) console.log(`[crm-hitos] ${clean}: lead renacido ${nuevo.leadId} (No Calificado >3 meses, regla 3b)`)
            return
          }
          // <3 meses (regla 3a): se re-trabaja el mismo lead — sigue el flujo
          // normal de status/nota más abajo.
        }
        // Regla 2: lead activo de dueño humano → re-notificar (nota; el flujo
        // de abajo ya evita convertir leads ajenos).
        const { agregarNotaLead } = await import("./zoho-leads")
        await agregarNotaLead(
          lead.id,
          "El cliente volvió a escribirle a Vicky",
          `Re-contacto por WhatsApp (hito: ${hito}). El cliente retomó la conversación con Vicky; este lead es tuyo y no se creó ninguno nuevo. Revisa la transcripción en las notas para el contexto.`,
        ).catch(() => false)
      }
    }

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
      if (!tieneIdentidadComercial(lead, datos)) {
        console.log(`[crm-hitos] ${clean}: hito "${hito}" sin empresa/RUT — lead ${lead.id} espera identidad para convertir (deal pendiente)`)
        return
      }
      // Candado cruzado: la emisión pudo haber creado SU deal hace segundos
      // (con OTRO lead convertido). Convertir este lead con un deal propio
      // duplicaba — se reusa el existente y este lead queda solo con status.
      const dealCruzado = await dealActivoEnKv(clean)
      if (dealCruzado) {
        console.log(`[crm-hitos] ${clean}: deal ${dealCruzado} recién creado por la otra puerta (candado kv) — hito "${hito}" sube el piso, lead ${lead.id} no convierte deal propio`)
        await avanzarDealHasta(dealCruzado, piso)
        await actualizarNotaTranscripcion(dealCruzado, clean)
        return
      }
      const dealNuevo = await convertirConDeal(lead, clean, piso, ownerForzadoId || undefined)
      if (dealNuevo) await actualizarNotaTranscripcion(dealNuevo, clean)
      return
    }

    // Lead ya convertido: ubicar el deal y subirlo al piso.
    let dealId = lead.dealId
    if (!dealId && lead.contactId) {
      const deal = await dealVivoDelContacto(lead.contactId)
      dealId = deal?.id || null
    }
    // Reglas 4/6 (doc David): deal en Cierre Perdido o en 8. Facturando →
    // el re-contacto RENACE como lead nuevo en etapa 1 (nueva oportunidad).
    if (await reglasRecontactoActivas()) {
      const { h, api } = await zohoHeaders()
      const idParaEstado = dealId || lead.dealId
      let stageActual = ""
      if (idParaEstado) {
        const rEstado = await fetch(`${api}/crm/v3/Deals/${idParaEstado}?fields=Stage,Owner`, { headers: h, cache: "no-store" })
        const dEstado = ((await rEstado.json().catch(() => ({}))) as { data?: Array<{ Stage?: string; Owner?: { id?: string } }> }).data?.[0]
        stageActual = String(dEstado?.Stage || "")
        if (stageActual === "Cierre Perdido" || stageActual === "8. Facturando") {
          const { setKvValue } = await import("./supabase-persistence-v3")
          await setKvValue(`zoho_lead_${clean}`, "").catch(() => {})
          const { createZohoLead } = await import("./zoho-leads")
          const nuevo = await createZohoLead({
            contactoWA: clean, telefono: clean, nombre: datos.nombre,
            empresa: datos.empresa, email: datos.email, trabajadores: datos.empleados,
          })
          if (nuevo.success) console.log(`[crm-hitos] ${clean}: lead renacido ${nuevo.leadId} (deal en "${stageActual}", reglas 4/6)`)
          return
        }
        // Regla 5: deal ACTIVO → re-notificar al dueño del deal, sin crear nada.
        const { agregarNotaLead } = await import("./zoho-leads")
        await fetch(`${api}/crm/v3/Notes`, {
          method: "POST", headers: h, cache: "no-store",
          body: JSON.stringify({ data: [{
            Note_Title: "El cliente volvió a escribirle a Vicky",
            Note_Content: `Re-contacto por WhatsApp (hito: ${hito}). El cliente retomó la conversación; este deal es tuyo y no se creó ninguno nuevo. Transcripción actualizada en las notas.`,
            Parent_Id: idParaEstado, $se_module: "Deals",
          }] }),
        }).catch(() => null)
        void agregarNotaLead
      }
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
