/**
 * CRON — Cadencia multicanal post toque 0 (Vicky proactiva, F2 + correos).
 *
 * Corre cada 15 min (pg_cron). Para cada lead outbound ACTIVO en
 * vic_outbound_cadence dispara el siguiente toque pendiente según las horas
 * desde el toque 0 (offsets configurables en vic_kv `outbound_cadence_offsets_h`
 * como "e1,waNudge,e2,waCierre,e3" — default "2,24,120,168,192"):
 *
 *   e1  (~+2h)  correo 1 "a un mensaje de distancia"   → Zoho send_mail (lead)
 *   waN (día 1) HSM vicky_lead_nudge                    → Botmaker
 *   e2  (día 5) correo 2 beneficios                     → Zoho send_mail
 *   waC (día 7) HSM vicky_lead_cierre (breakup)         → Botmaker
 *   e3  (día 8) correo 3 breakup                        → Zoho send_mail
 *   +4h tras e3 sin respuesta → lead reasignado round-robin a las SDR Inbound
 *
 * CUALQUIER respuesta del cliente corta la cadencia (last_user_at desde el
 * toque 0); opt-out/perdido también. Envíos solo en horario hábil del contacto
 * (mismo RPC que seguimiento/reactivación). Los HSM quedan en el historial de
 * la conversación para que Vicky retome con continuidad.
 *
 * Auth: x-cron-secret == vic_kv.followup_cron_secret (o Bearer/?key=CRON_SECRET).
 */

import { NextResponse } from "next/server"
import { sendBotmakerTemplate } from "@/lib/botmaker-push-v3"
import {
  appendAssistantV3,
  getFollowupCronSecret,
  getKvValue,
} from "@/lib/supabase-persistence-v3"
import { buildCorreoCadencia, sendLeadEmail } from "@/lib/zoho-lead-mail"
import {
  agregarNotaLead,
  reasignarLeadSdrInbound,
  reasignarLeadSdrInboundCO,
  updateZohoLeadOwner,
} from "@/lib/zoho-leads"
import { isTestContact, testContactSet } from "@/lib/funnel-analysis"
import { contactosEnLoop } from "@/lib/loop-v2"
import { PERFIL_CO } from "@/lib/paises/co"
import { PERFIL_MX } from "@/lib/paises/mx"

export const dynamic = "force-dynamic"
export const maxDuration = 120

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const CRON_SECRET = (process.env.CRON_SECRET || "").trim()
const TPL_NUDGE = (process.env.OUTBOUND_TEMPLATE_NUDGE || "vicky_lead_nudge").trim()
const TPL_CIERRE = (process.env.OUTBOUND_TEMPLATE_CIERRE || "vicky_lead_cierre").trim()
// Colombia (17-jul, paridad de proactividad): plantillas propias por la línea
// +57, aprobadas en Meta el 16-jul (misma convención que las de reactivación
// CO); las envs quedan como override. Si una plantilla se despublica, setear
// la env en vacío NO sirve (cae al default): usar un nombre inválido y el
// envío fallará marcando el toque.
const TPL_NUDGE_CO = (process.env.OUTBOUND_TEMPLATE_NUDGE_CO || "vicky_co_lead_nudge").trim()
const TPL_CIERRE_CO = (process.env.OUTBOUND_TEMPLATE_CIERRE_CO || "vicky_co_lead_cierre").trim()
// México (22-jul): sin plantillas de nudge/cierre propias todavía — se reusan
// las de reactivación (aprobadas, UTILITY, con ${nombre} y ${empresa}): la
// corta calza como nudge ("tu cotización quedó a medio camino") y la final
// como breakup. Cuando existan plantillas de cadencia MX dedicadas, basta
// setear las envs.
const TPL_NUDGE_MX = (process.env.OUTBOUND_TEMPLATE_NUDGE_MX || "vicky_mx_react_corta").trim()
const TPL_CIERRE_MX = (process.env.OUTBOUND_TEMPLATE_CIERRE_MX || "vicky_mx_react_final").trim()
const BATCH = Number(process.env.OUTBOUND_CADENCE_BATCH || 30)

// Texto que queda en el historial de la conversación por cada HSM (contexto
// para Vicky cuando el cliente responda; el cliente recibió la plantilla).
const CONTEXT_NUDGE = (nombre: string, empresa: string) =>
  `Hola ${nombre}, soy Vicky de GeoVictoria 👋 Te escribí ayer por tu solicitud para ${empresa}. Armar tu cotización toma 2 minutos por acá. ¿Hay algo que te falte para avanzar o alguna duda que te pueda resolver?`
const CONTEXT_CIERRE = (nombre: string, empresa: string) =>
  `Hola ${nombre}! Soy Vicky de GeoVictoria. No te quiero molestar más: dejo tu cotización para ${empresa} lista para retomarla cuando tú quieras — me escribes por acá y la armamos de inmediato. ¡Que te vaya súper! 👋`
// Versión CO: tuteo cálido colombiano, sin chilenismos (feedback equipo CO).
const CONTEXT_NUDGE_CO = (nombre: string, empresa: string) =>
  `Hola ${nombre}! Soy Vicky de GeoVictoria 👋 Te escribí ayer por tu solicitud para ${empresa}. Armar tu cotización toma 2 minutos por acá. Hay algo que te falte para avanzar o alguna duda que te pueda resolver? 😊`
const CONTEXT_CIERRE_CO = (nombre: string, empresa: string) =>
  `Hola ${nombre}! Soy Vicky de GeoVictoria. No te quiero molestar más: dejo tu cotización para ${empresa} lista para retomarla cuando quieras — me escribes por acá y la armamos de una vez. Que te vaya muy bien! 👋`
// Versión MX: espejo 1:1 de las plantillas de reactivación reusadas como
// nudge/cierre (si cambian las envs TPL_*_MX, actualizar estos literales).
const CONTEXT_NUDGE_MX = (nombre: string, empresa: string) =>
  `Hola ${nombre}, soy Vicky de GeoVictoria 👋 Te escribo para retomar tu cotización de ${empresa}, que quedó a medio camino — en 2 minutos la terminamos por aquí. ¿Seguimos? 😊`
const CONTEXT_CIERRE_MX = (nombre: string, empresa: string) =>
  `Hola ${nombre}! Soy Vicky de GeoVictoria. ¿Sigues interesado en resolver el control de asistencia de ${empresa}, o lo dejamos para más adelante? Cualquiera de las dos me sirve — solo dime y no te molesto más 🙌`

type Row = {
  contact: string
  zoho_lead_id: string | null
  email: string | null
  nombre: string | null
  empresa: string | null
  started_at: string
  e1_sent_at: string | null
  wa_nudge_sent_at: string | null
  e2_sent_at: string | null
  wa_cierre_sent_at: string | null
  e3_sent_at: string | null
}

function supa(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
    cache: "no-store",
  })
}

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

async function cerrar(contact: string, reason: string): Promise<void> {
  await supa(`vic_outbound_cadence?contact=eq.${encodeURIComponent(contact)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      status: reason === "respondio" ? "respondio" : reason === "optout" ? "optout" : "agotada_reasignada",
      closed_at: new Date().toISOString(),
      closed_reason: reason,
    }),
  }).catch(() => {})
}

async function marcarToque(contact: string, campo: string): Promise<void> {
  await supa(`vic_outbound_cadence?contact=eq.${encodeURIComponent(contact)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ [campo]: new Date().toISOString() }),
  }).catch(() => {})
}

export async function GET(req: Request): Promise<Response> {
  if (!(await authorized(req))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return NextResponse.json({ ok: false, error: "Supabase no configurado" }, { status: 503 })
  }

  // Offsets en horas desde el toque 0 (override en vic_kv para pruebas E2E).
  const rawOffsets = (await getKvValue("outbound_cadence_offsets_h").catch(() => null)) || "2,24,120,168,192"
  const [hE1, hWaN, hE2, hWaC, hE3] = rawOffsets
    .split(",")
    .map((s) => Number(s.trim()))
    .concat([2, 24, 120, 168, 192])
    .slice(0, 5)
  const hAgotar = hE3 + 4

  const res = await supa(
    `vic_outbound_cadence?status=eq.activa&select=*&order=started_at.asc&limit=200`,
  )
  const rows = (res.ok ? ((await res.json()) as Row[]) : []).filter(
    (r) => r.contact && !isTestContact(r.contact, testContactSet()),
  )
  if (rows.length === 0) {
    const { estamparLatido } = await import("@/lib/latido")
    await estamparLatido("outbound").catch(() => undefined)
    return NextResponse.json({ ok: true, activos: 0 })
  }

  // Loop v2 (flag LOOP_V2_ENABLED): los contactos migrados al motor nuevo NO
  // reciben la cadencia vieja — un solo fetch batch (con el flag apagado el
  // helper devuelve set vacío sin tocar la red: comportamiento idéntico a hoy).
  const enLoopV2 = await contactosEnLoop(rows.map((r) => r.contact)).catch(() => new Set<string>())
  let saltadosLoopV2 = 0

  // Estado conversacional de todos los contactos en una sola query.
  const contactsIn = rows.map((r) => `"${r.contact}"`).join(",")
  const convRes = await supa(
    `vic_v3_conversations?contact=in.(${contactsIn})&select=contact,last_user_at,followup_closed_reason`,
  )
  const convs = new Map<string, { last_user_at: string | null; followup_closed_reason: string | null }>()
  for (const c of (convRes.ok ? await convRes.json() : []) as Array<{
    contact: string
    last_user_at: string | null
    followup_closed_reason: string | null
  }>) {
    convs.set(c.contact, c)
  }

  const now = Date.now()
  let cerradosRespondio = 0
  let cerradosOptout = 0
  const pendientes: Array<{ row: Row; accion: "e1" | "waNudge" | "e2" | "waCierre" | "e3" | "agotar" }> = []

  for (const r of rows) {
    // Migrado al Loop v2 → este motor no lo toca (el loop es el dueño del ciclo).
    if (enLoopV2.has(r.contact)) {
      saltadosLoopV2++
      continue
    }
    const conv = convs.get(r.contact)
    // CUALQUIER respuesta del cliente desde el toque 0 corta la cadencia.
    if (conv?.last_user_at && new Date(conv.last_user_at).getTime() >= new Date(r.started_at).getTime()) {
      await cerrar(r.contact, "respondio")
      cerradosRespondio++
      continue
    }
    if (["opt_out", "perdido"].includes(conv?.followup_closed_reason || "")) {
      await cerrar(r.contact, "optout")
      cerradosOptout++
      continue
    }
    const hrs = (now - new Date(r.started_at).getTime()) / 3600e3
    if (!r.e1_sent_at && hrs >= hE1) pendientes.push({ row: r, accion: "e1" })
    else if (!r.wa_nudge_sent_at && hrs >= hWaN) pendientes.push({ row: r, accion: "waNudge" })
    else if (!r.e2_sent_at && hrs >= hE2) pendientes.push({ row: r, accion: "e2" })
    else if (!r.wa_cierre_sent_at && hrs >= hWaC) pendientes.push({ row: r, accion: "waCierre" })
    else if (!r.e3_sent_at && hrs >= hE3) pendientes.push({ row: r, accion: "e3" })
    else if (r.e3_sent_at && hrs >= hAgotar) pendientes.push({ row: r, accion: "agotar" })
  }

  // Horario hábil del contacto (mismo RPC que seguimiento/reactivación).
  let elegibles = new Set<string>()
  if (pendientes.length) {
    const rpc = await supa(`rpc/vic_filter_business_now`, {
      method: "POST",
      body: JSON.stringify({ p_contacts: pendientes.map((p) => p.row.contact) }),
    })
      .then((r) => (r.ok ? (r.json() as Promise<string[]>) : Promise.resolve([] as string[])))
      .catch(() => [] as string[])
    elegibles = new Set(rpc)
  }

  let enviados = 0
  const detalle: Array<Record<string, unknown>> = []
  for (const p of pendientes) {
    if (enviados >= BATCH) break
    if (!elegibles.has(p.row.contact)) continue
    const nombre = (p.row.nombre || "").trim() || "Hola"
    // Mismo saneo que el toque 0: vacío O puramente numérico (cédula/RUT en el
    // campo empresa del formulario) → "tu empresa", para plantillas y correos.
    const empresaRow = (p.row.empresa || "").trim()
    const empresa = /^[\d\s.\-]*$/.test(empresaRow) ? "tu empresa" : empresaRow

    // País por prefijo: define línea de salida, plantillas, tono y SDRs.
    const esCO = p.row.contact.startsWith("57")
    const esMX =
      p.row.contact.startsWith("521") || (p.row.contact.startsWith("52") && p.row.contact.length === 12)

    if (p.accion === "agotar") {
      // Cadencia agotada sin respuesta → el lead vuelve a un humano (acuerdo
      // con Marketing: round-robin SDR Inbound del país; MX v1 sin SDRs → va
      // directo al ejecutivo MX, Yahel Segura).
      let reasignado: string | undefined
      let errorReasignacion: string | undefined
      if (p.row.zoho_lead_id) {
        if (esMX) {
          const yahel = "ysegura@geovictoria.com"
          const rr = await updateZohoLeadOwner(p.row.zoho_lead_id, yahel).catch(() => null)
          reasignado = rr?.success ? yahel : undefined
          errorReasignacion = rr?.success ? undefined : rr?.error || "reasignación MX falló"
          await agregarNotaLead(
            p.row.zoho_lead_id,
            "Vicky: cadencia agotada",
            "El lead no respondió la cadencia outbound (WhatsApp + correos). Requiere contacto manual.",
          ).catch(() => {})
        } else if (esCO) {
          const rr = await reasignarLeadSdrInboundCO(p.row.zoho_lead_id).catch((e) => ({
            success: false as const,
            error: e instanceof Error ? e.message : "excepción",
          }))
          reasignado = rr && "ownerEmail" in rr ? rr.ownerEmail : undefined
          errorReasignacion = rr?.error
        } else {
          // CL: cadencia agotada → telemarketing por la regla de Zoho (Lalo
          // 04-ago); SDR de fallback si la regla no asigna.
          const { reasignarLeadTelemarketingCL } = await import("@/lib/zoho-leads")
          let rr = await reasignarLeadTelemarketingCL(p.row.zoho_lead_id).catch(() => ({ success: false as const }))
          if (!rr.success) {
            rr = await reasignarLeadSdrInbound(p.row.zoho_lead_id).catch((e) => ({
              success: false as const,
              error: e instanceof Error ? e.message : "excepción",
            }))
          }
          reasignado = rr && "ownerEmail" in rr ? rr.ownerEmail : undefined
          errorReasignacion = "error" in rr ? rr.error : undefined
        }
      }
      await cerrar(p.row.contact, "agotada")
      detalle.push({
        contact: p.row.contact,
        accion: "agotar",
        reasignado: reasignado || null,
        ...(errorReasignacion ? { error: errorReasignacion } : {}),
      })
      continue
    }

    if (p.accion === "e1" || p.accion === "e2" || p.accion === "e3") {
      const campo = `${p.accion}_sent_at`
      if (!p.row.email || !p.row.zoho_lead_id) {
        // Sin email o sin lead no hay correo posible: marca el toque para que
        // la cadencia avance a los siguientes (WhatsApp sigue corriendo).
        await marcarToque(p.row.contact, campo)
        detalle.push({ contact: p.row.contact, accion: p.accion, skip: "sin email/lead" })
        continue
      }
      const { subject, html } = buildCorreoCadencia(
        p.accion,
        p.row.nombre || "",
        empresa,
        esMX ? "mx" : esCO ? "co" : "cl",
      )
      const envio = await sendLeadEmail(p.row.zoho_lead_id, p.row.email, subject, html)
      if (envio.ok) {
        await marcarToque(p.row.contact, campo)
        enviados++
        detalle.push({ contact: p.row.contact, accion: p.accion, ok: true })
      } else {
        detalle.push({ contact: p.row.contact, accion: p.accion, ok: false, error: envio.error })
      }
      continue
    }

    // Toques de WhatsApp (HSM): nudge día 1 / breakup día 7, por la línea del país.
    const esNudge = p.accion === "waNudge"
    const tpl = esMX
      ? esNudge ? TPL_NUDGE_MX : TPL_CIERRE_MX
      : esCO
        ? esNudge ? TPL_NUDGE_CO : TPL_CIERRE_CO
        : esNudge ? TPL_NUDGE : TPL_CIERRE
    if (!tpl) {
      // CO sin plantilla aprobada aún: el toque se marca para que la cadencia
      // avance con los correos en vez de reintentar para siempre.
      await marcarToque(p.row.contact, esNudge ? "wa_nudge_sent_at" : "wa_cierre_sent_at")
      detalle.push({ contact: p.row.contact, accion: p.accion, skip: "sin plantilla del país" })
      continue
    }
    const ok = await sendBotmakerTemplate(
      p.row.contact,
      tpl,
      { nombre, empresa },
      esMX ? PERFIL_MX.canal.channelId : esCO ? PERFIL_CO.canal.channelId : undefined,
    ).catch(() => false)
    if (ok) {
      await marcarToque(p.row.contact, esNudge ? "wa_nudge_sent_at" : "wa_cierre_sent_at")
      await appendAssistantV3(
        p.row.contact,
        esMX
          ? esNudge
            ? CONTEXT_NUDGE_MX(nombre, empresa)
            : CONTEXT_CIERRE_MX(nombre, empresa)
          : esCO
            ? esNudge
              ? CONTEXT_NUDGE_CO(nombre, empresa)
              : CONTEXT_CIERRE_CO(nombre, empresa)
            : esNudge
              ? CONTEXT_NUDGE(nombre, empresa)
              : CONTEXT_CIERRE(nombre, empresa),
        esMX ? "mx" : esCO ? "co" : "cl",
      ).catch(() => {})
      enviados++
      detalle.push({ contact: p.row.contact, accion: p.accion, ok: true, tpl })
    } else {
      detalle.push({ contact: p.row.contact, accion: p.accion, ok: false, tpl })
    }
  }

  // Latido (Lalo 08-ago): tick exitoso queda estampado.
  {
    const { estamparLatido } = await import("@/lib/latido")
    await estamparLatido("outbound").catch(() => undefined)

  }
  return NextResponse.json({
    ok: true,
    activos: rows.length,
    cerrados_respondio: cerradosRespondio,
    cerrados_optout: cerradosOptout,
    saltados_loop_v2: saltadosLoopV2,
    enviados,
    detalle,
  })
}

// pg_cron llama con http_post.
export async function POST(req: Request): Promise<Response> {
  return GET(req)
}
