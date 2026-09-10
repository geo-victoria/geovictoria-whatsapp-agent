/**
 * ADMIN — pasar UN deal por la "Tómbola Deals 2026 Chile" a mano.
 *
 * Nace el 10-sep con la orden de Lalo "pasa a los ejecutivos OMEGA y TRAMUS":
 * dos casos que Vicky YA había calificado y cotizado (COT832 del 24-ago y
 * COT1084 del 01-sep) y que el 02-sep quedaron a nombre de una SDR porque el
 * traspaso de la conversación se la había presentado al cliente. La
 * conciliación automática no los toca —y no debe— porque su dueño lo puso una
 * persona (veredicto de lib/owner-manual), así que la re-entrega necesita una
 * puerta explícita.
 *
 * Hace lo mismo que la entrega del PTV: PUT con `lar_id` (la regla de Zoho es
 * la que sortea, nunca nosotros), relee el Owner porque la regla corre
 * ASÍNCRONA, avisa al ejecutivo nuevo, actualiza la fila vic_ptv del contacto
 * y deja nota. NO le escribe al cliente: la presentación queda pendiente
 * (`presentado_al_prospecto=false`) para que salga por el camino normal si
 * Lalo enciende `ptv_reintento_presentacion`.
 *
 * POST {dealId, motivo?}  ·  auth de cron
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret, getKvValue, setKvValue } from "@/lib/supabase-persistence-v3"
import { getZohoAccessToken } from "@/lib/zoho-token"
import { esSdrCalificacionCL } from "@/lib/sdr-calificacion"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const REGLA_CL = (process.env.VICKY_PTV_TOMBOLA_DEALS_CL || "3525045000595568541").trim()

async function autorizado(req: Request): Promise<boolean> {
  const secreto = await getFollowupCronSecret().catch(() => "")
  const cron = (process.env.CRON_SECRET || "").trim()
  const auth = req.headers.get("authorization") || ""
  const url = new URL(req.url)
  const entregado =
    req.headers.get("x-cron-secret") || (auth.startsWith("Bearer ") ? auth.slice(7) : "") || url.searchParams.get("key") || ""
  return Boolean(entregado) && (entregado === secreto || (Boolean(cron) && entregado === cron))
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  const body = (await req.json().catch(() => ({}))) as { dealId?: string; motivo?: string }
  const dealId = String(body.dealId || "").trim()
  if (!/^\d{10,}$/.test(dealId)) return NextResponse.json({ ok: false, error: "falta dealId" }, { status: 400 })
  if (!REGLA_CL) return NextResponse.json({ ok: false, error: "sin regla de tómbola" }, { status: 503 })

  const token = await getZohoAccessToken().catch(() => "")
  if (!token) return NextResponse.json({ ok: false, error: "sin token zoho" }, { status: 502 })
  const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
  const H = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }

  const leer = async () => {
    const r = await fetch(`${api}/crm/v3/Deals/${dealId}?fields=Deal_Name,Owner,Stage,Contact_Name,N_Empleados_que_marcan`, { headers: H, cache: "no-store" })
    if (r.status !== 200) return null
    return (((await r.json().catch(() => ({}))) as {
      data?: Array<{ Deal_Name?: string; Stage?: string; N_Empleados_que_marcan?: number; Owner?: { id?: string; name?: string; email?: string }; Contact_Name?: { id?: string } | null }>
    }).data || [])[0] || null
  }
  const antes = await leer()
  if (!antes) return NextResponse.json({ ok: false, error: "deal no encontrado" }, { status: 404 })

  const put = await fetch(`${api}/crm/v3/Deals`, {
    method: "PUT", headers: H, cache: "no-store",
    body: JSON.stringify({ data: [{ id: dealId }], lar_id: REGLA_CL }),
  })
  if (!put.ok) return NextResponse.json({ ok: false, error: `put ${put.status}` }, { status: 502 })
  // La regla corre ASÍNCRONA: se relee con un par de intentos.
  let despues = await leer()
  for (let i = 0; i < 3 && despues?.Owner?.id === antes.Owner?.id; i++) {
    await new Promise((r) => setTimeout(r, 3000))
    despues = await leer()
  }
  const ownerNuevo = despues?.Owner || null
  const cambio = Boolean(ownerNuevo?.id && ownerNuevo.id !== antes.Owner?.id)
  const sigueEnSdr = esSdrCalificacionCL({ ownerId: ownerNuevo?.id, ownerEmail: ownerNuevo?.email })

  if (cambio && !sigueEnSdr) {
    const { notificarTraspasoDeal } = await import("@/lib/crm-hitos")
    await notificarTraspasoDeal(dealId).catch(() => {})
    // Fila vic_ptv del contacto al dueño nuevo, con la presentación PENDIENTE.
    if (SUPABASE_URL && SUPABASE_KEY && antes.Contact_Name?.id) {
      const h = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" }
      const rc = await fetch(`${api}/crm/v3/Contacts/${antes.Contact_Name.id}?fields=Phone,Mobile`, { headers: H, cache: "no-store" }).catch(() => null)
      const c = rc?.status === 200 ? (((await rc.json().catch(() => ({}))) as { data?: Array<{ Phone?: string; Mobile?: string }> }).data || [])[0] : null
      const tel = String(c?.Mobile || c?.Phone || "").replace(/\D/g, "")
      if (tel) {
        await fetch(`${SUPABASE_URL}/rest/v1/vic_ptv?contact=eq.${tel}&estado=eq.activo`, {
          method: "PATCH", headers: h, cache: "no-store",
          body: JSON.stringify({
            vendedor_email: ownerNuevo?.email || "",
            vendedor_nombre: ownerNuevo?.name || "",
            vendedor_zoho_id: ownerNuevo?.id || "",
            presentado_al_prospecto: false,
          }),
        }).catch(() => null)
      }
    }
    await fetch(`${api}/crm/v3/Notes`, {
      method: "POST", headers: H, cache: "no-store",
      body: JSON.stringify({
        data: [{
          Note_Title: "Re-entrega a telemarketing (Tómbola Deals)",
          Note_Content:
            `${body.motivo || "Caso ya calificado por Vicky que estaba a nombre de una SDR de calificación."}\n` +
            `Dueño anterior: ${antes.Owner?.name || "?"} (${antes.Owner?.email || "?"}). Nuevo dueño por la regla "Tómbola Deals 2026 Chile": ${ownerNuevo?.name} (${ownerNuevo?.email}).\n` +
            `Etapa ${antes.Stage || "?"} · ${antes.N_Empleados_que_marcan || "?"} personas. Al cliente no se le avisó del cambio: la presentación queda pendiente.`,
          Parent_Id: { module: { api_name: "Deals" }, id: dealId },
        }],
      }),
    }).catch(() => null)
    await setKvValue(`sdr_recon_deal_${dealId}`, `tomboleado_manual:${new Date().toISOString()}`).catch(() => {})
  }

  return NextResponse.json({
    ok: true,
    dealId,
    deal: antes.Deal_Name || "",
    etapa: antes.Stage || "",
    duenoAntes: { nombre: antes.Owner?.name, email: antes.Owner?.email },
    duenoDespues: { nombre: ownerNuevo?.name, email: ownerNuevo?.email },
    cambio,
    sigueEnSdr,
    candadoPrevio: (await getKvValue(`sdr_recon_deal_${dealId}`).catch(() => null)) || "",
  })
}
