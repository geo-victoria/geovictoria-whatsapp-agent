/**
 * ADMIN — RESET de un contacto INTERNO para pruebas (24-ago, "elimina mi
 * historial y el de Rodrigo para que pruebe Vicky Onboarding").
 *
 * POST { contact } (auth cron) → borra su historial de conversación
 * (vic_v3_messages + vic_v3_conversations) y el estado de onboarding
 * (fase, borrador, alta solicitada, candado de kickoff).
 *
 * LISTA BLANCA DURA: solo los números internos de prueba. Este endpoint
 * BORRA datos — jamás debe poder apuntarse a un cliente real, ni con el
 * secreto en mano.
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"

export const dynamic = "force-dynamic"
export const maxDuration = 30

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()

/** Números internos reseteables (Lalo y Rodrigo). Ampliable por env
 * VICKY_RESET_CONTACTOS (coma-separado) — también solo para internos. */
const RESETEABLES = new Set(
  ["56944668823", "56978385048", ...(process.env.VICKY_RESET_CONTACTOS || "").split(",")]
    .map((s) => s.replace(/\D/g, ""))
    .filter(Boolean),
)

async function autorizado(req: Request): Promise<boolean> {
  const secreto = await getFollowupCronSecret().catch(() => "")
  const cron = (process.env.CRON_SECRET || "").trim()
  const url = new URL(req.url)
  const auth = req.headers.get("authorization") || ""
  const entregado =
    req.headers.get("x-cron-secret") || (auth.startsWith("Bearer ") ? auth.slice(7) : "") || url.searchParams.get("key") || ""
  return Boolean(entregado) && (entregado === secreto || (Boolean(cron) && entregado === cron))
}

const H = () => ({ apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" })

export async function POST(req: Request): Promise<NextResponse> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  const body = (await req.json().catch(() => ({}))) as { contact?: string }
  const contact = String(body.contact || "").replace(/\D/g, "")
  if (!RESETEABLES.has(contact)) {
    return NextResponse.json({ ok: false, error: "contacto fuera de la lista blanca de prueba" }, { status: 403 })
  }

  // 1. Conversaciones del contacto → sus mensajes → las filas.
  const rc = await fetch(
    `${SUPABASE_URL}/rest/v1/vic_v3_conversations?contact=eq.${contact}&select=id`,
    { headers: H(), cache: "no-store" },
  )
  const convs = rc.ok ? ((await rc.json().catch(() => [])) as Array<{ id: string }>) : []
  let mensajesBorrados = 0
  for (const c of convs) {
    const rm = await fetch(`${SUPABASE_URL}/rest/v1/vic_v3_messages?conversation_id=eq.${c.id}`, {
      method: "DELETE",
      headers: { ...H(), Prefer: "count=exact" },
      cache: "no-store",
    })
    mensajesBorrados += Number(rm.headers.get("content-range")?.split("/")[1] || 0)
  }
  await fetch(`${SUPABASE_URL}/rest/v1/vic_v3_conversations?contact=eq.${contact}`, {
    method: "DELETE",
    headers: H(),
    cache: "no-store",
  })

  // 2. TODO el estado por contacto en vic_kv (31-ago, caso Rodrigo: el reset
  // dejaba vivo `campana_dcto_` de una prueba anterior y el vigía de la
  // campaña le aplicó +10 sobre el descuento recién negociado). El endpoint
  // es SOLO para los probadores de la lista blanca, así que borrar toda
  // llave que contenga su número es lo correcto: fase, borrador, campaña,
  // gate, marcas de pago, dedup de lead, tqlogs — prueba limpia de verdad.
  let llavesBorradas = 0
  const rk = await fetch(
    `${SUPABASE_URL}/rest/v1/vic_kv?key=like.${encodeURIComponent(`*${contact}*`)}`,
    { method: "DELETE", headers: { ...H(), Prefer: "count=exact" }, cache: "no-store" },
  )
  if (rk.ok) llavesBorradas = Number(rk.headers.get("content-range")?.split("/")[1] || 0)

  // 2-bis. ESTADO OPERATIVO FUERA DE vic_kv (Lalo 02-sep: "de nuevo borra
  // todo" — Vicky le respondió con la cotización COT1074 de una prueba
  // anterior, ya expirada, en vez de emitir una nueva). El puntero de
  // cotización vive en `vic_v3_quote_pointers`, tabla SEPARADA a propósito
  // para sobrevivir a la conversación; el reset lo dejaba intacto y el
  // siguiente turno recuperaba la cotización vieja. Lo mismo el loop de
  // seguimiento, el traspaso (que además deja al probador "presentado" a un
  // vendedor) y las llamadas/promesas de campaña. Sin esto el reset borra
  // el historial pero NO el estado: la prueba nace sucia.
  const tablasEstado: Array<[string, string]> = [
    ["vic_v3_quote_pointers", "contact"],
    ["vic_loop", "contact"],
    ["vic_ptv", "contact"],
    ["vic_scheduled_calls", "contact"],
    ["vic_llamadas", "contact"],
    ["vic_promesas", "contact"],
  ]
  const estadoBorrado: Record<string, number> = {}
  for (const [tabla, col] of tablasEstado) {
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/${tabla}?${col}=eq.${contact}`, {
        method: "DELETE",
        headers: { ...H(), Prefer: "count=exact" },
        cache: "no-store",
      })
      // Una tabla ausente (404) no rompe el reset: se anota en 0.
      estadoBorrado[tabla] = r.ok ? Number(r.headers.get("content-range")?.split("/")[1] || 0) : 0
    } catch {
      estadoBorrado[tabla] = 0
    }
  }

  // 3. COTIZACIONES VIVAS EN ZOHO → Expirada (Lalo 01-sep, tras el caso del
  // descuento sobre una cotización vieja de Rodrigo): las cotizaciones de
  // pruebas anteriores quedaban vivas en el CRM y cualquier tool que busque
  // "la cotización del contacto" podía adoptarlas. NO se borra nada (deals,
  // NDV y PDFs quedan como historia); solo se expiran las que siguen en
  // juego (Borrador/Enviada/Aceptada). Las Pagadas no se tocan jamás.
  let cotizacionesExpiradas = 0
  try {
    const { getZohoAccessToken } = await import("@/lib/zoho-token")
    const token = await getZohoAccessToken()
    const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
    const HZ = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }
    const quoteModule = (process.env.ZOHO_QUOTE_MODULE || "Cotizaciones_GeoVictoria").trim()
    const rs = await fetch(`${api}/crm/v3/${quoteModule}/search?phone=${contact}&per_page=50`, {
      headers: HZ,
      cache: "no-store",
    })
    if (rs.ok && rs.status === 200) {
      const filas = ((await rs.json().catch(() => ({}))) as {
        data?: Array<{ id?: string; Estado_Cotizacion?: string | null }>
      }).data || []
      const vivas = filas.filter((q) =>
        /^(borrador|enviada|aceptada)$/i.test(String(q.Estado_Cotizacion || "").trim()),
      )
      for (const q of vivas) {
        const ru = await fetch(`${api}/crm/v3/${quoteModule}/${q.id}`, {
          method: "PUT",
          headers: HZ,
          body: JSON.stringify({
            data: [{ id: q.id, Estado_Cotizacion: "Expirada" }],
            trigger: ["blueprint"],
          }),
          cache: "no-store",
        })
        if (ru.ok) cotizacionesExpiradas++
      }
    }
  } catch (e) {
    console.warn(`[reset-contacto] expirar cotizaciones falló (no bloquea):`, e instanceof Error ? e.message : e)
  }

  const estadoTxt = Object.entries(estadoBorrado)
    .filter(([, n]) => n > 0)
    .map(([t, n]) => `${t}=${n}`)
    .join(" ")
  console.log(`[reset-contacto] +${contact}: ${convs.length} conversación(es), ${mensajesBorrados} mensajes, ${llavesBorradas} llaves kv, ${cotizacionesExpiradas} cotización(es) expirada(s)${estadoTxt ? `, estado: ${estadoTxt}` : ""}`)
  return NextResponse.json({
    ok: true,
    contact,
    conversaciones: convs.length,
    mensajes: mensajesBorrados,
    llavesKv: llavesBorradas,
    cotizacionesExpiradas,
    estado: estadoBorrado,
  })
}
