/**
 * RESCATE DE HUÉRFANOS DE VICKY (Lalo 25-ago, auditoría "¿todo se traspasó?").
 *
 * El barrido encontró tres bolsones con dueño Vicky que ninguna regla viva
 * cubría: leads viejos que conversaron sin llegar a hito (jul→12-ago), deals
 * con propuesta enviada más allá del reloj, y leads CO que no pasaron por la
 * entrega fija. Órdenes de Lalo: (1) leads CL → REACTIVAR con plantilla y
 * luego traspasar según las reglas nuevas (escalera 18-ago: sin calificar →
 * tómbola SDR); (2) deals varados → tómbola de deals (+alerta si aceptada);
 * (3) leads CO → Galindo (regla fija del equipo CO).
 *
 * POST auth cron: { leadsCl?: string[], leadsCo?: string[], deals?: string[],
 * plantilla?: string, dry?: boolean }. Con dry=true solo evalúa y reporta
 * (sin envíos ni escrituras). Guardas por lead: dueño debe seguir siendo el
 * robot Vicky (si un humano ya lo tomó, no se toca) y los motivos TERMINALES
 * jamás se reactivan (regla 21-ago).
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret, appendAssistantV3 } from "@/lib/supabase-persistence-v3"
import { sendBotmakerTemplate } from "@/lib/botmaker-push-v3"
import { reasignarLeadTelemarketingCL, reasignarLeadSdrInboundCO, esMotivoTerminal } from "@/lib/zoho-leads"
import { aplicarTombolaDeals } from "@/lib/crm-hitos"
import { avisarEquipoInterno } from "@/lib/alerta-interna"
import { getZohoAccessToken } from "@/lib/zoho-token"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const CRON_SECRET = (process.env.CRON_SECRET || "").trim()
const VICKY_ROBOT_ID = "3525045000484500876"
const PLANTILLA_DEFAULT = (process.env.VICKY_RESCATE_PLANTILLA || "reactivacion_preform_oferta_v2").trim()
// Mismo contexto de historial que usa la reactivación: al responder el
// cliente, Vicky sabe que ELLA reabrió y le da continuidad.
const CONTEXTO_HISTORIAL =
  "Hola, soy Vicky 👋 Te escribí para retomar tu cotización pendiente. Tengo un precio especial por tiempo limitado para ti. ¿Lo vemos antes de que caduque?"

async function autorizado(req: Request): Promise<boolean> {
  const url = new URL(req.url)
  const entregado =
    req.headers.get("x-cron-secret") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") ||
    url.searchParams.get("key") ||
    ""
  if (!entregado) return false
  const kv = await getFollowupCronSecret().catch(() => "")
  return entregado === CRON_SECRET || (Boolean(kv) && entregado === kv)
}

type FilaLead = {
  id: string
  First_Name?: string | null
  Last_Name?: string | null
  Phone?: string | null
  Lead_Status?: string | null
  Motivo_No_calificado?: string | null
  Owner?: { id?: string; email?: string } | null
  Territorio?: string | null
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  const body = (await req.json().catch(() => ({}))) as {
    leadsCl?: string[]
    leadsCo?: string[]
    deals?: string[]
    alertaDeals?: string[]
    plantilla?: string
    dry?: boolean
  }
  const dry = body.dry === true
  const plantilla = (body.plantilla || "").trim() || PLANTILLA_DEFAULT
  // VENTANA DURA 9-21 CL (lección 25-ago: la corrida real salió 21:07 y el
  // gate en sombra solo lo anotó): fuera de ventana el run REAL se niega —
  // el dry siempre puede correr.
  const horaCl = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/Santiago", hour: "numeric", hour12: false }).format(new Date()),
  )
  if (!dry && (horaCl < 9 || horaCl >= 21)) {
    return NextResponse.json(
      { ok: false, error: `fuera de ventana 9-21 CL (hora local ${horaCl}) — correr en horario o usar dry` },
      { status: 425 },
    )
  }
  const token = await getZohoAccessToken()
  const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").replace(/\/$/, "")
  const H = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }

  async function leerLead(id: string): Promise<FilaLead | null> {
    const r = await fetch(
      `${api}/crm/v3/Leads/${id}?fields=First_Name,Last_Name,Phone,Lead_Status,Motivo_No_calificado,Owner,Territorio`,
      { headers: H, cache: "no-store" },
    )
    if (r.status !== 200) return null
    const data = (await r.json().catch(() => null)) as { data?: FilaLead[] } | null
    return data?.data?.[0] ?? null
  }

  const resultado: Record<string, unknown[]> = { leadsCl: [], leadsCo: [], deals: [] }

  // ── (1) Leads CL: plantilla de reactivación + entrega a la tómbola SDR ──
  for (const id of body.leadsCl || []) {
    const fila = await leerLead(id)
    const item: Record<string, unknown> = { id, nombre: `${fila?.First_Name || ""} ${fila?.Last_Name || ""}`.trim() }
    if (!fila) {
      resultado.leadsCl.push({ ...item, accion: "omitido", motivo: "lead no encontrado" })
      continue
    }
    if (fila.Owner?.id !== VICKY_ROBOT_ID) {
      resultado.leadsCl.push({ ...item, accion: "omitido", motivo: `ya tiene dueño ${fila.Owner?.email || "?"}` })
      continue
    }
    if (esMotivoTerminal(fila.Lead_Status || "", fila.Motivo_No_calificado)) {
      resultado.leadsCl.push({ ...item, accion: "omitido", motivo: `motivo terminal: ${fila.Motivo_No_calificado}` })
      continue
    }
    const fono = String(fila.Phone || "").replace(/\D/g, "").replace(/^5656/, "56")
    const fonoOk = /^569\d{8}$/.test(fono)
    if (dry) {
      resultado.leadsCl.push({ ...item, accion: "dry", fono: fonoOk ? fono : `INVÁLIDO (${fila.Phone})`, plantilla })
      continue
    }
    // 1. Reactivar por WhatsApp (solo con fono discable; sin fono igual se entrega).
    let plantillaEnviada = false
    if (fonoOk) {
      const nombre = (fila.First_Name || fila.Last_Name || "").trim()
      plantillaEnviada = await sendBotmakerTemplate(fono, plantilla, { nombre }).catch(() => false)
      if (plantillaEnviada) await appendAssistantV3(fono, CONTEXTO_HISTORIAL, "cl").catch(() => {})
    }
    // 2. "No Calificado" (no terminal) revive a etapa 1 (regla de re-contacto,
    //    doc marketing 30-jul) antes de entregarse.
    if ((fila.Lead_Status || "") === "No Calificado") {
      await fetch(`${api}/crm/v3/Leads`, {
        method: "PUT",
        headers: H,
        cache: "no-store",
        body: JSON.stringify({ data: [{ id, Lead_Status: "1. No contactado" }], trigger: ["blueprint"] }),
      }).catch(() => undefined)
    }
    // 3. Entrega según la escalera vigente: sin calificar → tómbola SDR.
    const entrega = await reasignarLeadTelemarketingCL(id).catch(() => ({ success: false, error: "excepción" }))
    resultado.leadsCl.push({
      ...item,
      accion: "procesado",
      plantillaEnviada,
      fono: fonoOk ? fono : `sin WhatsApp discable (${fila.Phone})`,
      entrega,
    })
  }

  // ── (2) Deals varados: tómbola de deals CL (con notificación al sorteado) ──
  const alertar = new Set(body.alertaDeals || [])
  for (const id of body.deals || []) {
    if (dry) {
      resultado.deals.push({ id, accion: "dry" })
      continue
    }
    await aplicarTombolaDeals(id, "Chile")
    const g = await fetch(`${api}/crm/v3/Deals/${id}?fields=Owner,Deal_Name,Stage`, { headers: H, cache: "no-store" })
    const fila = g.status === 200
      ? ((await g.json().catch(() => ({}))) as { data?: Array<{ Owner?: { email?: string; name?: string }; Deal_Name?: string; Stage?: string }> }).data?.[0]
      : undefined
    if (alertar.has(id)) {
      await avisarEquipoInterno(
        `⚠️ DEAL ACEPTADO SIN GESTIÓN: "${fila?.Deal_Name || id}" llevaba días en "${fila?.Stage || "?"}" con dueña Vicky. ` +
          `Recién sorteado a ${fila?.Owner?.name || fila?.Owner?.email || "?"} — empujar el cierre HOY.`,
      ).catch(() => undefined)
    }
    resultado.deals.push({ id, deal: fila?.Deal_Name, stage: fila?.Stage, accion: "tombola", owner: fila?.Owner?.email })
  }

  // ── (3) Leads CO: entrega fija a Galindo (regla del equipo CO) ──
  for (const id of body.leadsCo || []) {
    const fila = await leerLead(id)
    if (!fila || fila.Owner?.id !== VICKY_ROBOT_ID) {
      resultado.leadsCo.push({ id, accion: "omitido", motivo: fila ? `dueño ${fila.Owner?.email}` : "no encontrado" })
      continue
    }
    if (dry) {
      resultado.leadsCo.push({ id, accion: "dry" })
      continue
    }
    const r = await reasignarLeadSdrInboundCO(id).catch(() => ({ success: false, error: "excepción" }))
    resultado.leadsCo.push({ id, accion: "procesado", entrega: r })
  }

  return NextResponse.json({ ok: true, dry, plantilla, resultado })
}
