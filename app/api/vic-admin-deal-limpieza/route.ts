/**
 * LIMPIEZA DE DEALS DE VICKY (Lalo 20-ago, "actualicemos toodo lo de Vicky")
 * — deja el CRM apto para forecast/pipeline/facturación:
 *
 *   1. MONTOS según convención de MARKETING (David García 20-ago, vía Lalo):
 *      Tipo_de_Cobro = "Mensual fijo" · Valor_fijo_del_trato_Global =
 *      recurrente mensual REAL (subform con descuento, NETO sin IVA) ÷ 1000
 *      (regla Lalo: 1.000 CLP = 1 USD "Global") · N_Empleados_que_marcan =
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

type Puntero = { quote_id: string; deal_id: string | null; created_at: string }

/** Veredicto de atribución CONGELADO al momento del pago (Lalo 20-ago,
 * afinado): lo ÚNICO que importa es si el PAGO fue antes o después de
 * traspasar al ejecutivo — un traspaso POSTERIOR al pago es gestión
 * interna y da lo mismo. Traspaso antes del pago → Asistida; todo lo
 * demás (sin traspaso, o traspaso posterior) → 100% Autónoma. */
async function veredictoAtribucion(tel: string, pagoMs: number): Promise<string> {
  const filas = await supa<{ traspasado_at: string }>(
    `vic_ptv?contact=eq.${tel}&select=traspasado_at&order=traspasado_at.asc&limit=1`,
  )
  const primerMs = filas[0] ? Date.parse(String(filas[0].traspasado_at)) : NaN
  return Number.isFinite(primerMs) && primerMs <= pagoMs ? "Asistida" : "100% Autónoma"
}

export async function GET(req: Request): Promise<Response> {
  if (!(await authorized(req))) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  const { searchParams } = new URL(req.url)
  const limit = Math.min(Math.max(parseInt(searchParams.get("limit") || "20", 10) || 20, 1), 60)
  const force = searchParams.get("force") === "1"

  const token = await getZohoAccessToken()
  const H = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }

  // ── MODO ATRIBUCIÓN (?atribucion=1): recorre las VENTAS PAGADAS del
  // registro venta_dash y estampa Atribucion_Venta en su deal si está vacío.
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
        const rd = await fetch(`${ZOHO_API}/crm/v3/Deals/${dealId}?fields=Atribucion_Venta,Created_By`, { headers: H, cache: "no-store" })
        if (rd.status !== 200) continue
        const dd = ((await rd.json().catch(() => ({}))) as { data?: Array<{ Atribucion_Venta?: string | null; Created_By?: { id?: string } }> })?.data?.[0]
        // Deal creado por un HUMANO = venta del canal ejecutivo (caso MATER):
        // la atribución Vicky no aplica.
        if (dd?.Created_By?.id && !ROBOT_OWNER_IDS.has(String(dd.Created_By.id))) { out.sin_deal++; continue }
        const actual = String(dd?.Atribucion_Venta || "")
        if (actual) { out.ya_tenian++; continue }
        const veredicto = await veredictoAtribucion(tel, pagoMs)
        const up = await fetch(`${ZOHO_API}/crm/v3/Deals/${dealId}`, {
          method: "PUT",
          headers: H,
          cache: "no-store",
          body: JSON.stringify({ data: [{ id: dealId, Atribucion_Venta: veredicto }], skip_feature_execution: [{ name: "assignment_rules" }] }),
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

  for (const p of punteros) {
    if (res.procesados >= limit) break
    try {
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
      if (!p.deal_id && dealAsociado) {
        await supa(`vic_v3_quote_pointers?quote_id=eq.${p.quote_id}`, {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ deal_id: dealAsociado }),
        }).catch(() => [])
        res.punteros_backfilleados++
      }

      // Candado semanal por deal.
      if (!force) {
        const kvKey = `dlz_${dealId}`
        const vivo = await supa<{ key: string; expires_at?: string }>(
          `vic_kv?key=eq.${kvKey}&select=key,expires_at&limit=1`,
        )
        if (vivo[0] && (!vivo[0].expires_at || new Date(vivo[0].expires_at).getTime() > Date.now())) continue
      }
      res.procesados++
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
      const recurrenteNeto = Math.round(
        items.filter((i) => i.Es_Recurrente).reduce((a, i) => a + (Number(i.Subtotal_CLP) || 0), 0) * (1 - pct / 100),
      )

      // 3. Deal actual.
      const rd = await fetch(`${ZOHO_API}/crm/v3/Deals/${dealId}?fields=Stage,Owner,Tipo_de_Cobro,Valor_fijo_del_trato_Global,N_Empleados_que_marcan`, { headers: H, cache: "no-store" })
      if (rd.status !== 200) continue
      const deal = ((await rd.json().catch(() => ({}))) as {
        data?: Array<{
          Stage?: string
          Owner?: { id?: string; email?: string }
          Tipo_de_Cobro?: string | null
          Valor_fijo_del_trato_Global?: number | null
          N_Empleados_que_marcan?: number | null
        }>
      })?.data?.[0]
      if (!deal) continue

      // 4a. Convención de MARKETING (David 20-ago): Mensual fijo + recurrente
      // real ÷1000 en Valor_fijo + usuarios de la cotización (Por usuario).
      const valorFijoUsd = Math.round((recurrenteNeto / 1000) * 100) / 100
      const asistencia = items.find((i) => (i.Codigo_Item || "") === "asistencia")
      const modalidadPorUsuario = String(asistencia?.Modalidad || "").toLowerCase().includes("usuario")
      const usuariosCot = modalidadPorUsuario ? Number(asistencia?.Cantidad) || 0 : 0
      const cambios: Record<string, unknown> = {}
      if (recurrenteNeto > 0 && Math.abs(Number(deal.Valor_fijo_del_trato_Global || 0) - valorFijoUsd) > 0.011) {
        cambios.Valor_fijo_del_trato_Global = valorFijoUsd
      }
      if (recurrenteNeto > 0 && String(deal.Tipo_de_Cobro || "") !== "Mensual fijo") {
        cambios.Tipo_de_Cobro = "Mensual fijo"
      }
      if (usuariosCot > 0 && Number(deal.N_Empleados_que_marcan || 0) !== usuariosCot) {
        cambios.N_Empleados_que_marcan = usuariosCot
      }
      if (Object.keys(cambios).length) {
        const up = await fetch(`${ZOHO_API}/crm/v3/Deals/${dealId}`, {
          method: "PUT",
          headers: H,
          cache: "no-store",
          body: JSON.stringify({ data: [{ id: dealId, ...cambios }], skip_feature_execution: [{ name: "assignment_rules" }] }),
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
          body: JSON.stringify({ data: [{ id: p.quote_id, Owner: { id: dealOwnerId } }], skip_feature_execution: [{ name: "assignment_rules" }] }),
        })
        if (uo.ok) res.owner_cotizacion_alineado++
        else res.errores.push(`owner ${p.quote_id}: HTTP ${uo.status}`)
      }

      // 4c. Piso de stage para PAGADAS (pago ⇒ mínimo "6. Listo para Cierre").
      const estado = String(quote.Estado_Cotizacion || "").toLowerCase()
      const pagada = estado.includes("pagad") || Boolean(String(quote.Onboarding_Link || "").trim())
      if (pagada) {
        // Atribución congelada al pago (ventas futuras): si el deal no la
        // tiene, se calcula y estampa aquí mismo.
        try {
          const ra = await fetch(`${ZOHO_API}/crm/v3/Deals/${dealId}?fields=Atribucion_Venta,Created_By`, { headers: H, cache: "no-store" })
          const da = ((await ra.json().catch(() => ({}))) as { data?: Array<{ Atribucion_Venta?: string | null; Created_By?: { id?: string } }> })?.data?.[0]
          const atr = String(da?.Atribucion_Venta || "")
          const dealDeHumano = Boolean(da?.Created_By?.id) && !ROBOT_OWNER_IDS.has(String(da?.Created_By?.id))
          const telPago = (p as unknown as { contact?: string }).contact || ""
          const pagoMs = Date.parse(String(quote.Fecha_Hora_Cotizacion || quote.Modified_Time || ""))
          if (!atr && !dealDeHumano && telPago && Number.isFinite(pagoMs)) {
            const veredicto = await veredictoAtribucion(telPago.replace(/\D/g, ""), pagoMs)
            await fetch(`${ZOHO_API}/crm/v3/Deals/${dealId}`, {
              method: "PUT",
              headers: H,
              cache: "no-store",
              body: JSON.stringify({ data: [{ id: dealId, Atribucion_Venta: veredicto }], skip_feature_execution: [{ name: "assignment_rules" }] }),
            }).catch(() => undefined)
          }
        } catch { /* best-effort */ }
        const stage = String(deal.Stage || "").toLowerCase()
        if (stage.includes("perdido") || stage.includes("congelado")) {
          res.pagadas_en_perdido.push(`${quote.Numero_Cotizacion || p.quote_id} → deal ${dealId} (${deal.Stage})`)
        } else {
          const t = await transicionarDealHacia(dealId, "listo para cierre")
          if (t.resultado === "avanzado") res.stage_subido++
          else if (t.resultado === "error") res.errores.push(`stage ${dealId}: ${t.detalle || t.resultado}`)
        }
      }
    } catch (e) {
      res.errores.push(`${p.quote_id}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  res.errores = res.errores.slice(0, 15)
  console.log(`[deal-limpieza] ${JSON.stringify({ ...res, pagadas_en_perdido: res.pagadas_en_perdido.length })}`)
  return NextResponse.json({ ok: true, ...res, punteros_totales: punteros.length, deals_unicos: dealVisto.size })
}
