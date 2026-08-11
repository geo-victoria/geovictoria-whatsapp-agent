/**
 * CRON — PTV: traspaso a vendedor por TTV + chequeo de calidad (doc "Vicky
 * paso a paso", 30-jul). Corre cada 10 min; con TTV mínimo de 15 el error
 * máximo de disparo es aceptable (doc no exige precisión al minuto).
 *
 * Cada tick:
 *  1. Barre conversaciones con actividad reciente cuyo ÚLTIMO mensaje es de
 *     Vicky, y les aplica debeTraspasar() (TTV 120/15 según precio, horario
 *     hábil del país, pausa anunciada suspende, sin traspaso activo previo).
 *  2. Ejecuta el PTV: vendedor por tómbola del país (round-robin persistido
 *     en vic_kv), presentación al prospecto por WhatsApp, asignación del
 *     lead/deal en Zoho, alerta interna "llamar en <5 min", y registro en
 *     vic_ptv con el chequeo agendado a 9 horas hábiles.
 *  3. Barre los chequeos vencidos y pregunta cómo le fue (solo con ventana
 *     de 24 h abierta; si está cerrada queda 'sin_respuesta').
 *
 * DETRÁS DE VICKY_PTV_ENABLED (apagado): responde skipped sin tocar nada.
 * Auth: misma del resto de los crons del repo.
 */

import { NextResponse } from "next/server"
import {
  ptvHabilitado,
  debeTraspasar,
  debeTraspasarEtapa,
  traspasoV2Habilitado,
  CALIFICACION_24H_MIN,
  minutosHabilesEntre,
  vendedoresDePais,
  mensajePresentacion,
  mensajeChequeo,
  sumarHorasHabiles,
} from "@/lib/ptv"
import { sendBotmakerMessage, sendBotmakerTemplate } from "@/lib/botmaker-push-v3"
import { contactosAtendidosPorVendedor } from "@/lib/loop-v2"
import { appendAssistantV3, getFollowupCronSecret, getKvValue, getQuotePointers } from "@/lib/supabase-persistence-v3"
import { avisarEquipoInterno } from "@/lib/alerta-interna"
import { paisDeContacto } from "@/lib/botmaker-tags"
import { isTestContact, testContactSet } from "@/lib/funnel-analysis"
import { despacharHuerfanos } from "@/lib/despachador-huerfanos"

export const dynamic = "force-dynamic"
export const maxDuration = 120

const CRON_SECRET = (process.env.CRON_SECRET || "").trim()
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
// 7 días, no 48 h (caso Fundación Amigos de Jesús / Residencia San Sebastián,
// 10-ago): sus relojes vencieron el viernes 08-ago — día en que el PTV no
// traspasó a NADIE — y el fin de semana las sacó de la ventana de 48 h, así
// que el lunes el motor sano ya no las veía. Un reloj vencido no puede
// prescribir por un feriado largo o una caída: 7 días cubre cualquier hoyo
// de viernes a lunes con margen. El candado UNIQUE de vic_ptv hace inocuo
// re-mirar conversaciones viejas ya traspasadas.
const VENTANA_BARRIDO_MS = 7 * 24 * 3600_000
const VENTANA_META_MS = 24 * 3600_000
const MAX_TRASPASOS_POR_TICK = 15

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

async function supa<T>(path: string, init: RequestInit = {}): Promise<T[]> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return []
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(init.headers || {}),
    },
    cache: "no-store",
  })
  if (!res.ok) return []
  return ((await res.json().catch(() => [])) as T[]) || []
}

/** Feriados vigentes desde vic_holidays (best-effort, formato defensivo). */
async function feriadosDePais(pais: string): Promise<Set<string>> {
  const filas = await supa<Record<string, unknown>>(`vic_holidays?select=*&limit=500`)
  const set = new Set<string>()
  for (const f of filas) {
    // La columna real de vic_holidays es `d` (hallazgo 04-ago: con los otros
    // nombres el set salía vacío y los feriados JAMÁS se aplicaban).
    const fecha = String(f.d || f.date || f.fecha || f.holiday_date || "").slice(0, 10)
    const p = String(f.country || f.pais || "").toLowerCase()
    if (fecha && (!p || p === pais)) set.add(fecha)
  }
  return set
}

/** Turno de tómbola persistido en vic_kv (equitativo entre invocaciones). */
async function siguienteVendedor(pais: "cl" | "co" | "mx" | "pe") {
  const lista = vendedoresDePais(pais)
  if (!lista.length) return null
  const { getKvValue, setKvValue } = await import("@/lib/supabase-persistence-v3")
  const key = `ptv_rr_${pais}`
  const last = parseInt((await getKvValue(key).catch(() => null)) || "-1")
  const idx = (isNaN(last) ? 0 : last + 1) % lista.length
  await setKvValue(key, String(idx)).catch(() => {})
  return lista[idx]
}

/** Regla de tómbola de Deals en ZOHO por país (Lalo, 31-jul): cuando el PTV
 * entrega un DEAL, el dueño lo decide la regla de asignación de Zoho — la
 * misma tómbola que usa el equipo ("Tómbola Deals 2026 Chile") — y no la
 * rotación interna. La rotación interna queda para leads sin deal, para
 * países sin regla configurada y como fallback si la regla falla. */
const TOMBOLA_DEALS_RULE: Record<string, string> = {
  cl: (process.env.VICKY_PTV_TOMBOLA_DEALS_CL || "3525045000595568541").trim(),
  co: (process.env.VICKY_PTV_TOMBOLA_DEALS_CO || "").trim(),
  mx: (process.env.VICKY_PTV_TOMBOLA_DEALS_MX || "").trim(),
}

/** Nombre real para la presentación al prospecto (la tómbola interna solo
 * conoce el email; a un cliente jamás se le dice "emujica"). */
const NOMBRE_VENDEDOR: Record<string, string> = {
  "emujica@geovictoria.com": "Eddyluz Mujica",
  "agordillo@geovictoria.com": "Alejandro Gordillo",
  "egalindo@geovictoria.com": "Eddy Galindo",
  "ysegura@geovictoria.com": "Yahel Segura",
  "mmendozav@geovictoria.com": "Mónica Mendoza",
}

/** WhatsApp de los interinos (directorio verificado 27-jul; Mónica desde su
 * ficha Zoho, 04-ago). Los vendedores sorteados por Zoho traen su teléfono
 * desde su ficha de usuario. */
const WHATSAPP_VENDEDOR: Record<string, string> = {
  "emujica@geovictoria.com": "+56 9 3932 1687",
  "agordillo@geovictoria.com": "+57 314 267 7765",
  "ysegura@geovictoria.com": "+52 55 3763 6604",
  "mmendozav@geovictoria.com": "+51 962 277 502",
}

type VendedorFinal = {
  email: string
  zohoId: string
  nombre: string
  telefono?: string
  via: "tombola_zoho" | "tombola_interna" | "dueno_deal" | "dueno_lead_sdr"
}

/** Aviso por correo al vendedor de un traspaso sobre un LEAD (los deals van
 * con el template oficial vía notificarTraspasoDeal). Hallazgo Anáhuac
 * (31-jul): la alerta central no le llega al vendedor asignado — el correo
 * directo SÍ. La copia a Victoria Luna es SOLO CHILE (Lalo 31-jul): CO y MX
 * siguen con sus reglas antiguas. Best-effort. */
async function notificarTraspasoLeadEmail(
  leadId: string,
  vendedorEmail: string,
  fono: string,
  H: Record<string, string>,
  api: string,
  motivoHtml?: string,
): Promise<void> {
  try {
    const esChile = fono.startsWith("56")
    const cuerpo =
      motivoHtml ||
      "el cliente dejó de responder y venció su tiempo de espera. <b>Llámalo en menos de 5 minutos</b> — la conversación completa está en las notas del lead, precio incluido si se le mostró."
    const { correoEntregable } = await import("@/lib/correo-alias")
    const destino = await correoEntregable(vendedorEmail)
    await fetch(`${api}/crm/v3/Leads/${leadId}/actions/send_mail`, {
      method: "POST",
      headers: H,
      cache: "no-store",
      body: JSON.stringify({
        data: [{
          from: { email: "vicky@geovictoria.com" },
          to: [{ email: destino }],
          ...(esChile ? { cc: [{ email: (process.env.VICKY_TRASPASO_CC || "vluna@geovictoria.com").trim() }] } : {}),
          subject: `Traspaso PTV: llamar YA a +${fono}`,
          content: `<html><body style="font-family:Segoe UI,Arial,sans-serif;color:#2d3748;"><p>Vicky te traspasó esta conversación de WhatsApp: ${cuerpo}</p><p><a href="https://crm.zoho.com/crm/org685875245/tab/Leads/${leadId}">Ver el Lead en Zoho</a></p></body></html>`,
          mail_format: "html",
        }],
      }),
    })
  } catch { /* best-effort */ }
}

/** Teléfono del vendedor desde su ficha de usuario en Zoho (best-effort). */
async function telefonoDeUsuario(userId: string, H: Record<string, string>, api: string): Promise<string> {
  try {
    const r = await fetch(`${api}/crm/v3/users/${userId}`, { headers: H, cache: "no-store" })
    if (!r.ok) return ""
    const u = ((await r.json().catch(() => ({}))) as { users?: Array<{ phone?: string; mobile?: string }> }).users?.[0]
    return (u?.phone || u?.mobile || "").trim()
  } catch {
    return ""
  }
}

/**
 * Asigna en Zoho el lead (o su deal si ya convirtió) y devuelve el vendedor
 * FINAL — que puede diferir de la tómbola interna: si hay deal y el país
 * tiene regla de tómbola en Zoho, el PUT dispara la regla (lar_id) y el
 * dueño que Zoho sortee es quien se presenta al prospecto y recibe la
 * alerta. Best-effort: ante cualquier falla se cae al vendedor interno.
 */
async function asignarEnZoho(
  contact: string,
  pais: string,
  interno: { email: string; zohoId: string },
): Promise<VendedorFinal> {
  const porDefecto: VendedorFinal = {
    ...interno,
    nombre: NOMBRE_VENDEDOR[interno.email] || interno.email.split("@")[0],
    telefono: WHATSAPP_VENDEDOR[interno.email] || "",
    via: "tombola_interna",
  }
  try {
    const { getZohoAccessToken } = await import("@/lib/zoho-token")
    const token = await getZohoAccessToken()
    const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
    const H = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }
    const fono = contact.replace(/\D/g, "")
    const res = await fetch(`${api}/crm/v3/Leads/search?phone=${fono}&converted=both&per_page=3`, { headers: H, cache: "no-store" })
    const lead = res.ok && res.status !== 204
      ? ((await res.json().catch(() => ({}))) as { data?: Array<{ id?: string; Converted_Deal?: { id?: string } | null; Owner?: { id?: string; name?: string; email?: string } }> }).data?.[0]
      : undefined
    if (!lead?.id) {
      // Sin lead en Zoho no hay registro que asignar: se CREA (regla 1 del
      // Proceso de Gestión de Leads: primer contacto → lead automático) ya a
      // nombre del vendedor del traspaso. createZohoLead trae candado y
      // dedup por búsqueda — jamás duplica. Hallazgo de la auditoría 31-jul:
      // 12 de los 36 traspasos del primer día no tenían lead y la asignación
      // quedaba solo en vic_ptv.
      const { createZohoLead } = await import("@/lib/zoho-leads")
      const paisNombre = pais === "co" ? "Colombia" : pais === "mx" ? "México" : "Chile"
      // CO: el lead sin cotización lo posee el SDR Inbound (acuerdo equipo CO
      // 04-ago) — se crea sin dueño y se asigna por round-robin SDR abajo.
      const esCO = pais === "co"
      // CL (Lalo 06-ago): el lead nuevo de un traspaso NO nace con la
      // rotación interna (roster de una sola persona = todo a Eddyluz) —
      // nace sin dueño y lo sortea la regla de calificación (Araceli/Aleydis).
      const esCL = pais === "cl"
      const creado = await createZohoLead({
        nombre: "Prospecto WhatsApp",
        empresa: `Por identificar (WhatsApp +${fono})`,
        telefono: fono,
        contactoWA: fono,
        pais: paisNombre,
        necesidad: "Traspaso PTV: conversación activa con Vicky sin registro previo en el CRM — lead creado al asignar vendedor.",
        ownerEmail: esCO || esCL ? undefined : interno.email,
        ownerId: esCO || esCL ? undefined : interno.zohoId,
      }).catch(() => null)
      if (!creado || !creado.success) {
        console.warn(`[ptv] ${fono}: sin lead en Zoho y la creación falló — asignación solo en vic_ptv`)
      } else if (esCL) {
        const { reasignarLeadCalificacionCL } = await import("@/lib/zoho-leads")
        const r = await reasignarLeadCalificacionCL(creado.leadId).catch(() => null)
        await notificarTraspasoLeadEmail(creado.leadId, r?.ownerEmail || interno.email, fono, H, api)
        if (r?.success && r.ownerEmail && r.ownerId) {
          const tel = await telefonoDeUsuario(r.ownerId, H, api)
          return {
            email: r.ownerEmail,
            zohoId: r.ownerId,
            nombre: r.ownerNombre || NOMBRE_VENDEDOR[r.ownerEmail] || r.ownerEmail.split("@")[0],
            telefono: tel || WHATSAPP_VENDEDOR[r.ownerEmail] || "",
            via: "tombola_zoho",
          }
        }
      } else if (esCO) {
        const { reasignarLeadSdrInboundCO } = await import("@/lib/zoho-leads")
        const r = await reasignarLeadSdrInboundCO(creado.leadId).catch(() => null)
        await notificarTraspasoLeadEmail(creado.leadId, r?.ownerEmail || interno.email, fono, H, api)
        // Regla equipo CO (05-ago): al prospecto se le presenta el DUEÑO del
        // lead (el SDR, Galindo) — jamás un nombre distinto al dueño.
        if (r?.ownerEmail && r?.ownerId) {
          const tel = await telefonoDeUsuario(r.ownerId, H, api)
          return {
            email: r.ownerEmail,
            zohoId: r.ownerId,
            nombre: NOMBRE_VENDEDOR[r.ownerEmail] || r.ownerEmail.split("@")[0],
            telefono: tel || WHATSAPP_VENDEDOR[r.ownerEmail] || "",
            via: "dueno_lead_sdr",
          }
        }
      } else {
        await notificarTraspasoLeadEmail(creado.leadId, interno.email, fono, H, api)
      }
      return porDefecto
    }
    if (lead.Converted_Deal?.id) {
      const dealId = lead.Converted_Deal.id
      // Deal CERRADO = OTRA negociación (Lalo 31-jul): no se toca — el primer
      // barrido le quitó a Grey Meléndez un Cierre Perdido de 2023 y pisó
      // otro de Admin. La dedup/asignación es de procesos ABIERTOS; el
      // registro nuevo de esta conversación lo abre crm-hitos (reglas 4 y 6).
      const gDeal = await fetch(`${api}/crm/v3/Deals/${dealId}?fields=Stage,Owner`, { headers: H, cache: "no-store" })
      const filaDeal = gDeal.ok
        ? ((await gDeal.json().catch(() => ({}))) as { data?: Array<{ Stage?: string; Owner?: { id?: string; name?: string; email?: string } }> }).data?.[0]
        : undefined
      const stage = String(filaDeal?.Stage || "")
      if (/Cierre Perdido|8\. Facturando/.test(stage)) {
        console.warn(`[ptv] ${fono}: su deal ${dealId} está cerrado (${stage}) — no se reasigna; vendedor solo en vic_ptv`)
        return porDefecto
      }
      // Deal con dueño HUMANO vigente (la tómbola ya corrió al crearlo, o lo
      // gestiona un ejecutivo): NO se re-sortea — se presenta a ESE dueño.
      // Re-sortear acá cambiaría el dueño después de que el cliente pudo
      // haber escuchado otro nombre (caso Tosun/vaitiare/Sasval, 31-jul).
      const ownerActual = filaDeal?.Owner
      if (ownerActual?.id && ownerActual?.email && ownerActual.email.toLowerCase() !== "vicky@geovictoria.com") {
        const tel = await telefonoDeUsuario(ownerActual.id, H, api)
        // El dueño vigente recibe su aviso de traspaso (hallazgo Anáhuac:
        // la alerta central no le llega al asignado — el correo directo sí).
        const { notificarTraspasoDeal } = await import("@/lib/crm-hitos")
        await notificarTraspasoDeal(dealId).catch(() => {})
        return {
          email: ownerActual.email,
          zohoId: ownerActual.id,
          nombre: ownerActual.name || ownerActual.email.split("@")[0],
          telefono: tel || WHATSAPP_VENDEDOR[ownerActual.email.toLowerCase()] || "",
          via: "dueno_deal",
        }
      }
      const regla = TOMBOLA_DEALS_RULE[pais] || ""
      if (regla) {
        const put = await fetch(`${api}/crm/v3/Deals`, {
          method: "PUT", headers: H, cache: "no-store",
          body: JSON.stringify({ data: [{ id: dealId }], lar_id: regla }),
        })
        if (put.ok) {
          const get = await fetch(`${api}/crm/v3/Deals/${dealId}?fields=Owner`, { headers: H, cache: "no-store" })
          const owner = ((await get.json().catch(() => ({}))) as { data?: Array<{ Owner?: { id?: string; name?: string; email?: string } }> }).data?.[0]?.Owner
          if (owner?.id && owner?.email) {
            const tel = await telefonoDeUsuario(owner.id, H, api)
            // Notificación de traspaso al dueño sorteado + CC Victoria
            // (template oficial, Lalo 31-jul). Best-effort.
            const { notificarTraspasoDeal } = await import("@/lib/crm-hitos")
            await notificarTraspasoDeal(dealId).catch(() => {})
            return { email: owner.email, zohoId: owner.id, nombre: owner.name || owner.email.split("@")[0], telefono: tel, via: "tombola_zoho" }
          }
        } else {
          console.warn(`[ptv] regla de tómbola Zoho falló (${put.status}) para deal ${dealId} — fallback a tómbola interna`)
        }
      }
      await fetch(`${api}/crm/v3/Deals`, { method: "PUT", headers: H, cache: "no-store", body: JSON.stringify({ data: [{ id: dealId, Owner: { id: interno.zohoId } }], skip_feature_execution: [{ name: "assignment_rules" }] }) })
      const { notificarTraspasoDeal } = await import("@/lib/crm-hitos")
      await notificarTraspasoDeal(dealId).catch(() => {})
    } else if (pais === "co") {
      // CO: lead sin cotización → SDR fijo (Galindo, regla equipo 05-ago).
      // Sin cambios de propietario reales: si ya es de Galindo el PUT es
      // no-op; el prospecto conoce al DUEÑO del lead, no al roster.
      const { reasignarLeadSdrInboundCO } = await import("@/lib/zoho-leads")
      const r = await reasignarLeadSdrInboundCO(lead.id).catch(() => null)
      await notificarTraspasoLeadEmail(lead.id, r?.ownerEmail || interno.email, fono, H, api)
      if (r?.ownerEmail && r?.ownerId) {
        const tel = await telefonoDeUsuario(r.ownerId, H, api)
        return {
          email: r.ownerEmail,
          zohoId: r.ownerId,
          nombre: NOMBRE_VENDEDOR[r.ownerEmail] || r.ownerEmail.split("@")[0],
          telefono: tel || WHATSAPP_VENDEDOR[r.ownerEmail] || "",
          via: "dueno_lead_sdr",
        }
      }
    } else if (pais === "cl") {
      // Lead vivo SIN deal alcanzado por un reloj = Vicky no logró calificarlo
      // a tiempo (Lalo 06-ago): va a la tómbola de leads de calificación
      // (regla Araceli/Aleydis), NO a la rotación interna — el roster interno
      // CL es una sola persona y le llovía todo a Eddyluz (caso Veltis).
      // Dueño humano real no se pisa: se presenta ÉL. Eddyluz cuenta como
      // interina (marcador de "sin dueño real"), igual que Vicky.
      const ownerLead = (lead.Owner?.email || "").toLowerCase()
      const esInterina = !ownerLead || /vicky@|info@geovictoria|emujica@/.test(ownerLead)
      if (!esInterina && lead.Owner?.id) {
        await notificarTraspasoLeadEmail(lead.id, ownerLead, fono, H, api)
        const tel = await telefonoDeUsuario(lead.Owner.id, H, api)
        return {
          email: ownerLead,
          zohoId: lead.Owner.id,
          nombre: lead.Owner.name || NOMBRE_VENDEDOR[ownerLead] || ownerLead.split("@")[0],
          telefono: tel || WHATSAPP_VENDEDOR[ownerLead] || "",
          via: "dueno_lead_sdr",
        }
      }
      const { reasignarLeadCalificacionCL } = await import("@/lib/zoho-leads")
      const r = await reasignarLeadCalificacionCL(lead.id).catch(() => null)
      if (r?.success && r.ownerEmail && r.ownerId) {
        await notificarTraspasoLeadEmail(lead.id, r.ownerEmail, fono, H, api)
        const tel = await telefonoDeUsuario(r.ownerId, H, api)
        return {
          email: r.ownerEmail,
          zohoId: r.ownerId,
          nombre: r.ownerNombre || NOMBRE_VENDEDOR[r.ownerEmail] || r.ownerEmail.split("@")[0],
          telefono: tel || WHATSAPP_VENDEDOR[r.ownerEmail] || "",
          via: "tombola_zoho",
        }
      }
      // Fallback (regla y RR fallaron): rotación interna como siempre.
      await fetch(`${api}/crm/v3/Leads`, { method: "PUT", headers: H, cache: "no-store", body: JSON.stringify({ data: [{ id: lead.id, Owner: { id: interno.zohoId } }], skip_feature_execution: [{ name: "assignment_rules" }] }) })
      await notificarTraspasoLeadEmail(lead.id, interno.email, fono, H, api)
    } else {
      await fetch(`${api}/crm/v3/Leads`, { method: "PUT", headers: H, cache: "no-store", body: JSON.stringify({ data: [{ id: lead.id, Owner: { id: interno.zohoId } }], skip_feature_execution: [{ name: "assignment_rules" }] }) })
      await notificarTraspasoLeadEmail(lead.id, interno.email, fono, H, api)
    }
    return porDefecto
  } catch (e) {
    console.warn("[ptv] asignarEnZoho falló:", e instanceof Error ? e.message : e)
    return porDefecto
  }
}

/** ¿La cotización formal vigente del contacto ya está Aceptada en Zoho?
 * Solo se consulta para CANDIDATOS a traspaso v2 (barato). Best-effort:
 * ante cualquier duda devuelve false (el traspaso procede). */
async function cotizacionAceptada(contact: string): Promise<boolean> {
  try {
    const pointers = await getQuotePointers(contact).catch(() => [])
    const quoteId = pointers[0]?.quoteId
    if (!quoteId) return false
    const { getZohoAccessToken } = await import("@/lib/zoho-token")
    const token = await getZohoAccessToken()
    const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
    const modulo = (process.env.ZOHO_QUOTE_MODULE || "Cotizaciones_GeoVictoria").trim()
    const r = await fetch(`${api}/crm/v3/${modulo}/${quoteId}?fields=Estado_Cotizacion`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      cache: "no-store",
    })
    if (!r.ok) return false
    const estado = String(
      ((await r.json().catch(() => ({}))) as { data?: Array<{ Estado_Cotizacion?: string }> }).data?.[0]
        ?.Estado_Cotizacion || "",
    )
    return /aceptada|pagada/i.test(estado)
  } catch {
    return false
  }
}

// ── Reloj de calificación 24 h hábiles → tómbola de RE-ASIGNACIÓN (Lalo
// 03-ago, solo CL). Conversación sin intención comercial detectable en 24 h
// hábiles → el lead (se crea si no existe) se re-asigna por la regla de Zoho
// "Re-asignación de Vicky" a un ejecutivo de telemarketing, que hereda la
// calificación. La notificación al ejecutivo la da Zoho (regla); Vicky
// presenta al ejecutivo por la plantilla HSM (la ventana está cerrada por
// definición: el cliente no responde hace 24 h hábiles). ────────────────────
// Regla de re-asignación por país: CL usa la regla de Zoho (tómbola de
// telemarketing); PE no tiene tómbola — regla vacía = asignación DIRECTA a la
// ejecutiva del país (vendedoresDePais). Extensible por env.
const TM_REGLA: Record<string, string> = {
  cl: (process.env.VICKY_TM_REASIGNACION_RULE_CL || "3525045000649066001").trim(),
  pe: (process.env.VICKY_TM_REASIGNACION_RULE_PE || "").trim(),
}
const TM_PAIS_NOMBRE: Record<string, string> = { cl: "Chile", pe: "Perú" }
// VICKY PE AUTÓNOMA (orden de Lalo 11-ago, pre-encendido): en Perú NO se
// presenta a nadie por ahora — sin traspasos de etapa ni de calificación
// mientras Vicky PE sea autónoma (Mónica igual recibe los LEADS por los
// caminos de registro; lo que se apaga es el traspaso de la CONVERSACIÓN y
// la presentación al prospecto). Reencender sin deploy: vic_kv
// pe_presentacion=on (o env VICKY_PE_PRESENTACION=on).
async function pePresentaHabilitado(): Promise<boolean> {
  if ((process.env.VICKY_PE_PRESENTACION || "").trim().toLowerCase() === "on") return true
  try {
    const { getKvValue } = await import("@/lib/supabase-persistence-v3")
    return ((await getKvValue("pe_presentacion")) || "").trim().toLowerCase() === "on"
  } catch {
    return false
  }
}
const TM_FONO_REGEX: Record<string, RegExp> = { cl: /^56\d{8,10}$/, pe: /^51\d{8,10}$/ }
const TM_TEMPLATE = (process.env.VICKY_TM_TEMPLATE_PRESENTACION || "vicky_traspaso_ejecutivo").trim()
const MAX_TM_POR_TICK = 10
/** Teléfonos de los telemarketers ("email:+56...,email:+56..."). Fallback:
 * campo Phone/Mobile de su ficha de usuario en Zoho. */
function telefonoTmPorEmail(email: string): string {
  const raw = (process.env.VICKY_TM_TELEFONOS || "").trim()
  for (const par of raw.split(",")) {
    const [e, tel] = par.split(":").map((x) => (x || "").trim())
    if (e && tel && e.toLowerCase() === email.toLowerCase()) return tel
  }
  return ""
}

type CandidatoTM = { contact: string; origen: "outbound" | "inbound"; pais: "cl" | "pe" }

async function traspasarATelemarketing(
  contact: string,
  origen: string,
  ahora: Date,
  feriados: Set<string>,
  pais: "cl" | "pe" = "cl",
): Promise<{ ok: boolean; vendedor?: string; detalle?: string }> {
  // Candado primero (UNIQUE contact+activo evita dobles).
  const fila = await supa<{ id: string }>(`vic_ptv`, {
    method: "POST",
    body: JSON.stringify({
      contact,
      motivo: `sin_calificar_24h_${origen}`,
      ttv_minutos: CALIFICACION_24H_MIN,
      precio_mostrado: false,
      vendedor_email: "",
      vendedor_zoho_id: "",
      vendedor_nombre: "",
      chequeo_at: sumarHorasHabiles(ahora, 9, pais, feriados).toISOString(),
    }),
  })
  if (!fila.length) return { ok: false, detalle: "candado" }

  try {
    const { getZohoAccessToken } = await import("@/lib/zoho-token")
    const token = await getZohoAccessToken()
    const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
    const H = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }
    const fono = contact.replace(/\D/g, "")

    // 1. Lead: buscar; con deal convertido NO es un sin-calificar (fuera).
    const s = await fetch(`${api}/crm/v3/Leads/search?phone=${fono}&converted=both&per_page=3`, { headers: H, cache: "no-store" })
    const lead = s.ok && s.status !== 204
      ? ((await s.json().catch(() => ({}))) as {
          data?: Array<{ id?: string; First_Name?: string; Converted_Deal?: { id?: string } | null; Owner?: { id?: string; email?: string; name?: string } }>
        }).data?.[0]
      : undefined
    if (lead?.Converted_Deal?.id) {
      await supa(`vic_ptv?id=eq.${fila[0].id}`, { method: "PATCH", body: JSON.stringify({ estado: "cerrado" }) })
      // Con DEAL convertido la conversación NO es "sin calificar": se cierra
      // también su fila del loop para que no vuelva a candidatearse en cada
      // tick (primer barrido 03-ago: dos contactos reintentaban infinito).
      await supa(`vic_loop?contact=eq.${encodeURIComponent(contact)}`, {
        method: "PATCH",
        body: JSON.stringify({ estado: "cerrado", motivo_cierre: "tm_no_aplica_deal" }),
      })
      return { ok: false, detalle: "tiene deal — no es sin-calificar" }
    }

    let leadId = lead?.id || ""
    const ownerActual = (lead?.Owner?.email || "").toLowerCase()
    const ownerBot = !ownerActual || /vicky@|info@geovictoria/.test(ownerActual)
    if (!leadId) {
      // Sin lead → se crea (regla 1 del Proceso de Gestión de Leads) y la
      // regla de re-asignación decide el dueño en el paso siguiente.
      const { createZohoLead } = await import("@/lib/zoho-leads")
      const creado = await createZohoLead({
        nombre: "Prospecto WhatsApp",
        empresa: `Por identificar (WhatsApp +${fono})`,
        telefono: fono,
        contactoWA: fono,
        pais: TM_PAIS_NOMBRE[pais] || "Chile",
        necesidad: `Traspaso a telemarketing: ${origen === "outbound" ? "outbound sin respuesta" : "inbound sin responder la primera pregunta"} en 24 horas hábiles — el ejecutivo califica.`,
      }).catch(() => null)
      if (!creado || !creado.success) {
        await supa(`vic_ptv?id=eq.${fila[0].id}`, { method: "PATCH", body: JSON.stringify({ estado: "cerrado" }) })
        return { ok: false, detalle: "no se pudo crear el lead" }
      }
      leadId = creado.leadId
    }

    // 2. Dueño: si el lead ya es de un HUMANO, no se pisa su gestión (regla
    // marketing 30-jul) — ese humano es el ejecutivo que se presenta. Si es
    // del bot: CL va a la TÓMBOLA DE LEADS DE CALIFICACIÓN — la regla de Zoho
    // "Asignación Leads Vicky TLMK" cuyo roster Lalo dejó en Araceli y Aleydis
    // (06-ago: "lo que no ha podido calificar vuelve a Aleydis y Aracelli";
    // reasignarLeadCalificacionCL dispara la regla y solo si no asigna cae al
    // round-robin interno de ellas dos) — y PE (sin tómbola) asigna directo a
    // la ejecutiva del país (Mónica).
    let owner = lead?.Owner && !ownerBot ? lead.Owner : undefined
    if (!owner?.id && pais === "cl") {
      const { reasignarLeadCalificacionCL } = await import("@/lib/zoho-leads")
      const r = await reasignarLeadCalificacionCL(leadId)
      if (r.success && r.ownerId && r.ownerEmail) {
        owner = { id: r.ownerId, email: r.ownerEmail, name: r.ownerNombre }
      } else {
        console.warn(`[tm-24h] tómbola de calificación falló lead=${leadId}: ${r.error || "sin detalle"}`)
      }
    }
    if (!owner?.id) {
      const regla = (pais === "cl" ? (process.env.VICKY_TM_CALIFICACION_RULE_ID || "").trim() : "") || TM_REGLA[pais] || ""
      if (regla) {
        const put = await fetch(`${api}/crm/v3/Leads`, {
          method: "PUT", headers: H, cache: "no-store",
          body: JSON.stringify({ data: [{ id: leadId }], lar_id: regla }),
        })
        if (!put.ok) console.warn(`[tm-24h] regla de re-asignación falló (${put.status}) lead=${leadId}`)
        const g = await fetch(`${api}/crm/v3/Leads/${leadId}?fields=Owner,First_Name`, { headers: H, cache: "no-store" })
        owner = ((await g.json().catch(() => ({}))) as { data?: Array<{ Owner?: { id?: string; email?: string; name?: string } }> }).data?.[0]?.Owner
      } else {
        const { vendedoresDePais } = await import("@/lib/ptv")
        const interno = vendedoresDePais(pais)[0]
        if (interno?.zohoId) {
          await fetch(`${api}/crm/v3/Leads`, {
            method: "PUT", headers: H, cache: "no-store",
            body: JSON.stringify({
              data: [{ id: leadId, Owner: { id: interno.zohoId } }],
              skip_feature_execution: [{ name: "assignment_rules" }],
            }),
          }).catch(() => {})
          owner = { id: interno.zohoId, email: interno.email, name: NOMBRE_VENDEDOR[interno.email] || interno.email.split("@")[0] }
        }
      }
    }
    if (!owner?.id || !owner.email) {
      await supa(`vic_ptv?id=eq.${fila[0].id}`, { method: "PATCH", body: JSON.stringify({ estado: "cerrado" }) })
      return { ok: false, detalle: "sin dueño tras la regla" }
    }

    // 3. Registro final del traspaso.
    await supa(`vic_ptv?id=eq.${fila[0].id}`, {
      method: "PATCH",
      body: JSON.stringify({
        vendedor_email: owner.email,
        vendedor_zoho_id: owner.id,
        vendedor_nombre: owner.name || owner.email.split("@")[0],
      }),
    })

    // 3b. Correo DIRECTO al vendedor (caso Paola Díaz 04-ago: la asignación
    // por regla de Zoho no le avisa de forma visible al asignado — mismo
    // hallazgo Anáhuac del 31-jul en los traspasos de nivel lead. Sin este
    // correo, el ejecutivo no se entera de que Vicky le entregó el lead).
    await notificarTraspasoLeadEmail(
      leadId,
      owner.email,
      contact,
      H,
      api,
      `no logró calificarla en 24 horas hábiles (${origen === "sin_calificar_24h_inbound" ? "el cliente escribió y no respondió la primera pregunta" : "outbound sin respuesta desde el primer toque"}). <b>El lead ahora es tuyo</b> — la transcripción está en sus notas.`,
    ).catch(() => {})

    // 4. Presentación por PLANTILLA (regla dura: ejecutivo, teléfono y correo
    // son obligatorios — sin teléfono no sale, antes que presentar a medias).
    const telefono = telefonoTmPorEmail(owner.email) || (await telefonoDeUsuario(owner.id, H, api))
    if (telefono) {
      const params: Record<string, string> = {
        nombre: (lead?.First_Name || "").trim() || "👋",
        ejecutivo_smb: owner.name || owner.email.split("@")[0],
        telefono_ejecutivo: telefono,
        correoElectronico: owner.email,
      }
      const enviado = await sendBotmakerTemplate(contact, TM_TEMPLATE, params).catch(() => false)
      if (enviado) {
        await supa(`vic_ptv?id=eq.${fila[0].id}`, { method: "PATCH", body: JSON.stringify({ presentado_al_prospecto: true }) })
        await appendAssistantV3(
          contact,
          `[Plantilla ${TM_TEMPLATE}]: presenté a ${params.ejecutivo_smb} (${telefono} · ${owner.email}) como tu ejecutivo de acompañamiento.`,
        ).catch(() => {})
      }
    } else {
      console.warn(`[tm-24h] ${contact}: sin teléfono para ${owner.email} — traspaso sin presentación (el ejecutivo llama directo)`)
    }

    // 5. El traspaso apaga la cadencia del loop para este contacto.
    await supa(`vic_loop?contact=eq.${encodeURIComponent(contact)}`, {
      method: "PATCH",
      body: JSON.stringify({ estado: "cerrado", motivo_cierre: "tm_traspasado" }),
    })
    console.log(`[tm-24h] ${contact} → ${owner.email} (${origen})`)
    return { ok: true, vendedor: owner.email }
  } catch (e) {
    console.warn(`[tm-24h] ${contact} falló:`, e instanceof Error ? e.message : e)
    return { ok: false, detalle: "excepción" }
  }
}

export async function GET(req: Request) {
  if (!(await authorized(req))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }
  if (!ptvHabilitado()) {
    {
      const { estamparLatido } = await import("@/lib/latido")
      await estamparLatido("ptv").catch(() => undefined)
    }
    return NextResponse.json({ ok: true, skipped: "VICKY_PTV_ENABLED off" })
  }
  // Candado de turno (barrido acelerado 10-ago): agenda externa + despacho
  // cada 2 min desde vic-callback-cron. Dos ticks solapados traspasarían al
  // mismo contacto dos veces (dos presentaciones). Uno solo tiene el turno.
  const { reclamarTurno, liberarTurno } = await import("@/lib/cron-lock")
  if (!(await reclamarTurno("ptv"))) {
    return NextResponse.json({ ok: true, skipped: "otro tick en curso" })
  }
  try {

  const ahora = new Date()
  const desde = new Date(ahora.getTime() - VENTANA_BARRIDO_MS).toISOString()
  // Flag del traspaso v2: env O vic_kv (traspaso_v2_enabled=on) — la clave kv
  // permite encender/apagar al instante sin tocar el env de Vercel.
  const v2Activo =
    traspasoV2Habilitado() ||
    ((await getKvValue("traspaso_v2_enabled").catch(() => null)) || "").trim() === "on"

  // 1. Conversaciones con actividad reciente + su compromiso de pausa (vic_loop).
  const convs = await supa<{
    contact: string
    country: string | null
    last_user_at: string | null
    updated_at: string
    pref_escalon: number | null
    pref_escalon_at: string | null
    pref_quote_id: string | null
    formal_quote_id: string | null
    formal_quote_at: string | null
    followup_closed_reason: string | null
    first_user_at: string | null
    user_msg_count: number | null
  }>(
    `vic_v3_conversations?updated_at=gte.${encodeURIComponent(desde)}` +
      `&select=contact,country,last_user_at,updated_at,pref_escalon,pref_escalon_at,pref_quote_id,formal_quote_id,formal_quote_at,followup_closed_reason,first_user_at,user_msg_count&order=updated_at.desc&limit=1000`,
  )
  const activos = await supa<{ contact: string }>(`vic_ptv?estado=eq.activo&select=contact&limit=1000`)
  const conTraspaso = new Set(activos.map((a) => a.contact))
  // >50 detectados (Lalo 06-ago): "no pasa por el proceso de traspaso" — su
  // camino es tómbola de deals (calificado), tómbola de leads de calificación
  // (sin número) u host de reunión. El reloj de etapa NO les corre (caso
  // Veltis: derivado >50 a las 13:00 y el reloj de 120' lo traspasó igual).
  const mas50 = await supa<{ contact: string }>(
    `vic_loop?motivo_cierre=in.(mas_de_50,sobre_umbral)&select=contact&limit=1000`,
  )
  const contactosMas50 = new Set(mas50.map((m) => m.contact))
  const pausas = await supa<{ contact: string; compromiso_at: string | null }>(
    `vic_loop?select=contact,compromiso_at&compromiso_at=not.is.null&limit=500`,
  )
  const compromisoPor = new Map(pausas.map((p) => [p.contact, p.compromiso_at]))

  const traspasados: Array<{ contact: string; vendedor: string; ttv: number }> = []
  const contactosPrueba = testContactSet()
  for (const c of convs) {
    if (traspasados.length >= MAX_TRASPASOS_POR_TICK) break
    // Elegibilidad (fix 31-jul, cazado en el primer día encendido):
    //  - contactos internos de prueba NUNCA se traspasan (el tester terminó
    //    en la bandeja de Eddyluz con orden de llamarlo en 5 minutos);
    //  - solo teléfonos DISCABLES (56/57/52...): el PTV exige que el vendedor
    //    LLAME — los IDs anónimos de Meta (CIMA "CO.10259...") no tienen
    //    número y esa conversación se queda con Vicky por chat.
    if (isTestContact(c.contact, contactosPrueba)) continue
    if (!/^(56|57|52|51)\d{8,12}$/.test(c.contact)) continue
    const pais = (paisDeContacto(c.contact) || (c.country as "cl" | "co" | "mx" | "pe" | null))
    if (!pais) continue
    // opt-out/soporte/perdido: el loop ya cerró esta conversación — no traspasar.
    if (c.followup_closed_reason) continue
    // >50: fuera del proceso de traspaso (Lalo 06-ago).
    if (contactosMas50.has(c.contact)) continue
    // Reloj TTV: el silencio se mide desde el último mensaje del CLIENTE.
    // updated_at se mueve con cada toque del Loop, y usarlo de referencia
    // reiniciaba el TTV en cada toque (brecha 1, 30-jul). Sin mensaje del
    // cliente no hay TTV que medir: esa conversación la gobierna el Loop.
    if (!c.last_user_at) continue
    const ultimoCliente = new Date(c.last_user_at)
    // ESTRICTO, no >= (caso Fundación Amigos de Jesús, 10-ago): cuando el
    // mensaje del cliente y la respuesta de Vicky quedan grabados en el
    // MISMO milisegundo, el empate hacía "cliente activo" verdadero para
    // siempre y esa conversación nunca más era traspasable. El empate
    // significa que Vicky YA respondió (los appends van en orden); el único
    // instante genuinamente ambiguo — cliente recién escribió y Vicky aún no
    // contesta — es inofensivo con >, porque ese mismo mensaje acaba de
    // reiniciar el reloj de silencio a cero.
    const clienteRespondioDespues = ultimoCliente.getTime() > new Date(c.updated_at).getTime()
    const feriados = await feriadosDePais(pais)
    const compromisoAt = compromisoPor.get(c.contact) ? new Date(String(compromisoPor.get(c.contact))) : null
    // TRASPASO v2 (CL desde 03-ago; PE desde el día uno — Lalo 04-ago; CO
    // desde 05-ago — mismo flujo de relojes que Chile, ok de Lalo): relojes
    // de DURACIÓN DE ETAPA en minutos hábiles reemplazan a los TTV de
    // silencio — corren aunque el cliente converse. En CO el traspaso AVISA
    // y presenta al dueño vigente, JAMÁS cambia propietarios (regla equipo
    // CO: el primero se lo queda hasta el final — asignarEnZoho ya respeta
    // dueños humanos, y todos los registros CO nacen con Galindo/Gordillo).
    // MX en v2 desde el 08-ago (réplica ordenada por Lalo); con flag apagado, todos vuelven al TTV clásico.
    // PE autónoma (Lalo 11-ago): sin presentación, la conversación peruana
    // no se traspasa por relojes — Vicky la sigue atendiendo.
    if (pais === "pe" && !(await pePresentaHabilitado())) continue
    const usaV2 = v2Activo && (pais === "cl" || pais === "pe" || pais === "co" || pais === "mx")
    const decision = usaV2
      ? debeTraspasarEtapa({
          firstUserAt: c.first_user_at ? new Date(c.first_user_at) : null,
          userMsgCount: Number(c.user_msg_count || 0),
          precioAt: c.pref_escalon_at ? new Date(c.pref_escalon_at) : null,
          formalAt: c.formal_quote_at ? new Date(c.formal_quote_at) : null,
          aceptada: false, // se verifica en Zoho SOLO si la decisión es traspasar
          // Relojes con-precio de SILENCIO (08-ago): misma referencia que el
          // TTV clásico — el último mensaje del CLIENTE, que los toques del
          // Loop no mueven; cliente activo (nos debe respuesta Vicky) = no corre.
          ultimoClienteAt: ultimoCliente,
          clienteRespondioDespues,
          pais,
          ahora,
          feriados,
          compromisoAt,
          traspasoActivo: conTraspaso.has(c.contact),
        })
      : debeTraspasar({
          referenciaRelojAt: ultimoCliente,
          clienteRespondioDespues,
          precioMostrado: Boolean(c.pref_escalon !== null || c.pref_quote_id || c.formal_quote_id),
          pais,
          ahora,
          feriados,
          compromisoAt,
          traspasoActivo: conTraspaso.has(c.contact),
        })
    if (!decision.traspasar) continue
    // v2, etapas con cotización de por medio: si la vigente ya está ACEPTADA
    // en Zoho, no hay demora que castigar — el cliente está en el pago.
    if (usaV2 && decision.motivo !== "etapa_sin_preform") {
      if (await cotizacionAceptada(c.contact)) continue
    }

    const interno = await siguienteVendedor(pais)
    if (!interno) continue
    // Registro PRIMERO (candado UNIQUE evita carrera de doble traspaso).
    const fila = await supa<{ id: string }>(`vic_ptv`, {
      method: "POST",
      body: JSON.stringify({
        contact: c.contact,
        motivo: decision.motivo,
        ttv_minutos: decision.ttv,
        precio_mostrado: Boolean(c.pref_escalon !== null || c.pref_quote_id || c.formal_quote_id),
        vendedor_email: interno.email,
        vendedor_zoho_id: interno.zohoId,
        vendedor_nombre: NOMBRE_VENDEDOR[interno.email] || interno.email.split("@")[0],
        chequeo_at: sumarHorasHabiles(ahora, 9, pais, feriados).toISOString(),
      }),
    })
    if (!fila.length) continue // candado: ya había traspaso activo
    // Asignación en Zoho ANTES de presentar: si el deal pasa por la regla de
    // tómbola de Zoho, el dueño que Zoho sorteó es quien se presenta al
    // prospecto y quien recibe la alerta — nunca un nombre distinto al dueño.
    const vendedor = await asignarEnZoho(c.contact, pais, interno)
    if (vendedor.email !== interno.email) {
      await supa(`vic_ptv?id=eq.${fila[0].id}`, {
        method: "PATCH",
        body: JSON.stringify({ vendedor_email: vendedor.email, vendedor_zoho_id: vendedor.zohoId, vendedor_nombre: vendedor.nombre }),
      })
    }
    // Presentación al prospecto (solo con ventana Meta abierta).
    const ventanaAbierta = Boolean(c.last_user_at && ahora.getTime() - new Date(c.last_user_at).getTime() < VENTANA_META_MS)
    if (ventanaAbierta) {
      const texto = mensajePresentacion(pais, vendedor.nombre, { email: vendedor.email, whatsapp: vendedor.telefono })
      const enviado = await sendBotmakerMessage(c.contact, texto).catch(() => false)
      if (enviado) {
        await appendAssistantV3(c.contact, texto).catch(() => {})
        await supa(`vic_ptv?id=eq.${fila[0].id}`, { method: "PATCH", body: JSON.stringify({ presentado_al_prospecto: true }) })
      }
    }
    // El traspaso APAGA la cadencia automática de esta conversación: con un
    // vendedor encima, Vicky no sigue mandando toques (el único contacto
    // proactivo posterior es el chequeo de calidad de las 9 h hábiles).
    // Vicky sigue respondiendo REACTIVAMENTE si el cliente escribe.
    await supa(`vic_loop?contact=eq.${encodeURIComponent(c.contact)}`, {
      method: "PATCH",
      body: JSON.stringify({ estado: "cerrado", motivo_cierre: "ptv_traspasado" }),
    })
    await avisarEquipoInterno(
      `📞 PTV: traspaso a ${vendedor.email} — contacto +${c.contact} (TTV ${decision.ttv} min vencido, ${decision.motivo}). LLAMAR EN MENOS DE 5 MINUTOS. La conversación completa está en las notas del registro en Zoho; si hay link de pago vigente, empujar el mismo link.`,
    ).catch(() => {})
    traspasados.push({ contact: c.contact, vendedor: vendedor.email, ttv: decision.ttv || 0 })
  }

  // 2bis. Reloj de calificación 24 h hábiles → telemarketing (v2, solo CL).
  // Solo en horario hábil: a nadie se le entrega un lead a las 3 AM.
  const tmTraspasados: Array<{ contact: string; vendedor?: string; origen: string; pais: string }> = []
  if (v2Activo) {
    const { esHorarioHabil } = await import("@/lib/ptv")
    const candidatos: CandidatoTM[] = []
    const feriadosPorPais: Record<string, Set<string>> = {}
    // CL con tómbola de re-asignación; PE directo a Mónica (Lalo 04-ago:
    // Perú nace con el traspaso v2 — la contención ya persiste sus
    // conversaciones, así que los leads peruanos llegan a la ejecutiva
    // ANTES de que Vicky PE venda).
    // PE autónoma (Lalo 11-ago): el reloj de calificación PE también queda
    // en pausa — sin presentaciones en Perú hasta nueva orden.
    const paisesTm: Array<"cl" | "pe"> = (await pePresentaHabilitado()) ? ["cl", "pe"] : ["cl"]
    for (const paisTm of paisesTm) {
      const feriados = await feriadosDePais(paisTm)
      feriadosPorPais[paisTm] = feriados
      // Solo en horario hábil del país: a nadie se le entrega un lead a las 3 AM.
      if (!esHorarioHabil(paisTm, ahora, feriados)) continue
      const regex = TM_FONO_REGEX[paisTm]
      // Outbound: enrolado en el loop, sin respuesta (estado activo) y con el
      // toque 0 hace ≥24 h hábiles. La pausa anunciada suspende.
      const enLoop = await supa<{ contact: string; t0: string; compromiso_at: string | null }>(
        `vic_loop?estado=eq.activo&country=eq.${paisTm}&select=contact,t0,compromiso_at&limit=300`,
      )
      for (const r of enLoop) {
        if (candidatos.length >= MAX_TM_POR_TICK) break
        if (!regex.test(r.contact)) continue
        if (conTraspaso.has(r.contact)) continue
        if (isTestContact(r.contact, contactosPrueba)) continue
        if (r.compromiso_at && new Date(r.compromiso_at) > ahora) continue
        if (minutosHabilesEntre(new Date(r.t0), ahora, paisTm, feriados) < CALIFICACION_24H_MIN) continue
        candidatos.push({ contact: r.contact, origen: "outbound", pais: paisTm })
      }
      // Inbound: escribió UNA vez, no respondió la primera pregunta y no hay
      // hito comercial. Ventana de 14 días para no revivir fósiles.
      const desdeInbound = new Date(ahora.getTime() - 14 * 24 * 3600_000).toISOString()
      const corte24hCalendario = new Date(ahora.getTime() - 24 * 3600_000).toISOString()
      const inbound = await supa<{ contact: string; first_user_at: string | null; followup_closed_reason: string | null }>(
        `vic_v3_conversations?user_msg_count=eq.1&country=eq.${paisTm}&pref_quote_id=is.null&formal_quote_id=is.null` +
          `&followup_closed_reason=is.null&first_user_at=gte.${encodeURIComponent(desdeInbound)}` +
          `&first_user_at=lte.${encodeURIComponent(corte24hCalendario)}&select=contact,first_user_at,followup_closed_reason&limit=200`,
      )
      for (const r of inbound) {
        if (candidatos.length >= MAX_TM_POR_TICK) break
        if (!r.first_user_at) continue
        if (!regex.test(r.contact)) continue
        if (conTraspaso.has(r.contact)) continue
        if (isTestContact(r.contact, contactosPrueba)) continue
        if (compromisoPor.get(r.contact) && new Date(String(compromisoPor.get(r.contact))) > ahora) continue
        if (minutosHabilesEntre(new Date(r.first_user_at), ahora, paisTm, feriados) < CALIFICACION_24H_MIN) continue
        // Hitos fuera de la conversación: reunión agendada o llamada pedida =
        // intención comercial → NO va a telemarketing por esta vía.
        const reuniones = await supa<{ id: string }>(`vic_v3_meetings?contact=eq.${encodeURIComponent(r.contact)}&select=id&limit=1`)
        if (reuniones.length) continue
        const llamadas = await supa<{ id: string }>(`vic_scheduled_calls?contact=eq.${encodeURIComponent(r.contact)}&select=id&limit=1`)
        if (llamadas.length) continue
        candidatos.push({ contact: r.contact, origen: "inbound", pais: paisTm })
      }
    }
    for (const cand of candidatos) {
      const r = await traspasarATelemarketing(cand.contact, cand.origen, ahora, feriadosPorPais[cand.pais], cand.pais)
      if (r.ok) {
        conTraspaso.add(cand.contact)
        tmTraspasados.push({ contact: cand.contact, vendedor: r.vendedor, origen: cand.origen, pais: cand.pais })
      }
    }
  }

  // 3. Chequeos de calidad vencidos.
  const chequeos = await supa<{ id: string; contact: string; vendedor_email: string; vendedor_nombre: string | null }>(
    `vic_ptv?estado=eq.activo&chequeo_hecho_at=is.null&chequeo_at=lte.${encodeURIComponent(ahora.toISOString())}&select=id,contact,vendedor_email,vendedor_nombre&limit=20`,
  )
  let chequeosEnviados = 0
  for (const ch of chequeos) {
    const conv = convs.find((c) => c.contact === ch.contact)
    const pais = (paisDeContacto(ch.contact) || "cl") as "cl" | "co" | "mx" | "pe"
    const ventanaAbierta = Boolean(conv?.last_user_at && ahora.getTime() - new Date(conv.last_user_at).getTime() < VENTANA_META_MS)
    if (ventanaAbierta) {
      // Jamás un prefijo de correo en la cara del cliente: si no conocemos el
      // nombre, el chequeo pregunta por "nuestro ejecutivo" (filas viejas de
      // vic_ptv sin vendedor_nombre — auditoría 31-jul).
      const texto = mensajeChequeo(pais, ch.vendedor_nombre || NOMBRE_VENDEDOR[ch.vendedor_email] || "nuestro ejecutivo")
      const enviado = await sendBotmakerMessage(ch.contact, texto).catch(() => false)
      if (enviado) {
        await appendAssistantV3(ch.contact, texto).catch(() => {})
        chequeosEnviados++
      }
      await supa(`vic_ptv?id=eq.${ch.id}`, { method: "PATCH", body: JSON.stringify({ chequeo_hecho_at: ahora.toISOString(), chequeo_resultado: enviado ? null : "sin_respuesta" }) })
    } else {
      await supa(`vic_ptv?id=eq.${ch.id}`, { method: "PATCH", body: JSON.stringify({ chequeo_hecho_at: ahora.toISOString(), chequeo_resultado: "sin_respuesta" }) })
    }
  }

  // 4. CANDADO v3 (Lalo 07-ago, "haz la 2"): el traspaso ya no silencia a
  // Vicky hasta que el vendedor haga contacto REAL. Esta reconciliación
  // mantiene el vic_loop en sincronía con esa regla, en ambas direcciones.
  const reconciliacion = await reconciliarSilencioTraspasos().catch((e) => {
    console.warn("[ptv-cron] reconciliación de silencio falló:", e instanceof Error ? e.message : e)
    return { reabiertos: 0, recerrados: 0 }
  })

  // 5. ESCALADA SLA 60' (punto 1, Lalo 08-ago): traspaso activo sin contacto
  // real del vendedor a los 60 min hábiles → alerta interna, una sola vez.
  const slaAlertas = await escaladaSla(ahora).catch((e) => {
    console.warn("[ptv-cron] escalada SLA falló:", e instanceof Error ? e.message : e)
    return 0
  })

  // 6. VÁLVULA DE PRECIO (punto 2, Lalo 08-ago): derivación sobre-umbral sin
  // contacto del vendedor en N horas hábiles → Vicky recupera el precio.
  const valvulas = await abrirValvulasDePrecio(ahora).catch((e) => {
    console.warn("[ptv-cron] válvulas de precio fallaron:", e instanceof Error ? e.message : e)
    return 0
  })

  // 7. COBRO ASISTIDO (punto 2 de la segunda tanda, Lalo 08-ago): cotización
  // ACEPTADA hace 30+ minutos sin señal de pago → un empujón de pago único.
  // El cliente que aceptó es el más caliente de todo el embudo.
  const cobros = await cobroAsistido(ahora).catch((e) => {
    console.warn("[ptv-cron] cobro asistido falló:", e instanceof Error ? e.message : e)
    return { enviados: 0, pendientes: 0 }
  })

  // Latido (Lalo 08-ago): tick exitoso queda estampado; este cron vigila a los demás.
  {
    const { estamparLatido, vigilarLatidos } = await import("@/lib/latido")
    await estamparLatido("ptv").catch(() => undefined)
    await vigilarLatidos("ptv").catch(() => undefined)
  }

  // 8. CRONES HUÉRFANOS (Lalo 10-ago, "arréglalo"): vic-espejo-notas-cron y
  // vic-mudos-cron están declarados en vercel.json pero el scheduler real
  // nunca los dispara (el cron de Vercel corre contra el deployment de master
  // viejo). Este cron SÍ corre cada 10 minutos, así que los despacha él.
  const huerfanos = await despacharHuerfanos().catch(() => [] as string[])

  // 9. LEADS CRUZADOS DE PAÍS (caso Aleydis/+51994037412, 11-ago): la regla
  // de Zoho "Asignación Leads Vicky TLMK" corre ASÍNCRONA tras la creación y
  // puede pisar al dueño correcto con el roster CHILENO de calificación,
  // aunque el lead sea de otro país (el filtro de territorio de la regla
  // sigue pendiente del lado de Lalo). Este reconciliador deshace el cruce:
  // lead SIN convertir del roster CL con territorio ≠ Chile → ejecutivo de
  // su país (PE → Mónica, MX → Yahel). Best-effort, máx 10 por tick.
  const cruzados = await reconciliarLeadsCruzados().catch((e) => {
    console.warn("[ptv-cron] leads cruzados falló:", e instanceof Error ? e.message : e)
    return 0
  })

  return NextResponse.json({
    ok: true,
    crones_huerfanos_despachados: huerfanos,
    leads_cruzados_corregidos: cruzados,
    conversaciones_revisadas: convs.length,
    traspasados,
    tm_traspasados: tmTraspasados,
    chequeos_procesados: chequeos.length,
    chequeos_enviados: chequeosEnviados,
    loops_reabiertos_sin_atencion: reconciliacion.reabiertos,
    loops_recerrados_por_atencion: reconciliacion.recerrados,
    sla_alertas_60min: slaAlertas,
    valvulas_precio_abiertas: valvulas,
    cobros_asistidos: cobros.enviados,
    aceptadas_sin_pago: cobros.pendientes,
  })
  } finally {
    await liberarTurno("ptv").catch(() => undefined)
  }
}

/**
 * COBRO ASISTIDO (punto 2 de la segunda tanda, Lalo 08-ago): mide el gap
 * aceptada→pago y lo ataca. Barre cotizaciones en estado "Aceptada"
 * modificadas en las últimas 6 horas; si a los 30+ minutos no hay señal de
 * pago (loop cerrado por pagado, estado Pagada, o nota de venta emitida), se
 * envía UN mensaje de ayuda al pago (ventana de Meta abierta) — una sola vez
 * por cotización (kv cobro_asistido_<quoteId>).
 */
/** Ventana de contacto proactivo al cliente (Rodrigo 09-ago): todos los días
 * 9:00-21:00 hora local del contacto — ningún mensaje proactivo fuera de ella.
 * (Las alertas INTERNAS al equipo no se gatean: esas corren a toda hora.) */
function enVentanaProactiva(fono: string, ahora: Date): boolean {
  const pais = paisDeContacto(fono) || "cl"
  const tz =
    pais === "co" ? "America/Bogota" : pais === "mx" ? "America/Mexico_City" : pais === "pe" ? "America/Lima" : "America/Santiago"
  const hora =
    Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(ahora)) % 24
  return hora >= 9 && hora < 21
}

async function cobroAsistido(ahora: Date): Promise<{ enviados: number; pendientes: number }> {
  const { getZohoAccessToken } = await import("@/lib/zoho-token")
  const token = await getZohoAccessToken().catch(() => "")
  if (!token) return { enviados: 0, pendientes: 0 }
  const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
  // 20h de lookback (no 6): una aceptada a las 22:00 queda gateada por la
  // ventana 9-21 y debe seguir apareciendo en la consulta a la mañana
  // siguiente. La marca kv por cotización evita dobles envíos.
  const desde = new Date(ahora.getTime() - 20 * 3600_000)
  const fmt = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "+00:00")
  const q =
    `select id, Numero_Cotizacion, Telefono_Cliente, Tel_fono_Contacto, Modified_Time, ID_SO ` +
    `from Cotizaciones_GeoVictoria where Estado_Cotizacion = 'Aceptada' and Modified_Time >= '${fmt(desde)}' ` +
    `order by Modified_Time desc limit 0, 50`
  const res = await fetch(`${api}/crm/v3/coql`, {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({ select_query: q }),
  }).catch(() => null)
  const data = res && res.ok ? (((await res.json().catch(() => ({}))) as { data?: Array<Record<string, unknown>> }).data || []) : []
  if (!data.length) return { enviados: 0, pendientes: 0 }
  const { getKvValue, setKvValue } = await import("@/lib/supabase-persistence-v3")
  const pruebas = testContactSet()
  let enviados = 0
  let pendientes = 0
  for (const cot of data) {
    const fono = String(cot.Telefono_Cliente || cot.Tel_fono_Contacto || "").replace(/\D/g, "")
    if (!/^(56|57|52|51)\d{8,12}$/.test(fono) || isTestContact(fono, pruebas)) continue
    // Señal de pago: loop cerrado por PAGO REAL (motivo diferenciado 10-ago).
    // OJO: ID_SO ya NO sirve — desde que la cotización nace en Creator al
    // emitirse, ese campo viene lleno SIEMPRE (dejaba al cobro asistido ciego).
    const loopPagado = await supa<{ contact: string }>(
      `vic_loop?contact=eq.${encodeURIComponent(fono)}&motivo_cierre=eq.pagado&select=contact&limit=1`,
    )
    if (loopPagado.length) continue
    // 30 minutos de gracia para pagar solo; Modified_Time es el proxy del
    // momento de aceptación (el clic en aceptar la modifica).
    const modMs = Date.parse(String(cot.Modified_Time || ""))
    if (!Number.isFinite(modMs) || ahora.getTime() - modMs < 30 * 60_000) continue
    pendientes++
    if (enviados >= 10) continue
    const marca = `cobro_asistido_${String(cot.id)}`
    if (await getKvValue(marca).catch(() => null)) continue
    // Solo con ventana de Meta abierta (el que aceptó estuvo activo hace poco).
    const conv = await supa<{ last_user_at: string | null }>(
      `vic_v3_conversations?contact=eq.${encodeURIComponent(fono)}&select=last_user_at&limit=1`,
    )
    const lastUser = conv[0]?.last_user_at ? Date.parse(conv[0].last_user_at) : 0
    if (!lastUser || ahora.getTime() - lastUser >= VENTANA_META_MS) {
      await setKvValue(marca, "ventana_cerrada").catch(() => {})
      continue
    }
    if (!enVentanaProactiva(fono, ahora)) continue // fuera de 9-21: próximo tick en ventana
    const texto =
      "Vi que aceptaste tu cotización 🎉 ¿Te ayudo a completar el pago? Puedes pagar en línea desde el mismo link, y si prefieres transferencia me avisas: te paso los datos y con el comprobante por aquí lo dejamos listo."
    const okEnvio = await sendBotmakerMessage(fono, texto).catch(() => false)
    if (okEnvio) {
      await appendAssistantV3(fono, texto).catch(() => {})
      await setKvValue(marca, ahora.toISOString()).catch(() => {})
      enviados++
    }
  }
  return { enviados, pendientes }
}

/**
 * ESCALADA SLA (punto 1, Lalo 08-ago): el diseño del traspaso asume que el
 * vendedor llama en <5 minutos y nadie lo medía. A los 60 minutos hábiles de
 * un traspaso ACTIVO sin contacto real (mensaje espejado, llamada contestada
 * o atención manual del dashboard), sale UNA alerta interna con nombre y
 * apellido. El panel de SLA del dashboard muestra la foto completa.
 */
async function escaladaSla(ahora: Date): Promise<number> {
  // Piso de encendido: solo traspasos POSTERIORES al despliegue del SLA —
  // los de antes ya los maneja el candado v3 (Vicky reabierta) y alertarlos
  // en lote el primer tick era puro ruido para el equipo.
  const piso = "2026-08-09T00:00:00Z"
  const ventana = new Date(ahora.getTime() - 48 * 3600_000).toISOString()
  const desde = ventana > piso ? ventana : piso
  const activos = await supa<{ id: string; contact: string; vendedor_email: string | null; vendedor_nombre: string | null; traspasado_at: string }>(
    `vic_ptv?estado=eq.activo&traspasado_at=gte.${encodeURIComponent(desde)}&select=id,contact,vendedor_email,vendedor_nombre,traspasado_at&limit=200`,
  )
  if (!activos.length) return 0
  const atendidos = await contactosAtendidosPorVendedor(
    activos.map((a) => ({ contact: a.contact, desdeIso: a.traspasado_at })),
  ).catch(() => new Set<string>())
  const { getKvValue, setKvValue } = await import("@/lib/supabase-persistence-v3")
  let alertas = 0
  for (const a of activos) {
    if (alertas >= 15) break
    if (atendidos.has(a.contact)) continue
    const pais = paisDeContacto(a.contact) || "cl"
    const feriados = await feriadosDePais(pais)
    if (minutosHabilesEntre(new Date(a.traspasado_at), ahora, pais, feriados) < 60) continue
    const marca = `sla_alerta_${a.id}`
    if (await getKvValue(marca).catch(() => null)) continue
    await avisarEquipoInterno(
      `⏱️ SLA VENCIDO: +${a.contact} fue traspasado a ${a.vendedor_nombre || a.vendedor_email || "?"} hace más de 60 min hábiles y NO registra contacto (ni WhatsApp espejado, ni llamada, ni marca manual). El cliente está esperando — llamar AHORA o marcar "ya lo contacté" en el dashboard si ya se atendió por otra vía.`,
    ).catch(() => {})
    await setKvValue(marca, ahora.toISOString()).catch(() => {})
    alertas++
  }
  return alertas
}

/**
 * VÁLVULA DE ESCAPE DE PRECIO (punto 2, Lalo 08-ago): un cliente sobre-umbral
 * al que se le prometió ejecutivo (kv sobre_umbral_<fono>) y que en
 * VICKY_VALVULA_HORAS horas hábiles (default 4) no recibió contacto real,
 * recupera a Vicky con autonomía TOTAL de precio (kv valvula_precio_<fono> →
 * umbralPrecios devuelve 50). Se le avisa al cliente si la ventana de Meta
 * está abierta, y al equipo siempre. La inmediatez manda: mejor que Vicky
 * cierre a que el cliente espere a alguien que no llegó.
 */
async function abrirValvulasDePrecio(ahora: Date): Promise<number> {
  const { valvulaActiva, valvulaHoras } = await import("@/lib/umbral-autonomia")
  if (!valvulaActiva()) return 0
  const marcas = await supa<{ key: string; value: string }>(
    `vic_kv?key=like.sobre_umbral_%25&select=key,value&limit=200`,
  )
  if (!marcas.length) return 0
  const { getKvValue, setKvValue } = await import("@/lib/supabase-persistence-v3")
  let abiertas = 0
  for (const m of marcas) {
    if (abiertas >= 10) break
    const fono = String(m.key).replace("sobre_umbral_", "")
    if (!/^\d{10,13}$/.test(fono)) continue
    let at = ""
    try {
      at = String((JSON.parse(m.value || "{}") as { at?: string }).at || "")
    } catch { /* marca ilegible: se ignora */ }
    if (!at) continue
    if (await getKvValue(`valvula_precio_${fono}`).catch(() => null)) continue
    const pais = paisDeContacto(fono) || "cl"
    const feriados = await feriadosDePais(pais)
    if (minutosHabilesEntre(new Date(at), ahora, pais, feriados) < valvulaHoras() * 60) continue
    const atendidos = await contactosAtendidosPorVendedor([{ contact: fono, desdeIso: at }]).catch(
      () => new Set<string>(),
    )
    if (atendidos.has(fono)) continue
    await setKvValue(`valvula_precio_${fono}`, ahora.toISOString()).catch(() => {})
    abiertas++
    await avisarEquipoInterno(
      `🔓 Válvula de precio abierta para +${fono}: pasaron ${valvulaHoras()} horas hábiles desde la derivación sobre-umbral sin contacto del vendedor. Vicky recupera la autonomía de precio para este caso y retoma el cierre.`,
    ).catch(() => {})
    // Aviso al cliente solo con ventana de Meta abierta (24h desde su último
    // mensaje) — si está cerrada, la válvula igual queda abierta y el precio
    // sale apenas el cliente escriba o en el siguiente toque del loop.
    const conv = await supa<{ last_user_at: string | null }>(
      `vic_v3_conversations?contact=eq.${encodeURIComponent(fono)}&select=last_user_at&limit=1`,
    )
    const lastUser = conv[0]?.last_user_at ? Date.parse(conv[0].last_user_at) : 0
    if (lastUser && ahora.getTime() - lastUser < VENTANA_META_MS && enVentanaProactiva(fono, ahora)) {
      const texto =
        "Te cuento: para no dejarte esperando más, retomo yo misma tu cotización y te armo el valor de inmediato si quieres 😊 ¿Seguimos?"
      const enviado = await sendBotmakerMessage(fono, texto).catch(() => false)
      if (enviado) await appendAssistantV3(fono, texto).catch(() => {})
    }
  }
  return abiertas
}

/**
 * Reconciliación del silencio post-traspaso (candado v3, Lalo 07-ago).
 *
 * Diagnóstico del 07-ago: el traspaso v2 cerraba el vic_loop al minuto 10-15
 * de la etapa y el candado silenciaba TODA proactividad — 68 formales
 * emitidas del 04 al 07-ago con CERO aceptadas, mientras el vendedor
 * convertía ~0. La regla nueva: Vicky sigue con sus seguimientos de cierre
 * hasta que haya contacto humano REAL (mensaje del vendedor por su WhatsApp
 * espejado o llamada contestada, después del traspaso).
 *
 *  - REABRE loops cerrados por ptv_traspasado/tm_traspasado (últimos 7 días)
 *    cuyo vendedor aún no contacta al cliente: toques escalonados para no
 *    disparar una ráfaga.
 *  - RE-CIERRA los reabiertos cuando la atención del vendedor aparece (el
 *    humano tomó la conversación; Vicky vuelve a callar como siempre).
 *
 * Con VICKY_PTV_CANDADO_CLASICO=1 no reabre nada (rollback sin deploy).
 */
/**
 * LEADS CRUZADOS DE PAÍS (11-ago): deshace las asignaciones de la regla de
 * Zoho que caen en el roster chileno de calificación con leads de OTRO país.
 * La regla corre asíncrona tras el create y puede pisar al dueño correcto;
 * mientras Lalo no le ponga el filtro de territorio, este barrido corrige.
 * Solo toca leads SIN convertir cuyo dueño es del roster CL — un dueño
 * humano de otro equipo jamás se pisa.
 */
async function reconciliarLeadsCruzados(): Promise<number> {
  const rosterCL = (process.env.VICKY_TM_ROSTER_CALIFICACION_EMAILS ||
    "aaraque@geovictoria.com,asepulveda@geovictoria.com")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
  // Destino por territorio (mismos dueños fijos del canal de cada país).
  const destinoPorTerritorio: Record<string, { id: string; email: string }> = {
    "perú": { id: "3525045000323383015", email: "mmendozav@geovictoria.com" }, // Mónica
    "peru": { id: "3525045000323383015", email: "mmendozav@geovictoria.com" },
    "méxico": { id: "3525045000308323003", email: "ysegura@geovictoria.com" }, // Yahel
    "mexico": { id: "3525045000308323003", email: "ysegura@geovictoria.com" },
  }
  const { getZohoAccessToken } = await import("@/lib/zoho-token")
  const token = await getZohoAccessToken()
  const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
  const H = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }
  const emails = rosterCL.map((e) => `'${e}'`).join(",")
  const q = await fetch(`${api}/crm/v3/coql`, {
    method: "POST", headers: H, cache: "no-store",
    body: JSON.stringify({
      select_query: `select id, Territorio, Phone, Owner.email from Leads where (Owner.email in (${emails}) and Converted__s = false) and Territorio != 'Chile' limit 10`,
    }),
  })
  if (!q.ok || q.status === 204) return 0
  const filas = ((await q.json().catch(() => ({}))) as { data?: Array<{ id?: string; Territorio?: string; Phone?: string }> }).data || []
  let corregidos = 0
  for (const l of filas) {
    const destino = destinoPorTerritorio[String(l.Territorio || "").trim().toLowerCase()]
    if (!destino || !l.id) continue
    const put = await fetch(`${api}/crm/v3/Leads`, {
      method: "PUT", headers: H, cache: "no-store",
      body: JSON.stringify({
        data: [{ id: l.id, Owner: { id: destino.id } }],
        skip_feature_execution: [{ name: "assignment_rules" }],
      }),
    }).catch(() => null)
    if (put?.ok) {
      corregidos++
      console.warn(`[leads-cruzados] lead ${l.id} (${l.Territorio}, ${l.Phone || "?"}) roster CL → ${destino.email}`)
    }
  }
  return corregidos
}

async function reconciliarSilencioTraspasos(): Promise<{ reabiertos: number; recerrados: number }> {
  if ((process.env.VICKY_PTV_CANDADO_CLASICO || "").trim() === "1") return { reabiertos: 0, recerrados: 0 }
  const desde = new Date(Date.now() - 7 * 24 * 3600e3).toISOString()
  const ptvRows = await supa<{ contact: string; traspasado_at?: string }>(
    `vic_ptv?estado=eq.activo&traspasado_at=gte.${encodeURIComponent(desde)}&select=contact,traspasado_at&limit=500`,
  ).catch(() => [])
  if (!ptvRows.length) return { reabiertos: 0, recerrados: 0 }
  const testSet = testContactSet()
  const vivos = ptvRows.filter((r) => r.contact && !isTestContact(r.contact, testSet))
  const atendidos = await contactosAtendidosPorVendedor(
    vivos.map((r) => ({ contact: r.contact, desdeIso: r.traspasado_at || "" })),
  ).catch(() => new Set<string>())

  const lista = vivos.map((r) => `"${r.contact}"`).join(",")
  const loops = await supa<{ contact: string; estado: string; motivo_cierre: string | null }>(
    `vic_loop?contact=in.(${lista})&select=contact,estado,motivo_cierre&limit=500`,
  ).catch(() => [])

  let reabiertos = 0
  let recerrados = 0
  const ahoraMs = Date.now()
  for (const l of loops) {
    const atendido = atendidos.has(l.contact)
    if (!atendido && l.estado === "cerrado" && (l.motivo_cierre === "ptv_traspasado" || l.motivo_cierre === "tm_traspasado")) {
      if (reabiertos >= 40) continue
      // Escalonado: 20 min + 7 min por loop reabierto en este tick.
      const proximoToque = new Date(ahoraMs + 20 * 60_000 + reabiertos * 7 * 60_000).toISOString()
      await supa(`vic_loop?contact=eq.${encodeURIComponent(l.contact)}`, {
        method: "PATCH",
        body: JSON.stringify({
          estado: "activo",
          motivo_cierre: null,
          next_touch_at: proximoToque,
          updated_at: new Date().toISOString(),
        }),
      }).catch(() => {})
      reabiertos++
    } else if (atendido && l.estado === "activo") {
      await supa(`vic_loop?contact=eq.${encodeURIComponent(l.contact)}`, {
        method: "PATCH",
        body: JSON.stringify({ estado: "cerrado", motivo_cierre: "ptv_traspasado", updated_at: new Date().toISOString() }),
      }).catch(() => {})
      recerrados++
    }
  }
  if (reabiertos || recerrados) {
    console.log(`[ptv-cron] candado v3: ${reabiertos} loops reabiertos (vendedor sin contactar), ${recerrados} re-cerrados (vendedor atendió)`)
  }
  return { reabiertos, recerrados }
}
