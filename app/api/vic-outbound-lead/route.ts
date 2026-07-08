/**
 * OUTBOUND — Toque 0 a leads del formulario web (Vicky proactiva).
 *
 * Lo llama el Workflow de Zoho cuando se crea/asigna un lead del formulario
 * "Solicita cotización o demo" que califica para Vicky (≤49 empleados y NO es
 * cliente actual — ese ruteo/filtro vive en Zoho, acá se confía en él).
 *
 * Qué hace (velocity-first: cada minuto post-formulario es conversión perdida):
 *   1. Envía la plantilla HSM de apertura vía Botmaker (OUTBOUND_TEMPLATE_LEAD).
 *   2. Persiste el turno de apertura de Vicky + los datos del formulario en la
 *      conversación (patrón de la reactivación), para que cuando el lead
 *      responda, Vicky tenga TODO el contexto sin lookups.
 *
 * SEGURO POR DEFECTO: sin OUTBOUND_TEMPLATE_LEAD configurada no envía nada
 * (deployable antes de aprobar la plantilla en Meta).
 * DEDUP: si el contacto ya tiene conversación con mensajes, no se le escribe
 * (ya está conversando con Vicky o ya recibió el toque; re-disparos del
 * workflow quedan absorbidos).
 *
 * Auth: x-cron-secret == vic_kv.followup_cron_secret, o Bearer/?key=CRON_SECRET.
 *
 * Body esperado (JSON desde el workflow de Zoho):
 *   {
 *     "nombre": "María",              // requerido
 *     "apellido": "Pérez",            // opcional
 *     "empresa": "Comercial XYZ",     // requerido
 *     "telefono": "+56 9 1234 5678",  // requerido (con o sin formato)
 *     "email": "maria@xyz.cl",        // opcional pero recomendado
 *     "empleadosRango": "20 - 49",    // opcional (rango del formulario)
 *     "zohoLeadId": "352504500..."    // opcional (trazabilidad)
 *   }
 */

import { NextResponse } from "next/server"
import { sendBotmakerTemplate } from "@/lib/botmaker-push-v3"
import { appendAssistantV3, getFollowupCronSecret } from "@/lib/supabase-persistence-v3"
import { isTestContact, testContactSet } from "@/lib/funnel-analysis"
import { updateZohoLeadStatus, reasignarLeadSdrInbound } from "@/lib/zoho-leads"

export const dynamic = "force-dynamic"
export const maxDuration = 30

const CRON_SECRET = (process.env.CRON_SECRET || "").trim()
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
// Nombre de la plantilla HSM de apertura en Botmaker (variables: nombre, empresa).
const TPL_LEAD = (process.env.OUTBOUND_TEMPLATE_LEAD || "").trim()

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

type LeadBody = {
  nombre?: string
  apellido?: string
  empresa?: string
  telefono?: string
  email?: string
  empleadosRango?: string
  zohoLeadId?: string
  // Hook de PRUEBA (mismo patrón que el cron de reactivación): con test=true
  // salta la exclusión de internos y el dedup para validar la plantilla en un
  // número del equipo. NO persiste contexto ni toca el lead en Zoho.
  test?: boolean
}

export async function POST(req: Request): Promise<Response> {
  if (!(await authorized(req))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }
  const body = (await req.json().catch(() => ({}))) as LeadBody
  const nombre = (body.nombre || "").trim()
  const apellido = (body.apellido || "").trim()
  // Empresa es OPCIONAL (el formulario a veces llega sin Company): con fallback
  // la plantilla lee natural ("...tu solicitud de cotización para tu empresa").
  const empresa = (body.empresa || "").trim() || "tu empresa"
  const email = (body.email || "").trim()
  const rango = (body.empleadosRango || "").trim()
  const zohoLeadId = (body.zohoLeadId || "").trim()
  const contact = (body.telefono || "").replace(/\D/g, "")

  if (!contact || !nombre) {
    return NextResponse.json(
      { ok: false, error: "telefono y nombre son requeridos" },
      { status: 400 },
    )
  }
  // Hook de prueba: envía la plantilla real al número indicado (aunque sea
  // interno) y termina — sin dedup, sin contexto persistido, sin tocar Zoho.
  if (body.test === true) {
    if (!TPL_LEAD) {
      return NextResponse.json({ ok: false, test: true, error: "OUTBOUND_TEMPLATE_LEAD no configurada" })
    }
    const okTest = await sendBotmakerTemplate(contact, TPL_LEAD, { nombre, empresa }).catch(() => false)
    return NextResponse.json({ ok: okTest, test: true, contact, template: TPL_LEAD })
  }
  // Los números internos no reciben prospección (mismo set que excluye el embudo).
  if (isTestContact(contact, testContactSet())) {
    return NextResponse.json({ ok: true, skipped: "contacto interno" })
  }
  // Red de seguridad: prospección SOLO a Chile (+56). La calificación fina vive
  // en las assignment rules de Zoho; esto protege contra asignaciones manuales
  // equivocadas (la línea vende en CLP y el pago es MP Chile).
  if (!contact.startsWith("56")) {
    return NextResponse.json({ ok: true, skipped: "telefono no es +56", contact })
  }
  if (!TPL_LEAD) {
    return NextResponse.json({ ok: true, skipped: "OUTBOUND_TEMPLATE_LEAD no configurada" })
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return NextResponse.json({ ok: false, error: "Supabase no configurado" }, { status: 503 })
  }

  // DEDUP: si ya existe conversación para el contacto, no tocarla (ya está
  // hablando con Vicky, o el workflow re-disparó).
  const existing = await fetch(
    `${SUPABASE_URL}/rest/v1/vic_v3_conversations?contact=eq.${contact}&select=id&limit=1`,
    {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      cache: "no-store",
    },
  )
    .then((r) => (r.ok ? r.json() : []))
    .catch(() => [])
  if (Array.isArray(existing) && existing.length > 0) {
    return NextResponse.json({ ok: true, skipped: "conversación ya existe", contact })
  }

  // 1. Plantilla HSM de apertura (variables por nombre, como las define Botmaker).
  const sent = await sendBotmakerTemplate(contact, TPL_LEAD, { nombre, empresa }).catch(() => false)
  if (!sent) {
    // Acuerdo con Marketing (jul-2026): si el WhatsApp no se pudo enviar, el
    // lead NO se queda con Vicky — vuelve a un humano (round-robin SDR Inbound).
    let reasignado: string | undefined
    if (zohoLeadId) {
      const r = await reasignarLeadSdrInbound(zohoLeadId).catch(() => null)
      reasignado = r?.ownerEmail
      console.warn(`[outbound-lead] envío falló → lead ${zohoLeadId} reasignado a ${reasignado || "(reasignación falló)"}`)
    }
    return NextResponse.json(
      { ok: false, error: "fallo el envío de la plantilla", contact, reasignado },
      { status: 502 },
    )
  }
  // Diccionario Vicky (acuerdo con Marketing): envío de mensaje = intento de
  // contacto. Best-effort: no bloquea la respuesta al workflow.
  if (zohoLeadId) {
    await updateZohoLeadStatus(zohoLeadId, "2. Intento de contacto").catch(() => {})
  }

  // 2. Persistir la apertura + contexto del formulario. El bloque [Datos del
  // formulario web: ...] es CONTEXTO INTERNO para Vicky (el prompt le enseña a
  // usarlo sin citarlo); el cliente solo recibió la plantilla.
  const ctx = [
    `Hola ${nombre}, soy Vicky de GeoVictoria 👋 Recibimos tu solicitud de cotización para ${empresa}. Te ayudo a armarla al tiro por acá. ¿Avanzamos?`,
    ``,
    `[Datos del formulario web: nombre ${[nombre, apellido].filter(Boolean).join(" ")} · empresa ${empresa}` +
      `${rango ? ` · ${rango} empleados` : ""}${email ? ` · email ${email}` : ""}` +
      `${zohoLeadId ? ` · zohoLeadId ${zohoLeadId}` : ""}]`,
  ].join("\n")
  await appendAssistantV3(contact, ctx).catch(() => {})

  console.log(`[outbound-lead] toque 0 → ${contact} (${empresa}${rango ? `, ${rango}` : ""})`)
  return NextResponse.json({ ok: true, contact, empresa, template: TPL_LEAD })
}
