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
  vendedoresDePais,
  mensajePresentacion,
  mensajeChequeo,
  sumarHorasHabiles,
} from "@/lib/ptv"
import { sendBotmakerMessage } from "@/lib/botmaker-push-v3"
import { appendAssistantV3, getFollowupCronSecret } from "@/lib/supabase-persistence-v3"
import { avisarEquipoInterno } from "@/lib/alerta-interna"
import { paisDeContacto } from "@/lib/botmaker-tags"

export const dynamic = "force-dynamic"
export const maxDuration = 120

const CRON_SECRET = (process.env.CRON_SECRET || "").trim()
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const VENTANA_BARRIDO_MS = 48 * 3600_000
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
    const fecha = String(f.date || f.fecha || f.holiday_date || "").slice(0, 10)
    const p = String(f.country || f.pais || "").toLowerCase()
    if (fecha && (!p || p === pais)) set.add(fecha)
  }
  return set
}

/** Turno de tómbola persistido en vic_kv (equitativo entre invocaciones). */
async function siguienteVendedor(pais: "cl" | "co" | "mx") {
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
  "ysegura@geovictoria.com": "Yahel Segura",
}

type VendedorFinal = { email: string; zohoId: string; nombre: string; via: "tombola_zoho" | "tombola_interna" }

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
    via: "tombola_interna",
  }
  try {
    const { getZohoAccessToken } = await import("@/lib/zoho-token")
    const token = await getZohoAccessToken()
    const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
    const H = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }
    const fono = contact.replace(/\D/g, "")
    const res = await fetch(`${api}/crm/v3/Leads/search?phone=${fono}&converted=both&per_page=3`, { headers: H, cache: "no-store" })
    if (!res.ok || res.status === 204) return porDefecto
    const lead = ((await res.json().catch(() => ({}))) as { data?: Array<{ id?: string; Converted_Deal?: { id?: string } | null }> }).data?.[0]
    if (!lead?.id) return porDefecto
    if (lead.Converted_Deal?.id) {
      const dealId = lead.Converted_Deal.id
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
            return { email: owner.email, zohoId: owner.id, nombre: owner.name || owner.email.split("@")[0], via: "tombola_zoho" }
          }
        } else {
          console.warn(`[ptv] regla de tómbola Zoho falló (${put.status}) para deal ${dealId} — fallback a tómbola interna`)
        }
      }
      await fetch(`${api}/crm/v3/Deals`, { method: "PUT", headers: H, cache: "no-store", body: JSON.stringify({ data: [{ id: dealId, Owner: { id: interno.zohoId } }], skip_feature_execution: [{ name: "assignment_rules" }] }) })
    } else {
      await fetch(`${api}/crm/v3/Leads`, { method: "PUT", headers: H, cache: "no-store", body: JSON.stringify({ data: [{ id: lead.id, Owner: { id: interno.zohoId } }], skip_feature_execution: [{ name: "assignment_rules" }] }) })
    }
    return porDefecto
  } catch (e) {
    console.warn("[ptv] asignarEnZoho falló:", e instanceof Error ? e.message : e)
    return porDefecto
  }
}

export async function GET(req: Request) {
  if (!(await authorized(req))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }
  if (!ptvHabilitado()) {
    return NextResponse.json({ ok: true, skipped: "VICKY_PTV_ENABLED off" })
  }
  const ahora = new Date()
  const desde = new Date(ahora.getTime() - VENTANA_BARRIDO_MS).toISOString()

  // 1. Conversaciones con actividad reciente + su compromiso de pausa (vic_loop).
  const convs = await supa<{
    contact: string
    country: string | null
    last_user_at: string | null
    updated_at: string
    pref_escalon: number | null
    pref_quote_id: string | null
    formal_quote_id: string | null
    followup_closed_reason: string | null
  }>(
    `vic_v3_conversations?updated_at=gte.${encodeURIComponent(desde)}` +
      `&select=contact,country,last_user_at,updated_at,pref_escalon,pref_quote_id,formal_quote_id,followup_closed_reason&limit=200`,
  )
  const activos = await supa<{ contact: string }>(`vic_ptv?estado=eq.activo&select=contact&limit=1000`)
  const conTraspaso = new Set(activos.map((a) => a.contact))
  const pausas = await supa<{ contact: string; compromiso_at: string | null }>(
    `vic_loop?select=contact,compromiso_at&compromiso_at=not.is.null&limit=500`,
  )
  const compromisoPor = new Map(pausas.map((p) => [p.contact, p.compromiso_at]))

  const traspasados: Array<{ contact: string; vendedor: string; ttv: number }> = []
  for (const c of convs) {
    if (traspasados.length >= MAX_TRASPASOS_POR_TICK) break
    const pais = (paisDeContacto(c.contact) || (c.country as "cl" | "co" | "mx" | null))
    if (!pais) continue
    // opt-out/soporte/perdido: el loop ya cerró esta conversación — no traspasar.
    if (c.followup_closed_reason) continue
    // Reloj TTV: el silencio se mide desde el último mensaje del CLIENTE.
    // updated_at se mueve con cada toque del Loop, y usarlo de referencia
    // reiniciaba el TTV en cada toque (brecha 1, 30-jul). Sin mensaje del
    // cliente no hay TTV que medir: esa conversación la gobierna el Loop.
    if (!c.last_user_at) continue
    const ultimoCliente = new Date(c.last_user_at)
    const clienteRespondioDespues = ultimoCliente >= new Date(c.updated_at)
    const feriados = await feriadosDePais(pais)
    const decision = debeTraspasar({
      referenciaRelojAt: ultimoCliente,
      clienteRespondioDespues,
      precioMostrado: Boolean(c.pref_escalon !== null || c.pref_quote_id || c.formal_quote_id),
      pais,
      ahora,
      feriados,
      compromisoAt: compromisoPor.get(c.contact) ? new Date(String(compromisoPor.get(c.contact))) : null,
      traspasoActivo: conTraspaso.has(c.contact),
    })
    if (!decision.traspasar) continue

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
      const texto = mensajePresentacion(pais, vendedor.nombre)
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

  // 3. Chequeos de calidad vencidos.
  const chequeos = await supa<{ id: string; contact: string; vendedor_email: string; vendedor_nombre: string | null }>(
    `vic_ptv?estado=eq.activo&chequeo_hecho_at=is.null&chequeo_at=lte.${encodeURIComponent(ahora.toISOString())}&select=id,contact,vendedor_email,vendedor_nombre&limit=20`,
  )
  let chequeosEnviados = 0
  for (const ch of chequeos) {
    const conv = convs.find((c) => c.contact === ch.contact)
    const pais = (paisDeContacto(ch.contact) || "cl") as "cl" | "co" | "mx"
    const ventanaAbierta = Boolean(conv?.last_user_at && ahora.getTime() - new Date(conv.last_user_at).getTime() < VENTANA_META_MS)
    if (ventanaAbierta) {
      const texto = mensajeChequeo(pais, ch.vendedor_nombre || NOMBRE_VENDEDOR[ch.vendedor_email] || ch.vendedor_email.split("@")[0])
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

  return NextResponse.json({
    ok: true,
    conversaciones_revisadas: convs.length,
    traspasados,
    chequeos_procesados: chequeos.length,
    chequeos_enviados: chequeosEnviados,
  })
}
