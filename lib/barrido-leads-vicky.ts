/**
 * BARRIDO DE LEADS A NOMBRE DE VICKY (Lalo 09-sep: "nada queda a nombre de
 * Vicky mucho tiempo; si se queda, pasa a No Calificado por duplicidad").
 *
 * Por qué existe (autopsia del 09-sep, 84 leads varados):
 *  1. El rescate del form-fill (`rescatarFormSinConversacion`) dejaba candados
 *     "conversa"/"gemelo" y el lead SEGUÍA con Vicky para siempre; como su
 *     COQL toma los 50 más antiguos, los candados TAPABAN la ventana y los
 *     form-fills nuevos jamás se evaluaban (13 acumulados hasta 2 semanas).
 *  2. Quien conversó sin llegar a dotación/precio no tiene reloj: el de
 *     calificación 24h solo mira "no respondió la 1ª pregunta", y el de
 *     etapa (120') se apaga cuando el loop se cierra (derivado, soporte,
 *     no_interesa). Ahumada, Datasystems, Carsnack quedaron 2 semanas sin
 *     dueño humano.
 *  3. Leads huérfanos junto a deals vivos: el hito/emisión creó contacto +
 *     deal desde OTRO registro y el lead de Vicky quedó abierto (28 casos).
 *
 * Qué hace, por cada lead sin convertir con dueño Vicky y >24 h de edad,
 * en horario hábil del país, máx N por pasada, candado 7 d por lead:
 *  A) DUPLICADO: el teléfono ya es un CONTACTO con deal (cualquier etapa) o
 *     con dueño humano, o hay OTRO lead sin convertir de un humano → cierra
 *     "No Calificado / Duplicado en otro canal" con nota que nombra el
 *     registro vivo. Nadie recibe un lead que ya está siendo atendido.
 *  B) NO PROSPECTO: la casuística del chat dice cliente/soporte/trabajador →
 *     cierra con su motivo (Es un usuario, etc.) y nota con la evidencia.
 *  C) ENTREGA: calificado (dotación en el registro o en el chat, o precio
 *     mostrado) → regla TLMK ejecutivos; sin calificar → regla SDR. CO →
 *     Galindo, MX → SDR MX, PE → Mónica. Status tope "3. Contactado", aviso
 *     por correo al dueño nuevo y nota con resumen + transcripción.
 *
 * Todo best-effort y fuera del camino de la conversación. `dry` lista sin
 * tocar nada. Interruptor sin deploy: vic_kv `barrido_leads_vicky` = "off".
 */

import { getZohoAccessToken } from "./zoho-token"
import { fetchHistoryV3, getKvValue, setKvValue, getQuotePointer } from "./supabase-persistence-v3"
import {
  agregarNotaLead,
  reasignarLeadCalificacionCL,
  reasignarLeadTelemarketingCL,
  reasignarLeadSdrInboundCO,
  reasignarLeadSdrInboundMX,
  updateZohoLeadStatus,
  STATUS_ENTREGA_LEAD,
} from "./zoho-leads"
import { notificarLeadAsignado } from "./notificar-lead-asignado"
import { esHorarioHabil } from "./ptv"
import { casuisticaDeContacto } from "./casuistica-runtime"
import { datosDelChat } from "./extraer-datos-chat"

const VICKY_EMAIL = "vicky@geovictoria.com"
const OWNERS_ROBOT = /^(vicky@|info@geovictoria|ventas@geovictoria)/i
const MONICA_PE_ID = "3525045000323383015"
const RE_INTERNO = /prueba|test vicky|test carlos|no llamar|geovictoria|pruebasmkt|huellerocompany/i

export type ResultadoLead = {
  leadId: string
  nombre: string
  telefono: string
  pais: string
  horas: number
  accion: "duplicado" | "no_prospecto" | "entregado" | "omitido" | "error"
  detalle: string
  ownerEmail?: string
}

type LeadRow = {
  id: string
  First_Name?: string | null
  Last_Name?: string | null
  Company?: string | null
  Phone?: string | null
  Email?: string | null
  Lead_Status?: string | null
  N_Empleados_que_marcan?: number | null
  Territorio?: string | null
  Created_Time?: string | null
  Form_Vicky?: string | null
}

async function zoho(): Promise<{ H: Record<string, string>; api: string }> {
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

function paisDe(tel: string, territorio: string): string {
  if (/^56\d{9}$/.test(tel)) return "cl"
  if (/^57\d{10}$/.test(tel)) return "co"
  if (/^52\d{10}$/.test(tel)) return "mx"
  if (/^51\d{9}$/.test(tel)) return "pe"
  const t = territorio.toLowerCase()
  if (t === "chile") return "cl"
  if (t === "colombia") return "co"
  if (t === "méxico" || t === "mexico") return "mx"
  if (t === "perú" || t === "peru") return "pe"
  return ""
}

function normalizarTel(raw: string): string {
  let tel = String(raw || "").replace(/\D/g, "")
  if (/^(56|57|52|51)\1\d{8,12}$/.test(tel)) tel = tel.slice(2)
  return tel
}

async function feriados(pais: string): Promise<Set<string>> {
  try {
    const url = (process.env.SUPABASE_URL || "").trim().replace(/\/$/, "")
    const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
    if (!url || !key) return new Set()
    const r = await fetch(`${url}/rest/v1/vic_holidays?select=*&limit=500`, { headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: "no-store" })
    if (!r.ok) return new Set()
    const filas = (await r.json()) as Array<Record<string, unknown>>
    const set = new Set<string>()
    for (const f of filas) {
      const fecha = String(f.d || f.date || f.fecha || "").slice(0, 10)
      const p = String(f.country || f.pais || "").toLowerCase()
      if (fecha && (!p || p === pais)) set.add(fecha)
    }
    return set
  } catch {
    return new Set()
  }
}

async function cerrarNoCalificado(H: Record<string, string>, api: string, leadId: string, motivo: string): Promise<boolean> {
  // Un lead en "3." está EN blueprint → transición "No Calificado"; en "1."/"2."
  // no está en proceso → PUT directo. Se intenta la transición y se cae al PUT.
  try {
    const t = await fetch(`${api}/crm/v2/Leads/${leadId}/actions/blueprint`, {
      method: "PUT", headers: H, cache: "no-store",
      body: JSON.stringify({ blueprint: [{ transition_id: "3525045000350997005", data: { Motivo_No_calificado: motivo } }] }),
    })
    const tb = (await t.json().catch(() => ({}))) as { code?: string }
    if (t.ok && tb?.code === "SUCCESS") return true
  } catch { /* cae al PUT */ }
  const put = await fetch(`${api}/crm/v3/Leads`, {
    method: "PUT", headers: H, cache: "no-store",
    body: JSON.stringify({
      data: [{ id: leadId, Lead_Status: "No Calificado", Motivo_No_calificado: motivo }],
      trigger: ["blueprint"],
      skip_feature_execution: [{ name: "assignment_rules" }],
    }),
  })
  const body = (await put.json().catch(() => ({}))) as { data?: Array<{ code?: string }> }
  return put.ok && body?.data?.[0]?.code === "SUCCESS"
}

async function transcript(tel: string): Promise<string> {
  try {
    const h = await fetchHistoryV3(tel, 40)
    return h
      .filter((m) => !String(m.content || "").startsWith("[REGISTRO INTERNO"))
      .map((m) => {
        const at = String((m as { at?: string }).at || "").slice(0, 16).replace("T", " ")
        return `[${at}] ${m.role === "user" ? "CLIENTE" : "Vicky"}: ${String(m.content || "").replace(/\s+/g, " ").slice(0, 500)}`
      })
      .join("\n")
  } catch {
    return ""
  }
}

/** ¿El teléfono ya tiene un proceso en otro registro? Devuelve la descripción o null. */
async function procesoEnOtroRegistro(H: Record<string, string>, api: string, tel: string, leadId: string): Promise<string | null> {
  if (!tel) return null
  const p = `+${tel}`
  // (1) Otro lead sin convertir con dueño humano.
  const leads = await coql<{ id: string; Full_Name?: string; Lead_Status?: string; "Owner.email"?: string }>(
    H, api,
    `select id, Full_Name, Lead_Status, Owner.email from Leads where ((Phone = '${p}' and Converted__s = false) and Owner != '3525045000484500876') limit 5`,
  ).catch(() => [])
  const otro = leads.find((l) => l.id !== leadId && !OWNERS_ROBOT.test(String(l["Owner.email"] || "")))
  if (otro) return `lead ${otro.id} (${otro.Full_Name || "?"}, ${otro.Lead_Status || "?"}) de ${otro["Owner.email"]}`
  // (2) Contacto (= proceso convertido) con deal o con dueño humano.
  const contactos = await coql<{ id: string; Full_Name?: string; "Owner.email"?: string; "Account_Name.name"?: string }>(
    H, api,
    `select id, Full_Name, Owner.email, Account_Name.name from Contacts where (Phone = '${p}' or Mobile = '${p}') limit 10`,
  ).catch(() => [])
  if (!contactos.length) return null
  const ids = contactos.map((c) => `'${c.id}'`).join(",")
  const deals = await coql<{ id: string; Deal_Name?: string; Stage?: string; "Owner.email"?: string }>(
    H, api,
    `select id, Deal_Name, Stage, Owner.email from Deals where Contact_Name in (${ids}) order by Created_Time desc limit 5`,
  ).catch(() => [])
  if (deals.length) {
    const d = deals[0]
    return `deal ${d.id} "${d.Deal_Name || ""}" (${d.Stage || "?"}) de ${d["Owner.email"] || "?"}`
  }
  const humano = contactos.find((c) => !OWNERS_ROBOT.test(String(c["Owner.email"] || "")))
  if (humano) return `contacto ${humano.id} (${humano.Full_Name || "?"}${humano["Account_Name.name"] ? `, ${humano["Account_Name.name"]}` : ""}) de ${humano["Owner.email"]}`
  return null
}

export async function barrerLeadsVicky(opts: { dry?: boolean; max?: number; ahora?: Date; minHoras?: number } = {}): Promise<{
  revisados: number
  resultados: ResultadoLead[]
}> {
  const ahora = opts.ahora || new Date()
  const max = Math.max(1, Math.min(50, opts.max ?? 10))
  const minHoras = Math.max(1, opts.minHoras ?? (Number(process.env.VICKY_BARRIDO_LEADS_HORAS || 24) || 24))
  const dry = Boolean(opts.dry)
  const resultados: ResultadoLead[] = []
  if (!dry && (await getKvValue("barrido_leads_vicky").catch(() => null)) === "off") {
    return { revisados: 0, resultados }
  }
  const { H, api } = await zoho()
  const filas = await coql<LeadRow>(
    H, api,
    "select id, First_Name, Last_Name, Company, Phone, Email, Lead_Status, N_Empleados_que_marcan, Territorio, Created_Time, Form_Vicky from Leads " +
      `where ((Owner.email = '${VICKY_EMAIL}' and Converted__s = false) and Lead_Status != 'No Calificado') order by Created_Time asc limit 200`,
  )
  const feriadosPorPais = new Map<string, Set<string>>()
  let hechos = 0
  for (const l of filas) {
    if (hechos >= max) break
    const creadoMs = Date.parse(String(l.Created_Time || ""))
    const horas = Number.isFinite(creadoMs) ? Math.floor((ahora.getTime() - creadoMs) / 3600e3) : 0
    if (!Number.isFinite(creadoMs) || horas < minHoras) continue
    const nombre = [l.First_Name, l.Last_Name].filter(Boolean).join(" ").trim() || "(sin nombre)"
    const blob = `${nombre} ${l.Company || ""} ${l.Email || ""}`
    const tel = normalizarTel(String(l.Phone || ""))
    const pais = paisDe(tel, String(l.Territorio || ""))
    const base = { leadId: l.id, nombre, telefono: tel, pais, horas }
    if (RE_INTERNO.test(blob) || tel === "56987654321") {
      resultados.push({ ...base, accion: "omitido", detalle: "contacto interno/prueba" })
      continue
    }
    if (!pais) {
      resultados.push({ ...base, accion: "omitido", detalle: "sin teléfono válido ni Territorio" })
      continue
    }
    if (!dry && (await getKvValue(`barrido_lead_${l.id}`).catch(() => null))) continue
    let fer = feriadosPorPais.get(pais)
    if (!fer) { fer = await feriados(pais); feriadosPorPais.set(pais, fer) }
    if (!esHorarioHabil(pais, ahora, fer)) {
      resultados.push({ ...base, accion: "omitido", detalle: "fuera de horario hábil, espera" })
      continue
    }
    hechos++
    try {
      // A) Duplicado de un proceso vivo en otro registro.
      const proceso = await procesoEnOtroRegistro(H, api, tel, l.id)
      if (proceso) {
        const detalle = `duplicado de ${proceso}`
        if (!dry) {
          const ok = await cerrarNoCalificado(H, api, l.id, "Duplicado en otro canal")
          await agregarNotaLead(
            l.id,
            "Cerrado por Vicky: duplicado de otro registro",
            `Este lead seguía a nombre de Vicky ${horas} h después de nacer, pero el mismo teléfono ya tiene un proceso en Zoho: ${proceso}. ` +
              `Regla (Lalo 09-sep): nada queda a nombre de Vicky; si ya hay otro registro vigente, se cierra como duplicado. ${ok ? "" : "OJO: el cambio de estado falló, corresponde No Calificado / Duplicado en otro canal."}`,
          ).catch(() => false)
          await setKvValue(`barrido_lead_${l.id}`, `duplicado:${ok ? "ok" : "fallo"}`).catch(() => {})
        }
        resultados.push({ ...base, accion: "duplicado", detalle })
        continue
      }
      // B) Conversación que no es de un prospecto (cliente/soporte/trabajador).
      const hayConv = (await fetchHistoryV3(tel, 1).catch(() => [])).length > 0
      if (hayConv) {
        const c = await casuisticaDeContacto(tel)
        if (!c.esProspecto) {
          const motivo = c.motivoZoho || "Es un usuario"
          if (!dry) {
            const ok = await cerrarNoCalificado(H, api, l.id, motivo)
            await agregarNotaLead(
              l.id,
              `Cerrado por Vicky: ${c.tipo} (no es prospecto)`,
              `Por lo que escribió el contacto en WhatsApp no es un prospecto de venta (${c.tipo}). Evidencia: ${c.evidencia.join(", ") || "-"}. ` +
                `${ok ? `Queda "No Calificado / ${motivo}".` : `No se pudo cambiar el estado: corresponde "No Calificado / ${motivo}".`}\n\nCONVERSACIÓN:\n${await transcript(tel)}`,
            ).catch(() => false)
            await setKvValue(`barrido_lead_${l.id}`, `no_prospecto:${c.tipo}`).catch(() => {})
          }
          resultados.push({ ...base, accion: "no_prospecto", detalle: `${c.tipo}: ${c.evidencia.slice(0, 3).join(", ")}` })
          continue
        }
      }
      // C) Entrega por la regla que corresponde.
      const chat = hayConv ? await datosDelChat(tel).catch(() => null) : null
      const empleadosLead = Number(l.N_Empleados_que_marcan || 0) || 0
      const empleados = empleadosLead || Number(chat?.empleados || 0) || 0
      const puntero = hayConv ? await getQuotePointer(tel).catch(() => null) : null
      const calificado = empleados > 0 || Boolean(puntero?.quoteId)
      const regla = pais !== "cl" ? pais : calificado ? "tlmk" : "sdr"
      if (dry) {
        resultados.push({ ...base, accion: "entregado", detalle: `(dry) regla ${regla}${empleados ? ` · ${empleados} personas` : ""}${chat?.rut ? ` · RUT ${chat.rut}` : ""}` })
        continue
      }
      if (!/^\s*3\./.test(String(l.Lead_Status || ""))) await updateZohoLeadStatus(l.id, STATUS_ENTREGA_LEAD).catch(() => {})
      // Datos del chat que el registro no tenía (solo vacíos).
      if (!empleadosLead && empleados > 0) {
        await fetch(`${api}/crm/v3/Leads`, {
          method: "PUT", headers: H, cache: "no-store",
          body: JSON.stringify({ data: [{ id: l.id, N_Empleados_que_marcan: empleados }], trigger: ["blueprint"], skip_feature_execution: [{ name: "assignment_rules" }] }),
        }).catch(() => null)
      }
      let ownerEmail = ""
      let error = ""
      if (pais === "cl") {
        const r = calificado
          ? await reasignarLeadCalificacionCL(l.id, { calificado: true }).catch((e) => ({ success: false, error: String(e) }))
          : await reasignarLeadTelemarketingCL(l.id).catch((e) => ({ success: false, error: String(e) }))
        ownerEmail = String((r as { ownerEmail?: string }).ownerEmail || "")
        error = String((r as { error?: string }).error || "")
      } else if (pais === "co") {
        const r = await reasignarLeadSdrInboundCO(l.id).catch((e) => ({ success: false, error: String(e) }))
        ownerEmail = String((r as { ownerEmail?: string }).ownerEmail || "")
        error = String((r as { error?: string }).error || "")
      } else if (pais === "mx") {
        const r = await reasignarLeadSdrInboundMX(l.id).catch((e) => ({ success: false, error: String(e) }))
        ownerEmail = String((r as { ownerEmail?: string }).ownerEmail || "")
        error = String((r as { error?: string }).error || "")
      } else {
        const put = await fetch(`${api}/crm/v3/Leads`, {
          method: "PUT", headers: H, cache: "no-store",
          body: JSON.stringify({ data: [{ id: l.id, Owner: { id: MONICA_PE_ID } }], trigger: ["blueprint"], skip_feature_execution: [{ name: "assignment_rules" }] }),
        }).catch(() => null)
        if (put?.ok) ownerEmail = "mmendozav@geovictoria.com"
      }
      if (!ownerEmail) {
        resultados.push({ ...base, accion: "error", detalle: `la regla ${regla} no asignó dueño${error ? `: ${error}` : ""}` })
        continue
      }
      await setKvValue(`barrido_lead_${l.id}`, `entregado:${ownerEmail}`).catch(() => {})
      await notificarLeadAsignado({ leadId: l.id, vendedorEmail: ownerEmail, contact: tel, nombre, empresa: String(l.Company || chat?.empresa || ""), empleados }).catch(() => false)
      const resumen = [
        hayConv ? `Conversó con Vicky por WhatsApp (+${tel}) sin llegar a un hito comercial.` : `Llenó el formulario de la landing hace ${horas} h y nunca conversó por WhatsApp (+${tel}): llamar directo.`,
        empleados ? `Dotación: ${empleados} personas.` : "Dotación: no la dio.",
        chat?.rut ? `RUT en el chat: ${chat.rut}.` : "",
        chat?.empresa ? `Empresa: ${chat.empresa}.` : "",
        chat?.email || l.Email ? `Correo: ${chat?.email || l.Email}.` : "",
        puntero?.quoteId ? `Vio precio / tiene cotización (${puntero.quoteId}).` : "",
        `Entregado por regla ${regla.toUpperCase()} porque llevaba ${horas} h a nombre de Vicky (barrido automático).`,
      ].filter(Boolean).join(" ")
      const tx = hayConv ? await transcript(tel) : ""
      await agregarNotaLead(
        l.id,
        `Entrega de Vicky (barrido) → ${ownerEmail}`,
        `${resumen}${tx ? `\n\nCONVERSACIÓN CON VICKY:\n${tx}` : ""}`,
      ).catch(() => false)
      resultados.push({ ...base, accion: "entregado", detalle: `regla ${regla}${empleados ? ` · ${empleados} personas` : ""}`, ownerEmail })
    } catch (e) {
      resultados.push({ ...base, accion: "error", detalle: e instanceof Error ? e.message : String(e) })
    }
  }
  return { revisados: filas.length, resultados }
}
