/**
 * ADMIN — CAMPAÑA DE REMARKETING sobre DEALS PERDIDOS (Lalo 08-sep, "igual a
 * la última que hicimos a los 30 leads, esta vez a 300 deals").
 *
 * Réplica de la campaña del 03-sep: por cada deal en Cierre Perdido se
 * resuelve el TELÉFONO del contacto en Zoho, se aplican las exclusiones, se
 * siembra la marca vic_kv `reactivar_deal_<fono>` = id del deal (lo único que
 * habilita revivir un Cierre Perdido — crm-hitos.dealAReactivar) y se manda la
 * plantilla HSM `vicky_reactivacion_cotizacion_cl_v4` (con nombre) o la
 * gemela `vicky_reactivacion_sin_nombre_cl_v4` (sin nombre legible).
 *
 * POST { campana, dealIds: string[], dry?: boolean (default true), max?, offset?, pausaMs? }
 *   → por deal: { dealId, empresa, fono, nombre, owner, motivo, accion|omitido }
 *
 * EXCLUSIONES (cada una nombrada en la salida):
 *  - deal que ya no está en Cierre Perdido (compró después / se reabrió)
 *  - contacto sin celular chileno discable
 *  - contacto interno (testContactSet)
 *  - ya tocado por la campaña del 03-sep (kv reactivar_deal_ presente)
 *  - opt-out (voz_no_llamar_ / voz_excluir_ / followup_closed_reason opt_out)
 *  - pagó o registró comprobante (kv comprobante_ok_ / pago_online_)
 *  - cliente existente (cuenta 3. Cliente/Facturando o usuarios activos)
 *  - conversación viva (mensaje del cliente en los últimos 14 días)
 *  - otro deal del mismo contacto abierto en 6/7/8 (compró por otro camino)
 *
 * En modo real cada envío deja un [REGISTRO INTERNO] en el historial para
 * que Vicky sepa por qué le escriben "Retomemos" y retome la cotización.
 */

import { NextResponse } from "next/server"
import { appendAssistantV3, getFollowupCronSecret, getKvValue, setKvValue } from "@/lib/supabase-persistence-v3"
import { sendBotmakerTemplate } from "@/lib/botmaker-push-v3"
import { getZohoAccessToken } from "@/lib/zoho-token"
import { testContactSet } from "@/lib/funnel-analysis"
import { detectarClienteExistente } from "@/lib/cliente-existente"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const TPL_CON_NOMBRE = (process.env.REMK_TEMPLATE_CON_NOMBRE || "vicky_reactivacion_cotizacion_cl_v4").trim()
const TPL_SIN_NOMBRE = (process.env.REMK_TEMPLATE_SIN_NOMBRE || "vicky_reactivacion_sin_nombre_cl_v4").trim()
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()

async function autorizado(req: Request): Promise<boolean> {
  const secreto = await getFollowupCronSecret()
  const url = new URL(req.url)
  const auth = req.headers.get("authorization") || ""
  const entregado =
    req.headers.get("x-cron-secret") || (auth.startsWith("Bearer ") ? auth.slice(7) : "") || url.searchParams.get("key") || ""
  return Boolean(secreto) && entregado === secreto
}

async function supa<T>(path: string): Promise<T | null> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    cache: "no-store",
  }).catch(() => null)
  if (!r || !r.ok) return null
  return (await r.json().catch(() => null)) as T | null
}

/** Celular chileno discable en formato 569XXXXXXXX, o "" si no sirve. */
export function celularCL(raw: string | null | undefined): string {
  let d = String(raw || "").replace(/\D/g, "")
  if (!d) return ""
  if (d.startsWith("5656")) d = d.slice(2)
  if (/^9\d{8}$/.test(d)) d = `56${d}`
  if (/^569\d{8}$/.test(d)) return d
  return ""
}

function nombrePila(raw: string | null | undefined): string {
  const limpio = String(raw || "").trim().replace(/\s+/g, " ")
  if (!limpio) return ""
  const primera = limpio.split(" ")[0]
  // Nombres "no nombre": placeholders, cargos, siglas, razones sociales.
  if (primera.length < 3 || /^[^a-záéíóúñü]/i.test(primera)) return ""
  if (/recursos|humanos|condominio|edificio|prospecto|whatsapp|admin|contacto|gerencia|n\/a|no proporcionado/i.test(limpio)) return ""
  if (limpio === limpio.toUpperCase() && limpio.length > 14) return ""
  return primera.charAt(0).toUpperCase() + primera.slice(1).toLowerCase()
}

type DealZ = {
  id: string
  Deal_Name?: string
  Stage?: string
  Owner?: { email?: string; name?: string }
  Contact_Name?: { id?: string; name?: string } | null
  Raz_n_de_P_rdida?: string | null
  Fecha_paso_a_Cierre_Perdido?: string | null
  N_Empleados_que_marcan?: number | null
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  const body = (await req.json().catch(() => ({}))) as {
    campana?: string
    dealIds?: string[]
    dry?: boolean
    max?: number
    offset?: number
    pausaMs?: number
  }
  const campana = String(body.campana || "").trim().replace(/[^a-z0-9_]/gi, "_")
  const ids = Array.isArray(body.dealIds) ? body.dealIds.map((x) => String(x).replace(/\D/g, "")).filter((x) => /^\d{15,}$/.test(x)) : []
  if (!campana || !ids.length) return NextResponse.json({ ok: false, error: "faltan campana y dealIds" }, { status: 400 })
  const dry = body.dry !== false
  const max = Math.max(1, Math.min(120, Number(body.max) || 40))
  const offset = Math.max(0, Number(body.offset) || 0)
  const pausaMs = Math.max(300, Math.min(10_000, Number(body.pausaMs) || 1500))
  const inicio = Date.now()

  const token = await getZohoAccessToken()
  const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
  const H = { Authorization: `Zoho-oauthtoken ${token}` }
  const internos = testContactSet()
  const lote = ids.slice(offset, offset + max)
  const filas: Array<Record<string, unknown>> = []
  let enviados = 0
  let omitidos = 0
  const vistos = new Set<string>()

  for (const dealId of lote) {
    if (Date.now() - inicio > 270_000) {
      filas.push({ dealId, omitido: "presupuesto_de_tiempo" })
      continue
    }
    const fila: Record<string, unknown> = { dealId }
    try {
      const rd = await fetch(
        `${api}/crm/v3/Deals/${dealId}?fields=Deal_Name,Stage,Owner,Contact_Name,Raz_n_de_P_rdida,Fecha_paso_a_Cierre_Perdido,N_Empleados_que_marcan`,
        { headers: H, cache: "no-store" },
      )
      const deal = rd.status === 200 ? (((await rd.json().catch(() => ({}))) as { data?: DealZ[] }).data?.[0] || null) : null
      if (!deal) {
        fila.omitido = "deal_no_encontrado"
        filas.push(fila); omitidos++; continue
      }
      fila.empresa = deal.Deal_Name
      fila.owner = deal.Owner?.email
      fila.motivoPerdida = deal.Raz_n_de_P_rdida
      fila.perdidoEl = deal.Fecha_paso_a_Cierre_Perdido
      fila.dotacion = deal.N_Empleados_que_marcan
      if (deal.Stage !== "Cierre Perdido") {
        fila.omitido = `deal_no_perdido (${deal.Stage})`
        filas.push(fila); omitidos++; continue
      }
      const contactId = deal.Contact_Name?.id || ""
      if (!contactId) {
        fila.omitido = "deal_sin_contacto"
        filas.push(fila); omitidos++; continue
      }
      const rc = await fetch(`${api}/crm/v3/Contacts/${contactId}?fields=Phone,Mobile,First_Name,Last_Name,Email`, { headers: H, cache: "no-store" })
      const c = rc.status === 200
        ? (((await rc.json().catch(() => ({}))) as { data?: Array<{ Phone?: string; Mobile?: string; First_Name?: string; Last_Name?: string; Email?: string }> }).data?.[0] || null)
        : null
      const fono = celularCL(c?.Mobile) || celularCL(c?.Phone)
      fila.fono = fono || `(${c?.Phone || c?.Mobile || "sin teléfono"})`
      fila.nombre = nombrePila(c?.First_Name)
      if (!fono) {
        fila.omitido = "sin_celular_cl"
        filas.push(fila); omitidos++; continue
      }
      if (vistos.has(fono)) {
        fila.omitido = "fono_repetido_en_la_lista"
        filas.push(fila); omitidos++; continue
      }
      vistos.add(fono)
      if (internos.has(fono)) {
        fila.omitido = "contacto_interno"
        filas.push(fila); omitidos++; continue
      }
      const [yaMarca, noLlamar, excluirVoz, comprobante, pagoOnline] = await Promise.all([
        getKvValue(`reactivar_deal_${fono}`).catch(() => null),
        getKvValue(`voz_no_llamar_${fono}`).catch(() => null),
        getKvValue(`voz_excluir_${fono}`).catch(() => null),
        getKvValue(`comprobante_ok_${fono}`).catch(() => null),
        getKvValue(`pago_online_${fono}`).catch(() => null),
      ])
      if (yaMarca) {
        fila.omitido = `ya_tocado_por_campana_anterior (deal ${yaMarca})`
        filas.push(fila); omitidos++; continue
      }
      if (noLlamar) {
        fila.omitido = "opt_out"
        filas.push(fila); omitidos++; continue
      }
      if (excluirVoz) {
        let motivo = ""
        try { motivo = String((JSON.parse(excluirVoz) as { motivo?: string }).motivo || "") } catch { /* texto plano */ }
        if (/declino|no_contactar|opt|rechaz|competencia|cliente/i.test(motivo)) {
          fila.omitido = `excluido_campanas (${motivo})`
          filas.push(fila); omitidos++; continue
        }
      }
      if (comprobante || pagoOnline) {
        fila.omitido = "pago_registrado"
        filas.push(fila); omitidos++; continue
      }
      const conv = await supa<Array<{ followup_closed_reason: string | null; last_user_at: string | null }>>(
        `vic_v3_conversations?contact=eq.${fono}&select=followup_closed_reason,last_user_at&limit=1`,
      )
      const cv = conv?.[0]
      if (cv?.followup_closed_reason === "opt_out") {
        fila.omitido = "opt_out_conversacion"
        filas.push(fila); omitidos++; continue
      }
      if (cv?.last_user_at && Date.now() - new Date(cv.last_user_at).getTime() < 14 * 24 * 3600_000) {
        fila.omitido = `conversacion_viva (${cv.last_user_at.slice(0, 10)})`
        filas.push(fila); omitidos++; continue
      }
      const ce = await detectarClienteExistente(fono).catch(() => null)
      if (ce) {
        fila.omitido = `cliente_existente (${ce.cuentaNombre})`
        filas.push(fila); omitidos++; continue
      }
      // Otro deal del mismo contacto ya avanzado (compró por otro camino, caso Molinas).
      const rq = await fetch(`${api}/crm/v8/coql`, {
        method: "POST", headers: { ...H, "Content-Type": "application/json" }, cache: "no-store",
        body: JSON.stringify({
          select_query: `select id, Stage from Deals where (Contact_Name = '${contactId}' and Stage in ('6. Listo para Cierre','7. Implementando','8. Facturando')) limit 1`,
        }),
      })
      if (rq.ok && rq.status !== 204) {
        const otro = (((await rq.json().catch(() => ({}))) as { data?: Array<{ id: string; Stage: string }> }).data || [])[0]
        if (otro) {
          fila.omitido = `otro_deal_avanzado (${otro.Stage})`
          filas.push(fila); omitidos++; continue
        }
      }

      const tpl = fila.nombre ? TPL_CON_NOMBRE : TPL_SIN_NOMBRE
      fila.plantilla = tpl
      if (dry) {
        fila.accion = "SE ENVIARÍA"
        filas.push(fila)
        continue
      }
      await setKvValue(`reactivar_deal_${fono}`, dealId)
      const ok = await sendBotmakerTemplate(fono, tpl, fila.nombre ? { nombre: String(fila.nombre) } : {}).catch(() => false)
      await setKvValue(
        `campana_remk_${campana}_${fono}`,
        JSON.stringify({ dealId, empresa: deal.Deal_Name, tpl, ok, at: new Date().toISOString() }),
      ).catch(() => {})
      if (ok) {
        enviados++
        await appendAssistantV3(
          fono,
          `[REGISTRO INTERNO] Campaña de remarketing "${campana}" (${new Date().toISOString().slice(0, 10)}): se le envió la plantilla de reactivación ` +
            `por su cotización de ${deal.Deal_Name || "control de asistencia"} (deal en Cierre Perdido, motivo "${deal.Raz_n_de_P_rdida || "-"}"` +
            `${deal.N_Empleados_que_marcan ? `, ${deal.N_Empleados_que_marcan} personas` : ""}). Si responde con interés: retomar la cotización ` +
            `desde donde quedó, actualizar dotación si cambió y cerrar con link de pago. Si dice que no: agradecer y cerrar sin insistir.`,
        ).catch(() => {})
        fila.accion = "enviada"
      } else {
        fila.accion = "ENVÍO FALLÓ (Botmaker)"
      }
      filas.push(fila)
      await new Promise((r) => setTimeout(r, pausaMs))
    } catch (e) {
      fila.omitido = `error: ${e instanceof Error ? e.message : String(e)}`
      filas.push(fila); omitidos++
    }
  }

  const resumen: Record<string, number> = {}
  for (const f of filas) {
    const k = String(f.omitido ? String(f.omitido).split(" (")[0] : f.accion || "?")
    resumen[k] = (resumen[k] || 0) + 1
  }
  return NextResponse.json({
    ok: true, dry, campana, total: ids.length, offset, lote: lote.length, enviados, omitidos, resumen, filas,
    siguienteOffset: offset + lote.length < ids.length ? offset + lote.length : null,
  })
}
