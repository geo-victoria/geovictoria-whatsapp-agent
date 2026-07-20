/**
 * Cron de etapas de DEALS (pedido Lalo 20-jul): mantiene el pipeline de Zoho
 * sincronizado con la realidad comercial de Vicky, vía blueprint:
 *
 *   1. Cotización PAGADA (Estado_Cotizacion = Aceptada) → su deal avanza a
 *      "6. Listo para Cierre".
 *   2. Auto-onboarding COMPLETADO (Autoservicio_Onboarding con
 *      Estado_del_Onboarding = Completado) → su deal avanza a "Implementando".
 *
 * Idempotente y forward-only (ver lib/zoho-deals): corre cada hora por Vercel
 * Cron; los deals ya avanzados, terminales o gestionados a mano no se tocan.
 * Cubre además el backfill histórico y los pagos por transferencia (que se
 * marcan Aceptada a mano) — no depende del webhook de pago.
 *
 * Auth: Vercel Cron manda Bearer CRON_SECRET; manual: x-cron-secret ==
 * vic_kv.followup_cron_secret o ?key=CRON_SECRET.
 */

import { NextResponse } from "next/server"
import { getZohoAccessToken } from "@/lib/zoho-token"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"
import { transicionarDealHacia, type ResultadoTransicion } from "@/lib/zoho-deals"

export const dynamic = "force-dynamic"
export const maxDuration = 120

const CRON_SECRET = (process.env.CRON_SECRET || "").trim()
const ZOHO_API_DOMAIN = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
const QUOTE_MODULE = (process.env.ZOHO_QUOTE_MODULE || "Cotizaciones_GeoVictoria").trim()
const VICKY_CREATOR_ID = "3525045000484500876"

async function authorized(req: Request): Promise<boolean> {
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim()
  if (CRON_SECRET && bearer === CRON_SECRET) return true
  const key = (new URL(req.url).searchParams.get("key") || "").trim()
  if (CRON_SECRET && key === CRON_SECRET) return true
  const xcron = (req.headers.get("x-cron-secret") || "").trim()
  if (xcron) {
    const expected = await getFollowupCronSecret().catch(() => "")
    if (expected && xcron === expected) return true
  }
  return false
}

async function coql<T>(query: string): Promise<T[]> {
  const token = await getZohoAccessToken()
  const res = await fetch(`${ZOHO_API_DOMAIN}/crm/v3/coql`, {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ select_query: query }),
    cache: "no-store",
  })
  if (!res.ok) return []
  const data = (await res.json().catch(() => ({}))) as { data?: T[] }
  return data?.data || []
}

async function handler(req: Request): Promise<Response> {
  if (!(await authorized(req))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }

  // Modo debug: volcar las transiciones crudas del blueprint de un deal, para
  // diagnosticar INVALID_DATA (campos obligatorios de la transición).
  const debugDeal = (new URL(req.url).searchParams.get("debugDeal") || "").trim()
  if (debugDeal) {
    const token = await getZohoAccessToken()
    const r = await fetch(`${ZOHO_API_DOMAIN}/crm/v2/Deals/${debugDeal}/actions/blueprint`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      cache: "no-store",
    })
    const raw = await r.json().catch(() => ({}))
    return NextResponse.json({ ok: r.ok, status: r.status, raw })
  }

  // 1. Objetivo "Listo para Cierre": cotizaciones pagadas de Vicky con deal.
  const pagadas = await coql<{
    id?: string
    Name?: string
    "Deal_Asociado.id"?: string
  }>(
    `select id, Name, Deal_Asociado.id from ${QUOTE_MODULE} where Created_By = ${VICKY_CREATOR_ID} and Estado_Cotizacion = 'Aceptada' limit 200`,
  )

  // 2. Objetivo "Implementando": onboardings completados con deal asociado.
  const completados = await coql<{
    id?: string
    Name?: string
    "Deal_asociado.id"?: string
    Estado_del_Onboarding?: string
  }>(
    `select id, Name, Deal_asociado.id, Estado_del_Onboarding from Autoservicio_Onboarding where Estado_del_Onboarding = 'Completado' and Created_By = 3525045000484500876 limit 200`,
  )

  // Consolidar: un deal con onboarding completo apunta a Implementando (gana
  // sobre Listo para Cierre). Se excluyen pruebas por nombre.
  const objetivos = new Map<string, "listo para cierre" | "implementando">()
  for (const q of pagadas) {
    const dealId = String(q["Deal_Asociado.id"] || "")
    const nombre = String(q.Name || "").toLowerCase()
    if (dealId && !nombre.includes("prueba")) objetivos.set(dealId, "listo para cierre")
  }
  for (const o of completados) {
    const dealId = String(o["Deal_asociado.id"] || "")
    const nombre = String(o.Name || "").toLowerCase()
    if (dealId && !nombre.includes("prueba")) objetivos.set(dealId, "implementando")
  }

  const resultados: ResultadoTransicion[] = []
  for (const [dealId, objetivo] of objetivos) {
    resultados.push(await transicionarDealHacia(dealId, objetivo))
  }

  const resumen = {
    avanzados: resultados.filter((r) => r.resultado === "avanzado").length,
    ya_estaban: resultados.filter((r) => r.resultado === "ya_estaba").length,
    sin_transicion: resultados.filter((r) => r.resultado === "sin_transicion").length,
    intocables: resultados.filter((r) => r.resultado === "intocable").length,
    errores: resultados.filter((r) => r.resultado === "error").length,
  }
  console.log(
    `[deal-stage-cron] deals=${objetivos.size} avanzados=${resumen.avanzados} errores=${resumen.errores}`,
  )
  return NextResponse.json({ ok: true, deals: objetivos.size, resumen, resultados })
}

export async function GET(req: Request): Promise<Response> {
  return handler(req)
}

export async function POST(req: Request): Promise<Response> {
  return handler(req)
}
