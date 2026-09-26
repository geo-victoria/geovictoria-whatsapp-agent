/**
 * BARRIDO DE DEALS A NOMBRE DE VICKY (Lalo 23-sep: "me preocupa que Vicky
 * esté quedándose con cosas y sea un cuello de botella" → "dale con el
 * barrido, ok con 2, 3 y 4"). Es el gemelo de lib/barrido-leads-vicky.ts
 * para DEALS: nada queda a nombre del usuario Vicky sin una razón vigente.
 *
 * Medido el 23-sep: de más de 200 deals abiertos creados por Vicky desde el
 * 24-ago, 27 seguían a su nombre — 5 en curso (correcto), 5 traspasados cuyo
 * deal nunca cambió de dueño (bug), 5 aceptadas sin pago sin dueño humano y
 * 12 conversaciones ya cerradas (soporte, cliente existente, no le interesa,
 * opt-out, no prospecto) con el deal abierto en etapa 4 inflando el pipeline.
 *
 * Por cada deal abierto (etapas 1-6) con Owner = Vicky, >24 h de edad, en
 * horario hábil del país, máx N por pasada:
 *  1) TRASPASO ACTIVO (vic_ptv con vendedor) → el dueño pasa a ser el
 *     ejecutivo que el cliente ya conoce. Mecánico.
 *  2) CONVERSACIÓN CERRADA (loop/seguimiento cerrado por no_interesa, opt_out,
 *     soporte, no_prospecto, autorespuesta) → "Cierre Perdido" con su razón,
 *     por transición del blueprint (PUT directo si el deal no está en proceso).
 *  3) ACEPTADA SIN PAGO ≥48 h (cotización Aceptada, sin marca de pago) → la
 *     tómbola de deals del país (regla de Zoho), notificación al dueño nuevo,
 *     fila vic_ptv con la presentación PENDIENTE. Supersede "aceptada no se
 *     traspasa" (25-ago) SOLO pasado ese plazo.
 *  4) CLIENTE EXISTENTE (ampliación) → dueño de la CUENTA si es una persona;
 *     si la cuenta es del robot, tómbola.
 *  Lo demás (loop activo, traspaso en curso, pagado) se deja como está y se
 *  reporta. `dry` lista sin tocar nada. Apagar: vic_kv `barrido_deals_vicky`="off".
 *
 * Alcance: global (mecanismo común; la regla de tómbola sale del país).
 */

import { getZohoAccessToken } from "./zoho-token"
import { getKvValue, setKvValue, getQuotePointer } from "./supabase-persistence-v3"
import { esHorarioHabil } from "./ptv"
import { reglaZoho } from "./paises/ficha-operativa"

const VICKY_ID = "3525045000484500876"
const OWNERS_ROBOT = /^(vicky@|info@geovictoria|ventas@geovictoria|productmanager@)/i
const RE_INTERNO = /prueba|no usar|\btest\b|huellerocompany|pruebasmkt/i
const RE_SINTETICO = /^(56|51|57|52)9000\d{5}$/
const PROBADORES = new Set(["56944668823", "56978385048"])
// 26-sep: las reglas por país salen de la ficha operativa (antes CO y MX
// estaban vacías acá y el barrido no sorteaba sus tratos).
const REGLAS_TOMBOLA: Record<string, string> = {
  cl: reglaZoho("cl", "deals"),
  pe: reglaZoho("pe", "deals"),
  co: reglaZoho("co", "deals"),
  mx: reglaZoho("mx", "deals"),
}
const ETAPAS_ABIERTAS = [
  "1. Trato Creado",
  "2. Primera Reunion Realizada",
  "3. En Levantamiento",
  "4. Propuesta Enviada / En Negociación",
  "5. Piloto",
  "6. Listo para Cierre",
]
// Motivos de cierre de conversación que cierran el deal (regla 2) y su razón de pérdida.
const RAZON_POR_MOTIVO: Record<string, string> = {
  no_interesa: "5. Cierre por Inactividad",
  autorespuesta: "5. Cierre por Inactividad",
  opt_out: "5. Cierre por Inactividad",
  soporte: "11. Lead mal Calificado",
  no_prospecto: "11. Lead mal Calificado",
  wsp_no_entregable: "5. Cierre por Inactividad",
}
/**
 * La razón de pérdida es un picklist POR LAYOUT: Chile numera ("5. Cierre por
 * Inactividad"); Perú y Colombia NO ("Cierre por Inactividad", "Otro") y no
 * tienen "Lead mal Calificado" (verificado en las transiciones de sus
 * blueprints el 23-sep). Además esas dos exigen `Contratar_n_otro_Proveedor`.
 */
function razonParaPais(pais: string, razonCL: string): { razon: string; extra: Record<string, unknown> } {
  if (pais === "pe" || pais === "co") {
    const sinNumero = razonCL.replace(/^\d+\.\s*/, "")
    const razon = /Lead mal Calificado/i.test(sinNumero) ? "Otro" : sinNumero
    return { razon, extra: { Contratar_n_otro_Proveedor: "No" } }
  }
  return { razon: razonCL, extra: {} }
}

export type ResultadoDeal = {
  dealId: string
  deal: string
  etapa: string
  pais: string
  telefono: string
  horas: number
  accion: "dueno_presentado" | "cerrado" | "tombola_aceptada" | "cuenta_cliente" | "sin_accion" | "omitido" | "error"
  detalle: string
  ownerEmail?: string
}

type DealRow = {
  id: string
  Deal_Name?: string | null
  Stage?: string | null
  Territorio?: string | null
  Created_Time?: string | null
  N_Empleados_que_marcan?: number | null
  Contact_Name?: { id?: string; name?: string } | null
  Account_Name?: { id?: string; name?: string } | null
  "Contact_Name.Phone"?: string | null
}

type Owner = { id?: string; email?: string; name?: string }

async function zoho(): Promise<{ H: Record<string, string>; api: string }> {
  const token = await getZohoAccessToken()
  const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
  return { H: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }, api }
}

async function coql<T>(H: Record<string, string>, api: string, select_query: string): Promise<T[]> {
  const r = await fetch(`${api}/crm/v8/coql`, { method: "POST", headers: H, cache: "no-store", body: JSON.stringify({ select_query }) })
  if (r.status === 204) return []
  if (!r.ok) throw new Error(`COQL ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`)
  return ((await r.json().catch(() => ({}))) as { data?: T[] }).data || []
}

function supaEnv(): { url: string; key: string } | null {
  const url = (process.env.SUPABASE_URL || "").trim().replace(/\/$/, "")
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
  return url && key ? { url, key } : null
}

async function supa<T>(path: string, init?: RequestInit & { headers?: Record<string, string> }): Promise<T[]> {
  const env = supaEnv()
  if (!env) return []
  const r = await fetch(`${env.url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: env.key,
      Authorization: `Bearer ${env.key}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(init?.headers || {}),
    },
    cache: "no-store",
  })
  if (!r.ok) {
    console.warn(`[barrido-deals] supabase ${path.split("?")[0]} HTTP ${r.status}`)
    return []
  }
  const txt = await r.text().catch(() => "")
  if (!txt) return []
  try {
    return (JSON.parse(txt) as T[]) || []
  } catch {
    return []
  }
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

async function feriados(pais: string): Promise<Set<string>> {
  const filas = await supa<Record<string, unknown>>(`vic_holidays?select=*&limit=500`).catch(() => [])
  const set = new Set<string>()
  for (const f of filas) {
    const fecha = String(f.d || f.date || f.fecha || "").slice(0, 10)
    const p = String(f.country || f.pais || "").toLowerCase()
    if (fecha && (!p || p === pais)) set.add(fecha)
  }
  return set
}

async function nota(H: Record<string, string>, api: string, dealId: string, titulo: string, texto: string): Promise<void> {
  await fetch(`${api}/crm/v3/Notes`, {
    method: "POST",
    headers: H,
    cache: "no-store",
    body: JSON.stringify({
      data: [{ Note_Title: titulo, Note_Content: texto, Parent_Id: { module: { api_name: "Deals" }, id: dealId } }],
    }),
  }).catch(() => null)
}

async function ponerDueno(H: Record<string, string>, api: string, dealId: string, ownerId: string): Promise<boolean> {
  const put = await fetch(`${api}/crm/v3/Deals`, {
    method: "PUT",
    headers: H,
    cache: "no-store",
    body: JSON.stringify({
      data: [{ id: dealId, Owner: { id: ownerId } }],
      trigger: ["blueprint"],
      skip_feature_execution: [{ name: "assignment_rules" }],
    }),
  })
  const body = (await put.json().catch(() => ({}))) as { data?: Array<{ code?: string }> }
  return put.ok && body?.data?.[0]?.code === "SUCCESS"
}

async function leerOwner(H: Record<string, string>, api: string, modulo: "Deals" | "Accounts", id: string): Promise<Owner | null> {
  const r = await fetch(`${api}/crm/v3/${modulo}/${id}?fields=Owner`, { headers: H, cache: "no-store" })
  if (r.status !== 200) return null
  return (((await r.json().catch(() => ({}))) as { data?: Array<{ Owner?: Owner }> }).data || [])[0]?.Owner || null
}

/** Cierre Perdido por transición del blueprint; sin proceso, PUT directo. Verifica el Stage releído. */
async function cerrarPerdido(H: Record<string, string>, api: string, dealId: string, razonCL: string, pais = "cl"): Promise<{ ok: boolean; detalle: string }> {
  const { razon, extra } = razonParaPais(pais, razonCL)
  try {
    const bpRes = await fetch(`${api}/crm/v3/Deals/${dealId}/actions/blueprint`, { headers: H, cache: "no-store" })
    const bp = (await bpRes.json().catch(() => ({}))) as {
      code?: string
      blueprint?: {
        transitions?: Array<{ id: string; name?: string; next_field_value?: string; fields?: Array<{ api_name?: string; mandatory?: boolean }> }>
      }
    }
    if (bpRes.ok && bp?.code !== "RECORD_NOT_IN_PROCESS") {
      const trans = (bp?.blueprint?.transitions || []).find((t) => /cierre perdido/i.test(String(t.next_field_value || t.name || "")))
      if (trans) {
        const data: Record<string, unknown> = { Raz_n_de_P_rdida: razon, ...extra }
        const exec = await fetch(`${api}/crm/v3/Deals/${dealId}/actions/blueprint`, {
          method: "PUT",
          headers: H,
          cache: "no-store",
          body: JSON.stringify({ blueprint: [{ transition_id: trans.id, data }] }),
        })
        const eb = (await exec.json().catch(() => ({}))) as { code?: string; message?: string }
        if (exec.ok && eb?.code === "SUCCESS") {
          const ver = await fetch(`${api}/crm/v3/Deals/${dealId}?fields=Stage`, { headers: H, cache: "no-store" })
          const st = String((((await ver.json().catch(() => ({}))) as { data?: Array<{ Stage?: string }> }).data || [])[0]?.Stage || "")
          if (/cierre perdido/i.test(st)) return { ok: true, detalle: `transición "${trans.next_field_value}" (${razon})` }
          return { ok: false, detalle: `PUT ok pero Stage sigue "${st}"` }
        }
        return { ok: false, detalle: `transición falló: ${eb?.code || exec.status} ${String(eb?.message || "").slice(0, 100)}` }
      }
    }
  } catch (e) {
    console.warn(`[barrido-deals] blueprint ${dealId}:`, e instanceof Error ? e.message : e)
  }
  // Fuera del blueprint (o sin transición de cierre): PUT directo.
  const put = await fetch(`${api}/crm/v3/Deals`, {
    method: "PUT",
    headers: H,
    cache: "no-store",
    body: JSON.stringify({
      data: [{ id: dealId, Stage: "Cierre Perdido", Raz_n_de_P_rdida: razon, ...extra }],
      trigger: ["blueprint"],
      skip_feature_execution: [{ name: "assignment_rules" }],
    }),
  })
  const pb = (await put.json().catch(() => ({}))) as { data?: Array<{ code?: string; message?: string }> }
  const fila = pb?.data?.[0]
  if (put.ok && fila?.code === "SUCCESS") return { ok: true, detalle: `PUT directo (${razon})` }
  return { ok: false, detalle: `PUT directo falló: ${fila?.code || put.status} ${String(fila?.message || "").slice(0, 100)}` }
}

/** Tómbola de deals del país (regla de Zoho por lar_id) + relectura. */
async function tombolear(H: Record<string, string>, api: string, dealId: string, pais: string): Promise<{ ok: boolean; owner?: Owner; detalle: string }> {
  const regla = REGLAS_TOMBOLA[pais] || ""
  if (!regla) return { ok: false, detalle: `sin regla de tómbola para ${pais}` }
  const antes = await leerOwner(H, api, "Deals", dealId)
  const put = await fetch(`${api}/crm/v3/Deals`, {
    method: "PUT",
    headers: H,
    cache: "no-store",
    body: JSON.stringify({ data: [{ id: dealId }], lar_id: regla }),
  })
  if (!put.ok) return { ok: false, detalle: `PUT lar_id ${put.status}` }
  let despues = await leerOwner(H, api, "Deals", dealId)
  for (let i = 0; i < 3 && (!despues?.id || despues.id === antes?.id); i++) {
    await new Promise((r) => setTimeout(r, 3000))
    despues = await leerOwner(H, api, "Deals", dealId)
  }
  if (!despues?.email || OWNERS_ROBOT.test(despues.email)) return { ok: false, detalle: `la regla ${regla} no sorteó (dueño ${despues?.email || "?"})` }
  return { ok: true, owner: despues, detalle: `regla ${regla} → ${despues.email}` }
}

/** Notificación con rastro + fila vic_ptv con la presentación PENDIENTE. */
async function entregarAVendedor(dealId: string, tel: string, pais: string, owner: Owner, motivo: string, ahora: Date, fer: Set<string>): Promise<void> {
  try {
    const { notificarTraspasoDeal } = await import("./crm-hitos")
    await notificarTraspasoDeal(dealId, tel).catch(() => {})
  } catch {
    /* best-effort */
  }
  if (!tel) return
  const activo = await supa<{ id: string }>(`vic_ptv?contact=eq.${tel}&estado=eq.activo&select=id&limit=1`).catch(() => [])
  const fila = {
    vendedor_email: owner.email || "",
    vendedor_zoho_id: owner.id || "",
    vendedor_nombre: owner.name || String(owner.email || "").split("@")[0],
    presentado_al_prospecto: false,
  }
  if (activo.length) {
    await supa(`vic_ptv?contact=eq.${tel}&estado=eq.activo`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(fila) }).catch(() => [])
    return
  }
  const { sumarHorasHabiles } = await import("./ptv")
  await supa(`vic_ptv`, {
    method: "POST",
    body: JSON.stringify({ contact: tel, motivo, ttv_minutos: 0, precio_mostrado: true, ...fila, chequeo_at: sumarHorasHabiles(ahora, 9, pais, fer).toISOString() }),
  }).catch(() => [])
}

export async function barrerDealsVicky(
  opts: { dry?: boolean; max?: number; ahora?: Date; minHoras?: number; horasAceptada?: number } = {},
): Promise<{ revisados: number; resultados: ResultadoDeal[] }> {
  const ahora = opts.ahora || new Date()
  const max = Math.max(1, Math.min(40, opts.max ?? 10))
  const minHoras = Math.max(1, opts.minHoras ?? (Number(process.env.VICKY_BARRIDO_DEALS_HORAS || 24) || 24))
  const horasAceptada = Math.max(1, opts.horasAceptada ?? (Number(process.env.VICKY_BARRIDO_ACEPTADA_HORAS || 48) || 48))
  const dry = Boolean(opts.dry)
  const resultados: ResultadoDeal[] = []
  if (!dry && (await getKvValue("barrido_deals_vicky").catch(() => null)) === "off") return { revisados: 0, resultados }
  const { H, api } = await zoho()
  const etapas = ETAPAS_ABIERTAS.map((e) => `'${e}'`).join(",")
  const filas = await coql<DealRow>(
    H,
    api,
    `select id, Deal_Name, Stage, Territorio, Created_Time, N_Empleados_que_marcan, Contact_Name, Account_Name, Contact_Name.Phone from Deals where (Owner = '${VICKY_ID}' and Stage in (${etapas})) order by Created_Time asc limit 200`,
  )
  const feriadosPorPais = new Map<string, Set<string>>()
  let hechos = 0
  for (const d of filas) {
    if (hechos >= max) break
    const creadoMs = Date.parse(String(d.Created_Time || ""))
    const horas = Number.isFinite(creadoMs) ? Math.floor((ahora.getTime() - creadoMs) / 3600e3) : 0
    const tel = String(d["Contact_Name.Phone"] || "").replace(/\D/g, "")
    const pais = paisDe(tel, String(d.Territorio || ""))
    const base = { dealId: d.id, deal: String(d.Deal_Name || ""), etapa: String(d.Stage || ""), pais, telefono: tel, horas }
    if (!Number.isFinite(creadoMs) || horas < minHoras) continue
    if (RE_INTERNO.test(base.deal) || RE_SINTETICO.test(tel) || PROBADORES.has(tel)) {
      resultados.push({ ...base, accion: "omitido", detalle: "prueba/interno" })
      continue
    }
    if (!pais) {
      resultados.push({ ...base, accion: "omitido", detalle: "sin teléfono ni Territorio" })
      continue
    }
    let fer = feriadosPorPais.get(pais)
    if (!fer) {
      fer = await feriados(pais)
      feriadosPorPais.set(pais, fer)
    }
    if (!esHorarioHabil(pais, ahora, fer)) {
      resultados.push({ ...base, accion: "omitido", detalle: "fuera de horario hábil" })
      continue
    }
    if (!tel) {
      resultados.push({ ...base, accion: "sin_accion", detalle: "deal sin teléfono de contacto" })
      continue
    }
    hechos++
    try {
      const [ptv, loop, conv, kvPago, kvComp] = await Promise.all([
        supa<{ vendedor_email: string; vendedor_zoho_id: string; vendedor_nombre: string; motivo: string }>(
          `vic_ptv?contact=eq.${tel}&estado=eq.activo&vendedor_zoho_id=not.is.null&select=vendedor_email,vendedor_zoho_id,vendedor_nombre,motivo&order=traspasado_at.desc&limit=1`,
        ),
        supa<{ estado: string; motivo_cierre: string | null; stage: string | null }>(
          `vic_loop?contact=eq.${tel}&select=estado,motivo_cierre,stage&order=updated_at.desc&limit=1`,
        ),
        supa<{ followup_closed_reason: string | null }>(
          `vic_v3_conversations?contact=eq.${tel}&select=followup_closed_reason&order=started_at.desc&limit=1`,
        ),
        getKvValue(`pago_online_${tel}`).catch(() => null),
        getKvValue(`comprobante_ok_${tel}`).catch(() => null),
      ])
      if (kvPago || kvComp) {
        resultados.push({ ...base, accion: "sin_accion", detalle: "pagado: lo asigna el post-pago" })
        continue
      }
      const motivoLoop = String(loop[0]?.motivo_cierre || "")
      const estadoLoop = String(loop[0]?.estado || "")
      const loopActivo = estadoLoop === "activo" || estadoLoop === "pausado_compromiso"
      const cierreConv = String(conv[0]?.followup_closed_reason || "")

      // 1) Traspaso activo → dueño = el ejecutivo presentado.
      const v = ptv[0]
      if (v?.vendedor_zoho_id && v.vendedor_email && !OWNERS_ROBOT.test(v.vendedor_email)) {
        const detalle = `traspaso activo (${v.motivo}) → ${v.vendedor_email}`
        if (!dry) {
          const ok = await ponerDueno(H, api, d.id, v.vendedor_zoho_id)
          await nota(
            H,
            api,
            d.id,
            "Dueño alineado con el ejecutivo presentado (barrido Vicky)",
            `El deal seguía a nombre del usuario Vicky ${horas} h después de nacer, pero la conversación ya fue traspasada a ${v.vendedor_nombre || v.vendedor_email} (motivo ${v.motivo}) y el cliente lo conoce. Regla (Lalo 23-sep): el deal pasa a quien fue presentado.${ok ? "" : " OJO: el cambio de dueño falló, revisar a mano."}`,
          )
          await setKvValue(`barrido_deal_${d.id}`, `dueno_presentado:${ok ? "ok" : "fallo"}:${ahora.toISOString()}`).catch(() => {})
          if (!ok) {
            resultados.push({ ...base, accion: "error", detalle: `${detalle} — PUT Owner falló` })
            continue
          }
        }
        resultados.push({ ...base, accion: "dueno_presentado", detalle, ownerEmail: v.vendedor_email })
        continue
      }

      // 2) Conversación cerrada → Cierre Perdido con razón.
      const motivoCierre = RAZON_POR_MOTIVO[motivoLoop] ? motivoLoop : RAZON_POR_MOTIVO[cierreConv] ? cierreConv : ""
      if (motivoCierre && !loopActivo) {
        const razon = RAZON_POR_MOTIVO[motivoCierre]
        const detalle = `conversación cerrada (${motivoCierre}) → Cierre Perdido "${razon}"`
        if (!dry) {
          const r = await cerrarPerdido(H, api, d.id, razon, pais)
          await nota(
            H,
            api,
            d.id,
            "Cerrado por Vicky: la conversación terminó sin venta",
            `La conversación de WhatsApp cerró con motivo "${motivoCierre}" y el deal seguía abierto en "${base.etapa}" a nombre de Vicky. Regla (Lalo 23-sep): se cierra como Cierre Perdido / ${razon} para que no infle el pipeline. Si el cliente vuelve a escribir, la regla de reactivación lo revive.${r.ok ? "" : ` OJO: el cierre falló (${r.detalle}).`}`,
          )
          await setKvValue(`barrido_deal_${d.id}`, `cerrado:${r.ok ? "ok" : "fallo"}:${ahora.toISOString()}`).catch(() => {})
          if (!r.ok) {
            resultados.push({ ...base, accion: "error", detalle: `${detalle} — ${r.detalle}` })
            continue
          }
        }
        resultados.push({ ...base, accion: "cerrado", detalle })
        continue
      }

      // 3) Aceptada sin pago ≥ horasAceptada → tómbola del país.
      const aceptada = String(loop[0]?.stage || "") === "aceptada" || cierreConv === "cotizacion_aceptada" || /^6\./.test(base.etapa)
      if (aceptada) {
        let aceptadaHace = -1
        try {
          const ptr = await getQuotePointer(tel)
          const quoteId = String(ptr?.quoteId || "")
          if (quoteId) {
            const q = await fetch(`${api}/crm/v3/Cotizaciones_GeoVictoria/${quoteId}?fields=Estado_Cotizacion,Fecha_Hora_Cotizacion,Modified_Time`, {
              headers: H,
              cache: "no-store",
            })
            const qd = (
              ((await q.json().catch(() => ({}))) as { data?: Array<{ Estado_Cotizacion?: string; Fecha_Hora_Cotizacion?: string; Modified_Time?: string }> }).data || []
            )[0]
            const estado = String(qd?.Estado_Cotizacion || "")
            if (/pagada/i.test(estado)) {
              resultados.push({ ...base, accion: "sin_accion", detalle: "cotización Pagada: lo asigna el post-pago" })
              continue
            }
            if (/aceptada/i.test(estado)) {
              const t = Date.parse(String(qd?.Fecha_Hora_Cotizacion || qd?.Modified_Time || ""))
              aceptadaHace = Number.isFinite(t) ? Math.floor((ahora.getTime() - t) / 3600e3) : horas
            }
          }
        } catch {
          /* sin cotización legible */
        }
        if (aceptadaHace >= horasAceptada) {
          const detalle = `aceptada sin pago hace ${aceptadaHace} h → tómbola ${pais}`
          if (dry) {
            resultados.push({ ...base, accion: "tombola_aceptada", detalle })
            continue
          }
          const t = await tombolear(H, api, d.id, pais)
          if (!t.ok || !t.owner) {
            await setKvValue(`barrido_deal_${d.id}`, `tombola_fallo:${ahora.toISOString()}`).catch(() => {})
            resultados.push({ ...base, accion: "error", detalle: `${detalle} — ${t.detalle}` })
            continue
          }
          await entregarAVendedor(d.id, tel, pais, t.owner, "aceptada_sin_pago", ahora, fer)
          await nota(
            H,
            api,
            d.id,
            "Entregado por Vicky: cotización aceptada sin pago",
            `La cotización quedó ACEPTADA hace ${aceptadaHace} h y no hay pago registrado; el deal seguía a nombre de Vicky. Regla (Lalo 23-sep): aceptada sin pago más de ${horasAceptada} h pasa por la tómbola para que una persona empuje el pago. ${t.detalle}. La presentación al cliente queda pendiente.`,
          )
          await setKvValue(`barrido_deal_${d.id}`, `tombola_aceptada:${t.owner.email}:${ahora.toISOString()}`).catch(() => {})
          resultados.push({ ...base, accion: "tombola_aceptada", detalle: `${detalle} → ${t.owner.email}`, ownerEmail: t.owner.email })
          continue
        }
        if (aceptadaHace >= 0) {
          resultados.push({ ...base, accion: "sin_accion", detalle: `aceptada hace ${aceptadaHace} h (espera ${horasAceptada} h)` })
          continue
        }
      }

      // 4) Cliente existente (ampliación) → dueño de la cuenta o tómbola.
      if (motivoLoop === "cliente_existente" || cierreConv === "cliente_existente") {
        const accId = String(d.Account_Name?.id || "")
        const dueno = accId ? await leerOwner(H, api, "Accounts", accId) : null
        if (dueno?.id && dueno.email && !OWNERS_ROBOT.test(dueno.email)) {
          const detalle = `cliente existente → dueño de la cuenta ${dueno.email}`
          if (!dry) {
            const ok = await ponerDueno(H, api, d.id, dueno.id)
            await entregarAVendedor(d.id, tel, pais, dueno, "cliente_existente", ahora, fer)
            await nota(
              H,
              api,
              d.id,
              "Entregado por Vicky: ampliación de un cliente existente",
              `El contacto es un cliente existente que pidió ampliar (más personas, reloj o sucursal). Regla (Lalo 23-sep): el deal pasa al dueño de su cuenta, ${dueno.name || dueno.email}.${ok ? "" : " OJO: el cambio de dueño falló."}`,
            )
            await setKvValue(`barrido_deal_${d.id}`, `cuenta_cliente:${ok ? "ok" : "fallo"}:${ahora.toISOString()}`).catch(() => {})
            if (!ok) {
              resultados.push({ ...base, accion: "error", detalle: `${detalle} — PUT Owner falló` })
              continue
            }
          }
          resultados.push({ ...base, accion: "cuenta_cliente", detalle, ownerEmail: dueno.email })
          continue
        }
        const detalle = `cliente existente sin dueño humano en la cuenta → tómbola ${pais}`
        if (dry) {
          resultados.push({ ...base, accion: "cuenta_cliente", detalle })
          continue
        }
        const t = await tombolear(H, api, d.id, pais)
        if (!t.ok || !t.owner) {
          resultados.push({ ...base, accion: "error", detalle: `${detalle} — ${t.detalle}` })
          continue
        }
        await entregarAVendedor(d.id, tel, pais, t.owner, "cliente_existente", ahora, fer)
        await nota(
          H,
          api,
          d.id,
          "Entregado por Vicky: ampliación de un cliente existente",
          `Cliente existente que pidió ampliar; la cuenta no tenía dueño humano. Regla (Lalo 23-sep): tómbola. ${t.detalle}.`,
        )
        await setKvValue(`barrido_deal_${d.id}`, `cuenta_cliente_tombola:${t.owner.email}:${ahora.toISOString()}`).catch(() => {})
        resultados.push({ ...base, accion: "cuenta_cliente", detalle: `${detalle} → ${t.owner.email}`, ownerEmail: t.owner.email })
        continue
      }

      resultados.push({
        ...base,
        accion: "sin_accion",
        detalle: loopActivo
          ? `loop ${estadoLoop} (${loop[0]?.stage || "?"}): en curso`
          : `loop ${estadoLoop || "sin loop"}${motivoLoop ? ` (${motivoLoop})` : ""}${cierreConv ? ` · conv ${cierreConv}` : ""}: sin regla que aplique`,
      })
    } catch (e) {
      resultados.push({ ...base, accion: "error", detalle: e instanceof Error ? e.message.slice(0, 160) : String(e) })
    }
  }
  return { revisados: filas.length, resultados }
}
