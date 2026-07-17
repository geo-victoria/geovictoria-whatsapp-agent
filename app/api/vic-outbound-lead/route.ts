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
import {
  updateZohoLeadStatus,
  reasignarLeadSdrInbound,
  reasignarLeadSdrInboundCO,
} from "@/lib/zoho-leads"
import { PERFIL_CO } from "@/lib/paises/co"

export const dynamic = "force-dynamic"
export const maxDuration = 30

const CRON_SECRET = (process.env.CRON_SECRET || "").trim()
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
// Nombre de la plantilla HSM de apertura en Botmaker (variables: nombre, empresa).
const TPL_LEAD = (process.env.OUTBOUND_TEMPLATE_LEAD || "").trim()
// Colombia (17-jul, paridad de proactividad): plantilla de apertura propia que
// sale por la línea +57. Categoría UTILITY (aprobada 17-jul con copy
// transaccional): inmune al cap de frecuencia de Meta sobre Marketing
// (131049, caso Marcela). La env queda como override. Zona horaria/feriados
// CO los resuelve la cadencia con vic_is_business_now (prefijo 57 → Bogotá).
const TPL_LEAD_CO = (process.env.OUTBOUND_TEMPLATE_LEAD_CO || "vicky_co_solicitud_recibida").trim()

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
  // País/territorio explícito desde Zoho ("Chile"/"Colombia" o "cl"/"co").
  // Manda sobre la inferencia por prefijo y permite NORMALIZAR teléfonos en
  // formato local (formularios que llegan sin +57/+56). Opcional: sin él, el
  // prefijo del teléfono decide, como siempre.
  country?: string
  territorio?: string
  // Página donde convirtió el lead (Zoho Conversion/Landing Page, ej.
  // "/es-cl/servicios/alertas/"). Va al contexto interno: Vicky abre sabiendo
  // qué producto estaba mirando en vez de partir genérica.
  paginaConversion?: string
  landingPage?: string
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
  // Un valor puramente numérico tampoco es un nombre — el formulario a veces
  // trae la cédula/RUT en el campo empresa (caso Marcela "1128404362", 17-jul)
  // y la plantilla quedaba "cotización para 1128404362". Se normaliza acá para
  // que plantilla, contexto y correos de cadencia hereden el fallback.
  const empresaRaw = (body.empresa || "").trim()
  const empresa = /^[\d\s.\-]*$/.test(empresaRaw) ? "tu empresa" : empresaRaw
  const email = (body.email || "").trim()
  const rango = (body.empleadosRango || "").trim()
  const zohoLeadId = (body.zohoLeadId || "").trim()
  // Página de conversión/aterrizaje (pista de interés). Zoho a veces manda el
  // literal "none" o "-" en estos campos de marketing: se tratan como vacío.
  const paginaRaw = (body.paginaConversion || body.landingPage || "").trim()
  const paginaInteres = /^(none|null|-|—)?$/i.test(paginaRaw) ? "" : paginaRaw.slice(0, 200)
  let contact = (body.telefono || "").replace(/\D/g, "")

  if (!contact || !nombre) {
    return NextResponse.json(
      { ok: false, error: "telefono y nombre son requeridos" },
      { status: 400 },
    )
  }

  // País: el territorio EXPLÍCITO de Zoho manda; el prefijo telefónico es el
  // fallback. Con país conocido se normalizan teléfonos en formato local:
  // CL móvil "9XXXXXXXX" (9 dígitos) → 56...; CO celular "3XXXXXXXXX" (10) → 57...
  const territorioRaw = (body.country || body.territorio || "").trim().toLowerCase()
  const territorio = /colombia|^co$/.test(territorioRaw)
    ? "co"
    : /chile|^cl$/.test(territorioRaw)
      ? "cl"
      : null
  if (territorio === "cl" && contact.length === 9 && contact.startsWith("9")) {
    contact = `56${contact}`
  } else if (territorio === "co" && contact.length === 10 && contact.startsWith("3")) {
    contact = `57${contact}`
  }
  const porPrefijo = contact.startsWith("56") ? "cl" : contact.startsWith("57") ? "co" : null
  // El prefijo del teléfono manda (define la línea por la que se puede escribir);
  // el territorio solo normaliza y deja traza si no calzan.
  const country = porPrefijo || territorio
  if (territorio && porPrefijo && territorio !== porPrefijo) {
    console.warn(
      `[outbound-lead] territorio=${territorio} no calza con prefijo del teléfono ${contact} — se usa el prefijo`,
    )
  }
  const esCO = country === "co"
  const tplPais = esCO ? TPL_LEAD_CO : TPL_LEAD
  const channelId = esCO ? PERFIL_CO.canal.channelId : undefined

  // Hook de prueba: envía la plantilla real al número indicado (aunque sea
  // interno) y termina — sin dedup, sin contexto persistido, sin tocar Zoho.
  if (body.test === true) {
    if (!tplPais) {
      return NextResponse.json({
        ok: false,
        test: true,
        error: `OUTBOUND_TEMPLATE_LEAD${esCO ? "_CO" : ""} no configurada`,
      })
    }
    const okTest = await sendBotmakerTemplate(contact, tplPais, { nombre, empresa }, channelId).catch(() => false)
    return NextResponse.json({ ok: okTest, test: true, contact, template: tplPais })
  }
  // Los números internos no reciben prospección (mismo set que excluye el
  // embudo). OUTBOUND_ALLOW_CONTACTS (coma-separado) permite excepciones
  // puntuales para pruebas E2E del flujo completo con números del equipo.
  const allowList = new Set(
    (process.env.OUTBOUND_ALLOW_CONTACTS || "")
      .split(",")
      .map((s) => s.replace(/\D/g, ""))
      .filter(Boolean),
  )
  if (!allowList.has(contact) && isTestContact(contact, testContactSet())) {
    return NextResponse.json({ ok: true, skipped: "contacto interno" })
  }
  // Red de seguridad: prospección SOLO a países con línea y flujo propios
  // (Chile +56, Colombia +57). WhatsApp necesita el número internacional: si
  // tras normalizar no hay prefijo válido (ej. fijo local sin país), se salta.
  // La calificación fina vive en las assignment rules de Zoho.
  if (!porPrefijo) {
    return NextResponse.json({
      ok: true,
      skipped: `telefono sin prefijo +56/+57 utilizable${territorio ? ` (territorio ${territorio})` : ""}`,
      contact,
    })
  }
  if (!tplPais) {
    return NextResponse.json({
      ok: true,
      skipped: `OUTBOUND_TEMPLATE_LEAD${esCO ? "_CO" : ""} no configurada`,
    })
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
  const sent = await sendBotmakerTemplate(contact, tplPais, { nombre, empresa }, channelId).catch(() => false)
  if (!sent) {
    // Acuerdo con Marketing (jul-2026): si el WhatsApp no se pudo enviar, el
    // lead NO se queda con Vicky — vuelve a un humano (round-robin SDR Inbound
    // del país correspondiente).
    let reasignado: string | undefined
    if (zohoLeadId) {
      const r = await (esCO
        ? reasignarLeadSdrInboundCO(zohoLeadId)
        : reasignarLeadSdrInbound(zohoLeadId)
      ).catch(() => null)
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
  // usarlo sin citarlo); el cliente solo recibió la plantilla. El country
  // marca la conversación para que la respuesta corra el agente del país y
  // los toques salgan por su línea y en su zona horaria.
  // Espejos 1:1 de las plantillas reales (si se edita una plantilla en
  // Botmaker, actualizar el literal en el mismo cambio):
  // CO → UTILITY vicky_co_solicitud_recibida · CL → vicky_lead_apertura_v3
  // (v3 pide de una la cantidad de personas: ahorra un turno y la respuesta
  // ya es la calificación — decisión Lalo/Rodrigo 17-jul).
  const saludoApertura = esCO
    ? `Hola ${nombre}, te escribimos de GeoVictoria por la solicitud de cotización que registraste para ${empresa}. Puedes completarla por este medio: responde este mensaje y continuamos con el detalle.`
    : `Hola ${nombre} 👋 Soy Vicky de GeoVictoria. Recibimos tu solicitud de cotización para ${empresa}. ¿Cuántas personas marcarían asistencia? Con eso te la armo de inmediato.`
  const ctx = [
    saludoApertura,
    ``,
    `[Datos del formulario web: nombre ${[nombre, apellido].filter(Boolean).join(" ")} · empresa ${empresa}` +
      `${rango ? ` · ${rango} empleados` : ""}${email ? ` · email ${email}` : ""}` +
      `${paginaInteres ? ` · convirtió en la página ${paginaInteres} (úsalo como pista de qué le interesa, sin citar la URL)` : ""}` +
      `${zohoLeadId ? ` · zohoLeadId ${zohoLeadId}` : ""}]`,
  ].join("\n")
  await appendAssistantV3(contact, ctx, esCO ? "co" : "cl").catch(() => {})

  // 3. Arranca la CADENCIA multicanal (correos vía Zoho + HSM día 1/7): el cron
  // vic-outbound-cadence-cron toma esta fila; cualquier respuesta la corta.
  await fetch(`${SUPABASE_URL}/rest/v1/vic_outbound_cadence?on_conflict=contact`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({
      contact,
      zoho_lead_id: zohoLeadId || null,
      email: email || null,
      nombre,
      empresa,
    }),
    cache: "no-store",
  }).catch(() => {})

  console.log(`[outbound-lead] toque 0 → ${contact} (${empresa}${rango ? `, ${rango}` : ""})`)
  return NextResponse.json({ ok: true, contact, empresa, template: TPL_LEAD, cadencia: "iniciada" })
}
