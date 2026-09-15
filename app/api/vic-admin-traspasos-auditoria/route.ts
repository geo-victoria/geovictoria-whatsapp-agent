/**
 * AUDITORÍA DE TRASPASOS — SOLO LECTURA (15-sep, pedido de Lalo: "¿Vicky ya
 * traspasó correctamente y notificó en Zoho las oportunidades? … lo de Chile
 * estas semanas … y si TODAS las conversaciones tienen su traspaso correcto").
 *
 * POR QUÉ EXISTE: la bitácora `vic_ptv` solo se lee por contacto (fijar-vendedor,
 * toque-contexto) o desde el panel del funnel (login por vendedor). No había
 * forma de listar los traspasos de un RANGO y cruzarlos, uno por uno, con lo
 * que importa para decir "quedó bien":
 *   (1) REGISTRO en Zoho a nombre de un HUMANO (deal o lead; el robot no cuenta)
 *   (2) NOTIFICACIÓN al ejecutivo (rastro kv `notif_traspaso_` desde el 11-sep
 *       + la related list Emails del registro: "Asignación Nuevo Deal",
 *       "Traspaso PTV", "Lead calificado por Vicky", "Notificación Nuevo Lead")
 *   (3) COHERENCIA bitácora ↔ dueño real (el 02-sep se midió 8/48 cruzados)
 *   (4) PRESENTACIÓN al cliente y ATENCIÓN del vendedor (espejo / llamada)
 *
 * Y la SEGUNDA mitad de la pregunta (`?sinTraspaso=1`): conversaciones CL del
 * rango que tocaron un gatillo de traspaso —precio mostrado, formal, promesa
 * de contacto, derivación— y NO tienen fila en `vic_ptv`: ¿quedó alguien sin
 * registro humano? Ahí no hay bitácora que leer, así que la verdad es Zoho
 * (lead/deal por los 9 dígitos del teléfono).
 *
 * GET ?key=&desde=YYYY-MM-DD&hasta=YYYY-MM-DD[&max=200][&sinTraspaso=1][&emails=0]
 * Auth: x-cron-secret / Bearer / ?key= (kv followup_cron_secret o env CRON_SECRET).
 * No escribe nada.
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"
import { getZohoAccessToken } from "@/lib/zoho-token"
import { metricsContactSet, isTestContact } from "@/lib/funnel-analysis"
import { veredictoNotificacion, type EvidenciaNotificacion } from "@/lib/notificacion-traspaso"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const ZOHO_API = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
const ROBOTS = new Set(["vicky@geovictoria.com", "info@geovictoria.com", "admin@geovictoria.com"])
const PRESUPUESTO_MS = 250_000

async function autorizado(req: Request): Promise<boolean> {
  const secreto = await getFollowupCronSecret().catch(() => "")
  const cron = (process.env.CRON_SECRET || "").trim()
  const url = new URL(req.url)
  const auth = req.headers.get("authorization") || ""
  const entregado =
    req.headers.get("x-cron-secret") || (auth.startsWith("Bearer ") ? auth.slice(7) : "") || url.searchParams.get("key") || ""
  return Boolean(entregado) && (entregado === secreto || (Boolean(cron) && entregado === cron))
}

const HS = () => ({ apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` })
const digits = (s: unknown) => String(s || "").replace(/\D/g, "")
const nueve = (s: unknown) => digits(s).slice(-9)

async function supa<T>(path: string, fallos: string[]): Promise<T[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: HS(), cache: "no-store" }).catch(() => null)
  if (!r) { fallos.push(`supa sin respuesta: ${path.slice(0, 60)}`); return [] }
  if (!r.ok) { fallos.push(`supa ${r.status}: ${path.slice(0, 60)} ${(await r.text().catch(() => "")).slice(0, 120)}`); return [] }
  return ((await r.json().catch(() => [])) as T[]) || []
}

type Ptv = {
  id: string; contact: string; vendedor_email: string | null; vendedor_nombre: string | null; vendedor_zoho_id: string | null
  traspasado_at: string; motivo: string | null; presentado_al_prospecto: boolean | null; estado: string | null; chequeo_resultado?: string | null
}
type DealZ = { id: string; Deal_Name?: string; Stage?: string; Created_Time?: string; N_Empleados_que_marcan?: number | null; "Owner.email"?: string; "Owner.first_name"?: string; "Owner.last_name"?: string; "Contact_Name.Phone"?: string; "Contact_Name.Mobile"?: string; "Created_By.email"?: string }
type LeadZ = { id: string; Last_Name?: string; Company?: string; Phone?: string; Lead_Status?: string; Converted__s?: boolean; Created_Time?: string; N_Empleados_que_marcan?: number | null; "Owner.email"?: string; "Owner.first_name"?: string; "Owner.last_name"?: string; "Created_By.email"?: string }
type Registro = { tipo: "deal" | "lead"; id: string; nombre: string; ownerEmail: string; ownerNombre: string; estado: string; creado: string; humano: boolean }

export async function GET(req: Request): Promise<NextResponse> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  if (!SUPABASE_URL || !SUPABASE_KEY) return NextResponse.json({ ok: false, error: "Supabase no configurado" }, { status: 503 })
  const t0 = Date.now()
  const sp = new URL(req.url).searchParams
  const valida = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s)
  const hoyCL = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())
  const hasta = valida(sp.get("hasta") || "") ? String(sp.get("hasta")) : hoyCL
  const desde = valida(sp.get("desde") || "") ? String(sp.get("desde")) : new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10)
  const max = Math.min(400, Math.max(10, Number(sp.get("max") || 250)))
  const conEmails = sp.get("emails") !== "0"
  const modoSinTraspaso = sp.get("sinTraspaso") === "1"
  const desdeISO = `${desde}T00:00:00-04:00`
  const hastaISO = `${hasta}T23:59:59-04:00`
  const fallos: string[] = []
  const setMetricas = metricsContactSet()
  const esCL = (c: string) => /^56\d{9}$/.test(c) && !isTestContact(c, setMetricas)

  // ── ZOHO: índice de deals y leads por los 9 dígitos del teléfono ─────────
  // Se bajan por COQL paginada desde 60 días antes del rango (un traspaso de
  // hoy puede colgar de un lead del mes pasado) y se indexan por teléfono.
  // Cicatriz 09/10-sep: un fallo de COQL se DEVUELVE, jamás se traga.
  const token = await getZohoAccessToken().catch(() => "")
  if (!token) return NextResponse.json({ ok: false, error: "sin token zoho" }, { status: 502 })
  const HZ = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }
  const coql = async <T,>(q: string): Promise<T[]> => {
    const r = await fetch(`${ZOHO_API}/crm/v8/coql`, { method: "POST", headers: HZ, cache: "no-store", body: JSON.stringify({ select_query: q }) }).catch(() => null)
    if (!r) { fallos.push("coql sin respuesta"); return [] }
    if (r.status === 204) return []
    if (!r.ok) { fallos.push(`coql ${r.status} ${(await r.text().catch(() => "")).slice(0, 160)}`); return [] }
    return (((await r.json().catch(() => ({}))) as { data?: T[] }).data) || []
  }
  const desdeZoho = new Date(Date.parse(desdeISO) - 60 * 86_400_000).toISOString().slice(0, 10)
  const dealsPorNueve = new Map<string, DealZ[]>()
  const dealsPorId = new Map<string, DealZ>()
  for (let off = 0; off < 6000; off += 200) {
    const lote = await coql<DealZ>(
      `select id, Deal_Name, Stage, Created_Time, N_Empleados_que_marcan, Owner.email, Owner.first_name, Owner.last_name, Created_By.email, Contact_Name.Phone, Contact_Name.Mobile from Deals where Created_Time >= '${desdeZoho}T00:00:00+00:00' order by Created_Time desc limit ${off}, 200`,
    )
    for (const d of lote) {
      dealsPorId.set(String(d.id), d)
      for (const t of [d["Contact_Name.Mobile"], d["Contact_Name.Phone"]]) {
        const n = nueve(t)
        if (n.length !== 9) continue
        const arr = dealsPorNueve.get(n) || []
        if (!arr.some((x) => x.id === d.id)) arr.push(d)
        dealsPorNueve.set(n, arr)
      }
    }
    if (lote.length < 200 || Date.now() - t0 > PRESUPUESTO_MS * 0.3) break
  }
  const leadsPorNueve = new Map<string, LeadZ[]>()
  for (let off = 0; off < 8000; off += 200) {
    const lote = await coql<LeadZ>(
      `select id, Last_Name, Company, Phone, Lead_Status, Converted__s, Created_Time, N_Empleados_que_marcan, Owner.email, Owner.first_name, Owner.last_name, Created_By.email from Leads where Created_Time >= '${desdeZoho}T00:00:00+00:00' order by Created_Time desc limit ${off}, 200`,
    )
    for (const l of lote) {
      const n = nueve(l.Phone)
      if (n.length !== 9) continue
      const arr = leadsPorNueve.get(n) || []
      arr.push(l)
      leadsPorNueve.set(n, arr)
    }
    if (lote.length < 200 || Date.now() - t0 > PRESUPUESTO_MS * 0.45) break
  }
  const owner = (r: { "Owner.email"?: string; "Owner.first_name"?: string; "Owner.last_name"?: string }) => {
    const em = String(r["Owner.email"] || "").toLowerCase()
    const nom = `${String(r["Owner.first_name"] || "").trim()} ${String(r["Owner.last_name"] || "").trim()}`.trim()
    return { em, nom: nom || em, humano: Boolean(em) && !ROBOTS.has(em) }
  }
  const nivel = (s: string) => { const m = /^(\d+)/.exec(s || ""); return m ? Number(m[1]) : s.startsWith("Cierre") ? -1 : 0 }
  /** El registro que "manda" para un teléfono: deal más avanzado no perdido; si no, deal perdido; si no, lead sin convertir; si no, lead. */
  const registroDe = (fono: string, dealIdPreferido?: string): { principal: Registro | null; todos: Registro[] } => {
    const n = nueve(fono)
    const todos: Registro[] = []
    for (const d of dealsPorNueve.get(n) || []) {
      const o = owner(d)
      todos.push({ tipo: "deal", id: String(d.id), nombre: String(d.Deal_Name || ""), ownerEmail: o.em, ownerNombre: o.nom, estado: String(d.Stage || ""), creado: String(d.Created_Time || ""), humano: o.humano })
    }
    if (dealIdPreferido && !todos.some((r) => r.id === dealIdPreferido)) {
      const d = dealsPorId.get(dealIdPreferido)
      if (d) { const o = owner(d); todos.push({ tipo: "deal", id: String(d.id), nombre: String(d.Deal_Name || ""), ownerEmail: o.em, ownerNombre: o.nom, estado: String(d.Stage || ""), creado: String(d.Created_Time || ""), humano: o.humano }) }
    }
    for (const l of leadsPorNueve.get(n) || []) {
      const o = owner(l)
      todos.push({ tipo: "lead", id: String(l.id), nombre: `${String(l.Last_Name || "")} · ${String(l.Company || "")}`.trim(), ownerEmail: o.em, ownerNombre: o.nom, estado: l.Converted__s ? "convertido" : String(l.Lead_Status || ""), creado: String(l.Created_Time || ""), humano: o.humano })
    }
    const deals = todos.filter((r) => r.tipo === "deal")
    const vivos = deals.filter((r) => !r.estado.startsWith("Cierre"))
    const pref = dealIdPreferido ? deals.find((r) => r.id === dealIdPreferido) : undefined
    const mejorDeal = pref && !pref.estado.startsWith("Cierre") ? pref : vivos.sort((a, b) => nivel(b.estado) - nivel(a.estado) || b.creado.localeCompare(a.creado))[0] || pref || deals.sort((a, b) => b.creado.localeCompare(a.creado))[0]
    const leads = todos.filter((r) => r.tipo === "lead")
    const leadVivo = leads.filter((r) => r.estado !== "convertido" && !r.estado.startsWith("No Calificado")).sort((a, b) => b.creado.localeCompare(a.creado))[0]
    // El registro que MANDA prefiere al que tiene dueño HUMANO: un deal
    // gemelo que quedó en el robot no puede tapar al deal vivo del ejecutivo
    // (Pet Aventura: deal de Vicky + deal de Ana Paula sobre el mismo fono).
    const humanoPrimero = [...vivos, ...leads.filter((r) => r.estado !== "convertido")]
      .filter((r) => r.humano)
      .sort((a, b) => (a.tipo === b.tipo ? nivel(b.estado) - nivel(a.estado) || b.creado.localeCompare(a.creado) : a.tipo === "deal" ? -1 : 1))[0]
    const principal = humanoPrimero || mejorDeal || leadVivo || leads.sort((a, b) => b.creado.localeCompare(a.creado))[0] || null
    return { principal, todos }
  }

  // ── Emails de un registro: la notificación al ejecutivo vive ahí ─────────
  const RE_NOTIF = /asignaci[oó]n nuevo deal|traspaso ptv|lead calificado por vicky|notificaci[oó]n nuevo lead|nuevo lead/i
  const emailsDe = async (mod: "Deals" | "Leads", id: string, desdeMs: number) => {
    const r = await fetch(`${ZOHO_API}/crm/v8/${mod}/${id}/Emails`, { headers: HZ, cache: "no-store" }).catch(() => null)
    if (!r || r.status === 204) return { total: 0, notif: [] as Array<{ asunto: string; a: string; cuando: string }> }
    if (!r.ok) { fallos.push(`emails ${mod}/${id} ${r.status}`); return { total: 0, notif: [] } }
    const j = (await r.json().catch(() => ({}))) as { Emails?: Array<{ subject?: string; sent?: boolean; to?: Array<{ email?: string }>; sent_time?: string; time?: string }> }
    const lista = j.Emails || []
    const notif = lista
      .filter((e) => RE_NOTIF.test(String(e.subject || "")))
      .map((e) => ({ asunto: String(e.subject || "").slice(0, 110), a: (e.to || []).map((x) => String(x.email || "")).join(","), cuando: String(e.sent_time || e.time || "") }))
      .filter((e) => !e.cuando || !Number.isFinite(desdeMs) || Date.parse(e.cuando) >= desdeMs - 10 * 60_000)
    return { total: lista.length, notif }
  }

  // ═══════════════════════════ PARTE A: LOS TRASPASOS ══════════════════════
  // Paginado: una sola página de 800 se llenó con ENTREGAS FANTASMA (15-sep:
  // el reloj 24h insertaba y cerraba una fila por tick para 8 contactos con
  // deal, ~98 filas cada uno) y tapó las dos semanas. Esas filas —vendedor
  // vacío y estado cerrado— se cuentan aparte y no se auditan.
  const crudas: Ptv[] = []
  for (let off = 0; off < 20000; off += 1000) {
    const pag = await supa<Ptv>(
      `vic_ptv?traspasado_at=gte.${encodeURIComponent(desdeISO)}&traspasado_at=lte.${encodeURIComponent(hastaISO)}` +
        `&select=id,contact,vendedor_email,vendedor_nombre,vendedor_zoho_id,traspasado_at,motivo,presentado_al_prospecto,estado,chequeo_resultado&order=traspasado_at.desc&limit=1000&offset=${off}`,
      fallos,
    )
    crudas.push(...pag)
    if (pag.length < 1000) break
  }
  const esFantasma = (f: Ptv) => !String(f.vendedor_email || "").trim() && f.estado === "cerrado"
  const fantasmas = crudas.filter(esFantasma)
  const fantasmasPorContacto: Record<string, number> = {}
  for (const f of fantasmas) fantasmasPorContacto[digits(f.contact)] = (fantasmasPorContacto[digits(f.contact)] || 0) + 1
  const filasCL = crudas.filter((f) => !esFantasma(f)).map((f) => ({ ...f, contact: digits(f.contact) })).filter((f) => esCL(f.contact))
  const porContacto = new Map<string, Ptv[]>()
  for (const f of filasCL) porContacto.set(f.contact, [...(porContacto.get(f.contact) || []), f])
  const contactos = [...porContacto.keys()].slice(0, max)

  // Contexto en lotes: puntero, conversación, kv (notificación + pago + fase), espejo del rango.
  const puntero = new Map<string, { quoteId: string; dealId: string; empresa: string }>()
  const convs = new Map<string, { last: string; first: string; n: number; precioAt: string; formalAt: string }>()
  const kv = new Map<string, string>()
  const espejoVend = new Map<string, Array<{ ses: string; at: string }>>()
  const llamadas = new Map<string, Array<{ ses: string; at: string }>>()
  const loops = new Map<string, { estado: string; stage: string; motivo: string }>()
  const desdeEspejo = new Date(Date.parse(desdeISO) - 60_000).toISOString()
  const lotes = <T,>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n))
  const cargarContexto = async (tels: string[]) => {
    for (const lote of lotes(tels, 40)) {
      const inl = lote.map((t) => `"${t}"`).join(",")
      const kvKeys = lote.flatMap((t) => [`"notif_traspaso_${t}"`, `"pago_online_${t}"`, `"comprobante_ok_${t}"`, `"fase_vicky_${t}"`, `"ptv_omitido_${t}"`]).join(",")
      const [rq, rc, rk, rm, rl, rlo] = await Promise.all([
        supa<{ contact: string; quote_id?: string; deal_id?: string; empresa?: string }>(`vic_v3_quote_pointers?contact=in.(${inl})&select=contact,quote_id,deal_id,empresa&order=updated_at.desc&limit=200`, fallos),
        supa<{ contact: string; last_user_at?: string; first_user_at?: string; user_msg_count?: number; pref_escalon_at?: string; formal_quote_at?: string }>(`vic_v3_conversations?contact=in.(${inl})&select=contact,last_user_at,first_user_at,user_msg_count,pref_escalon_at,formal_quote_at&limit=200`, fallos),
        supa<{ key: string; value: string }>(`vic_kv?key=in.(${kvKeys})&select=key,value&limit=400`, fallos),
        supa<{ telefono_chat: string; from_me: boolean; enviado_at: string; session_id?: string }>(`vic_wa_espejo_mensajes?telefono_chat=in.(${inl})&from_me=eq.true&enviado_at=gte.${encodeURIComponent(desdeEspejo)}&select=telefono_chat,from_me,enviado_at,session_id&order=enviado_at.desc&limit=3000`, fallos),
        supa<{ telefono: string; estado: string; at: string; session_id?: string }>(`vic_wa_espejo_llamadas?telefono=in.(${inl})&estado=eq.accept&at=gte.${encodeURIComponent(desdeEspejo)}&select=telefono,estado,at,session_id&limit=800`, fallos),
        supa<{ contact: string; estado?: string; stage?: string; motivo_cierre?: string }>(`vic_loop?contact=in.(${inl})&select=contact,estado,stage,motivo_cierre&limit=200`, fallos),
      ])
      for (const f of rq) { const t = digits(f.contact); if (t && !puntero.has(t)) puntero.set(t, { quoteId: String(f.quote_id || ""), dealId: String(f.deal_id || ""), empresa: String(f.empresa || "") }) }
      for (const f of rc) { const t = digits(f.contact); if (t) convs.set(t, { last: String(f.last_user_at || ""), first: String(f.first_user_at || ""), n: Number(f.user_msg_count || 0), precioAt: String(f.pref_escalon_at || ""), formalAt: String(f.formal_quote_at || "") }) }
      for (const f of rk) kv.set(String(f.key), String(f.value || ""))
      for (const f of rm) { const t = digits(f.telefono_chat); if (t) espejoVend.set(t, [...(espejoVend.get(t) || []), { ses: String(f.session_id || ""), at: String(f.enviado_at || "") }]) }
      for (const f of rl) { const t = digits(f.telefono); if (t) llamadas.set(t, [...(llamadas.get(t) || []), { ses: String(f.session_id || ""), at: String(f.at || "") }]) }
      for (const f of rlo) { const t = digits(f.contact); if (t) loops.set(t, { estado: String(f.estado || ""), stage: String(f.stage || ""), motivo: String(f.motivo_cierre || "") }) }
    }
  }
  await cargarContexto(contactos)

  const sesionDe = (email: string) => String(email || "").toLowerCase().split("@")[0]
  const filas: Array<Record<string, unknown>> = []
  const resumen = { traspasos: filasCL.length, contactos: porContacto.size, ok: 0, con_problemas: 0, sin_registro_humano: 0, registro_robot: 0, bitacora_distinta_del_dueno: 0, sin_notificacion: 0, notificacion_fallida: 0, sin_presentar: 0, sin_atencion_vendedor: 0, cerrados_pago_u_onboarding: 0 }
  for (const c of contactos) {
    if (Date.now() - t0 > PRESUPUESTO_MS) { fallos.push(`presupuesto agotado en A tras ${filas.length} contactos`); break }
    const hist = porContacto.get(c) || []
    const vig = hist[0]
    const tsTr = Date.parse(vig.traspasado_at)
    const pt = puntero.get(c)
    const { principal, todos } = registroDe(c, pt?.dealId)
    const pagado = Boolean(kv.get(`pago_online_${c}`) || kv.get(`comprobante_ok_${c}`))
    const fase = kv.get(`fase_vicky_${c}`) || ""
    let ev: EvidenciaNotificacion | null = null
    try { const raw = kv.get(`notif_traspaso_${c}`); ev = raw ? (JSON.parse(raw) as EvidenciaNotificacion) : null } catch { ev = null }
    const verNotifKv = veredictoNotificacion(ev, vig.traspasado_at)
    // La notificación puede vivir en OTRO registro del mismo contacto (el
    // lead que se entregó por el reloj 24h y después se convirtió en deal):
    // se miran hasta 3 registros, empezando por el principal.
    let emails: { total: number; notif: Array<{ asunto: string; a: string; cuando: string }> } = { total: 0, notif: [] }
    if (conEmails && principal) {
      const aMirar = [principal, ...todos.filter((r) => r.id !== principal.id)].slice(0, 3)
      for (const r of aMirar) {
        const e = await emailsDe(r.tipo === "deal" ? "Deals" : "Leads", r.id, tsTr)
        emails = { total: emails.total + e.total, notif: [...emails.notif, ...e.notif] }
        if (e.notif.length) break
      }
    }
    const notifEmail = emails.notif.length > 0
    const sesAsig = sesionDe(vig.vendedor_email || "")
    const atendidoPor = new Set<string>()
    for (const m of espejoVend.get(c) || []) if (Date.parse(m.at) >= tsTr - 5 * 60_000) atendidoPor.add(m.ses || "?")
    for (const m of llamadas.get(c) || []) if (Date.parse(m.at) >= tsTr - 5 * 60_000) atendidoPor.add(m.ses || "?")
    const atendidoPorAsignado = atendidoPor.has(sesAsig) || atendidoPor.has(sesionDe(principal?.ownerEmail || "__"))
    const conv = convs.get(c)
    const clienteHabloDespues = Boolean(conv?.last && Date.parse(conv.last) > tsTr)
    const bitacoraVsDueno = !principal || !principal.humano ? "sin_dueno_humano" : sesionDe(principal.ownerEmail) === sesAsig ? "calza" : "distinto"
    const problemas: string[] = []
    const cerrado = pagado || fase === "onboarding"
    if (!principal) problemas.push("SIN_REGISTRO_EN_ZOHO")
    else if (!principal.humano) problemas.push(`REGISTRO_EN_ROBOT (${principal.tipo} ${principal.estado})`)
    if (principal?.humano && bitacoraVsDueno === "distinto") problemas.push(`BITACORA≠DUEÑO (bitácora ${sesAsig} · dueño ${sesionDe(principal.ownerEmail)})`)
    if (principal?.humano && verNotifKv !== "ok" && !notifEmail) problemas.push(verNotifKv === "fallo" ? "NOTIFICACION_FALLIDA" : conEmails ? "SIN_NOTIFICACION_VISIBLE" : "SIN_RASTRO_KV")
    if (!vig.presentado_al_prospecto && vig.estado === "activo" && !cerrado) problemas.push("SIN_PRESENTAR_AL_CLIENTE")
    if (principal?.humano && !atendidoPorAsignado && !cerrado && vig.estado === "activo") problemas.push(atendidoPor.size ? `ATENDIDO_POR_OTRO (${[...atendidoPor].join("/")})` : "SIN_ATENCION_DEL_VENDEDOR")
    if (!principal) resumen.sin_registro_humano++
    else if (!principal.humano) resumen.registro_robot++
    if (principal?.humano && bitacoraVsDueno === "distinto") resumen.bitacora_distinta_del_dueno++
    if (principal?.humano && verNotifKv !== "ok" && !notifEmail) { if (verNotifKv === "fallo") resumen.notificacion_fallida++; else resumen.sin_notificacion++ }
    if (!vig.presentado_al_prospecto && vig.estado === "activo" && !cerrado) resumen.sin_presentar++
    if (principal?.humano && !atendidoPorAsignado && !cerrado && vig.estado === "activo") resumen.sin_atencion_vendedor++
    if (cerrado) resumen.cerrados_pago_u_onboarding++
    if (problemas.length) resumen.con_problemas++; else resumen.ok++
    filas.push({
      contact: c, empresa: pt?.empresa || principal?.nombre || "", traspasos: hist.length, traspasado_at: vig.traspasado_at, motivo: vig.motivo, estado_ptv: vig.estado, presentado: Boolean(vig.presentado_al_prospecto), chequeo: vig.chequeo_resultado || null,
      bitacora: { vendedor: vig.vendedor_nombre, email: vig.vendedor_email },
      registro: principal ? { tipo: principal.tipo, id: principal.id, nombre: principal.nombre, dueno: principal.ownerNombre, duenoEmail: principal.ownerEmail, estado: principal.estado, humano: principal.humano } : null,
      otrosRegistros: todos.filter((r) => r.id !== principal?.id).map((r) => `${r.tipo} ${r.id} ${r.estado} → ${r.ownerNombre}`),
      bitacoraVsDueno, notificacion: { kv: verNotifKv, kvDetalle: ev ? { at: ev.at, ok: ev.ok, a: ev.ownerEmail, error: ev.error } : null, emails: emails.notif, emailsTotal: emails.total },
      atencion: { porAsignado: atendidoPorAsignado, sesiones: [...atendidoPor], clienteHabloDespues },
      cotizacion: pt ? { quoteId: pt.quoteId, dealId: pt.dealId } : null, pagado, fase: fase || null, loop: loops.get(c) || null,
      problemas,
    })
  }

  // ═══════════════ PARTE B: CONVERSACIONES SIN FILA EN vic_ptv ═════════════
  let sinTraspaso: Record<string, unknown> | null = null
  if (modoSinTraspaso && Date.now() - t0 < PRESUPUESTO_MS * 0.8) {
    const convsRango = await supa<{ contact: string; last_user_at?: string; first_user_at?: string; user_msg_count?: number; pref_escalon_at?: string; formal_quote_at?: string }>(
      `vic_v3_conversations?contact=like.56*&last_user_at=gte.${encodeURIComponent(desdeISO)}&last_user_at=lte.${encodeURIComponent(hastaISO)}&select=contact,last_user_at,first_user_at,user_msg_count,pref_escalon_at,formal_quote_at&order=last_user_at.desc&limit=2000`,
      fallos,
    )
    const candidatos = convsRango.map((r) => ({ ...r, contact: digits(r.contact) })).filter((r) => esCL(r.contact) && (r.user_msg_count || 0) >= 1)
    const tels = candidatos.map((r) => r.contact)
    // ¿Alguna fila vic_ptv (de cualquier fecha) para estos contactos?
    const conPtv = new Set<string>()
    for (const lote of lotes(tels, 60)) {
      const inl = lote.map((t) => `"${t}"`).join(",")
      for (const f of await supa<{ contact: string }>(`vic_ptv?contact=in.(${inl})&select=contact&limit=500`, fallos)) conPtv.add(digits(f.contact))
    }
    const sinPtv = candidatos.filter((r) => !conPtv.has(r.contact))
    // Promesas de contacto del rango (callback / llamada_ejecutivo).
    const promesas = new Map<string, Array<{ tipo: string; estado: string; deadline: string }>>()
    for (const lote of lotes(sinPtv.map((r) => r.contact), 60)) {
      const inl = lote.map((t) => `"${t}"`).join(",")
      for (const p of await supa<{ contact: string; tipo: string; estado: string; deadline_at: string }>(`vic_promesas?contact=in.(${inl})&select=contact,tipo,estado,deadline_at&order=creado_at.desc&limit=500`, fallos)) {
        const t = digits(p.contact); promesas.set(t, [...(promesas.get(t) || []), { tipo: p.tipo, estado: p.estado, deadline: p.deadline_at }])
      }
    }
    await cargarContexto(sinPtv.map((r) => r.contact))
    const MOTIVOS_TRASPASO_SIN_PTV = new Set(["mas_de_50", "sobre_umbral", "derivado", "reunion"])
    const filasB: Array<Record<string, unknown>> = []
    const resB = { conversaciones_cl_rango: candidatos.length, con_bitacora: candidatos.length - sinPtv.length, sin_bitacora: sinPtv.length, gatillo_sin_bitacora: 0, registro_humano: 0, registro_robot: 0, sin_registro: 0, en_curso_o_cerrado_por_regla: 0, pagado_u_onboarding: 0 }
    for (const r of sinPtv) {
      const c = r.contact
      const lp = loops.get(c)
      const pt = puntero.get(c)
      const pr = promesas.get(c) || []
      const gatillo: string[] = []
      if (r.pref_escalon_at) gatillo.push("precio_mostrado")
      if (r.formal_quote_at || pt?.quoteId) gatillo.push("formal")
      if (pr.length) gatillo.push(`promesa:${pr.map((p) => `${p.tipo}/${p.estado}`).join("|")}`)
      if (lp && MOTIVOS_TRASPASO_SIN_PTV.has(lp.motivo)) gatillo.push(`loop:${lp.motivo}`)
      if (!gatillo.length) continue
      resB.gatillo_sin_bitacora++
      const pagado = Boolean(kv.get(`pago_online_${c}`) || kv.get(`comprobante_ok_${c}`))
      const fase = kv.get(`fase_vicky_${c}`) || ""
      const { principal, todos } = registroDe(c, pt?.dealId)
      let veredicto: string
      if (pagado || fase === "onboarding") { veredicto = "pagado_u_onboarding"; resB.pagado_u_onboarding++ }
      else if (principal?.humano) { veredicto = "registro_humano_sin_bitacora"; resB.registro_humano++ }
      else if (principal) { veredicto = lp?.estado === "activo" || lp?.estado === "pausado_compromiso" ? "en_curso_registro_en_robot" : "REGISTRO_EN_ROBOT_SIN_TRASPASO"; if (veredicto.startsWith("REGISTRO")) resB.registro_robot++; else resB.en_curso_o_cerrado_por_regla++ }
      else { veredicto = lp?.estado === "activo" || lp?.estado === "pausado_compromiso" ? "en_curso_sin_registro" : "SIN_REGISTRO_NI_TRASPASO"; if (veredicto.startsWith("SIN")) resB.sin_registro++; else resB.en_curso_o_cerrado_por_regla++ }
      filasB.push({
        contact: c, empresa: pt?.empresa || principal?.nombre || "", ultimo_mensaje: r.last_user_at, mensajes: r.user_msg_count, gatillo, loop: lp || null, cotizacion: pt || null,
        registro: principal ? { tipo: principal.tipo, id: principal.id, nombre: principal.nombre, dueno: principal.ownerNombre, estado: principal.estado, humano: principal.humano } : null,
        otrosRegistros: todos.filter((x) => x.id !== principal?.id).map((x) => `${x.tipo} ${x.id} ${x.estado} → ${x.ownerNombre}`),
        veredicto,
      })
      if (Date.now() - t0 > PRESUPUESTO_MS) { fallos.push(`presupuesto agotado en B tras ${filasB.length}`); break }
    }
    sinTraspaso = { resumen: resB, filas: filasB.sort((a, b) => String(a.veredicto).localeCompare(String(b.veredicto))) }
  }

  return NextResponse.json({
    ok: true, rango: { desde, hasta }, indice: { deals: dealsPorId.size, leadsTel: leadsPorNueve.size, dealsTel: dealsPorNueve.size },
    entregasFantasma: { filas: fantasmas.length, porContacto: fantasmasPorContacto },
    resumen, traspasos: filas, sinTraspaso, fallos, ms: Date.now() - t0,
  })
}
