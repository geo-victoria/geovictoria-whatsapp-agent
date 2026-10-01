/**
 * LEADS GEMELOS (Lalo 01-oct, "dale con el punto 2"; reclamos de Mónica y
 * Priscila del 30-sep): cuando un cliente tiene TRATO, ningún otro lead
 * abierto de su mismo teléfono puede seguir vivo. Hoy nacen gemelos por la
 * carrera formulario-vs-Vicky: el formulario web crea un lead (que la regla de
 * marketing entrega a una SDR) y, segundos después, el chat de Vicky busca por
 * teléfono, el buscador de Zoho todavía no lo indexó (~2 min) y nace otro
 * lead; cuando el de Vicky se convierte en trato, el del formulario queda
 * abierto y la SDR llama a un cliente que ya está con su ejecutivo.
 *
 * Dos piezas:
 *  - `leadsAbiertosPorTelefono`: COQL (va a la base, no al índice de búsqueda,
 *    así que ve un lead creado hace segundos). La usa createZohoLead como
 *    última búsqueda ANTES de crear, y este módulo para cazar gemelos.
 *  - `cerrarLeadsGemelos`: con el trato ya en manos de una persona, cada lead
 *    abierto del mismo teléfono se cierra "No Calificado / Duplicado en otro
 *    canal", con nota que nombra el trato y su dueño, y su dueño (si es una
 *    persona distinta) recibe un correo con copia al dueño del trato.
 *    Un trato que sigue con el usuario Vicky (esperando el traspaso) NO se
 *    toca: se espera a que tenga dueño. Un trato perdido tampoco.
 *
 * Global (4 países). Best-effort: jamás lanza ni toca la conversación.
 */

const VICKY_OWNER_ID = "3525045000484500876"
const OWNERS_ROBOT = /^(vicky@|info@geovictoria|ventas@geovictoria|productmanager@geovictoria)/i
const PREFIJO_TERRITORIO: Array<[RegExp, string]> = [
  [/^56\d{9}$/, "chile"],
  [/^51\d{9}$/, "peru"],
  [/^57\d{10}$/, "colombia"],
  [/^52\d{10}$/, "mexico"],
]

const sinTildes = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim()

/** Dígitos del teléfono, colapsando el prefijo de país repetido del formulario ("+5656…"). PURO. */
export function digitosTel(raw: string): string {
  let t = String(raw || "").replace(/\D/g, "")
  if (/^(56|57|52|51)\1\d{8,12}$/.test(t)) t = t.slice(2)
  return t
}

/** Territorio (normalizado, sin tildes) que corresponde al número completo. PURO. */
export function territorioDeFono(fono: string): string {
  const d = digitosTel(fono)
  for (const [re, t] of PREFIJO_TERRITORIO) if (re.test(d)) return t
  return ""
}

/**
 * ¿El teléfono de un lead es el del contacto? PURO.
 * - Con código de país en el lead: los dígitos tienen que calzar completos.
 * - Sin código (el formulario a veces guarda solo el número local): calzan
 *   los dígitos locales Y el Territorio del lead tiene que ser el del país —
 *   Chile y Perú comparten celulares de 9 dígitos que empiezan en 9.
 */
export function telCalza(rawLead: string, fono: string, territorioLead = ""): boolean {
  const lead = digitosTel(rawLead)
  const contacto = digitosTel(fono)
  if (!lead || !contacto || lead.length < 8) return false
  if (lead === contacto) return true
  const pais = territorioDeFono(contacto)
  const local = contacto.slice(2) // los cuatro países tienen código de 2 dígitos
  if (lead === local) return !territorioLead || sinTildes(territorioLead) === pais
  return false
}

export type LeadGemelo = {
  id: string
  nombre: string
  empresa: string
  status: string
  ownerId: string
  ownerEmail: string
  ownerNombre: string
  creado: string
  territorio: string
}

type FilaLead = {
  id: string
  Full_Name?: string | null
  Company?: string | null
  Phone?: string | null
  Mobile?: string | null
  Lead_Status?: string | null
  Owner?: { id?: string } | null
  "Owner.email"?: string | null
  "Owner.first_name"?: string | null
  "Owner.last_name"?: string | null
  Created_Time?: string | null
  Territorio?: string | null
}

async function zoho(): Promise<{ H: Record<string, string>; api: string }> {
  const { getZohoAccessToken } = await import("./zoho-token")
  const token = await getZohoAccessToken()
  const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
  return { H: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }, api }
}

async function coql<T>(H: Record<string, string>, api: string, select_query: string): Promise<T[]> {
  const r = await fetch(`${api}/crm/v8/coql`, { method: "POST", headers: H, cache: "no-store", body: JSON.stringify({ select_query }) })
  if (r.status === 204) return []
  if (!r.ok) throw new Error(`COQL ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`)
  return (((await r.json().catch(() => ({}))) as { data?: T[] }).data || [])
}

/**
 * Leads SIN convertir y no descartados del teléfono, creados en los últimos
 * `dias`. COQL por los 3 últimos dígitos (el formulario guarda el número con
 * espacios "+51957 732 010" — los 3 finales siempre quedan juntos) y el calce
 * exacto se hace en código. Un fallo de la consulta se LOGUEA y devuelve [].
 */
export async function leadsAbiertosPorTelefono(
  fono: string,
  opts: { dias?: number; excluir?: string[] } = {},
): Promise<LeadGemelo[]> {
  const d = digitosTel(fono)
  if (d.length < 9) return []
  try {
    const { H, api } = await zoho()
    const desde = new Date(Date.now() - (opts.dias ?? 60) * 864e5).toISOString().slice(0, 19) + "+00:00"
    const fin = d.slice(-3)
    const filas = await coql<FilaLead>(
      H,
      api,
      `select id, Full_Name, Company, Phone, Mobile, Lead_Status, Owner, Owner.email, Owner.first_name, Owner.last_name, Created_Time, Territorio from Leads where ((Converted__s = false and Created_Time >= '${desde}') and (Phone like '%${fin}' or Mobile like '%${fin}')) limit 200`,
    )
    const excluir = new Set(opts.excluir || [])
    return filas
      .filter((l) => !excluir.has(String(l.id)))
      .filter((l) => !/^no calificado/i.test(String(l.Lead_Status || "")))
      .filter((l) => telCalza(String(l.Phone || ""), d, String(l.Territorio || "")) || telCalza(String(l.Mobile || ""), d, String(l.Territorio || "")))
      .map((l) => ({
        id: String(l.id),
        nombre: String(l.Full_Name || ""),
        empresa: String(l.Company || ""),
        status: String(l.Lead_Status || ""),
        ownerId: String(l.Owner?.id || ""),
        ownerEmail: String(l["Owner.email"] || ""),
        ownerNombre: [l["Owner.first_name"], l["Owner.last_name"]].filter(Boolean).join(" "),
        creado: String(l.Created_Time || ""),
        territorio: String(l.Territorio || ""),
      }))
  } catch (e) {
    console.warn(`[leads-gemelos] búsqueda ${d} falló:`, e instanceof Error ? e.message : e)
    return []
  }
}

/** Transición "No Calificado" de los dos blueprints de Leads (Chile y Latam no Chile). */
const TRANSICIONES_NO_CALIFICADO = ["3525045000350997005", "3525045000351550301"]

export async function cerrarLeadNoCalificado(leadId: string, motivo: string): Promise<boolean> {
  const { H, api } = await zoho()
  for (const transicion of TRANSICIONES_NO_CALIFICADO) {
    try {
      const t = await fetch(`${api}/crm/v2/Leads/${leadId}/actions/blueprint`, {
        method: "PUT",
        headers: H,
        cache: "no-store",
        body: JSON.stringify({ blueprint: [{ transition_id: transicion, data: { Motivo_No_calificado: motivo } }] }),
      })
      const tb = (await t.json().catch(() => ({}))) as { code?: string }
      if (t.ok && tb?.code === "SUCCESS") return true
    } catch { /* prueba la siguiente o cae al PUT */ }
  }
  const put = await fetch(`${api}/crm/v3/Leads`, {
    method: "PUT",
    headers: H,
    cache: "no-store",
    body: JSON.stringify({
      data: [{ id: leadId, Lead_Status: "No Calificado", Motivo_No_calificado: motivo }],
      trigger: ["blueprint"],
      skip_feature_execution: [{ name: "assignment_rules" }],
    }),
  })
  const body = (await put.json().catch(() => ({}))) as { data?: Array<{ code?: string }> }
  return put.ok && body?.data?.[0]?.code === "SUCCESS"
}

export type ResultadoGemelo = {
  leadId: string
  leadDueno: string
  accion: "cerrado" | "cerrado_sin_estado" | "ya_revisado" | "dry"
  avisado: boolean
}

type DealInfo = { id: string; nombre: string; stage: string; ownerId: string; ownerEmail: string; ownerNombre: string }

async function leerDeal(dealId: string): Promise<DealInfo | null> {
  const { H, api } = await zoho()
  const r = await fetch(`${api}/crm/v8/Deals/${dealId}?fields=Deal_Name,Stage,Owner`, { headers: H, cache: "no-store" })
  if (r.status !== 200) return null
  const d = (((await r.json().catch(() => ({}))) as { data?: Array<Record<string, unknown>> }).data || [])[0]
  if (!d) return null
  const o = (d.Owner || {}) as { id?: string; email?: string; name?: string }
  return {
    id: dealId,
    nombre: String(d.Deal_Name || ""),
    stage: String(d.Stage || ""),
    ownerId: String(o.id || ""),
    ownerEmail: String(o.email || ""),
    ownerNombre: String(o.name || ""),
  }
}

async function avisarDuenoLead(lead: LeadGemelo, deal: DealInfo, fono: string): Promise<boolean> {
  try {
    const { H, api } = await zoho()
    const { correoEntregable } = await import("./correo-alias")
    const destino = await correoEntregable(lead.ownerEmail)
    const cc = deal.ownerEmail && deal.ownerEmail.toLowerCase() !== destino.toLowerCase() ? [{ email: deal.ownerEmail }] : []
    const quien = lead.empresa && !/^prospecto|por identificar|^-$/i.test(lead.empresa) ? lead.empresa : lead.nombre || `+${fono}`
    const res = await fetch(`${api}/crm/v3/Leads/${lead.id}/actions/send_mail`, {
      method: "POST",
      headers: H,
      cache: "no-store",
      body: JSON.stringify({
        data: [
          {
            from: { email: "vicky@geovictoria.com" },
            to: [{ email: destino }],
            ...(cc.length ? { cc } : {}),
            subject: `Lead duplicado cerrado: ${quien} ya tiene trato con ${deal.ownerNombre || "otro ejecutivo"}`,
            mail_format: "html",
            content:
              `<html><body style="font-family:Segoe UI,Arial,sans-serif;color:#2d3748;">` +
              `<p>Cerramos tu lead <b>${lead.nombre || quien}</b> (+${fono}) como <i>No Calificado / Duplicado en otro canal</i>.</p>` +
              `<p>Este cliente ya tiene el trato <b>${deal.nombre}</b> (${deal.stage}) a cargo de <b>${deal.ownerNombre || deal.ownerEmail}</b>. Para que no lo contacten dos personas, la gestión sigue solo en el trato.</p>` +
              `<p>Si ya estabas conversando con él, coordínalo directamente con ${deal.ownerNombre || "el dueño del trato"} (va en copia).</p>` +
              `<p><a href="https://crm.zoho.com/crm/org685875245/tab/Potentials/${deal.id}">Ver el trato</a> · ` +
              `<a href="https://crm.zoho.com/crm/org685875245/tab/Leads/${lead.id}">Ver el lead cerrado</a></p>` +
              `</body></html>`,
          },
        ],
      }),
    })
    if (!res.ok) console.warn(`[leads-gemelos] aviso a ${destino} devolvió ${res.status} (lead ${lead.id})`)
    return res.ok
  } catch (e) {
    console.warn("[leads-gemelos] aviso falló:", e instanceof Error ? e.message : e)
    return false
  }
}

async function notaEnLead(leadId: string, deal: DealInfo, cerrado: boolean): Promise<void> {
  try {
    const { H, api } = await zoho()
    await fetch(`${api}/crm/v3/Notes`, {
      method: "POST",
      headers: H,
      cache: "no-store",
      body: JSON.stringify({
        data: [
          {
            Note_Title: "Lead duplicado: el cliente ya tiene trato",
            Note_Content:
              `Este cliente ya tiene el trato "${deal.nombre}" (${deal.stage}) a cargo de ${deal.ownerNombre || deal.ownerEmail} (id ${deal.id}). ` +
              `Regla (Lalo 01-oct): con trato vivo no queda ningún lead abierto del mismo teléfono, para que no lo contacten dos personas. ` +
              (cerrado ? "Se cerró como No Calificado / Duplicado en otro canal." : "OJO: el cambio de estado falló; corresponde No Calificado / Duplicado en otro canal."),
            Parent_Id: { module: { api_name: "Leads" }, id: leadId },
          },
        ],
      }),
    })
  } catch { /* la nota es informativa */ }
}

/**
 * Cierra los leads abiertos del teléfono del trato. `leadConvertidoId` se
 * excluye (es el que originó el trato). No toca nada si el trato sigue con un
 * robot o está perdido.
 */
export async function cerrarLeadsGemelos(opts: {
  fono: string
  dealId: string
  leadConvertidoId?: string
  dry?: boolean
}): Promise<{ deal?: DealInfo | null; motivo?: string; resultados: ResultadoGemelo[] }> {
  const fono = digitosTel(opts.fono)
  const resultados: ResultadoGemelo[] = []
  if (!fono || !opts.dealId) return { motivo: "sin_datos", resultados }
  const deal = await leerDeal(opts.dealId).catch(() => null)
  if (!deal) return { deal, motivo: "deal_ilegible", resultados }
  if (/cierre perdido/i.test(deal.stage)) return { deal, motivo: "deal_perdido", resultados }
  if (!deal.ownerId || deal.ownerId === VICKY_OWNER_ID || OWNERS_ROBOT.test(deal.ownerEmail)) {
    return { deal, motivo: "deal_sin_dueno_humano", resultados }
  }
  const gemelos = await leadsAbiertosPorTelefono(fono, { excluir: opts.leadConvertidoId ? [opts.leadConvertidoId] : [] })
  if (!gemelos.length) return { deal, motivo: "sin_gemelos", resultados }
  const { getKvValue, setKvValue } = await import("./supabase-persistence-v3")
  for (const l of gemelos) {
    const llave = `gemelo_lead_${l.id}`
    if (await getKvValue(llave).catch(() => null)) {
      resultados.push({ leadId: l.id, leadDueno: l.ownerEmail, accion: "ya_revisado", avisado: false })
      continue
    }
    if (opts.dry) {
      resultados.push({ leadId: l.id, leadDueno: l.ownerEmail, accion: "dry", avisado: false })
      continue
    }
    const cerrado = await cerrarLeadNoCalificado(l.id, "Duplicado en otro canal").catch(() => false)
    await notaEnLead(l.id, deal, cerrado)
    const humano = l.ownerEmail && !OWNERS_ROBOT.test(l.ownerEmail)
    const distinto = l.ownerEmail.toLowerCase() !== deal.ownerEmail.toLowerCase()
    const avisado = humano && distinto ? await avisarDuenoLead(l, deal, fono) : false
    await setKvValue(
      llave,
      JSON.stringify({ at: new Date().toISOString(), dealId: deal.id, dealOwner: deal.ownerEmail, cerrado, avisado }),
    ).catch(() => undefined)
    console.log(
      `[leads-gemelos] +${fono}: lead ${l.id} (${l.ownerEmail || "?"}) cerrado=${cerrado} avisado=${avisado} — trato ${deal.id} de ${deal.ownerEmail}`,
    )
    resultados.push({ leadId: l.id, leadDueno: l.ownerEmail, accion: cerrado ? "cerrado" : "cerrado_sin_estado", avisado })
  }
  return { deal, resultados }
}

/**
 * Barrido: tratos creados por Vicky en las últimas `horas` (default 72) con
 * dueño humano → cierra sus leads gemelos. Cubre las DOS puertas que crean
 * tratos (los hitos del agente y la emisión del cotizador) sin repetir la
 * lógica en el cotizador. Un trato se revisa a lo más cada 3 h.
 */
export async function barrerLeadsGemelos(opts: { dry?: boolean; horas?: number; max?: number } = {}): Promise<{
  revisados: number
  conGemelos: number
  detalle: Array<{ dealId: string; fono: string; motivo?: string; resultados: ResultadoGemelo[] }>
}> {
  const { H, api } = await zoho()
  const desde = new Date(Date.now() - (opts.horas ?? 72) * 3600e3).toISOString().slice(0, 19) + "+00:00"
  type FilaDeal = { id: string; "Contact_Name.Phone"?: string | null; "Contact_Name.Mobile"?: string | null; "Owner.email"?: string | null }
  const deals = await coql<FilaDeal>(
    H,
    api,
    `select id, Contact_Name.Phone, Contact_Name.Mobile, Owner.email from Deals where (Created_By = '${VICKY_OWNER_ID}' and Created_Time >= '${desde}') order by Created_Time desc limit 200`,
  )
  const { getKvValue, setKvValue } = await import("./supabase-persistence-v3")
  const max = opts.max ?? 40
  const detalle: Array<{ dealId: string; fono: string; motivo?: string; resultados: ResultadoGemelo[] }> = []
  let revisados = 0
  for (const d of deals) {
    if (revisados >= max) break
    if (OWNERS_ROBOT.test(String(d["Owner.email"] || ""))) continue // espera al traspaso
    const fono = digitosTel(String(d["Contact_Name.Phone"] || d["Contact_Name.Mobile"] || ""))
    if (!territorioDeFono(fono)) continue
    const marca = `gemelos_revisado_${d.id}`
    const previa = Number((await getKvValue(marca).catch(() => "")) || 0)
    if (!opts.dry && previa && Date.now() - previa < 3 * 3600e3) continue
    revisados++
    const r = await cerrarLeadsGemelos({ fono, dealId: d.id, dry: opts.dry })
    if (!opts.dry) await setKvValue(marca, String(Date.now())).catch(() => undefined)
    if (r.resultados.length) detalle.push({ dealId: d.id, fono, motivo: r.motivo, resultados: r.resultados })
  }
  return { revisados, conGemelos: detalle.length, detalle }
}
