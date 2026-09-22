/**
 * ADMIN — dispara el aviso al ejecutivo de un lead ya asignado (29-ago).
 *
 * Nace de la auditoría del informe de Rodrigo: la regla de Zoho asigna el lead
 * al ejecutivo en silencio (el correo "Nuevo Lead Chile" sale al crearse, con
 * Vicky como dueña, y nada se dispara al reasignar). El código nuevo ya avisa
 * en los caminos de entrega; este endpoint cubre los casos VIEJOS que
 * quedaron mudos —y cualquier rescate manual futuro— sin tocar la base a mano.
 *
 * POST (auth cron) { leadId } → lee dueño/nombre/empresa/dotación del lead en
 * Zoho y le manda el aviso a su dueño actual. Idempotencia: candado kv
 * `notif_lead_<id>` (7 días) para no bombardear al ejecutivo si se repite la
 * llamada. `forzar: true` lo salta.
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret, getKvValue, setKvValue } from "@/lib/supabase-persistence-v3"
import { notificarLeadAsignado } from "@/lib/notificar-lead-asignado"
import { getZohoAccessToken } from "@/lib/zoho-token"

export const dynamic = "force-dynamic"
export const maxDuration = 30

async function autorizado(req: Request): Promise<boolean> {
  const secreto = await getFollowupCronSecret().catch(() => "")
  const cron = (process.env.CRON_SECRET || "").trim()
  const url = new URL(req.url)
  const auth = req.headers.get("authorization") || ""
  const entregado =
    req.headers.get("x-cron-secret") ||
    (auth.startsWith("Bearer ") ? auth.slice(7) : "") ||
    url.searchParams.get("key") ||
    ""
  return Boolean(entregado) && (entregado === secreto || (Boolean(cron) && entregado === cron))
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!(await autorizado(req))) {
    return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  }
  const body = (await req.json().catch(() => ({}))) as { leadId?: string; forzar?: boolean }
  const leadId = String(body.leadId || "").replace(/\D/g, "")
  if (!leadId) return NextResponse.json({ ok: false, error: "falta leadId" }, { status: 400 })

  // El candado frena SOLO el correo (no bombardear al ejecutivo si la llamada
  // se repite); el traspaso de tareas y llamadas corre igual — es idempotente
  // por naturaleza (una actividad que ya cambió de dueño deja de calificar).
  const candado = `notif_lead_${leadId}`
  const yaAvisado = !body.forzar && Boolean(await getKvValue(candado).catch(() => null))

  try {
    const token = await getZohoAccessToken()
    const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
    const r = await fetch(
      `${api}/crm/v3/Leads/${leadId}?fields=Owner,Full_Name,Company,Phone,N_Empleados_que_marcan`,
      { headers: { Authorization: `Zoho-oauthtoken ${token}` }, cache: "no-store" },
    )
    if (r.status !== 200) {
      return NextResponse.json({ ok: false, error: `lead no legible (${r.status})` }, { status: 404 })
    }
    const lead = ((await r.json().catch(() => ({}))) as {
      data?: Array<{
        Owner?: { email?: string; name?: string }
        Full_Name?: string
        Company?: string
        Phone?: string
        N_Empleados_que_marcan?: number
      }>
    }).data?.[0]
    const vendedorEmail = String(lead?.Owner?.email || "")
    if (!vendedorEmail || /vicky@|info@geovictoria/i.test(vendedorEmail)) {
      return NextResponse.json({
        ok: false,
        leadId,
        avisado: false,
        error: `el lead sigue con dueño robot (${vendedorEmail || "sin dueño"}) — asígnalo primero`,
      })
    }

    const avisado = yaAvisado
      ? false
      : await notificarLeadAsignado({
          leadId,
          vendedorEmail,
          contact: String(lead?.Phone || "").replace(/\D/g, ""),
          nombre: lead?.Full_Name,
          empresa: lead?.Company,
          empleados: Number(lead?.N_Empleados_que_marcan) || 0,
          pidioHumano: true,
        })
    if (avisado) await setKvValue(candado, new Date().toISOString()).catch(() => {})
    // Y sus PENDIENTES: la tarea y la llamada del workflow quedaron a nombre
    // del robot al nacer el lead; se las pasamos al dueño de ahora.
    const { reasignarPendientesDelLead } = await import("@/lib/reasignar-pendientes-lead")
    const pendientes = await reasignarPendientesDelLead(leadId, { ownerEmail: vendedorEmail })
    return NextResponse.json({
      ok: avisado || yaAvisado,
      leadId,
      avisado,
      ...(yaAvisado ? { motivo: "correo ya enviado antes; solo se revisaron los pendientes" } : {}),
      vendedor: vendedorEmail,
      cliente: [lead?.Full_Name, lead?.Company].filter(Boolean).join(" · "),
      pendientes: { tareas: pendientes.tareas, llamadas: pendientes.llamadas, error: pendientes.error },
    })
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "excepción" },
      { status: 500 },
    )
  }
}
