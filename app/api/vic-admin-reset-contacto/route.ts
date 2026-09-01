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

  console.log(`[reset-contacto] +${contact}: ${convs.length} conversación(es), ${mensajesBorrados} mensajes, ${llavesBorradas} llaves kv`)
  return NextResponse.json({ ok: true, contact, conversaciones: convs.length, mensajes: mensajesBorrados, llavesKv: llavesBorradas })
}
