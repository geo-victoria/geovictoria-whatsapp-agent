/**
 * LIMPIEZA DE DEALS DE VICKY (Lalo 20-ago, "actualicemos toodo lo de Vicky")
 * — deja el CRM apto para forecast/pipeline/facturación:
 *
 *   1. MONTOS según convención de MARKETING (David García 20-ago, vía Lalo):
 *      Tipo_de_Cobro = "Mensual fijo" · Valor_fijo_del_trato_Global =
 *      recurrente mensual REAL (subform con descuento, NETO sin IVA) en CLP
 *      tal cual (Lalo 20-ago, caso Constanza) · N_Empleados_que_marcan =
 *      usuarios de la cotización (solo modalidad Por usuario; en tarifa fija
 *      se conserva el del deal). Amount estándar NO se usa (Zoho lo ignora).
 *   2. Piso de stage: cotización PAGADA (estado Pagada u Onboarding_Link) →
 *      deal mínimo "6. Listo para Cierre" (regla Lalo 20-ago: precio ⇒ 4,
 *      pago ⇒ 6, a Facturando solo lo mueve el ejecutivo). Forward-only vía
 *      blueprint (transicionarDealHacia). Un pagado en "Cierre Perdido" se
 *      REPORTA (no se resucita solo — decisión humana).
 *   3. Dueño cotización = dueño deal (Lalo 20-ago): si el deal tiene humano
 *      y la cotización quedó con el robot Vicky, se alinea la cotización.
 *   4. Puntero local sin deal_id pero con Deal_Asociado en Zoho → backfill.
 *
 * Idempotente y por tandas: candado vic_kv `dlz_<dealId>` (TTL 7 días) — se
 * puede correr en loop hasta que responda procesados=0, y colgado del
 * despachador de huérfanos actúa de reconciliador permanente (cada deal se
 * re-verifica una vez por semana). `?force=1` ignora el candado.
 *
 * GET /api/vic-admin-deal-limpieza?limit=20[&force=1]
 * Auth: x-cron-secret == vic_kv.followup_cron_secret, o Bearer/?key=CRON_SECRET.
 */

import { NextResponse } from "next/server"
import { getZohoAccessToken } from "@/lib/zoho-token"
import { transicionarDealHacia } from "@/lib/zoho-deals"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"

export const dynamic = "force-dynamic"
export const maxDuration = 120

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const CRON_SECRET = (process.env.CRON_SECRET || "").trim()
const ZOHO_API = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
const ROBOT_OWNER_IDS = new Set(["3525045000484500876"]) // Vicky GeoVictoria

async function supa<T>(path: string, init: RequestInit = {}): Promise<T[]> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return []
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(init.headers || {}),
    },
    cache: "no-store",
  })
  if (!res.ok) return []
  return ((await res.json().catch(() => [])) as T[]) || []
}

async function authorized(req: Request): Promise<boolean> {
  const xcron = (req.headers.get("x-cron-secret") || "").trim()
  if (xcron) {
    const expected = await getFollowupCronSecret().catch(() => "")
    if (expected && xcron === expected) return true
  }
  if (CRON_SECRET) {
    const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim()
    if (bearer === CRON_SECRET) return true
    const key = (new URL(req.url).searchParams.get("key") || "").trim()
    if (key === CRON_SECRET) return true
  }
  return false
}

type Puntero = { quote_id: string; deal_id: string | null; created_at: string; contact?: string | null; zoho?: boolean }

/** GESTIÓN VICKY (Lalo 20-ago, categorías finales de marketing) —
 * congelado al momento del PAGO; lo posterior es gestión interna:
 *   · "Derivado fuera de Rango": el loop se cerró por sobre_umbral/mas_de_50
 *     antes del pago (Vicky no vende ese rango).
 *   · "Derivado por Reunión": hay una reunión (Event de Zoho del deal)
 *     creada antes del pago.
 *   · "Derivado": traspaso conversacional (vic_ptv) o derivación del loop
 *     antes del pago.
 *   · "Gestión Vicky": nada de lo anterior entre el inicio y el pago. */
async function veredictoGestion(tel: string, pagoMs: number, dealId: string, H: Record<string, string>): Promise<string> {
  // Sin conversación en el canal de Vicky (cotizadora usada directo por el
  // ejecutivo, cliente que jamás escribió) → "No habló con Vicky" (Lalo
  // 20-ago). El valor vive en el picklist Gesti_n_Vicky.
  const conv = await supa<{ id: string }>(`vic_v3_conversations?contact=eq.${tel}&select=id&limit=1`)
  if (!conv[0]) return "No habló con Vicky"
  const margen = 5 * 60e3 // eventos "en el acto" del pago no cuentan como previos
  const loop = await supa<{ motivo_cierre: string | null; estado: string; updated_at: string }>(
    `vic_loop?contact=eq.${tel}&select=motivo_cierre,estado,updated_at&limit=1`,
  )
  const cierre = String(loop[0]?.motivo_cierre || "")
  const cierreMs = Date.parse(String(loop[0]?.updated_at || ""))
  const cerradoAntes = loop[0]?.estado === "cerrado" && Number.isFinite(cierreMs) && cierreMs <= pagoMs + margen
  if ((cierre === "sobre_umbral" || cierre === "mas_de_50") && cerradoAntes) return "Derivado fuera de Rango"
  try {
    const re = await fetch(`${ZOHO_API}/crm/v3/coql`, {
      method: "POST",
      headers: H,
      cache: "no-store",
      body: JSON.stringify({ select_query: `select id, Created_Time from Events where What_Id = ${dealId} limit 5` }),
    })
    if (re.status === 200) {
      const evs = (((await re.json().catch(() => ({}))) as { data?: Array<{ Created_Time?: string }> }).data) || []
      if (evs.some((e) => Date.parse(String(e.Created_Time || "")) <= pagoMs)) return "Derivado por Reunión"
    }
  } catch { /* sin señal de reunión */ }
  const ptv = await supa<{ traspasado_at: string }>(
    `vic_ptv?contact=eq.${tel}&select=traspasado_at&order=traspasado_at.asc&limit=1`,
  )
  const primerMs = ptv[0] ? Date.parse(String(ptv[0].traspasado_at)) : NaN
  if (Number.isFinite(primerMs) && primerMs <= pagoMs) return "Derivado"
  if (cierre === "derivado" && cerradoAntes) return "Derivado"
  return "Gestión Vicky"
}

export async function GET(req: Request): Promise<Response> {
  if (!(await authorized(req))) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  const { searchParams } = new URL(req.url)
  const limit = Math.min(Math.max(parseInt(searchParams.get("limit") || "20", 10) || 20, 1), 60)
  const force = searchParams.get("force") === "1"

  const token = await getZohoAccessToken()
  const H = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }

  // ── MODO ATRIBUCIÓN (?atribucion=1): recorre las VENTAS PAGADAS del
  // registro venta_dash y estampa Gesti_n_Vicky en su deal si está vacío.
  if (searchParams.get("atribucion") === "1") {
    const out = { estampadas: 0, ya_tenian: 0, sin_deal: 0, detalle: [] as string[], errores: [] as string[] }
    const ventas = await supa<{ key: string; value: string }>(`vic_kv?key=like.venta_dash_v3_*&select=key,value&limit=3000`)
    for (const v of ventas) {
      try {
        const qid = String(v.key).replace("venta_dash_v3_", "")
        const dato = JSON.parse(v.value) as { pagoIso?: string; numero?: string }
        const pagoMs = Date.parse(String(dato.pagoIso || ""))
        if (!Number.isFinite(pagoMs)) continue
        const pt = await supa<{ deal_id: string | null; contact: string }>(
          `vic_v3_quote_pointers?quote_id=eq.${qid}&select=deal_id,contact&limit=1`,
        )
        const dealId = pt[0]?.deal_id || ""
        const tel = (pt[0]?.contact || "").replace(/\D/g, "")
        if (!dealId || !tel) { out.sin_deal++; continue }
        const rd = await fetch(`${ZOHO_API}/crm/v3/Deals/${dealId}?fields=Gesti_n_Vicky,Created_By`, { headers: H, cache: "no-store" })
        if (rd.status !== 200) continue
        const dd = ((await rd.json().catch(() => ({}))) as { data?: Array<{ Gesti_n_Vicky?: string | null; Created_By?: { id?: string } }> })?.data?.[0]
        // Deal creado por un HUMANO = venta del canal ejecutivo (caso MATER):
        // la atribución Vicky no aplica.
        if (dd?.Created_By?.id && !ROBOT_OWNER_IDS.has(String(dd.Created_By.id))) { out.sin_deal++; continue }
        const actual = String(dd?.Gesti_n_Vicky || "")
        if (actual) { out.ya_tenian++; continue }
        const veredicto = await veredictoGestion(tel, pagoMs, dealId, H)
        const up = await fetch(`${ZOHO_API}/crm/v3/Deals/${dealId}`, {
          method: "PUT",
          headers: H,
          cache: "no-store",
          body: JSON.stringify({ data: [{ id: dealId, Gesti_n_Vicky: veredicto }], trigger: [], skip_feature_execution: [{ name: "assignment_rules" }] }),
        })
        const cuerpo = (await up.json().catch(() => ({}))) as { data?: Array<{ code?: string }> }
        if (up.ok && cuerpo?.data?.[0]?.code === "SUCCESS") {
          out.estampadas++
          out.detalle.push(`${dato.numero || qid}: ${veredicto}`)
        } else out.errores.push(`${dato.numero || qid}: ${cuerpo?.data?.[0]?.code || up.status}`)
      } catch (e) {
        out.errores.push(e instanceof Error ? e.message.slice(0, 60) : "err")
      }
    }
    console.log(`[deal-limpieza] atribucion ${JSON.stringify({ ...out, detalle: out.detalle.length })}`)
    return NextResponse.json({ ok: true, modo: "atribucion", ...out })
  }

  // ── MODO MONEDA (?moneda=1): backfill masivo de "Moneda del trato"
  // (campo custom Monda_del_trato — el visible en las vistas; distinto del
  // Currency sistema). Lalo 20-ago: "la moneda del trato también pásala a
  // CLP". UF solo existe en Chile → todo deal de Vicky con UF pasa a CLP;
  // CO/MX/PE (COP/MXN/SOL) no se tocan. Pagina hasta agotar o `limit`.
  if (searchParams.get("moneda") === "1") {
    const out = { actualizados: 0, errores: [] as string[], quedan: 0 }
    for (let vuelta = 0; vuelta < 10 && out.actualizados < limit; vuelta++) {
      const rc = await fetch(`${ZOHO_API}/crm/v3/coql`, {
        method: "POST",
        headers: H,
        cache: "no-store",
        body: JSON.stringify({
          select_query: `select id from Deals where Created_By = 3525045000484500876 and Monda_del_trato = 'UF' limit 100`,
        }),
      })
      if (rc.status === 204) break // sin más filas
      if (rc.status !== 200) { out.errores.push(`coql ${rc.status}`); break }
      const filas = (((await rc.json().catch(() => ({}))) as { data?: Array<{ id: string }> }).data) || []
      if (!filas.length) break
      const ids = filas.slice(0, Math.max(1, limit - out.actualizados))
      const up = await fetch(`${ZOHO_API}/crm/v3/Deals`, {
        method: "PUT",
        headers: H,
        cache: "no-store",
        body: JSON.stringify({
          data: ids.map((f) => ({ id: f.id, Monda_del_trato: "CLP" })),
          skip_feature_execution: [{ name: "assignment_rules" }],
          trigger: [],
        }),
      })
      const cuerpo = (await up.json().catch(() => ({}))) as { data?: Array<{ code?: string; details?: { id?: string } }> }
      for (const r of cuerpo?.data || []) {
        if (r.code === "SUCCESS") out.actualizados++
        else out.errores.push(`${r.details?.id || "?"}: ${r.code}`)
      }
      if (!up.ok && !cuerpo?.data?.length) { out.errores.push(`put ${up.status}`); break }
    }
    const rq = await fetch(`${ZOHO_API}/crm/v3/coql`, {
      method: "POST",
      headers: H,
      cache: "no-store",
      body: JSON.stringify({ select_query: `select COUNT(id) from Deals where Created_By = 3525045000484500876 and Monda_del_trato = 'UF' group by Monda_del_trato` }),
    })
    if (rq.status === 200) {
      const d = (((await rq.json().catch(() => ({}))) as { data?: Array<Record<string, unknown>> }).data) || []
      out.quedan = Number(Object.values(d[0] || {}).find((v) => typeof v === "number") || 0)
    }
    console.log(`[deal-limpieza] moneda ${JSON.stringify(out)}`)
    return NextResponse.json({ ok: true, modo: "moneda", ...out })
  }

  // ── MODO GESTIÓN DE LEADS (?gestionleads=1): mismo campo Gesti_n_Vicky
  // creado en el módulo LEADS (Lalo 20-ago, "los leads que se asignaron a
  // Vicky, ¿podemos marcarlos igual?"). Universo: leads CREADOS por Vicky O
  // ASIGNADOS a Vicky (los que recibió por tómbola/reglas hace tiempo — Lalo
  // 20-ago), aún sin convertir (COQL excluye convertidos); teléfono del lead.
  if (searchParams.get("gestionleads") === "1") {
    const out = { estampados: 0, sin_telefono: 0, errores: [] as string[] }
    const rc = await fetch(`${ZOHO_API}/crm/v3/coql`, {
      method: "POST", headers: H, cache: "no-store",
      body: JSON.stringify({ select_query: `select id, Phone, Mobile from Leads where (Created_By = 3525045000484500876 or Owner = 3525045000484500876) and Gesti_n_Vicky is null order by Created_Time desc limit 100` }),
    })
    if (rc.status !== 200 && rc.status !== 204) return NextResponse.json({ ok: false, error: `coql ${rc.status}` }, { status: 500 })
    const filas = rc.status === 204 ? [] : ((((await rc.json().catch(() => ({}))) as { data?: Array<{ id: string; Phone?: string | null; Mobile?: string | null }> }).data) || [])
    for (const f of filas.slice(0, limit)) {
      try {
        const tel = String(f.Mobile || f.Phone || "").replace(/\D/g, "")
        if (!tel) { out.sin_telefono++; continue }
        const veredicto = await veredictoGestion(tel, Date.now(), f.id, H)
        const up = await fetch(`${ZOHO_API}/crm/v3/Leads/${f.id}`, {
          method: "PUT", headers: H, cache: "no-store",
          body: JSON.stringify({ data: [{ id: f.id, Gesti_n_Vicky: veredicto }], trigger: [], skip_feature_execution: [{ name: "assignment_rules" }] }),
        })
        const cuerpo = (await up.json().catch(() => ({}))) as { data?: Array<{ code?: string }> }
        if (up.ok && cuerpo?.data?.[0]?.code === "SUCCESS") out.estampados++
        else out.errores.push(`${f.id}: ${cuerpo?.data?.[0]?.code || up.status}`)
      } catch (e) {
        out.errores.push(`${f.id}: ${e instanceof Error ? e.message.slice(0, 50) : "err"}`)
      }
    }
    console.log(`[deal-limpieza] gestionleads ${JSON.stringify(out)}`)
    return NextResponse.json({ ok: true, modo: "gestionleads", quedan_en_pagina: filas.length, ...out })
  }

  // ── MODO GESTIÓN DE HITOS (?gestionhitos=1): deals del robot SIN cotización
  // (derivación >50, reunión, callback — el barrido normal no los visita
  // porque recorre pares cotización↔deal). El teléfono sale del CONTACTO del
  // deal y con él se calcula el mismo veredicto. Sin candado: el estampado
  // los saca de la consulta.
  if (searchParams.get("gestionhitos") === "1") {
    const out = { estampados: 0, sin_contacto: 0, sin_telefono: 0, errores: [] as string[] }
    const rc = await fetch(`${ZOHO_API}/crm/v3/coql`, {
      method: "POST", headers: H, cache: "no-store",
      body: JSON.stringify({ select_query: `select id, Contact_Name from Deals where Created_By = 3525045000484500876 and Gesti_n_Vicky is null order by Created_Time desc limit 100` }),
    })
    if (rc.status !== 200 && rc.status !== 204) return NextResponse.json({ ok: false, error: `coql ${rc.status}` }, { status: 500 })
    const filas = rc.status === 204 ? [] : ((((await rc.json().catch(() => ({}))) as { data?: Array<{ id: string; Contact_Name?: { id?: string } | null }> }).data) || [])
    for (const f of filas.slice(0, limit)) {
      try {
        const contactId = String(f.Contact_Name?.id || "")
        if (!contactId) { out.sin_contacto++; continue }
        const rp = await fetch(`${ZOHO_API}/crm/v3/Contacts/${contactId}?fields=Phone,Mobile`, { headers: H, cache: "no-store" })
        const cont = rp.status === 200 ? ((await rp.json().catch(() => ({}))) as { data?: Array<{ Phone?: string | null; Mobile?: string | null }> })?.data?.[0] : undefined
        const tel = String(cont?.Mobile || cont?.Phone || "").replace(/\D/g, "")
        if (!tel) { out.sin_telefono++; continue }
        const veredicto = await veredictoGestion(tel, Date.now(), f.id, H)
        const up = await fetch(`${ZOHO_API}/crm/v3/Deals/${f.id}`, {
          method: "PUT", headers: H, cache: "no-store",
          body: JSON.stringify({ data: [{ id: f.id, Gesti_n_Vicky: veredicto }], trigger: [], skip_feature_execution: [{ name: "assignment_rules" }] }),
        })
        const cuerpo = (await up.json().catch(() => ({}))) as { data?: Array<{ code?: string }> }
        if (up.ok && cuerpo?.data?.[0]?.code === "SUCCESS") out.estampados++
        else out.errores.push(`${f.id}: ${cuerpo?.data?.[0]?.code || up.status}`)
      } catch (e) {
        out.errores.push(`${f.id}: ${e instanceof Error ? e.message.slice(0, 50) : "err"}`)
      }
    }
    console.log(`[deal-limpieza] gestionhitos ${JSON.stringify(out)}`)
    return NextResponse.json({ ok: true, modo: "gestionhitos", quedan_en_pagina: filas.length, ...out })
  }

  // ── MODO ENLAZAR (?enlazar=1): cotizaciones de Vicky ANTERIORES al lookup
  // Deal_Asociado (junio-julio) quedan huérfanas de deal aunque el deal exista
  // — se emparejan por la CUENTA asociada (deal del robot sin valor + la
  // cotización del robot de esa misma cuenta) y se escribe Deal_Asociado en la
  // cotización. Con el enlace puesto, el barrido normal les calcula montos.
  if (searchParams.get("enlazar") === "1") {
    const out = { enlazadas: 0, sin_par: 0, errores: [] as string[] }
    // Deals del robot sin valor, con su cuenta.
    const dealPorCuenta = new Map<string, string>()
    for (let off = 0; off < 1000; off += 200) {
      const rd = await fetch(`${ZOHO_API}/crm/v3/coql`, {
        method: "POST", headers: H, cache: "no-store",
        body: JSON.stringify({ select_query: `select id, Account_Name from Deals where Created_By = 3525045000484500876 and Valor_fijo_del_trato_Global is null order by Created_Time desc limit 200 offset ${off}` }),
      })
      if (rd.status !== 200) break
      const filas = (((await rd.json().catch(() => ({}))) as { data?: Array<{ id: string; Account_Name?: { id?: string } | null }>; info?: { more_records?: boolean } }))
      for (const f of filas?.data || []) {
        const acc = String(f.Account_Name?.id || "")
        if (acc && !dealPorCuenta.has(acc)) dealPorCuenta.set(acc, f.id)
      }
      if (!filas?.info?.more_records) break
    }
    // Cotizaciones del robot sin Deal_Asociado, por cuenta.
    for (let off = 0; off < 1000; off += 200) {
      const rq = await fetch(`${ZOHO_API}/crm/v3/coql`, {
        method: "POST", headers: H, cache: "no-store",
        body: JSON.stringify({ select_query: `select id, Cuenta_Asociada from Cotizaciones_GeoVictoria where Created_By = 3525045000484500876 and Deal_Asociado is null order by Created_Time desc limit 200 offset ${off}` }),
      })
      if (rq.status !== 200) break
      const filas = (((await rq.json().catch(() => ({}))) as { data?: Array<{ id: string; Cuenta_Asociada?: { id?: string } | null }>; info?: { more_records?: boolean } }))
      for (const q of filas?.data || []) {
        const acc = String(q.Cuenta_Asociada?.id || "")
        const dealId = acc ? dealPorCuenta.get(acc) : undefined
        if (!dealId) { out.sin_par++; continue }
        const up = await fetch(`${ZOHO_API}/crm/v3/Cotizaciones_GeoVictoria/${q.id}`, {
          method: "PUT", headers: H, cache: "no-store",
          body: JSON.stringify({ data: [{ id: q.id, Deal_Asociado: dealId }], trigger: [] }),
        })
        const cuerpo = (await up.json().catch(() => ({}))) as { data?: Array<{ code?: string }> }
        if (up.ok && cuerpo?.data?.[0]?.code === "SUCCESS") {
          out.enlazadas++
          dealPorCuenta.delete(acc) // un deal recibe UNA cotización (la más nueva)
          // El candado del deal se libera para que el barrido lo tome ya.
          await supa(`vic_kv?key=eq.${encodeURIComponent(`dlz_${dealId}`)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } }).catch(() => [])
        } else out.errores.push(`${q.id}: ${cuerpo?.data?.[0]?.code || up.status}`)
      }
      if (!filas?.info?.more_records) break
    }
    console.log(`[deal-limpieza] enlazar ${JSON.stringify(out)}`)
    return NextResponse.json({ ok: true, modo: "enlazar", ...out })
  }

  // Emisiones completas, más reciente primero; por deal se usa SU cotización
  // más nueva (la vigente). Punteros sin deal se resuelven vía Deal_Asociado.
  const punteros: Puntero[] = []
  for (let offset = 0; offset < 5000; offset += 1000) {
    const lote = await supa<Puntero>(
      `vic_v3_quote_pointers?select=quote_id,deal_id,created_at,contact&order=created_at.desc&limit=1000&offset=${offset}`,
    )
    punteros.push(...lote)
    if (lote.length < 1000) break
  }
  // Y el barrido DESDE ZOHO (Lalo 20-ago, "aún hay deals con cotizaciones
  // existentes pero el valor en 0 o en UF"): el registro local de punteros
  // solo cubre las emisiones recientes (~93 deals de 239 con cotización) —
  // las de junio/julio no tienen puntero y quedaban fuera del reconciliador.
  // Fuente de verdad: toda Cotización con Deal_Asociado. El teléfono para la
  // regla de moneda sale de la propia cotización (Tel_fono_Contacto).
  const yaLocal = new Set(punteros.map((p) => p.quote_id))
  for (let offset = 0; offset < 4000; offset += 200) {
    const rz = await fetch(`${ZOHO_API}/crm/v3/coql`, {
      method: "POST",
      headers: H,
      cache: "no-store",
      body: JSON.stringify({
        select_query: `select id, Deal_Asociado, Tel_fono_Contacto, Created_Time from Cotizaciones_GeoVictoria where Deal_Asociado is not null order by Created_Time desc limit 200 offset ${offset}`,
      }),
    })
    if (rz.status !== 200) break
    const cuerpo = (await rz.json().catch(() => ({}))) as {
      data?: Array<{ id: string; Deal_Asociado?: { id?: string } | null; Tel_fono_Contacto?: string | null; Created_Time?: string }>
      info?: { more_records?: boolean }
    }
    for (const q of cuerpo?.data || []) {
      if (yaLocal.has(q.id)) continue
      punteros.push({
        quote_id: q.id,
        deal_id: String(q.Deal_Asociado?.id || "") || null,
        created_at: String(q.Created_Time || ""),
        contact: String(q.Tel_fono_Contacto || "").replace(/\D/g, ""),
        zoho: true,
      })
    }
    if (!cuerpo?.info?.more_records) break
  }
  punteros.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))

  // ── DEBUG BLUEPRINT (?debugbp=<dealId>): transiciones disponibles con sus
  // campos, para diagnosticar INVALID_DATA (variantes por deal).
  const debugbp = (searchParams.get("debugbp") || "").replace(/\D/g, "")
  if (debugbp) {
    const r = await fetch(`${ZOHO_API.replace("/crm/v3", "")}/crm/v2/Deals/${debugbp}/actions/blueprint`, { headers: H, cache: "no-store" })
    const cuerpo = await r.json().catch(() => ({}))
    return NextResponse.json({ ok: true, status: r.status, blueprint: cuerpo })
  }

  // ── MODO PAGADAS (?pagadas=1): la pasada completa (montos CLP, moneda,
  // stage, dueño, gestión) SOLO sobre las ventas pagadas del registro
  // venta_dash, ignorando el candado — "cerremos por el grupo de deals que
  // ya pagaron" (Lalo 20-ago).
  let forzar = force
  if (searchParams.get("pagadas") === "1") {
    const ventas = await supa<{ key: string }>(`vic_kv?key=like.venta_dash_v3_*&select=key&limit=3000`)
    const qidsPagadas = new Set(ventas.map((v) => String(v.key).replace("venta_dash_v3_", "")))
    for (let i = punteros.length - 1; i >= 0; i--) {
      if (!qidsPagadas.has(punteros[i].quote_id)) punteros.splice(i, 1)
    }
    forzar = true
  }

  const res = {
    procesados: 0,
    amount_actualizado: 0,
    owner_cotizacion_alineado: 0,
    stage_subido: 0,
    punteros_backfilleados: 0,
    pagadas_en_perdido: [] as string[],
    errores: [] as string[],
  }
  const dealVisto = new Set<string>()

  // Candados PRECARGADOS en una sola consulta (antes se consultaba vic_kv por
  // puntero Y se bajaba la cotización de Zoho por puntero — con cientos de
  // deals ya tratados, la función se comía los 120s solo en saltarlos).
  const candadoVivo = new Set<string>()
  if (!forzar) {
    for (let off = 0; off < 4000; off += 1000) {
      const lote = await supa<{ key: string; expires_at?: string }>(
        `vic_kv?key=like.dlz_*&select=key,expires_at&limit=1000&offset=${off}`,
      )
      for (const c of lote) {
        if (!c.expires_at || new Date(c.expires_at).getTime() > Date.now()) {
          candadoVivo.add(String(c.key).replace("dlz_", ""))
        }
      }
      if (lote.length < 1000) break
    }
  }

  for (const p of punteros) {
    if (res.procesados >= limit) break
    try {
      // Salto barato ANTES de tocar Zoho (solo posible con deal_id conocido).
      if (p.deal_id && (dealVisto.has(p.deal_id) || candadoVivo.has(p.deal_id))) continue
      // 1. Cotización (fuente de verdad del deal, estado, dueño y montos).
      const rq = await fetch(`${ZOHO_API}/crm/v3/Cotizaciones_GeoVictoria/${p.quote_id}`, { headers: H, cache: "no-store" })
      if (rq.status !== 200) continue
      const quote = ((await rq.json().catch(() => ({}))) as { data?: Array<Record<string, unknown>> })?.data?.[0]
      if (!quote) continue
      const dealAsociado = (quote.Deal_Asociado as { id?: string } | null)?.id || ""
      const dealId = p.deal_id || dealAsociado
      if (!dealId) continue
      if (dealVisto.has(dealId)) continue // ya tratado con una cotización más nueva
      dealVisto.add(dealId)

      // Backfill del puntero local (cosmético pero deja la data consistente).
      // Solo para filas del registro local — las venidas del barrido Zoho no
      // tienen fila que parchar.
      if (!p.deal_id && dealAsociado && !p.zoho) {
        await supa(`vic_v3_quote_pointers?quote_id=eq.${p.quote_id}`, {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ deal_id: dealAsociado }),
        }).catch(() => [])
        res.punteros_backfilleados++
      }

      // Candado semanal por deal (del precargado; cubre el caso deal_id
      // resuelto recién vía Deal_Asociado).
      if (!forzar && candadoVivo.has(dealId)) continue
      res.procesados++
      candadoVivo.add(dealId)
      await supa(`vic_kv?on_conflict=key`, {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({
          key: `dlz_${dealId}`,
          value: new Date().toISOString(),
          expires_at: new Date(Date.now() + 7 * 86400e3).toISOString(),
        }),
      }).catch(() => [])

      // 2. Recurrente mensual NETO (subform × (1-desc), sin IVA/IGV).
      const pct = Number(quote.Descuento_Recurrente_Pct || 0) || 0
      const items = (quote.Detalle_Items_Cotizacion as Array<{ Subtotal_CLP?: number; Es_Recurrente?: boolean; Codigo_Item?: string; Modalidad?: string; Cantidad?: number }>) || []
      // Las emisiones de JUNIO marcaban la asistencia fija Es_Recurrente=false
      // (caso TAO COT168) — la asistencia SIEMPRE es recurrente, así que entra
      // por código de ítem aunque el flag venga apagado.
      const recurrenteNeto = Math.round(
        items
          .filter((i) => i.Es_Recurrente || (i.Codigo_Item || "") === "asistencia")
          .reduce((a, i) => a + (Number(i.Subtotal_CLP) || 0), 0) * (1 - pct / 100),
      )

      // 3. Deal actual.
      const rd = await fetch(`${ZOHO_API}/crm/v3/Deals/${dealId}?fields=Stage,Owner,Tipo_de_Cobro,Valor_fijo_del_trato_Global,Valor_por_usuario_Global,N_Empleados_que_marcan,Currency,Monda_del_trato,Gesti_n_Vicky,Created_By`, { headers: H, cache: "no-store" })
      if (rd.status !== 200) continue
      const deal = ((await rd.json().catch(() => ({}))) as {
        data?: Array<{
          Stage?: string
          Owner?: { id?: string; email?: string }
          Tipo_de_Cobro?: string | null
          Valor_fijo_del_trato_Global?: number | null
          Valor_por_usuario_Global?: number | null
          N_Empleados_que_marcan?: number | null
          Currency?: string | null
          Monda_del_trato?: string | null
          Gesti_n_Vicky?: string | null
          Created_By?: { id?: string } | null
        }>
      })?.data?.[0]
      if (!deal) continue

      // 4a. Convención FINAL (Lalo 20-ago, caso Constanza: "dejemos el monto
      // recurrente mensual en CLP"): Mensual fijo + recurrente real NETO en
      // CLP tal cual en Valor_fijo + usuarios de la cotización (Por usuario).
      const valorFijoUsd = recurrenteNeto
      const asistencia = items.find((i) => (i.Codigo_Item || "") === "asistencia")
      const modalidadPorUsuario = String(asistencia?.Modalidad || "").toLowerCase().includes("usuario")
      const usuariosCot = modalidadPorUsuario ? Number(asistencia?.Cantidad) || 0 : 0
      const cambios: Record<string, unknown> = {}
      if (recurrenteNeto > 0 && Math.abs(Number(deal.Valor_fijo_del_trato_Global || 0) - valorFijoUsd) > 1) {
        cambios.Valor_fijo_del_trato_Global = valorFijoUsd
      }
      if (recurrenteNeto > 0 && String(deal.Tipo_de_Cobro || "") !== "Mensual fijo") {
        cambios.Tipo_de_Cobro = "Mensual fijo"
      }
      // Residuo del workflow de Zoho: Valor_por_usuario_Global con tarifa de
      // LISTA en UF (0,081/0,1275…). Bajo la convención Mensual fijo ese
      // campo no aplica — se vacía para que no aparezcan "valores extraños"
      // en los reportes (Lalo 20-ago).
      if (recurrenteNeto > 0 && Number(deal.Valor_por_usuario_Global || 0) !== 0) {
        cambios.Valor_por_usuario_Global = null
      }
      if (usuariosCot > 0 && Number(deal.N_Empleados_que_marcan || 0) !== usuariosCot) {
        cambios.N_Empleados_que_marcan = usuariosCot
      }
      // Moneda del trato → CLP (Lalo 20-ago) — SOLO deals de Chile; CO/MX/PE
      // conservan la suya.
      const telDeal = (p.contact || "").replace(/\D/g, "")
      if (telDeal.startsWith("56") && String(deal.Currency || "") !== "CLP") {
        cambios.Currency = "CLP"
      }
      // Y el campo VISIBLE "Moneda del trato" (custom Monda_del_trato — el que
      // sale en las vistas de Zoho; Lalo 20-ago "la moneda del trato sigue
      // diciendo UF"). CL → CLP; UF de cualquier origen también cae acá.
      const monedaTrato = String(deal.Monda_del_trato || "")
      if ((telDeal.startsWith("56") || monedaTrato === "UF") && monedaTrato !== "CLP") {
        cambios.Monda_del_trato = "CLP"
      }
      if (Object.keys(cambios).length) {
        const up = await fetch(`${ZOHO_API}/crm/v3/Deals/${dealId}`, {
          method: "PUT",
          headers: H,
          cache: "no-store",
          // trigger:[] OBLIGATORIO: sin él, el workflow "DEPRECADO. UPDATE
          // MONEDA Y V. POR USUARIO A" se dispara con NUESTRA edición y
          // re-estampa Moneda=UF + valor por usuario (caso SUPERMERCADO SUR).
          body: JSON.stringify({ data: [{ id: dealId, ...cambios }], trigger: [], skip_feature_execution: [{ name: "assignment_rules" }] }),
        })
        const cuerpo = (await up.json().catch(() => ({}))) as { data?: Array<{ code?: string; message?: string }> }
        if (up.ok && cuerpo?.data?.[0]?.code === "SUCCESS") res.amount_actualizado++
        else res.errores.push(`montos ${dealId}: ${cuerpo?.data?.[0]?.code || up.status} ${String(cuerpo?.data?.[0]?.message || "").slice(0, 60)}`)
      }

      // 4b. Dueño cotización = dueño deal (solo si el deal tiene HUMANO y la
      // cotización quedó con el robot).
      const dealOwnerId = String(deal.Owner?.id || "")
      const quoteOwnerId = String((quote.Owner as { id?: string } | null)?.id || "")
      if (dealOwnerId && !ROBOT_OWNER_IDS.has(dealOwnerId) && ROBOT_OWNER_IDS.has(quoteOwnerId)) {
        const uo = await fetch(`${ZOHO_API}/crm/v3/Cotizaciones_GeoVictoria/${p.quote_id}`, {
          method: "PUT",
          headers: H,
          cache: "no-store",
          body: JSON.stringify({ data: [{ id: p.quote_id, Owner: { id: dealOwnerId } }], trigger: [], skip_feature_execution: [{ name: "assignment_rules" }] }),
        })
        if (uo.ok) res.owner_cotizacion_alineado++
        else res.errores.push(`owner ${p.quote_id}: HTTP ${uo.status}`)
      }

      // 4c. Piso de stage para PAGADAS (pago ⇒ mínimo "6. Listo para Cierre").
      const estado = String(quote.Estado_Cotizacion || "").toLowerCase()
      const pagada = estado.includes("pagad") || Boolean(String(quote.Onboarding_Link || "").trim())
      if (pagada) {
        // NORMALIZACIÓN DE ESTADO (Lalo 20-ago, "mi filtro solo pesca 6"):
        // los pagos MP dejaban la cotización en "Aceptada"+link y el estado
        // mentía en los filtros del CRM. Toda pagada real queda "Pagada";
        // trigger:[] para no despertar workflows de Zoho.
        if (!String(quote.Estado_Cotizacion || "").toLowerCase().includes("pagad")) {
          await fetch(`${ZOHO_API}/crm/v3/Cotizaciones_GeoVictoria/${p.quote_id}`, {
            method: "PUT",
            headers: H,
            cache: "no-store",
            body: JSON.stringify({ data: [{ id: p.quote_id, Estado_Cotizacion: "Pagada" }], trigger: [], skip_feature_execution: [{ name: "assignment_rules" }] }),
          }).catch(() => undefined)
        }
        // Atribución congelada al pago (ventas futuras): si el deal no la
        // tiene, se calcula y estampa aquí mismo.
        try {
          const ra = await fetch(`${ZOHO_API}/crm/v3/Deals/${dealId}?fields=Gesti_n_Vicky,Created_By`, { headers: H, cache: "no-store" })
          const da = ((await ra.json().catch(() => ({}))) as { data?: Array<{ Gesti_n_Vicky?: string | null; Created_By?: { id?: string } }> })?.data?.[0]
          const atr = String(da?.Gesti_n_Vicky || "")
          const dealDeHumano = Boolean(da?.Created_By?.id) && !ROBOT_OWNER_IDS.has(String(da?.Created_By?.id))
          const telPago = (p as unknown as { contact?: string }).contact || ""
          const pagoMs = Date.parse(String(quote.Fecha_Hora_Cotizacion || quote.Modified_Time || ""))
          // CORRECCIÓN de estampas pre-20-ago-PM: pagadas del canal ejecutivo
          // marcadas "Gestión Vicky" sin conversación real → "No habló con
          // Vicky" (única sobre-escritura permitida en pagadas).
          if (atr === "Gestión Vicky" && telPago) {
            const conv = await supa<{ id: string }>(`vic_v3_conversations?contact=eq.${telPago.replace(/\D/g, "")}&select=id&limit=1`)
            if (!conv[0]) {
              await fetch(`${ZOHO_API}/crm/v3/Deals/${dealId}`, {
                method: "PUT",
                headers: H,
                cache: "no-store",
                body: JSON.stringify({ data: [{ id: dealId, Gesti_n_Vicky: "No habló con Vicky" }], trigger: [], skip_feature_execution: [{ name: "assignment_rules" }] }),
              }).catch(() => undefined)
            }
          }
          // Deal creado por humano: la única estampa automática es "No habló
          // con Vicky" (sin conversación); con conversación queda vacío hasta
          // que Lalo defina esa categoría.
          if (!atr && dealDeHumano && telPago) {
            const conv = await supa<{ id: string }>(`vic_v3_conversations?contact=eq.${telPago.replace(/\D/g, "")}&select=id&limit=1`)
            if (!conv[0]) {
              await fetch(`${ZOHO_API}/crm/v3/Deals/${dealId}`, {
                method: "PUT",
                headers: H,
                cache: "no-store",
                body: JSON.stringify({ data: [{ id: dealId, Gesti_n_Vicky: "No habló con Vicky" }], trigger: [], skip_feature_execution: [{ name: "assignment_rules" }] }),
              }).catch(() => undefined)
            }
          }
          if (!atr && !dealDeHumano && telPago && Number.isFinite(pagoMs)) {
            const veredicto = await veredictoGestion(telPago.replace(/\D/g, ""), pagoMs, dealId, H)
            await fetch(`${ZOHO_API}/crm/v3/Deals/${dealId}`, {
              method: "PUT",
              headers: H,
              cache: "no-store",
              body: JSON.stringify({ data: [{ id: dealId, Gesti_n_Vicky: veredicto }], trigger: [], skip_feature_execution: [{ name: "assignment_rules" }] }),
            }).catch(() => undefined)
          }
        } catch { /* best-effort */ }
        const stage = String(deal.Stage || "").toLowerCase()
        if (stage.includes("perdido") || stage.includes("congelado")) {
          res.pagadas_en_perdido.push(`${quote.Numero_Cotizacion || p.quote_id} → deal ${dealId} (${deal.Stage})`)
        } else {
          // Fecha real del pago (registro venta_dash) para la variante que
          // exige Fecha_de_Primera_Factura; fallback: aceptación.
          const vkv = await supa<{ value: string }>(`vic_kv?key=eq.venta_dash_v3_${p.quote_id}&select=value&limit=1`)
          let fechaPago = ""
          try { fechaPago = String((JSON.parse(vkv[0]?.value || "{}") as { pagoIso?: string }).pagoIso || "") } catch { /* sin registro */ }
          if (!fechaPago) fechaPago = String(quote.Fecha_Hora_Cotizacion || "")
          const t = await transicionarDealHacia(dealId, "listo para cierre", { fechaPrimeraFactura: fechaPago })
          if (t.resultado === "avanzado") res.stage_subido++
          else if (t.resultado === "error") res.errores.push(`stage ${dealId}: ${t.detalle || t.resultado}`)
        }
      } else {
        // 4d. GESTIÓN VICKY también SIN pago (Lalo 20-ago, "aún hay muchos
        // deals con gestión Vicky vacío"): veredicto "hasta ahora" (reloj =
        // este momento), recalculado en cada pasada; el PAGO lo congela (la
        // rama pagada solo estampa cuando está vacío y nunca re-escribe).
        // Deals creados por humanos no se estampan (regla del 20-ago).
        try {
          const dealDeHumano = Boolean(deal.Created_By?.id) && !ROBOT_OWNER_IDS.has(String(deal.Created_By?.id))
          if (dealDeHumano && telDeal && !String(deal.Gesti_n_Vicky || "")) {
            // Humano + sin conversación de Vicky → "No habló con Vicky";
            // humano CON conversación queda vacío (categoría por definir).
            const conv = await supa<{ id: string }>(`vic_v3_conversations?contact=eq.${telDeal}&select=id&limit=1`)
            if (!conv[0]) {
              await fetch(`${ZOHO_API}/crm/v3/Deals/${dealId}`, {
                method: "PUT",
                headers: H,
                cache: "no-store",
                body: JSON.stringify({ data: [{ id: dealId, Gesti_n_Vicky: "No habló con Vicky" }], trigger: [], skip_feature_execution: [{ name: "assignment_rules" }] }),
              }).catch(() => undefined)
            }
          }
          if (!dealDeHumano && telDeal) {
            const veredicto = await veredictoGestion(telDeal, Date.now(), dealId, H)
            if (veredicto !== String(deal.Gesti_n_Vicky || "")) {
              await fetch(`${ZOHO_API}/crm/v3/Deals/${dealId}`, {
                method: "PUT",
                headers: H,
                cache: "no-store",
                body: JSON.stringify({ data: [{ id: dealId, Gesti_n_Vicky: veredicto }], trigger: [], skip_feature_execution: [{ name: "assignment_rules" }] }),
              }).catch(() => undefined)
            }
          }
        } catch { /* best-effort */ }
      }
    } catch (e) {
      res.errores.push(`${p.quote_id}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  res.errores = res.errores.slice(0, 15)
  console.log(`[deal-limpieza] ${JSON.stringify({ ...res, pagadas_en_perdido: res.pagadas_en_perdido.length })}`)
  return NextResponse.json({ ok: true, ...res, punteros_totales: punteros.length, deals_unicos: dealVisto.size })
}
