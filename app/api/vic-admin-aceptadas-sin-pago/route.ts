/**
 * ACEPTADAS QUE NO PAGAN — levantamiento SOLO LECTURA (Lalo 11-sep).
 *
 * Una cotización "Aceptada" es un cliente que dijo SÍ, firmó el checkbox y
 * NO pagó: es la fuga más cara del embudo, porque ya está convencido. Este
 * endpoint las junta todas y, por cada una, dice POR QUÉ sigue ahí.
 *
 * Por cada cotización cruza cinco cosas:
 *   1. el MONTO desde el subform (la Caja `venta_dash_v3_` NO sirve: su
 *      cinturón solo admite pagadas reales, una Aceptada jamás entra)
 *   2. las MARCAS DE PAGO del contacto (`pago_online_` / `comprobante_ok_`) —
 *      si existen, la plata puede estar en el banco sin registrar (caso
 *      EFFICIENT LOGISTIC: 12 días Aceptada con el comprobante en el espejo)
 *   3. el LOOP (`vic_loop`): la cadencia de cierre post-aceptación del 25-ago
 *      transiciona a etapa `aceptada` y a los 3 toques cierra
 *      `aceptada_sin_pago` — si no hay fila o el motivo es otro, la cadencia
 *      no corrió
 *   4. los MENSAJES posteriores a la aceptación (¿le hablamos? ¿contestó?)
 *   5. el TRASPASO vivo (`vic_ptv`): si el caso es del ejecutivo, el empujón
 *      es suyo, no de Vicky
 *
 * GET auth cron (?key= | x-cron-secret):
 *   ?dias=N   solo las aceptadas en los últimos N días (default: todas)
 *   ?max=N    tope de filas (default 200)
 *   ?csv=1    devuelve CSV en vez de JSON (para pegar en una planilla)
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"
import { getZohoAccessToken } from "@/lib/zoho-token"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const CRON_SECRET = (process.env.CRON_SECRET || "").trim()
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim().replace(/\/$/, "")
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const ZOHO_API = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
const QUOTE_MODULE = (process.env.ZOHO_QUOTE_MODULE || "Cotizaciones_GeoVictoria").trim()

async function autorizado(req: Request): Promise<boolean> {
  const url = new URL(req.url)
  const dado =
    (req.headers.get("x-cron-secret") || "").trim() ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim() ||
    (url.searchParams.get("key") || "").trim()
  if (!dado) return false
  if (CRON_SECRET && dado === CRON_SECRET) return true
  const kv = await getFollowupCronSecret().catch(() => "")
  return Boolean(kv) && dado === kv
}

const SB = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
const fallas: string[] = []

async function sb<T>(path: string): Promise<T[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: SB, cache: "no-store" })
  if (!r.ok) {
    // Regla del 09-sep: los fallos de consulta se REPORTAN, no se tragan.
    fallas.push(`${path.slice(0, 70)} → ${r.status} ${(await r.text().catch(() => "")).slice(0, 120)}`)
    return []
  }
  return (await r.json().catch(() => [])) as T[]
}

const dig = (s: unknown): string => String(s || "").replace(/\D/g, "")

type QuoteRow = {
  id: string
  Numero_Cotizacion?: string
  Name?: string
  Fecha_Hora_Cotizacion?: string
  Created_Time?: string
  Owner?: { name?: string }
  Intervenci_n_Humana?: string | null
  Tel_fono_Contacto?: string | null
  Deal_Asociado?: { name?: string; id?: string } | null
  RUT_Cliente?: string | null
}

type ItemRow = { Subtotal_CLP?: number | null; Es_Recurrente?: boolean | null; Codigo_Item?: string | null }

type Fila = {
  numero: string
  empresa: string
  quoteId: string
  fono: string
  canal: string
  dueno: string
  aceptadaIso: string
  diasAceptada: number
  recurrenteClp: number
  unicoClp: number
  deal: string | null
  dealStage: string | null
  marcaPago: string | null
  otraPagada: string | null
  loop: string | null
  traspasoActivo: boolean
  mensajesNuestrosPost: number
  ultimoMensajeCliente: string | null
  clienteEscribioPost: boolean
  veredicto: string
}

export async function GET(req: Request): Promise<Response> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  const sp = new URL(req.url).searchParams
  const dias = Math.max(0, Number(sp.get("dias") || 0))
  const max = Math.min(Math.max(Number(sp.get("max")) || 200, 1), 400)
  const csv = sp.get("csv") === "1"
  const t0 = Date.now()
  fallas.length = 0

  const token = await getZohoAccessToken()
  const H = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }

  // 1. Las Aceptadas (la aceptación vive en Fecha_Hora_Cotizacion).
  const campos = "id, Numero_Cotizacion, Name, Fecha_Hora_Cotizacion, Created_Time, Owner, Intervenci_n_Humana, Tel_fono_Contacto, Deal_Asociado, RUT_Cliente"
  const desde = dias > 0 ? new Date(Date.now() - dias * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "+00:00") : ""
  const where = desde
    ? `Estado_Cotizacion = 'Aceptada' and Fecha_Hora_Cotizacion >= '${desde}'`
    : `Estado_Cotizacion = 'Aceptada'`
  const rq = await fetch(`${ZOHO_API}/crm/v8/coql`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ select_query: `select ${campos} from ${QUOTE_MODULE} where ${where} order by Fecha_Hora_Cotizacion desc limit ${max}` }),
    cache: "no-store",
  })
  if (!rq.ok) {
    return NextResponse.json({ ok: false, error: `COQL ${rq.status}`, detalle: (await rq.text().catch(() => "")).slice(0, 300) }, { status: 500 })
  }
  const quotes = (((await rq.json().catch(() => ({}))) as { data?: QuoteRow[] })?.data || []) as QuoteRow[]

  const fonos = [...new Set(quotes.map((q) => dig(q.Tel_fono_Contacto)).filter((f) => f.length >= 8))]

  // 1-bis. ¿El MISMO cliente tiene otra cotización PAGADA? Verificado el
  // 11-sep: de las 4 con marca de pago, 3 eran duplicados (FRIVAR COT890
  // aceptada y COT891 pagada el mismo día; ARAMOS; VARELA FADIC) — versiones
  // anteriores que quedaron Aceptadas cuando el cliente pagó otra. Sin esta
  // consulta la lista alarma por plata que ya entró.
  const pagadasPorFono = new Map<string, string[]>()
  if (fonos.length) {
    const lista = fonos.map((f) => `'${f}'`).join(",")
    const rp = await fetch(`${ZOHO_API}/crm/v8/coql`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ select_query: `select id, Numero_Cotizacion, Tel_fono_Contacto from ${QUOTE_MODULE} where (Tel_fono_Contacto in (${lista}) and Estado_Cotizacion = 'Pagada') limit 200` }),
      cache: "no-store",
    })
    if (rp.ok) {
      const filas = (((await rp.json().catch(() => ({}))) as { data?: QuoteRow[] })?.data || []) as QuoteRow[]
      for (const f of filas) {
        const k = dig(f.Tel_fono_Contacto)
        const arr = pagadasPorFono.get(k) || []
        arr.push(String(f.Numero_Cotizacion || f.id))
        pagadasPorFono.set(k, arr)
      }
    } else {
      fallas.push(`COQL pagadas del contacto → ${rp.status}`)
    }
  }

  // 2. Marcas de pago, loop, traspaso y mensajes — todo en lote.
  const claves: string[] = []
  for (const f of fonos) claves.push(`pago_online_${f}`, `comprobante_ok_${f}`)
  const kvs = claves.length
    ? await sb<{ key: string; value: string }>(`vic_kv?key=in.(${claves.map(encodeURIComponent).join(",")})&select=key,value&limit=2000`)
    : []
  const kvMap = new Map(kvs.map((k) => [k.key, k.value]))

  const loops = fonos.length
    ? await sb<{ contact: string; estado: string; stage: string | null; motivo_cierre: string | null; next_touch: number | null }>(
        `vic_loop?contact=in.(${fonos.join(",")})&select=contact,estado,stage,motivo_cierre,next_touch&limit=2000`,
      )
    : []
  const loopMap = new Map(loops.map((l) => [l.contact, l]))

  const ptv = fonos.length
    ? await sb<{ contact: string }>(`vic_ptv?contact=in.(${fonos.join(",")})&estado=eq.activo&select=contact&limit=2000`)
    : []
  const ptvSet = new Set(ptv.map((p) => p.contact))

  // Mensajes desde la aceptación MÁS ANTIGUA del lote. CICATRIZ: vic_v3_messages
  // NO tiene columna `contact` (da 400) — cuelga de `conversation_id`, así que
  // primero se resuelven las conversaciones de esos teléfonos.
  const minIso = quotes.reduce((a, q) => {
    const t = Date.parse(String(q.Fecha_Hora_Cotizacion || ""))
    return Number.isFinite(t) && t < a ? t : a
  }, Date.now())
  const convs = fonos.length
    ? await sb<{ id: string; contact: string }>(`vic_v3_conversations?contact=in.(${fonos.join(",")})&select=id,contact&limit=2000`)
    : []
  const contactoDeConv = new Map(convs.map((c) => [String(c.id), c.contact]))
  const porContacto = new Map<string, Array<{ role: string; at: number }>>()
  if (convs.length) {
    const ids = convs.map((c) => String(c.id))
    for (let i = 0; i < ids.length; i += 60) {
      const lote = ids.slice(i, i + 60)
      const msgs = await sb<{ conversation_id: string; role: string; at: string }>(
        `vic_v3_messages?conversation_id=in.(${lote.join(",")})&at=gte.${new Date(minIso).toISOString()}&select=conversation_id,role,at&order=at.asc&limit=20000`,
      )
      for (const m of msgs) {
        const c = contactoDeConv.get(String(m.conversation_id))
        if (!c) continue
        const arr = porContacto.get(c) || []
        arr.push({ role: m.role, at: Date.parse(m.at) })
        porContacto.set(c, arr)
      }
    }
  }

  // 3. Fila por cotización: el monto sale del SUBFORM (la Caja solo guarda pagadas).
  const filas: Fila[] = []
  for (const q of quotes) {
    if (Date.now() - t0 > 250_000) { fallas.push("presupuesto_de_tiempo: faltaron cotizaciones por leer"); break }
    const fono = dig(q.Tel_fono_Contacto)
    let recurrenteClp = 0
    let unicoClp = 0
    try {
      const rr = await fetch(`${ZOHO_API}/crm/v3/${QUOTE_MODULE}/${q.id}?fields=Detalle_Items_Cotizacion`, { headers: H, cache: "no-store" })
      if (rr.status === 200) {
        const items = (((await rr.json().catch(() => ({}))) as { data?: Array<{ Detalle_Items_Cotizacion?: ItemRow[] }> })?.data?.[0]?.Detalle_Items_Cotizacion || []) as ItemRow[]
        for (const it of items) {
          const sub = Number(it.Subtotal_CLP || 0)
          if (!Number.isFinite(sub) || sub <= 0) continue
          if (it.Es_Recurrente) recurrenteClp += sub
          else unicoClp += sub
        }
      }
    } catch { /* sin subform: queda en 0 y se ve en la fila */ }

    const aceptadaIso = String(q.Fecha_Hora_Cotizacion || q.Created_Time || "")
    const aceptadaMs = Date.parse(aceptadaIso)
    const diasAceptada = Number.isFinite(aceptadaMs) ? Math.floor((Date.now() - aceptadaMs) / 86_400_000) : -1

    const marcaOnline = kvMap.get(`pago_online_${fono}`)
    const marcaComp = kvMap.get(`comprobante_ok_${fono}`)
    const marcaPago = marcaComp ? "comprobante_ok" : marcaOnline ? "pago_online" : null

    const l = loopMap.get(fono) || null
    const loop = l ? `${l.estado}${l.motivo_cierre ? `/${l.motivo_cierre}` : ""}${l.stage ? ` · ${l.stage}` : ""}` : null

    const hist = (porContacto.get(fono) || []).filter((m) => Number.isFinite(aceptadaMs) && m.at > aceptadaMs + 60_000)
    const mensajesNuestrosPost = hist.filter((m) => m.role === "assistant").length
    const delCliente = hist.filter((m) => m.role === "user")
    const ultimoMensajeCliente = delCliente.length ? new Date(delCliente[delCliente.length - 1].at).toISOString().slice(0, 16) : null

    const otraPagada = (pagadasPorFono.get(fono) || []).filter((n) => n !== String(q.Numero_Cotizacion || ""))
    const veredicto = otraPagada.length
      ? `duplicado — el cliente pagó ${otraPagada.join(", ")}`
      : marcaPago
      ? "PAGO MARCADO — la plata puede estar y la cotización sigue Aceptada"
      : ptvSet.has(fono)
        ? "traspasado — el empujón es del ejecutivo"
        : delCliente.length
          ? "el cliente siguió hablando y no pagó"
          : mensajesNuestrosPost > 0
            ? `se le insistió ${mensajesNuestrosPost} ${mensajesNuestrosPost === 1 ? "vez" : "veces"} y no contestó`
            : "SIN NINGÚN SEGUIMIENTO tras aceptar"

    filas.push({
      numero: String(q.Numero_Cotizacion || ""),
      empresa: String(q.Name || "").replace(/^Cotización\s+/i, "").replace(/\s+-\s+\d{4}-\d{2}-\d{2}$/, "").trim(),
      quoteId: q.id,
      fono,
      canal: String(q.Intervenci_n_Humana || "(sin marca)"),
      dueno: String(q.Owner?.name || ""),
      aceptadaIso: aceptadaIso.slice(0, 16),
      diasAceptada,
      recurrenteClp,
      unicoClp,
      deal: q.Deal_Asociado?.name || null,
      dealStage: null,
      marcaPago,
      otraPagada: otraPagada.length ? otraPagada.join(", ") : null,
      loop,
      traspasoActivo: ptvSet.has(fono),
      mensajesNuestrosPost,
      ultimoMensajeCliente,
      clienteEscribioPost: delCliente.length > 0,
      veredicto,
    })
  }

  filas.sort((a, b) => b.diasAceptada - a.diasAceptada)

  const suma = (f: Fila[], k: "recurrenteClp" | "unicoClp") => f.reduce((a, x) => a + x[k], 0)
  const duplicados = filas.filter((f) => f.otraPagada)
  const reales = filas.filter((f) => !f.otraPagada)
  const vicky = reales.filter((f) => f.canal === "100% Vicky")
  const ejec = reales.filter((f) => f.canal !== "100% Vicky")
  const porVeredicto: Record<string, number> = {}
  for (const f of filas) {
    const k = f.veredicto.split(" —")[0].split(" y no")[0]
    porVeredicto[k] = (porVeredicto[k] || 0) + 1
  }

  if (csv) {
    const cab = "numero;empresa;canal;dueno;aceptada;dias;recurrente_clp;unico_clp;marca_pago;otra_pagada;loop;traspaso;nuestros_msgs_post;ultimo_msg_cliente;veredicto;deal"
    const cuerpo = filas.map((f) =>
      [f.numero, f.empresa.replace(/;/g, ","), f.canal, f.dueno, f.aceptadaIso, f.diasAceptada, f.recurrenteClp, f.unicoClp,
        f.marcaPago || "", f.otraPagada || "", f.loop || "", f.traspasoActivo ? "si" : "", f.mensajesNuestrosPost, f.ultimoMensajeCliente || "",
        f.veredicto.replace(/;/g, ","), (f.deal || "").replace(/;/g, ",")].join(";"),
    ).join("\n")
    return new Response(`${cab}\n${cuerpo}\n`, { headers: { "content-type": "text/csv; charset=utf-8" } })
  }

  return NextResponse.json({
    ok: true,
    total: filas.length,
    // El monto EN JUEGO excluye los duplicados: esa plata ya entró por otra
    // cotización del mismo cliente.
    reales: reales.length,
    mrrEnJuegoClp: suma(reales, "recurrenteClp"),
    unicosEnJuegoClp: suma(reales, "unicoClp"),
    duplicados: { casos: duplicados.length, mrrClp: suma(duplicados, "recurrenteClp"), detalle: duplicados.map((f) => `${f.numero} ${f.empresa} → pagó ${f.otraPagada}`) },
    canalVicky: { casos: vicky.length, mrrClp: suma(vicky, "recurrenteClp") },
    canalEjecutivo: { casos: ejec.length, mrrClp: suma(ejec, "recurrenteClp") },
    conMarcaDePago: reales.filter((f) => f.marcaPago).length,
    sinSeguimiento: reales.filter((f) => f.mensajesNuestrosPost === 0 && !f.traspasoActivo).length,
    porVeredicto,
    masViejas: filas.slice(0, 5).map((f) => `${f.numero} ${f.empresa} · ${f.diasAceptada} d`),
    filas,
    fallas,
    ms: Date.now() - t0,
  })
}
