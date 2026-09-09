/**
 * Endpoint ADMIN: POST /api/vic-admin-entregar-lead
 *
 * Entrega a mano un lead que quedó a nombre de Vicky (regla Lalo 09-sep:
 * "nada queda a nombre de Vicky mucho tiempo"). Ejecuta la MISMA regla de
 * asignación de Zoho que usa el traspaso automático, avisa por correo al
 * ejecutivo sorteado y deja nota en el lead. No escribe a WhatsApp.
 *
 * Body: { leadId: string, regla?: "tlmk" | "sdr", nota?: string }
 *  - tlmk (default): lead CALIFICADO → "Asignación Leads Vicky TLMK" (ejecutivos).
 *  - sdr: sin calificar → tómbola SDR (Aleydis / Aracelli).
 * Antes de entregar deja el status en "3. Contactado" si venía más abajo
 * (tope de entrega; jamás "4. Calificado" por API).
 * Auth: x-cron-secret == kv followup_cron_secret, o ?key=/Bearer == CRON_SECRET.
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"
import { getZohoAccessToken } from "@/lib/zoho-token"
import { reasignarLeadCalificacionCL, reasignarLeadTelemarketingCL, updateZohoLeadStatus, STATUS_ENTREGA_LEAD } from "@/lib/zoho-leads"
import { notificarLeadAsignado } from "@/lib/notificar-lead-asignado"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const CRON_SECRET = (process.env.CRON_SECRET || "").trim()
const ZOHO_API = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()

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

export async function POST(req: Request): Promise<Response> {
  if (!(await authorized(req))) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  const body = (await req.json().catch(() => ({}))) as { leadId?: string; regla?: string; nota?: string }
  const leadId = String(body.leadId || "").trim()
  if (!/^\d{10,25}$/.test(leadId)) return NextResponse.json({ ok: false, error: "leadId inválido" }, { status: 400 })
  const regla = (body.regla || "tlmk").toLowerCase() === "sdr" ? "sdr" : "tlmk"

  const token = await getZohoAccessToken()
  const H = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }
  const r = await fetch(
    `${ZOHO_API}/crm/v3/Leads/${leadId}?fields=First_Name,Last_Name,Company,Phone,Lead_Status,Owner,N_Empleados_que_marcan,Converted__s`,
    { headers: H, cache: "no-store" },
  )
  const lead = ((await r.json().catch(() => ({}))) as { data?: Array<Record<string, unknown>> }).data?.[0]
  if (!lead) return NextResponse.json({ ok: false, error: "lead no encontrado" }, { status: 404 })
  const status = String(lead.Lead_Status || "")
  const fono = String(lead.Phone || "").replace(/\D/g, "")
  const nombre = [lead.First_Name, lead.Last_Name].filter(Boolean).join(" ").trim()
  const empresa = String(lead.Company || "")
  const empleados = Number(lead.N_Empleados_que_marcan || 0) || 0
  const duenoAntes = String((lead.Owner as { email?: string } | undefined)?.email || "")

  // Tope de entrega: "3. Contactado" (nunca "4." por API — cierra el blueprint).
  if (!/^\s*[3]\./.test(status)) await updateZohoLeadStatus(leadId, STATUS_ENTREGA_LEAD).catch(() => {})

  const entrega =
    regla === "tlmk"
      ? await reasignarLeadCalificacionCL(leadId, { calificado: true }).catch((e) => ({ success: false, error: String(e) }))
      : await reasignarLeadTelemarketingCL(leadId).catch((e) => ({ success: false, error: String(e) }))
  const ownerEmail = String((entrega as { ownerEmail?: string }).ownerEmail || "")
  let avisado = false
  if (entrega.success && ownerEmail) {
    avisado = await notificarLeadAsignado({ leadId, vendedorEmail: ownerEmail, contact: fono, nombre, empresa, empleados }).catch(() => false)
  }
  const notaTexto =
    (body.nota ? `${body.nota}\n\n` : "") +
    `Entrega manual (admin, ${new Date().toISOString().slice(0, 16)}Z): lead que quedó a nombre de Vicky (${duenoAntes || "vicky"}) ` +
    `entregado por regla ${regla.toUpperCase()}${ownerEmail ? ` → ${ownerEmail}` : ""}. Status dejado en "${STATUS_ENTREGA_LEAD}" para que el ejecutivo convierta por blueprint.` +
    (fono ? `\nChat con Vicky: WhatsApp +${fono}.` : "")
  await fetch(`${ZOHO_API}/crm/v3/Leads/${leadId}/Notes`, {
    method: "POST",
    headers: H,
    cache: "no-store",
    body: JSON.stringify({ data: [{ Note_Title: "Entrega manual del lead de Vicky", Note_Content: notaTexto }] }),
  }).catch(() => null)
  console.log(`[entregar-lead] ${leadId} regla=${regla} ok=${entrega.success} owner=${ownerEmail} avisado=${avisado}`)
  return NextResponse.json({ ok: entrega.success, leadId, regla, statusAntes: status, duenoAntes, ownerEmail, avisado, error: (entrega as { error?: string }).error })
}
