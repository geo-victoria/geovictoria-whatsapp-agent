/**
 * ADMIN — LA PROACTIVIDAD QUE NO SALIÓ (13-sep, pedido de Lalo).
 *
 * Lee el registro de `lib/envio-fallido.ts` y lo resume: por motivo, por
 * plantilla y por día, con el detalle de Botmaker que es donde vive el porqué
 * real (número sin WhatsApp, plantilla no aprobada, ventana cerrada…).
 *
 * LO QUE ESTE INFORME **NO** VE, y hay que decirlo cada vez que se presente:
 * un 202 de Botmaker significa "encargo aceptado", no "mensaje entregado".
 * Una plantilla en revisión, el pacing de Meta o el tope de 2 mensajes de
 * marketing seguidos en 24 h se registran como ÉXITO de nuestro lado. Para
 * ese hueco hace falta cruzar contra lo que Botmaker efectivamente despachó.
 *
 * GET ?key=<cron>[&dias=7][&detalle=1]
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"
import { leerEnviosFallidos } from "@/lib/envio-fallido"

export const dynamic = "force-dynamic"
export const maxDuration = 60

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
  const dias = Math.min(30, Math.max(1, Number(sp.get("dias") || 7)))
  const fallos = await leerEnviosFallidos(dias)

  const cuenta = (clave: (f: (typeof fallos)[number]) => string): Record<string, number> => {
    const out: Record<string, number> = {}
    for (const f of fallos) {
      const k = clave(f) || "—"
      out[k] = (out[k] || 0) + 1
    }
    return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]))
  }

  return NextResponse.json({
    ok: true,
    dias,
    total: fallos.length,
    desdeQueEmpezoElRegistro: "2026-09-13",
    porMotivo: cuenta((f) => f.motivo),
    porPlantilla: cuenta((f) => f.tpl || "(texto libre)"),
    porDia: cuenta((f) => f.at.slice(0, 10)),
    porContacto: cuenta((f) => f.c),
    nota: "Un 202 de Botmaker es 'encargo aceptado', no 'entregado': plantilla en revisión, pacing de Meta o el tope de 2 marketing en 24 h NO aparecen acá.",
    ...(sp.get("detalle") === "1" ? { fallos: fallos.slice(0, 300) } : {}),
  })
}
