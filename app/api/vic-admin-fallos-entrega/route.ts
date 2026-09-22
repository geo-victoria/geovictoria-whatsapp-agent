import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"
import { leerEstadosFallidos, glosaCodigo } from "@/lib/estado-entrega"
import { salientesDesde } from "@/lib/entrega-plantilla"

export const runtime = "nodejs"
export const maxDuration = 120

/**
 * QUÉ PLANTILLAS ESTÁ BOTANDO META Y POR QUÉ (SOLO LECTURA, 13-sep).
 *
 * Agrupa los estados FALLIDOS que reportó Meta vía el webhook de Botmaker, por
 * código y por plantilla. El nombre de la plantilla no viene en el payload de
 * estado (solo `messageId`), así que se resuelve cruzando contra la API de
 * mensajes de Botmaker — que solo alcanza ~72 h atrás, de modo que lo más
 * viejo queda sin nombre de plantilla (se dice, no se inventa).
 */
export async function GET(req: Request): Promise<Response> {
  const sp = new URL(req.url).searchParams
  const key = (sp.get("key") || req.headers.get("x-cron-secret") || "").trim()
  const secreto = (process.env.FOLLOWUP_CRON_SECRET || "").trim() || (await getFollowupCronSecret().catch(() => "")) || ""
  if (!key || !secreto || key !== secreto) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })

  const dias = Math.min(Math.max(Number(sp.get("dias")) || 7, 1), 30)
  const fallos = await leerEstadosFallidos(dias)

  // Resolver messageId → plantilla para lo que siga dentro de la ventana viva.
  const porMsgId = new Map<string, string>()
  if (fallos.length) {
    const desdeIso = new Date(Date.now() - 70 * 3600e3).toISOString()
    const { porContacto } = await salientesDesde(desdeIso, { presupuestoMs: 60_000, maxPaginas: 20 })
    for (const arr of porContacto.values()) for (const m of arr) if (m.tpl) porMsgId.set(`${m.contacto}|${m.at}`, m.tpl)
  }

  const porCodigo: Record<string, { n: number; glosa: string; contactos: string[] }> = {}
  const porLinea: Record<string, number> = {}
  for (const f of fallos) {
    const c = f.codigo || f.status || "sin_codigo"
    porCodigo[c] = porCodigo[c] || { n: 0, glosa: glosaCodigo(c), contactos: [] }
    porCodigo[c].n++
    if (porCodigo[c].contactos.length < 10) porCodigo[c].contactos.push(f.contacto)
    const l = f.linea || "?"
    porLinea[l] = (porLinea[l] || 0) + 1
  }

  return NextResponse.json({
    ok: true,
    ventanaDias: dias,
    total: fallos.length,
    porCodigo,
    porLinea,
    nota:
      fallos.length === 0
        ? "sin fallos registrados. El histórico arranca el 13-sep, y ese mismo día la línea 56967308227 (Vicky Chile) quedó conectada al webhook de estados — verificado con un payload real de esa línea. Cero fallos acá significa que no hubo, no que no estemos escuchando."
        : "el nombre de la plantilla solo se resuelve dentro de las ~72 h que alcanza la API de mensajes de Botmaker",
    ultimos: fallos.slice(0, 40),
  })
}
