/**
 * PUENTE de sincronización de PDFs para el COTIZADOR (07-ago).
 *
 * El cotizador vive con su propio proyecto de Supabase (el de almacenamiento
 * de PDFs) y NO tiene credenciales del proyecto de Vicky — sus escrituras
 * directas a vic_v3_quote_pointers / vic_kv fallaban con 404 en silencio
 * (hallazgo caso COT341). Este endpoint recibe esas escrituras y las aplica
 * con las credenciales correctas:
 *
 *   POST { quoteId, accion: "pdf" | "marcar" | "limpiar", pdfUrl? }
 *     - "pdf":     actualiza pdf_url del puntero + limpia la marca pendiente
 *     - "marcar":  deja la marca pdf_dirty (edición sin versionar)
 *     - "limpiar": borra la marca
 *
 * Auth: x-vicky-secret == VICKY_COTIZADORA_SECRET (el secreto compartido que
 * ya viaja entre ambos deploys).
 */

import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"
export const maxDuration = 15

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim().replace(/\/$/, "")
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const SECRET = (process.env.VICKY_COTIZADORA_SECRET || "").trim()

const H = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" }

export async function POST(req: Request): Promise<Response> {
  if (!SECRET || (req.headers.get("x-vicky-secret") || "").trim() !== SECRET) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }
  const body = (await req.json().catch(() => ({}))) as {
    quoteId?: string
    accion?: string
    pdfUrl?: string
    meses?: number | null
  }
  const quoteId = (body.quoteId || "").trim()
  const accion = (body.accion || "").trim()
  if (!quoteId || !["pdf", "marcar", "limpiar", "meses_get", "meses_set"].includes(accion)) {
    return NextResponse.json({ ok: false, error: "quoteId/accion inválidos" }, { status: 400 })
  }
  try {
    // VIGENCIA DEL DESCUENTO (Lalo 10-ago): el cotizador no tiene credenciales
    // de este Supabase, así que su "cuántos meses dura el descuento de esta
    // cotización" pasa por acá. null = sin marca (política por defecto, 6
    // meses) · 0 = indefinido · N = N meses.
    if (accion === "meses_get") {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/vic_kv?key=eq.${encodeURIComponent(`descuento_meses_${quoteId}`)}&select=value&limit=1`,
        { headers: H, cache: "no-store" },
      )
      if (!r.ok) return NextResponse.json({ ok: false, meses: null }, { status: 502 })
      const filas = (await r.json().catch(() => [])) as Array<{ value?: string }>
      const crudo = filas[0]?.value
      const n = crudo === undefined || crudo === null || crudo === "" ? null : Number(crudo)
      return NextResponse.json({ ok: true, meses: Number.isFinite(n as number) ? n : null })
    }
    if (accion === "meses_set") {
      const key = `descuento_meses_${quoteId}`
      if (body.meses === null || body.meses === undefined) {
        await fetch(`${SUPABASE_URL}/rest/v1/vic_kv?key=eq.${encodeURIComponent(key)}`, {
          method: "DELETE",
          headers: H,
        }).catch(() => {})
        return NextResponse.json({ ok: true, meses: null })
      }
      const n = Math.min(120, Math.max(0, Math.trunc(Number(body.meses) || 0)))
      const r = await fetch(`${SUPABASE_URL}/rest/v1/vic_kv?on_conflict=key`, {
        method: "POST",
        headers: { ...H, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ key, value: String(n) }),
      })
      return NextResponse.json({ ok: r.ok, meses: n })
    }
    if (accion === "pdf") {
      const pdfUrl = (body.pdfUrl || "").trim()
      if (!pdfUrl) return NextResponse.json({ ok: false, error: "pdfUrl faltante" }, { status: 400 })
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/vic_v3_quote_pointers?quote_id=eq.${encodeURIComponent(quoteId)}`,
        {
          method: "PATCH",
          headers: { ...H, Prefer: "return=minimal" },
          body: JSON.stringify({ pdf_url: pdfUrl, updated_at: new Date().toISOString() }),
        },
      )
      if (!r.ok) return NextResponse.json({ ok: false, error: `pointer ${r.status}` }, { status: 502 })
      await fetch(`${SUPABASE_URL}/rest/v1/vic_kv?key=eq.${encodeURIComponent(`pdf_dirty_${quoteId}`)}`, {
        method: "DELETE",
        headers: H,
      }).catch(() => {})
      return NextResponse.json({ ok: true })
    }
    if (accion === "marcar") {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/vic_kv?on_conflict=key`, {
        method: "POST",
        headers: { ...H, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ key: `pdf_dirty_${quoteId}`, value: new Date().toISOString() }),
      })
      return NextResponse.json({ ok: r.ok })
    }
    // limpiar
    await fetch(`${SUPABASE_URL}/rest/v1/vic_kv?key=eq.${encodeURIComponent(`pdf_dirty_${quoteId}`)}`, {
      method: "DELETE",
      headers: H,
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e instanceof Error ? e.message : e).slice(0, 200) }, { status: 500 })
  }
}
