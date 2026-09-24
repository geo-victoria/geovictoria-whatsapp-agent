/**
 * QUÉ BUILD ESTÁ ARRIBA (Ignacio 24-sep-2026, acordado con Lalo). Vercel
 * inyecta el commit del deploy en env; esta ruta lo devuelve para verificar
 * un deploy SIN sondear una funcionalidad (cicatriz 12-sep y 13-sep: sondear
 * un modo que ya existía hizo creer que el build nuevo estaba arriba).
 *
 * Pública y sin secretos: sha, rama, entorno, región y hora de arranque de
 * la instancia. El mensaje del commit NO se expone (lleva nombres de clientes).
 *
 *   curl -s https://<alias>/api/version
 *   → {"ok":true,"commit":"e115c4c…","rama":"vicky-v3","entorno":"preview",…}
 */

import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"

const ARRANQUE = new Date().toISOString()

export async function GET(): Promise<NextResponse> {
  const env = process.env
  return NextResponse.json(
    {
      ok: true,
      commit: (env.VERCEL_GIT_COMMIT_SHA || "").trim() || null,
      commitCorto: (env.VERCEL_GIT_COMMIT_SHA || "").trim().slice(0, 7) || null,
      rama: (env.VERCEL_GIT_COMMIT_REF || "").trim() || null,
      entorno: (env.VERCEL_ENV || "local").trim(),
      region: (env.VERCEL_REGION || "").trim() || null,
      arranque: ARRANQUE,
      ahora: new Date().toISOString(),
    },
    { headers: { "cache-control": "no-store" } },
  )
}
