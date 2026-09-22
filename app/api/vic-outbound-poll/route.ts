/**
 * OUTBOUND — Poller de leads asignados a Vicky (POST /api/vic-outbound-poll)
 *
 * La tómbola de Zoho (assignment rule "DATA - LEAD - GLOBAL - SW/LP", entrada 1)
 * asigna leads de formulario a Vicky en round-robin junto a las SDR. El problema:
 * la asignación ocurre como ACCIÓN de un workflow de creación, y Zoho NO permite
 * que las acciones de un workflow gatillen otros workflows (anti-loop) — o sea
 * el patrón "workflow de edición: owner = Vicky → webhook" no es confiable.
 *
 * Este poller elimina esa dependencia: lo invoca pg_cron cada 2 minutos, busca
 * en Zoho los leads RECIENTES con owner Vicky que siguen "1. No contactado" y
 * sin marca de omisión, y por cada uno dispara /api/vic-outbound-lead (mismo
 * contrato que usaría el webhook). Ese endpoint ya trae todas las protecciones:
 * dedup por conversación, ruteo multi-país (CL/CO/MX), exclusión de internos, reasignación a SDR
 * si el envío falla, y actualización del Lead_Status a "2. Intento de contacto".
 *
 * Para no re-procesar leads que el endpoint omitió (dedup/interno/no +56), el
 * poller deja la razón en el campo Comentario_Vicky del lead y filtra por
 * Comentario_Vicky vacío en la siguiente pasada.
 *
 * Auth: x-cron-secret == vic_kv.followup_cron_secret (se reenvía tal cual al
 * endpoint de outbound).
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"
import { getZohoAccessToken } from "@/lib/zoho-token"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const ZOHO_API_DOMAIN = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
const VICKY_OWNER_ID = (process.env.VICKY_ZOHO_CREATOR_ID || "3525045000484500876").trim()
// URL propia para invocar vic-outbound-lead (mismo deployment).
const SELF_BASE = (
  process.env.OUTBOUND_SELF_URL ||
  "https://geovictoria-whatsapp-agent-git-vicky-v3-geo-victoria.vercel.app"
).trim().replace(/\/+$/, "")
// Ventana de búsqueda: leads creados en las últimas N horas (default 48).
const LOOKBACK_H = Number(process.env.OUTBOUND_POLL_LOOKBACK_HOURS || 48)
const BATCH = 10

type ZLead = {
  id: string
  First_Name?: string | null
  Last_Name?: string | null
  Company?: string | null
  Email?: string | null
  Phone?: string | null
  Rango_de_Empleados?: string | null
  Country?: string | null
  Territorio?: string | null
}

export async function POST(req: Request): Promise<Response> {
  const provided = (req.headers.get("x-cron-secret") || "").trim()
  const expected = await getFollowupCronSecret().catch(() => "")
  if (!expected || provided !== expected) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }

  const token = await getZohoAccessToken().catch(() => "")
  if (!token) {
    return NextResponse.json({ ok: false, error: "sin token Zoho" }, { status: 503 })
  }

  // Leads recientes de Vicky aún no contactados ni marcados como omitidos.
  const desde = new Date(Date.now() - LOOKBACK_H * 3600e3).toISOString().replace(/\.\d{3}Z$/, "-00:00")
  const query =
    `select id, First_Name, Last_Name, Company, Email, Phone, Rango_de_Empleados, Country, Territorio from Leads ` +
    `where (((Owner = ${VICKY_OWNER_ID} and Created_Time >= '${desde}') ` +
    `and Lead_Status = '1. No contactado') and Comentario_Vicky is null) ` +
    `order by Created_Time asc limit ${BATCH}`
  const coqlRes = await fetch(`${ZOHO_API_DOMAIN}/crm/v3/coql`, {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ select_query: query }),
    cache: "no-store",
  })
  // Zoho responde 204 sin body cuando no hay filas.
  if (coqlRes.status === 204) {
    return NextResponse.json({ ok: true, pendientes: 0, contactados: 0, omitidos: 0 })
  }
  if (!coqlRes.ok) {
    const detail = await coqlRes.text().catch(() => "")
    return NextResponse.json({ ok: false, error: `COQL ${coqlRes.status}: ${detail.slice(0, 200)}` }, { status: 502 })
  }
  const leads = ((await coqlRes.json().catch(() => null))?.data || []) as ZLead[]

  let contactados = 0
  let omitidos = 0
  const detalle: Array<Record<string, unknown>> = []
  for (const lead of leads) {
    const r = await fetch(`${SELF_BASE}/api/vic-outbound-lead`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-cron-secret": provided },
      body: JSON.stringify({
        nombre: (lead.First_Name || "").trim(),
        apellido: (lead.Last_Name || "").trim(),
        empresa: (lead.Company || "").trim(),
        telefono: (lead.Phone || "").trim(),
        email: (lead.Email || "").trim(),
        empleadosRango: (lead.Rango_de_Empleados || "").trim(),
        // País del lead (tómbola MX, 27-jul): sin esto, un teléfono mexicano
        // en formato local (10 dígitos, sin +52) no se puede normalizar a
        // 521... y el lead rebota a un SDR humano en vez de recibir su toque
        // 0. El endpoint prioriza Country y usa el prefijo como verdad final.
        country: ((lead.Country || lead.Territorio || "") as string).trim(),
        zohoLeadId: lead.id,
      }),
      cache: "no-store",
    })
    const data = (await r.json().catch(() => ({}))) as { ok?: boolean; skipped?: string; cadencia?: string }
    detalle.push({ leadId: lead.id, ...data })
    if (data.ok && data.cadencia === "iniciada") {
      contactados++ // el endpoint ya actualizó el Lead_Status en Zoho
      console.log(`[outbound-poll] contactado lead=${lead.id}`)
      continue
    }
    if (data.skipped) {
      // Marcar el lead para no re-procesarlo en cada tick (dedup/interno/no +56).
      omitidos++
      await fetch(`${ZOHO_API_DOMAIN}/crm/v2/Leads/${lead.id}`, {
        method: "PUT",
        headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ data: [{ Comentario_Vicky: `Outbound omitido: ${data.skipped}` }] }),
        cache: "no-store",
      }).catch(() => {})
      console.warn(`[outbound-poll] omitido lead=${lead.id}: ${data.skipped}`)
    }
    // ok:false (fallo de envío): el endpoint ya reasignó el lead a una SDR
    // inbound — sale del filtro de owner en la próxima pasada. No marcar.
  }

  return NextResponse.json({ ok: true, pendientes: leads.length, contactados, omitidos, detalle })
}
