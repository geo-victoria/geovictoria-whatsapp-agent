/**
 * ADMIN — búsqueda de texto en los MENSAJES de las conversaciones (24-ago,
 * primera necesidad: "¿cuántas empresas pidieron integración con otro
 * software?"). Auth de cron, solo lectura.
 *
 * GET ?q=<término>&rol=user|assistant&limit=<n>&dias=<n>
 *   → filas {contact, at, content} de mensajes que contienen el término
 *     (ilike), agrupables por contacto en el cliente.
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()

async function autorizado(req: Request): Promise<boolean> {
  const secreto = await getFollowupCronSecret().catch(() => "")
  const cron = (process.env.CRON_SECRET || "").trim()
  const url = new URL(req.url)
  const auth = req.headers.get("authorization") || ""
  const entregado =
    req.headers.get("x-cron-secret") || (auth.startsWith("Bearer ") ? auth.slice(7) : "") || url.searchParams.get("key") || ""
  return Boolean(entregado) && (entregado === secreto || (Boolean(cron) && entregado === cron))
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  const sp = new URL(req.url).searchParams
  const q = (sp.get("q") || "").trim()
  if (!q || q.length < 2) return NextResponse.json({ ok: false, error: "falta ?q= (mínimo 2 caracteres)" }, { status: 400 })
  const rol = (sp.get("rol") || "").trim()
  const limit = Math.min(500, Math.max(1, Number(sp.get("limit") || 200)))
  const dias = Math.min(365, Math.max(1, Number(sp.get("dias") || 90)))
  const desde = new Date(Date.now() - dias * 864e5).toISOString()

  // ilike con comodines; PostgREST exige escapar % como %25 en la URL.
  const patron = encodeURIComponent(`%${q}%`)
  const filtroRol = rol === "user" || rol === "assistant" ? `&role=eq.${rol}` : ""
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/vic_v3_messages?content=ilike.${patron}${filtroRol}&at=gte.${desde}` +
      `&select=content,at,role,conversation_id&order=at.desc&limit=${limit}`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, cache: "no-store" },
  )
  if (!r.ok) return NextResponse.json({ ok: false, error: `supabase ${r.status}` }, { status: 502 })
  const filas = (await r.json().catch(() => [])) as Array<{
    content?: string
    at?: string
    role?: string
    conversation_id?: string
  }>

  // Resolver contacto por conversación (lote único).
  const convIds = [...new Set(filas.map((f) => String(f.conversation_id || "")).filter(Boolean))]
  const porConv = new Map<string, string>()
  for (let i = 0; i < convIds.length; i += 80) {
    const lote = convIds.slice(i, i + 80).map((id) => `"${id}"`).join(",")
    const rc = await fetch(
      `${SUPABASE_URL}/rest/v1/vic_v3_conversations?id=in.(${lote})&select=id,contact`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, cache: "no-store" },
    ).catch(() => null)
    const rows = rc?.ok ? ((await rc.json().catch(() => [])) as Array<{ id: string; contact: string }>) : []
    for (const row of rows) porConv.set(String(row.id), String(row.contact))
  }

  return NextResponse.json({
    ok: true,
    q,
    total: filas.length,
    filas: filas.map((f) => ({
      contact: porConv.get(String(f.conversation_id || "")) || "",
      at: f.at,
      role: f.role,
      content: String(f.content || "").slice(0, 400),
    })),
  })
}
