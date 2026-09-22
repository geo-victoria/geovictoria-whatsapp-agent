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
import { cerrarYTraspasarPostPago, type ResultadoTraspaso } from "@/lib/traspaso-postpago"
import { getKvValue } from "@/lib/supabase-persistence-v3"
import { enFaseOnboarding } from "@/lib/loop-v2"

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
    const raw = (await r.json().catch(() => ({}))) as {
      blueprint?: { transitions?: Array<{ id: string; name?: string; data?: Record<string, unknown> }> }
    }
    // &ejecutar=<needle>: ejecuta la transición que calce y devuelve la
    // respuesta CRUDA del PUT (diagnóstico de INVALID_DATA).
    const ejecutar = (new URL(req.url).searchParams.get("ejecutar") || "").trim().toLowerCase()
    if (ejecutar) {
      const t = (raw?.blueprint?.transitions || []).find((x) =>
        (x.name || "").toLowerCase().includes(ejecutar),
      )
      if (!t) return NextResponse.json({ ok: false, error: "transición no encontrada", raw })
      const put = await fetch(`${ZOHO_API_DOMAIN}/crm/v2/Deals/${debugDeal}/actions/blueprint`, {
        method: "PUT",
        headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ blueprint: [{ transition_id: t.id, data: t.data || {} }] }),
      })
      const putBody = await put.text().catch(() => "")
      return NextResponse.json({ ok: put.ok, putStatus: put.status, putBody: putBody.slice(0, 1500), enviado: t.data || {} })
    }
    return NextResponse.json({ ok: r.ok, status: r.status, raw })
  }

  // 1. Objetivo "Listo para Cierre": cotizaciones aceptadas/pagadas de Vicky
  // con deal (la regla: aceptada → 6. Listo para Cierre).
  const pagadas = await coql<{
    id?: string
    Name?: string
    Estado_Cotizacion?: string
    "Deal_Asociado.id"?: string
    Fecha_Hora_Cotizacion?: string
    Tel_fono_Contacto?: string
  }>(
    // ORDEN DESCENDENTE (11-sep). Sin `order by`, Zoho devuelve las más
    // ANTIGUAS primero y el `limit 200` corta por arriba: medido hoy, el
    // universo Aceptada+Pagada de Vicky está EXACTAMENTE en 200 (la consulta
    // sin orden llegaba hasta el 10-sep y `offset 200` ya no trae nada), o sea
    // el tope está lleno y la PRÓXIMA cotización aceptada se caía del barrido
    // en silencio. No fue la causa del caso METALMAQ (ese estaba dentro de las
    // 200 y se corrigió el 10-sep), pero iba a serlo desde mañana. Mirar
    // primero lo nuevo es lo correcto: lo viejo ya avanzó y la transición es
    // idempotente y forward-only. Si algún día importa barrer más atrás, hay
    // que paginar: el límite de una COQL es 200 por página.
    `select id, Name, Estado_Cotizacion, Deal_Asociado.id, Fecha_Hora_Cotizacion, Tel_fono_Contacto` +
      ` from ${QUOTE_MODULE} where Created_By = ${VICKY_CREATOR_ID}` +
      ` and Estado_Cotizacion in ('Aceptada', 'Pagada') order by Created_Time desc limit 200`,
  )

  // Red de seguridad del TRASPASO post-pago (caso COT233, 20-jul): si el
  // webhook del cotizador al agente no llegó (env faltante, caída, etc.), este
  // barrido cierra la cadencia + llamadas agendadas y envía el traspaso al
  // ejecutivo humano. Solo pagos RECIENTES (36h): el kv candado hace el envío
  // idempotente, y no tocamos conversaciones nuevas de clientes antiguos.
  const traspasos: Array<ResultadoTraspaso & { quoteId: string }> = []
  const hace36h = Date.now() - 36 * 60 * 60 * 1000
  for (const q of pagadas) {
    const nombre = String(q.Name || "").toLowerCase()
    const fecha = Date.parse(String(q.Fecha_Hora_Cotizacion || ""))
    if (!q.id || nombre.includes("prueba") || !Number.isFinite(fecha) || fecha < hace36h) continue
    // BUG 25-ago (caso Carolina/COT309): el barrido trataba 'Aceptada' como
    // pagada — herencia de cuando el estado 'Pagada' no existía (nació ayer,
    // cef2bc2, y SOLO lo escriben caminos con pago MP verificado). Una
    // aceptada SIN pagar recibía "tu pago quedó registrado" + wizard +
    // presentación. El traspaso post-pago exige el estado real.
    if (String(q.Estado_Cotizacion || "") !== "Pagada") continue
    const r = await cerrarYTraspasarPostPago(String(q.id))
    traspasos.push({ ...r, quoteId: String(q.id) })
    if (r.traspaso === "enviado") {
      console.log(`[deal-stage-cron] traspaso post-pago de respaldo enviado quote=${q.id} contact=${r.contact}`)
    }
  }

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
  // 2-bis. ALTA POR CHAT (10-sep, caso METALMAQ / reclamo Aleydis): las ventas
  // que Vicky da de alta por WhatsApp no pasan por Autoservicio_Onboarding —
  // su señal de "onboarding listo" es la cotización con Onboarding_Status
  // "Cerrada" (la estampa el job NDV/IMP al nacer la Implementación). Sin esto
  // el deal se quedaba en "4. Propuesta" con NDV e IMP ya creadas.
  const cerradasChat = await coql<{ id?: string; Name?: string; "Deal_Asociado.id"?: string }>(
    `select id, Name, Deal_Asociado.id from ${QUOTE_MODULE} where ((Created_By = ${VICKY_CREATOR_ID} and Onboarding_Status = 'Cerrada') and Estado_Cotizacion = 'Pagada') limit 200`,
  ).catch((e) => {
    console.warn("[deal-stage-cron] COQL cerradas por chat falló:", e instanceof Error ? e.message : e)
    return [] as Array<{ id?: string; Name?: string; "Deal_Asociado.id"?: string }>
  })
  for (const q of cerradasChat) {
    const dealId = String(q["Deal_Asociado.id"] || "")
    const nombre = String(q.Name || "").toLowerCase()
    if (dealId && !nombre.includes("prueba")) objetivos.set(dealId, "implementando")
  }

  // 2-ter. EL PAGO QUE INVOCA A VICKY ONBOARDING YA ES "IMPLEMENTANDO"
  // (Lalo 11-sep: "la cotización aceptada debería pasar el deal a listo para
  // cierre, el pago que invoca a vicky onboarding debería pasarlo a
  // implementando"). Hasta ahora el salto a 7 esperaba a `Onboarding_Status =
  // 'Cerrada'`, que el job estampa recién al NACER la Implementación: un
  // cliente que paga y no completa el formulario se quedaba en 6 para siempre.
  // La señal correcta es el propio pago cuando ESE contacto va por el alta por
  // chat (kv `onb_quote_` apuntando a la cotización, o su fase en onboarding).
  // Solo canal Vicky: el flujo de los ejecutivos no se toca.
  let implementandoPorPago = 0
  const pagadasVicky = pagadas.filter((q) => String(q.Estado_Cotizacion || "") === "Pagada")
  const TOPE_KV = 40
  let leidas = 0
  for (const q of pagadasVicky) {
    if (leidas >= TOPE_KV) break
    const dealId = String(q["Deal_Asociado.id"] || "")
    const nombre = String(q.Name || "").toLowerCase()
    const fono = String(q.Tel_fono_Contacto || "").replace(/\D/g, "")
    if (!dealId || nombre.includes("prueba") || !/^569\d{8}$/.test(fono)) continue
    if (objetivos.get(dealId) === "implementando") continue
    leidas++
    try {
      const ancla = (await getKvValue(`onb_quote_${fono}`)) || ""
      const esSuAlta = ancla.trim() === String(q.id || "")
      const enOnboarding = esSuAlta ? true : await enFaseOnboarding(fono).catch(() => false)
      if (esSuAlta || enOnboarding) {
        objetivos.set(dealId, "implementando")
        implementandoPorPago++
      }
    } catch { /* sin kv: se queda en "listo para cierre", como hoy */ }
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
  return NextResponse.json({
    ok: true,
    deals: objetivos.size,
    implementando_por_pago: implementandoPorPago,
    resumen,
    resultados,
    traspasos,
  })
}

export async function GET(req: Request): Promise<Response> {
  return handler(req)
}

export async function POST(req: Request): Promise<Response> {
  return handler(req)
}
