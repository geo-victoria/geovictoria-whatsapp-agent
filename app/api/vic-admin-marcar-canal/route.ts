/**
 * Endpoint ADMIN: GET /api/vic-admin-marcar-canal
 *
 * BACKFILL del canal de emisión (Lalo 25-ago, "ahí no debe haber nada de
 * ejecutivos, ni en la fila de formales ni de vio precio"): las cotizaciones
 * anteriores al 19-ago no llevan `Intervenci_n_Humana` (la marca nació ese
 * día) y la regla de respaldo del dash las cuenta como Vicky si el contacto
 * conversó ALGUNA vez antes de la emisión — hoyo que infló la Foto con
 * tandas del editor (caso CAUK: 15 comunidades emitidas el 17-ago con el
 * chat mudo desde el 12).
 *
 * Criterio determinista: Vicky emite SIEMPRE dentro de la conversación, a
 * segundos/minutos de un mensaje del cliente. Cotización sin marca cuyo
 * contacto NO tiene mensajes de usuario en las 6 horas previas a la emisión
 * (o sin teléfono/conversación) = emisión de EJECUTIVO → se estampa
 * "Con intervención humana" en Zoho y el dash la excluye solo.
 *
 * Guardas:
 *  - Las PAGADAS no se tocan (el canal de las ventas ya fue curado a mano).
 *  - ?dry=1 (default): solo reporta; ?dry=0 escribe en Zoho (trigger
 *    blueprint, regla 21-ago).
 *  - Rango acotado por ?desde/?hasta (default 2026-08-01 → 2026-08-19,
 *    el período sin marca).
 */

import { NextResponse } from "next/server"
import { getZohoAccessToken } from "@/lib/zoho-token"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const CRON_SECRET = (process.env.CRON_SECRET || "").trim()
const ZOHO_API_DOMAIN = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
const QUOTE_MODULE = (process.env.ZOHO_QUOTE_MODULE || "Cotizaciones_GeoVictoria").trim()
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const VENTANA_MS = 6 * 3600_000
const HOLGURA_MS = 10 * 60_000

function hSb(): Record<string, string> {
  return { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
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

type Fila = { id: string; numero: string; fono: string; createdMs: number; estado: string }

export async function GET(req: Request): Promise<Response> {
  if (!(await authorized(req))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }
  const sp = new URL(req.url).searchParams
  const dry = sp.get("dry") !== "0"
  const desde = (sp.get("desde") || "2026-08-01").trim()
  const hasta = (sp.get("hasta") || "2026-08-19").trim()

  // 1. Cotizaciones sin marca del rango (paginado COQL).
  const token = await getZohoAccessToken()
  const filas: Fila[] = []
  for (let offset = 0; offset < 2000; offset += 200) {
    const q =
      `select id, Numero_Cotizacion, Tel_fono_Contacto, Created_Time, Estado_Cotizacion from ${QUOTE_MODULE} ` +
      `where Intervenci_n_Humana is null and Created_Time between '${desde}T00:00:00-04:00' and '${hasta}T23:59:59-04:00' ` +
      `order by Created_Time asc limit ${offset}, 200`
    const r = await fetch(`${ZOHO_API_DOMAIN}/crm/v3/coql`, {
      method: "POST",
      headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ select_query: q }),
      cache: "no-store",
    })
    const data = r.ok
      ? (((await r.json().catch(() => ({}))) as { data?: Array<Record<string, unknown>>; info?: { more_records?: boolean } }))
      : { data: [], info: { more_records: false } }
    for (const row of data.data || []) {
      filas.push({
        id: String(row.id || ""),
        numero: String(row.Numero_Cotizacion || ""),
        fono: String(row.Tel_fono_Contacto || "").replace(/\D/g, ""),
        createdMs: Date.parse(String(row.Created_Time || "")),
        estado: String(row.Estado_Cotizacion || ""),
      })
    }
    if (!data.info?.more_records) break
  }

  // 2. Mensajes de USUARIO por contacto en el rango (+ margen), en lotes.
  const fonos = Array.from(new Set(filas.map((f) => f.fono).filter(Boolean)))
  const convPorFono = new Map<string, string>()
  for (let i = 0; i < fonos.length; i += 50) {
    const lote = fonos.slice(i, i + 50)
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/vic_v3_conversations?contact=in.(${lote.join(",")})&select=id,contact`,
      { headers: hSb(), cache: "no-store" },
    ).catch(() => null)
    const rows = r?.ok ? (((await r.json().catch(() => [])) as Array<{ id: string; contact: string }>) || []) : []
    for (const c of rows) convPorFono.set(c.contact, String(c.id))
  }
  const msgsPorConv = new Map<string, number[]>()
  const convIds = Array.from(convPorFono.values())
  const margenIso = new Date(Date.parse(`${desde}T00:00:00-04:00`) - VENTANA_MS).toISOString()
  for (let i = 0; i < convIds.length; i += 40) {
    const lote = convIds.slice(i, i + 40)
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/vic_v3_messages?conversation_id=in.(${lote.join(",")})&role=eq.user&at=gte.${encodeURIComponent(margenIso)}&select=conversation_id,at&limit=20000`,
      { headers: hSb(), cache: "no-store" },
    ).catch(() => null)
    const rows = r?.ok ? (((await r.json().catch(() => [])) as Array<{ conversation_id: string; at: string }>) || []) : []
    for (const m of rows) {
      const t = Date.parse(m.at)
      if (!Number.isFinite(t)) continue
      const arr = msgsPorConv.get(String(m.conversation_id)) || []
      arr.push(t)
      msgsPorConv.set(String(m.conversation_id), arr)
    }
  }

  // 3. Clasificar.
  const ejecutivo: Fila[] = []
  let vicky = 0
  let pagadasIntactas = 0
  for (const f of filas) {
    if (!f.id || !Number.isFinite(f.createdMs)) continue
    if (f.estado === "Pagada") {
      pagadasIntactas++
      continue // ventas ya curadas a mano — no se tocan
    }
    const convId = f.fono ? convPorFono.get(f.fono) : undefined
    const tiempos = convId ? msgsPorConv.get(convId) || [] : []
    const hayChatCercano = tiempos.some((t) => t >= f.createdMs - VENTANA_MS && t <= f.createdMs + HOLGURA_MS)
    if (hayChatCercano) vicky++
    else ejecutivo.push(f)
  }

  // 4. Estampar (solo con dry=0), en lotes de 100.
  let marcadas = 0
  const errores: string[] = []
  if (!dry) {
    for (let i = 0; i < ejecutivo.length; i += 100) {
      const lote = ejecutivo.slice(i, i + 100)
      const r = await fetch(`${ZOHO_API_DOMAIN}/crm/v3/${QUOTE_MODULE}`, {
        method: "PUT",
        headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          data: lote.map((f) => ({ id: f.id, Intervenci_n_Humana: "Con intervención humana" })),
          trigger: ["blueprint"],
        }),
      })
      const body = (await r.json().catch(() => ({}))) as { data?: Array<{ code?: string }> }
      const ok = (body.data || []).filter((d) => d.code === "SUCCESS").length
      marcadas += ok
      if (!r.ok || ok !== lote.length) errores.push(`lote ${i}: HTTP ${r.status}, ok=${ok}/${lote.length}`)
    }
  }

  return NextResponse.json({
    ok: true,
    dry,
    rango: { desde, hasta },
    revisadas: filas.length,
    vicky,
    pagadasIntactas,
    ejecutivo: ejecutivo.length,
    marcadas,
    errores,
    muestraEjecutivo: ejecutivo.slice(0, 60).map((f) => `${f.numero} ${f.fono || "sin-fono"} ${new Date(f.createdMs).toISOString().slice(0, 16)}`),
    // ?ids=1: lista completa de ids clasificados ejecutivo (para estampar
    // desde fuera cuando este endpoint corre solo en modo lectura).
    ...(sp.get("ids") === "1" ? { idsEjecutivo: ejecutivo.map((f) => f.id) } : {}),
  })
}
