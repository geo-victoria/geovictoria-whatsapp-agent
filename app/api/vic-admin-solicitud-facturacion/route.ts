/**
 * Solicitud de Facturación a mano / retroactiva (24-sep).
 * GET ?key=<cron>&quoteId=<id>[&contact=569…][&referenciaId=][&impId=][&dry=1][&forzar=1]
 * Sin `contact` lo resuelve por la cotización (findContactByQuoteId).
 * `dry=1` devuelve el registro que se crearía y qué falta, sin escribir nada.
 * `publicar=1` (25-sep): NO crea solicitud; deja los datos de facturación en
 * la cuenta (Comuna/Dirección vacías) y en notas de cuenta y deal. Sirve para
 * cualquier canal (sin conversación usa el teléfono de la cotización).
 */
import { NextResponse } from "next/server"
import { findContactByQuoteId, getFollowupCronSecret } from "@/lib/supabase-persistence-v3"
import { crearSolicitudFacturacion, publicarDatosFacturacion } from "@/lib/solicitud-facturacion"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

const CRON_SECRET = (process.env.CRON_SECRET || "").trim()

async function autorizado(req: Request): Promise<boolean> {
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim()
  const key = (new URL(req.url).searchParams.get("key") || "").trim()
  const xcron = (req.headers.get("x-cron-secret") || "").trim()
  if (CRON_SECRET && (bearer === CRON_SECRET || key === CRON_SECRET || xcron === CRON_SECRET)) return true
  const kv = await getFollowupCronSecret().catch(() => "")
  return Boolean(kv) && (xcron === kv || key === kv)
}

export async function GET(req: Request): Promise<Response> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  const u = new URL(req.url)
  const quoteId = (u.searchParams.get("quoteId") || "").replace(/\D/g, "")
  if (!quoteId) return NextResponse.json({ ok: false, error: "falta quoteId" }, { status: 400 })
  if (u.searchParams.get("publicar") === "1") {
    const r = await publicarDatosFacturacion(quoteId, {
      contact: (u.searchParams.get("contact") || "").replace(/\D/g, "") || undefined,
      dry: u.searchParams.get("dry") === "1",
    })
    return NextResponse.json(r, { status: r.ok ? 200 : 502 })
  }
  let contact = (u.searchParams.get("contact") || "").replace(/\D/g, "")
  if (!contact) contact = (await findContactByQuoteId(quoteId).catch(() => null)) || ""
  if (!contact) return NextResponse.json({ ok: false, error: "sin contacto para esa cotización (pásalo con &contact=)" }, { status: 404 })
  const r = await crearSolicitudFacturacion(contact, {
    quoteId,
    referenciaNdvId: u.searchParams.get("referenciaId") || undefined,
    impId: u.searchParams.get("impId") || undefined,
    dry: u.searchParams.get("dry") === "1",
    forzar: u.searchParams.get("forzar") === "1",
  })
  return NextResponse.json({ contact, ...r }, { status: r.ok ? 200 : 502 })
}
