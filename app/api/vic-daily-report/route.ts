/**
 * Reporte diario de Vicky (V3) por WhatsApp.
 *
 * Reemplaza el reporte que vivía en el stack V2 (api/reengagement →
 * sendReporteDiario, que leía la tabla vic_evaluations hoy VACÍA porque V3 guarda
 * el análisis en vic_v3_conversation_analysis). Este endpoint lee los datos vivos
 * de V3 y manda el resumen del día anterior por la línea de Meta (Cloud API).
 *
 * Texto libre: llega si la ventana de 24h del destinatario está abierta (igual
 * que el reporte viejo). El resumen es dinámico, por eso no es plantilla.
 *
 * Datos: Supabase (vic_v3_conversation_analysis + vic_v3_conversations). Las
 * cotizaciones (enviadas/aceptadas) se agregan best-effort desde Zoho; si Zoho
 * falla, el reporte igual se envía con las métricas de conversación.
 *
 * Auth: x-cron-secret == vic_kv.followup_cron_secret, o Bearer/?key=CRON_SECRET.
 * Param opcional ?to=<fono> para overridear el destinatario (default
 * VICKY_REPORT_PHONE).
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"
import { getZohoAccessToken } from "@/lib/zoho-token"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const CRON_SECRET = (process.env.CRON_SECRET || "").trim()
const REPORT_PHONE = (process.env.VICKY_REPORT_PHONE || "56944668823").trim()
const QUOTE_MODULE = (process.env.ZOHO_QUOTE_MODULE || "Cotizaciones_GeoVictoria").trim()
const ZOHO_API_DOMAIN = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
// Vicky como creadora de cotizaciones en Zoho (para separar de ejecutivos).
const VICKY_CREATOR_ID = (process.env.VICKY_ZOHO_CREATOR_ID || "3525045000484500876").trim()

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

async function supaSelect(path: string): Promise<unknown[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    cache: "no-store",
  })
  if (!res.ok) return []
  return (await res.json().catch(() => [])) as unknown[]
}

// Ventana "ayer" en horario de Chile (UTC-4). Devuelve los límites en ISO UTC.
function ventanaAyerChile(): { desde: string; hasta: string; etiqueta: string } {
  const OFFSET_H = 4 // Chile estándar (UTC-4)
  const now = Date.now()
  // "Ahora" en hora local Chile.
  const localNow = new Date(now - OFFSET_H * 3600e3)
  // Medianoche local de HOY, luego retrocede un día para el inicio de AYER.
  const hoy0Local = Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate(), 0, 0, 0)
  const ayer0Local = hoy0Local - 86400e3
  // Reconvertir a UTC real sumando el offset.
  const desde = new Date(ayer0Local + OFFSET_H * 3600e3).toISOString()
  const hasta = new Date(hoy0Local + OFFSET_H * 3600e3).toISOString()
  const etiqueta = new Date(ayer0Local).toISOString().slice(0, 10)
  return { desde, hasta, etiqueta }
}

type Analisis = {
  contact: string
  grupo: string | null
  sub_bucket: string | null
  cotizacion_outcome: string | null
  motivo_no_cierre: string | null
}

// Cotizaciones de Vicky enviadas/aceptadas en la ventana (best-effort).
async function cotizacionesZoho(desde: string, hasta: string): Promise<{ enviadas: number; aceptadas: number } | null> {
  try {
    const token = await getZohoAccessToken()
    const q = async (extra: string): Promise<number> => {
      const select =
        `select count(id) from ${QUOTE_MODULE} ` +
        `where Created_By = ${VICKY_CREATOR_ID} and Modified_Time >= '${desde}' and Modified_Time < '${hasta}' ${extra}`
      const res = await fetch(`${ZOHO_API_DOMAIN}/crm/v3/coql`, {
        method: "POST",
        headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ select_query: select }),
        cache: "no-store",
      })
      if (!res.ok) return 0
      const data = await res.json().catch(() => null)
      return Number(data?.data?.[0]?.count || 0)
    }
    const aceptadas = await q("and Estado_Cotizacion = 'Aceptada'")
    const enviadas = await q("and Estado_Cotizacion = 'Enviada'")
    return { enviadas, aceptadas }
  } catch {
    return null
  }
}

function buildReporte(opts: {
  etiqueta: string
  rows: Analisis[]
  cot: { enviadas: number; aceptadas: number } | null
}): string {
  const { etiqueta, rows, cot } = opts
  const total = rows.length
  const preforms = rows.filter((r) => r.cotizacion_outcome === "preform_mostrado").length
  const cotEnviadasConv = rows.filter((r) => r.cotizacion_outcome === "cotizacion_enviada").length
  const leads = rows.filter((r) => r.sub_bucket === "lead").length
  const soporte = rows.filter((r) => r.grupo === "soporte" || r.sub_bucket === "soporte").length
  const sinCierre = rows.filter((r) => r.motivo_no_cierre)
  // Top motivos de no-cierre.
  const motivos = new Map<string, number>()
  for (const r of sinCierre) {
    const m = String(r.motivo_no_cierre)
    motivos.set(m, (motivos.get(m) || 0) + 1)
  }
  const topMotivos = [...motivos.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)

  const L: string[] = []
  L.push(`📊 Reporte Vicky — ${etiqueta}`)
  L.push("")
  L.push(`Conversaciones: ${total}`)
  L.push(`Preforms (vieron precio): ${preforms + cotEnviadasConv}`)
  if (cot) {
    L.push(`Cotizaciones enviadas (Zoho): ${cot.enviadas}`)
    L.push(`Cotizaciones aceptadas (Zoho): ${cot.aceptadas}`)
  } else {
    L.push(`Cotizaciones (Zoho): no disponible hoy`)
  }
  L.push(`Leads: ${leads} | Soporte: ${soporte}`)
  if (topMotivos.length) {
    L.push("")
    L.push("Motivos de no-cierre:")
    for (const [m, n] of topMotivos) L.push(`• ${m}: ${n}`)
  }
  return L.join("\n")
}

async function enviarCloud(to: string, text: string) {
  const accessToken = (process.env.WHATSAPP_ACCESS_TOKEN || "").trim()
  const phoneNumberId = (process.env.WHATSAPP_PHONE_NUMBER_ID || "").trim()
  if (!accessToken || !phoneNumberId) return { ok: false, error: "WhatsApp Cloud API no configurado" }
  const res = await fetch(`https://graph.facebook.com/v22.0/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text } }),
    cache: "no-store",
  })
  const response = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, response }
}

async function handle(req: Request): Promise<Response> {
  if (!(await authorized(req))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return NextResponse.json({ ok: false, error: "Supabase no configurado" }, { status: 503 })
  }
  const to = (new URL(req.url).searchParams.get("to") || REPORT_PHONE).replace(/\D/g, "")
  const { desde, hasta, etiqueta } = ventanaAyerChile()

  const rows = (await supaSelect(
    `vic_v3_conversation_analysis?last_message_at=gte.${desde}&last_message_at=lt.${hasta}` +
    `&select=contact,grupo,sub_bucket,cotizacion_outcome,motivo_no_cierre&limit=1000`,
  )) as Analisis[]

  const cot = await cotizacionesZoho(desde, hasta)
  const texto = buildReporte({ etiqueta, rows, cot })
  const envio = await enviarCloud(to, texto)

  return NextResponse.json({
    ok: envio.ok,
    ventana: { desde, hasta, etiqueta },
    conversaciones: rows.length,
    cotizaciones: cot,
    to,
    envio,
    preview: texto,
  }, { status: envio.ok ? 200 : 502 })
}

export async function GET(req: Request): Promise<Response> {
  return handle(req)
}
export async function POST(req: Request): Promise<Response> {
  return handle(req)
}
