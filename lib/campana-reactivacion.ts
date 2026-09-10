/**
 * CAMPAÑA DE REACTIVACIÓN — diseño cerrado con Lalo el 10-sep.
 *
 * Ciclo de 4 TOQUES MÁXIMO por cliente que recibió cotización o vio precio,
 * hasta nuevo aviso. Un toque = una semana: martes WhatsApp (plantilla),
 * miércoles correo, jueves llamada de Dapta, siempre a las 11:00 hora del
 * país. Tres grupos de condiciones, todos obligatorios:
 *
 *   GRUPO 1 (entrada, se re-evalúa antes de CADA canal):
 *     - 2 días hábiles sin actividad en NINGÚN canal: chat de Vicky (ambos
 *       roles, toques incluidos), espejo del ejecutivo (mensajes y
 *       llamadas), Zoho (notas/llamadas/tareas HUMANAS en el deal), Samu
 *       (pendiente de integrar) y la apertura/aceptación de la cotización.
 *     - no pidió que no le hablemos (opt-out explícito + rechazo en contexto)
 *     - no pidió tiempo acotado (loop pausado por compromiso, exclusión con
 *       fecha "hasta")
 *     - no es cliente (cuenta cliente / usuarios activos / deal 7-8 /
 *       casuística de soporte / pago registrado)
 *   GRUPO 2 (criterios): martes WhatsApp · miércoles correo · jueves Dapta.
 *   GRUPO 3 (mecánica): 4 casillas por cliente (toque1..toque4). Cada martes
 *     se manda la PRIMERA casilla en falso; el contador NO se reinicia con
 *     actividad — quien respondió y volvió a callar sigue en la casilla
 *     siguiente. Tras la 4, fuera hasta nuevo aviso. La casilla se marca con
 *     el WhatsApp del martes (toque parcial cuenta); miércoles y jueves salen
 *     solo si SIGUE sin actividad.
 *
 * Este módulo decide; el runner (app/api/vic-campana-reactivacion) envía.
 * Todo best-effort: una fuente caída NO abre la puerta — si no se puede
 * evaluar una condición, el contacto queda fuera con motivo.
 */

import { minutosHabilesEntre } from "./ptv"
import { getKvValue, getQuotePointers } from "./supabase-persistence-v3"
import { posturaRechazoCliente } from "./rechazo-cliente"
import { detectarClienteExistente } from "./cliente-existente"
import { casuisticaDeContacto } from "./casuistica-runtime"
import { testContactSet } from "./funnel-analysis"
import { canalDelDia, casillaAbierta, horaLocalDe, siguienteCasilla, HORA_INICIO_CAMPANA, MINUTOS_HABILES_INACTIVIDAD, type Canal, type Casilla, type FilaCasillas } from "./campana-reactivacion-reglas"

export { canalDelDia, casillaAbierta, horaLocalDe, siguienteCasilla, TOQUES_MAX, HORA_INICIO_CAMPANA, DIAS_HABILES_INACTIVIDAD, MINUTOS_HABILES_INACTIVIDAD } from "./campana-reactivacion-reglas"
export type { Canal, Casilla, FilaCasillas } from "./campana-reactivacion-reglas"

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const ZOHO_API = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
const QUOTE_MODULE = (process.env.ZOHO_QUOTE_MODULE || "Cotizaciones_GeoVictoria").trim()

/** Usuarios robot cuyas notas/actividades NO cuentan como gestión humana. */
const ROBOTS = new Set(["3525045000484500876", "3525045000000200013"])


export const TABLA = "vic_campana_reactivacion"

export type Actividad = { at: Date | null; fuente: string; detalle?: string }

export type EvaluacionGrupo1 = {
  apto: boolean
  motivo: string
  detalle?: string
  ultimaActividad: Actividad
  minutosHabilesSinActividad: number
}

function maxFecha(...cands: Array<Actividad | null | undefined>): Actividad {
  let mejor: Actividad = { at: null, fuente: "ninguna" }
  for (const c of cands) {
    if (!c || !c.at) continue
    if (!mejor.at || c.at.getTime() > mejor.at.getTime()) mejor = c
  }
  return mejor
}

function fechaDe(iso: string | null | undefined): Date | null {
  if (!iso) return null
  const ms = Date.parse(String(iso))
  return Number.isFinite(ms) ? new Date(ms) : null
}

// ── acceso a datos ──────────────────────────────────────────────────────────

async function sb<T>(ruta: string): Promise<T[]> {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error("supabase sin configurar")
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${ruta}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    cache: "no-store",
  })
  if (!r.ok) throw new Error(`supabase ${r.status} en ${ruta.split("?")[0]}`)
  return ((await r.json().catch(() => [])) as T[]) || []
}

async function zohoHeaders(): Promise<Record<string, string>> {
  const { getZohoAccessToken } = await import("./zoho-token")
  const token = await getZohoAccessToken()
  return { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }
}

async function coql<T>(H: Record<string, string>, query: string): Promise<T[]> {
  const r = await fetch(`${ZOHO_API}/crm/v8/coql`, {
    method: "POST",
    headers: H,
    cache: "no-store",
    body: JSON.stringify({ select_query: query }),
  })
  if (r.status === 204) return []
  if (!r.ok) throw new Error(`coql ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`)
  return ((((await r.json().catch(() => null)) as { data?: T[] } | null)?.data) || []) as T[]
}

export async function feriadosDe(pais: string): Promise<Set<string>> {
  try {
    // vic_holidays guarda el país en MAYÚSCULA ("CL"); con `eq.cl` el set
    // salía vacío y los feriados jamás se aplicaban (hallazgo 10-sep).
    const filas = await sb<{ d: string }>(`vic_holidays?country=ilike.${pais}&select=d&limit=500`)
    return new Set(filas.map((f) => String(f.d).slice(0, 10)))
  } catch {
    return new Set()
  }
}

export async function leerCasillas(contact: string): Promise<FilaCasillas | null> {
  const filas = await sb<FilaCasillas>(`${TABLA}?contact=eq.${contact}&select=*&limit=1`)
  return filas[0] || null
}

export async function leerCasillasLote(contacts: string[]): Promise<Map<string, FilaCasillas>> {
  const out = new Map<string, FilaCasillas>()
  for (let i = 0; i < contacts.length; i += 100) {
    const grupo = contacts.slice(i, i + 100)
    const filas = await sb<FilaCasillas>(`${TABLA}?contact=in.(${grupo.join(",")})&select=*&limit=200`)
    for (const f of filas) out.set(f.contact, f)
  }
  return out
}

export async function marcarCasilla(
  contact: string,
  casilla: Casilla,
  canal: Canal,
  extra: { pais?: string; quoteId?: string | null; empresa?: string | null; motivo?: string } = {},
): Promise<void> {
  const ahora = new Date().toISOString()
  const body: Record<string, unknown> = {
    contact,
    [`toque${casilla}_${canal}_at`]: ahora,
    ultima_eval_at: ahora,
    updated_at: ahora,
  }
  if (extra.pais) body.pais = extra.pais
  if (extra.quoteId) body.quote_id = extra.quoteId
  if (extra.empresa) body.empresa = extra.empresa
  if (extra.motivo) body.ultima_eval_motivo = extra.motivo
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${TABLA}?on_conflict=contact`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(body),
    cache: "no-store",
  })
  if (!r.ok) throw new Error(`no se pudo marcar casilla ${casilla}/${canal} de ${contact}: ${r.status}`)
}

export async function anotarEvaluacion(contact: string, motivo: string, pais = "cl"): Promise<void> {
  const ahora = new Date().toISOString()
  await fetch(`${SUPABASE_URL}/rest/v1/${TABLA}?on_conflict=contact`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({ contact, pais, ultima_eval_at: ahora, ultima_eval_motivo: motivo.slice(0, 200), updated_at: ahora }),
    cache: "no-store",
  }).catch(() => {})
}

// ── ÚLTIMA ACTIVIDAD (5 fuentes) ────────────────────────────────────────────

/**
 * Última actividad del contacto en cualquier canal. Cada fuente se consulta
 * por separado y se toma la más reciente. Si una fuente falla, se anota en
 * `fallas` para que el caller decida (el grupo 1 excluye ante duda).
 */
export async function ultimaActividad(
  contact: string,
  opts: { ahora?: Date; H?: Record<string, string>; ventanaDias?: number } = {},
): Promise<{ actividad: Actividad; fuentes: Record<string, string | null>; fallas: string[] }> {
  const ahora = opts.ahora || new Date()
  const nueve = contact.slice(-9)
  const fuentes: Record<string, string | null> = {}
  const fallas: string[] = []
  const cands: Actividad[] = []

  // 1. Chat de Vicky: cualquier mensaje visible (ambos roles). Los
  //    "[REGISTRO INTERNO" no son mensajes al cliente y no cuentan.
  try {
    const convs = await sb<{ id: string }>(`vic_v3_conversations?contact=eq.${contact}&select=id&limit=3`)
    if (convs.length) {
      const ids = convs.map((c) => c.id).join(",")
      const msgs = await sb<{ at: string; role: string; content: string }>(
        `vic_v3_messages?conversation_id=in.(${ids})&select=at,role,content&order=at.desc&limit=8`,
      )
      const real = msgs.find((m) => !String(m.content || "").startsWith("[REGISTRO INTERNO"))
      fuentes.chat_vicky = real?.at || null
      if (real) cands.push({ at: fechaDe(real.at), fuente: `chat_vicky (${real.role})` })
    } else fuentes.chat_vicky = null
  } catch (e) { fallas.push(`chat_vicky: ${e instanceof Error ? e.message : e}`) }

  // 2. Espejo del ejecutivo: mensajes en cualquier dirección y llamadas.
  try {
    const [msgs, llamadas] = await Promise.all([
      sb<{ enviado_at: string; from_me: boolean }>(
        `vic_wa_espejo_mensajes?select=enviado_at,from_me&telefono_chat=like.*${nueve}&es_grupo=eq.false&order=enviado_at.desc&limit=1`,
      ),
      sb<{ at: string }>(`vic_wa_espejo_llamadas?select=at&telefono=like.*${nueve}&order=at.desc&limit=1`),
    ])
    fuentes.espejo_mensaje = msgs[0]?.enviado_at || null
    fuentes.espejo_llamada = llamadas[0]?.at || null
    if (msgs[0]) cands.push({ at: fechaDe(msgs[0].enviado_at), fuente: `espejo_mensaje (${msgs[0].from_me ? "ejecutivo" : "cliente"})` })
    if (llamadas[0]) cands.push({ at: fechaDe(llamadas[0].at), fuente: "espejo_llamada" })
  } catch (e) { fallas.push(`espejo: ${e instanceof Error ? e.message : e}`) }

  // 3. Apertura / aceptación de la cotización (kv pf_<quote>_* + Fecha_Hora_Cotizacion).
  try {
    const punteros = await getQuotePointers(contact).catch(() => [])
    let mejor: Actividad | null = null
    for (const p of punteros.slice(0, 4)) {
      const filas = await sb<{ key: string; value: string }>(`vic_kv?key=like.pf_${p.quoteId}_*&select=key,value&limit=20`)
      for (const f of filas) {
        const iso = String(f.value || "").split("|")[0]
        const d = fechaDe(iso)
        if (d && (!mejor?.at || d > mejor.at)) mejor = { at: d, fuente: `cotizacion (${f.key.replace(`pf_${p.quoteId}_`, "")})` }
      }
    }
    fuentes.cotizacion_apertura = mejor?.at?.toISOString() || null
    if (mejor) cands.push(mejor)
  } catch (e) { fallas.push(`cotizacion: ${e instanceof Error ? e.message : e}`) }

  // 4. Zoho: aceptación formal + actividad HUMANA en el deal (notas, llamadas,
  //    tareas). NO se usa Modified_Time: los crones lo pisan a diario.
  try {
    const H = opts.H || (await zohoHeaders())
    const corte = new Date(ahora.getTime() - (opts.ventanaDias || 10) * 86_400_000).toISOString().slice(0, 19) + "+00:00"
    const quotes = await coql<{ id: string; Fecha_Hora_Cotizacion?: string | null }>(
      H,
      `select id, Fecha_Hora_Cotizacion from ${QUOTE_MODULE} where Tel_fono_Contacto like '%${nueve}%' order by Created_Time desc limit 5`,
    )
    let acept: Actividad | null = null
    for (const q of quotes) {
      const d = fechaDe(q.Fecha_Hora_Cotizacion)
      if (d && (!acept?.at || d > acept.at)) acept = { at: d, fuente: "cotizacion (aceptación)" }
    }
    fuentes.cotizacion_aceptacion = acept?.at?.toISOString() || null
    if (acept) cands.push(acept)

    const deals = await coql<{ id: string; Last_Activity_Time?: string | null; Fecha_ultima_Nota?: string | null }>(
      H,
      `select id, Last_Activity_Time, Fecha_ultima_Nota from Deals where (Contact_Phone like '%${nueve}%' and Last_Activity_Time > '${corte}') order by Last_Activity_Time desc limit 3`,
    )
    let humana: Actividad | null = null
    for (const d of deals) {
      for (const lista of ["Notes", "Calls", "Tasks"]) {
        const campo = lista === "Notes" ? "Created_By" : "Owner"
        const r = await fetch(`${ZOHO_API}/crm/v3/Deals/${d.id}/${lista}?fields=${campo},Created_Time&per_page=20`, { headers: H, cache: "no-store" })
        if (!r.ok || r.status === 204) continue
        const items = ((((await r.json().catch(() => null)) as { data?: Array<Record<string, unknown>> } | null)?.data) || [])
        for (const it of items) {
          const autor = String(((it[campo] as { id?: string } | null) || {}).id || "")
          if (ROBOTS.has(autor)) continue
          const at = fechaDe(it.Created_Time as string)
          if (at && (!humana?.at || at > humana.at)) humana = { at, fuente: `zoho_${lista.toLowerCase()} (deal ${d.id})` }
        }
      }
    }
    fuentes.zoho_humana = humana?.at?.toISOString() || null
    if (humana) cands.push(humana)
  } catch (e) { fallas.push(`zoho: ${e instanceof Error ? e.message : e}`) }

  // 5. Samu: sin integración server-side todavía (10-sep). Se declara para
  //    que el reporte lo muestre como fuente no cubierta, no como "sin actividad".
  fuentes.samu = null

  return { actividad: maxFecha(...cands), fuentes, fallas }
}

// ── GRUPO 1 ─────────────────────────────────────────────────────────────────

export async function evaluarGrupo1(
  contact: string,
  opts: { pais?: string; ahora?: Date; H?: Record<string, string>; feriados?: Set<string> } = {},
): Promise<EvaluacionGrupo1> {
  const ahora = opts.ahora || new Date()
  const pais = opts.pais || "cl"
  const feriados = opts.feriados || new Set<string>()
  const fuera = (motivo: string, detalle?: string, act?: Actividad, min = 0): EvaluacionGrupo1 => ({
    apto: false,
    motivo,
    detalle,
    ultimaActividad: act || { at: null, fuente: "ninguna" },
    minutosHabilesSinActividad: min,
  })

  if (testContactSet().has(contact)) return fuera("interno")

  // Opt-out explícito y exclusiones de campaña.
  const [noLlamar, excluir, pagoOnline, comprobante, loopPausado, conv] = await Promise.all([
    getKvValue(`voz_no_llamar_${contact}`).catch(() => null),
    getKvValue(`voz_excluir_${contact}`).catch(() => null),
    getKvValue(`pago_online_${contact}`).catch(() => null),
    getKvValue(`comprobante_ok_${contact}`).catch(() => null),
    sb<{ estado: string; compromiso_at: string | null; motivo_cierre: string | null }>(
      `vic_loop?contact=eq.${contact}&select=estado,compromiso_at,motivo_cierre&limit=1`,
    ).catch(() => [] as Array<{ estado: string; compromiso_at: string | null; motivo_cierre: string | null }>),
    sb<{ id: string; followup_closed_reason: string | null }>(
      `vic_v3_conversations?contact=eq.${contact}&select=id,followup_closed_reason&limit=1`,
    ).catch(() => [] as Array<{ id: string; followup_closed_reason: string | null }>),
  ])
  if (noLlamar) return fuera("opt_out", String(noLlamar).slice(0, 80))
  if (excluir) {
    let hasta = ""
    let motivo = ""
    try {
      const j = JSON.parse(excluir) as { hasta?: string; motivo?: string }
      hasta = j.hasta || ""
      motivo = j.motivo || ""
    } catch { motivo = String(excluir).slice(0, 60) }
    if (!hasta || Date.parse(hasta) > ahora.getTime()) return fuera(hasta ? "tiempo_acotado" : "excluido_campanas", `${motivo}${hasta ? ` hasta ${hasta}` : ""}`)
  }
  if (pagoOnline || comprobante) return fuera("pago_registrado")
  const lp = loopPausado[0]
  if (lp?.estado === "pausado_compromiso" && lp.compromiso_at && Date.parse(lp.compromiso_at) > ahora.getTime()) {
    return fuera("tiempo_acotado", `retoma ${lp.compromiso_at.slice(0, 10)}`)
  }
  if (lp?.motivo_cierre === "opt_out" || lp?.motivo_cierre === "no_interesa" || lp?.motivo_cierre === "no_prospecto" || lp?.motivo_cierre === "cliente_existente") {
    return fuera(lp.motivo_cierre === "no_interesa" ? "rechazo" : lp.motivo_cierre, "loop cerrado")
  }
  if (conv[0]?.followup_closed_reason === "opt_out") return fuera("opt_out", "conversación")

  // Rechazo en contexto (último mensaje con contenido del cliente).
  if (conv[0]) {
    try {
      const msgs = await sb<{ role: string; content: string }>(
        `vic_v3_messages?conversation_id=eq.${conv[0].id}&select=role,content&order=at.desc&limit=12`,
      )
      const postura = posturaRechazoCliente(msgs.reverse())
      if (postura) return fuera("rechazo", postura)
    } catch (e) {
      return fuera("no_evaluable", `historial: ${e instanceof Error ? e.message : e}`)
    }
  }

  // Cliente existente (cuenta/usuarios activos) y casuística no-prospecto.
  const ce = await detectarClienteExistente(contact).catch(() => null)
  if (ce) return fuera("cliente", ce.cuentaNombre || ce.cuentaId)
  const cas = await casuisticaDeContacto(contact).catch(() => null)
  if (cas && !cas.esProspecto) return fuera("no_prospecto", cas.tipo)

  // Deal en 7/8 = cliente aunque la cuenta no lo diga.
  const H = opts.H || (await zohoHeaders())
  try {
    const nueve = contact.slice(-9)
    const deals = await coql<{ id: string; Stage: string }>(
      H,
      `select id, Stage from Deals where (Contact_Phone like '%${nueve}%' and Stage in ('7. Implementando','8. Facturando')) limit 1`,
    )
    if (deals[0]) return fuera("cliente", `deal ${deals[0].id} · ${deals[0].Stage}`)
  } catch (e) {
    return fuera("no_evaluable", `zoho deals: ${e instanceof Error ? e.message : e}`)
  }

  // Inactividad: 2 días hábiles sin nada en ningún canal.
  const { actividad, fallas } = await ultimaActividad(contact, { ahora, H })
  if (fallas.length) return fuera("no_evaluable", fallas.join(" · ").slice(0, 200), actividad)
  const minutos = actividad.at ? minutosHabilesEntre(actividad.at, ahora, pais, feriados, HORA_INICIO_CAMPANA) : Number.POSITIVE_INFINITY
  if (actividad.at && minutos < MINUTOS_HABILES_INACTIVIDAD) {
    return fuera("activo_reciente", `${actividad.fuente} ${actividad.at.toISOString()}`, actividad, minutos)
  }
  return { apto: true, motivo: "apto", ultimaActividad: actividad, minutosHabilesSinActividad: minutos }
}

// ── UNIVERSO ────────────────────────────────────────────────────────────────

export type Candidato = { contact: string; quoteId: string | null; empresa: string | null; origen: string }

/**
 * Universo: quien recibió cotización (Zoho, Enviada/Aceptada, con teléfono
 * chileno) o vio precio (loop en con_precio/formal/aceptada) en los últimos
 * `dias`. Solo Chile por ahora: las plantillas de reactivación son CL.
 */
export async function universoCampana(opts: { dias?: number; H?: Record<string, string> } = {}): Promise<Candidato[]> {
  const dias = opts.dias || 90
  const H = opts.H || (await zohoHeaders())
  const corte = new Date(Date.now() - dias * 86_400_000).toISOString().slice(0, 19) + "+00:00"
  const porContacto = new Map<string, Candidato>()

  for (let offset = 0; offset < 2000; offset += 200) {
    const filas = await coql<{ id: string; Tel_fono_Contacto?: string | null; Razon_Social?: string | null; Name?: string; Estado_Cotizacion?: string }>(
      H,
      `select id, Tel_fono_Contacto, Name, Estado_Cotizacion from ${QUOTE_MODULE} where (Estado_Cotizacion in ('Enviada','Aceptada') and Created_Time > '${corte}') order by Created_Time desc limit ${offset}, 200`,
    )
    for (const q of filas) {
      const tel = String(q.Tel_fono_Contacto || "").replace(/\D/g, "").replace(/^5656/, "56")
      if (!/^569\d{8}$/.test(tel)) continue
      if (!porContacto.has(tel)) {
        porContacto.set(tel, {
          contact: tel,
          quoteId: q.id,
          empresa: String(q.Name || "").replace(/^Cotización\s+/i, "").replace(/\s+-\s+\d{4}-\d{2}-\d{2}$/, "") || null,
          origen: `cotizacion ${q.Estado_Cotizacion || ""}`.trim(),
        })
      }
    }
    if (filas.length < 200) break
  }

  const loops = await sb<{ contact: string; stage: string }>(
    `vic_loop?country=eq.cl&stage=in.(con_precio,formal,aceptada)&t0=gt.${encodeURIComponent(corte)}&select=contact,stage&limit=5000`,
  ).catch(() => [] as Array<{ contact: string; stage: string }>)
  for (const l of loops) {
    const tel = String(l.contact || "").replace(/\D/g, "")
    if (!/^569\d{8}$/.test(tel) || porContacto.has(tel)) continue
    porContacto.set(tel, { contact: tel, quoteId: null, empresa: null, origen: `precio visto (${l.stage})` })
  }
  return [...porContacto.values()]
}
