/**
 * ADMIN — VER un toque antes de mandarlo (04-sep).
 *
 * Cambiar el texto de los toques toca lo que van a leer miles de clientes, y
 * hasta hoy la única forma de saber qué diría la generación por contexto era
 * esperar a que el cron se lo mandara a alguien de verdad. Este endpoint la
 * corre en seco: devuelve el texto y NO envía nada, no toca la cadencia y no
 * escribe en el historial.
 *
 *   GET ?key=<cron>&contact=<fono>[&stage=formal|con_precio|sin_precio|aceptada]
 *
 * `stage` por defecto sale del loop vivo del contacto; se puede forzar para
 * ver cómo hablaría en otra etapa.
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"
import { generarToqueContexto } from "@/lib/toque-contexto"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim().replace(/\/$/, "")
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
// La generación por contexto es de las etapas de VENTA: la post-aceptación
// tiene su propio guion (el link de pago) y no pasa por acá.
type EtapaGenerable = "sin_precio" | "con_precio" | "formal"
const ETAPAS: EtapaGenerable[] = ["sin_precio", "con_precio", "formal"]

async function autorizado(req: Request): Promise<boolean> {
  const url = new URL(req.url)
  const dado =
    req.headers.get("x-cron-secret") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim() ||
    url.searchParams.get("key") ||
    ""
  if (!dado) return false
  const kv = await getFollowupCronSecret().catch(() => "")
  return dado === (process.env.CRON_SECRET || "").trim() || (Boolean(kv) && dado === kv)
}

/** Etapa y toque vigentes del loop del contacto (solo para informar). */
async function estadoDelLoop(contact: string): Promise<{ stage: string; next_touch: number | null } | null> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/vic_loop?contact=eq.${encodeURIComponent(contact)}&select=stage,next_touch&limit=1`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, cache: "no-store" },
    )
    const rows = (await r.json().catch(() => [])) as Array<{ stage: string; next_touch: number | null }>
    return rows[0] || null
  } catch {
    return null
  }
}

export async function GET(req: Request): Promise<Response> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  const sp = new URL(req.url).searchParams
  const contact = (sp.get("contact") || "").replace(/\D/g, "")
  if (!contact) return NextResponse.json({ ok: false, error: "falta contact" }, { status: 400 })

  const loop = await estadoDelLoop(contact)
  const pedida = (sp.get("stage") || "").trim() as EtapaGenerable
  const delLoop = (loop?.stage || "") as EtapaGenerable
  const stage: EtapaGenerable = ETAPAS.includes(pedida)
    ? pedida
    : ETAPAS.includes(delLoop)
      ? delLoop
      : "formal"

  const generado = await generarToqueContexto(contact, stage).catch((e) => {
    console.warn("[toque-preview]", e instanceof Error ? e.message : e)
    return null
  })

  return NextResponse.json({
    ok: true,
    contact,
    loop: loop || "sin loop vivo",
    stageUsada: stage,
    // null = la conversación no dio material y el toque caería al texto fijo.
    generado,
    nota: "Solo previsualiza: no envía, no persiste y no toca la cadencia.",
  })
}
