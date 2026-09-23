/**
 * ADMIN — la FICHA OPERATIVA por país tal como la ve el sistema (23-sep, Lalo
 * "me debes dar la ficha para completar y que se asuma que toda la operación
 * será igual en todos los países").
 *
 * GET ?key=<cron>[&pais=cl|pe|co|mx][&espejos=1]
 *   → por país: entidad, cuentas, bancos que avisan, moneda/tolerancia,
 *     equipo (telemarketing / SDR / venta autónoma) con su sesión de espejo, y
 *     `pendientes` (lo que la ficha declara que FALTA). Con `espejos=1` cruza
 *     cada sesión declarada contra el worker (kv wa_espejo_status_<s>) y dice
 *     quién NO tiene sesión: es la lista que hay que agregar a WA_SESSION_IDS.
 *
 * Solo lectura. La ficha vive en lib/paises/ficha-operativa.ts; para cambiar
 * un dato se edita ahí (o se pisa por env donde el consumidor lo permite).
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret, getKvValue } from "@/lib/supabase-persistence-v3"
import { equipoOperativo, resumenFicha, fichaOperativa, todasLasFichas, PAISES_OPERATIVOS } from "@/lib/paises/ficha-operativa"

export const dynamic = "force-dynamic"
export const maxDuration = 30

async function autorizado(req: Request): Promise<boolean> {
  const env = (process.env.CRON_SECRET || "").trim()
  const url = new URL(req.url)
  const auth = req.headers.get("authorization") || ""
  const dado = req.headers.get("x-cron-secret") || (auth.startsWith("Bearer ") ? auth.slice(7) : "") || url.searchParams.get("key") || ""
  if (!dado) return false
  if (env && dado === env) return true
  const kv = await getFollowupCronSecret().catch(() => "")
  return Boolean(kv) && dado === kv
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  const url = new URL(req.url)
  const pais = (url.searchParams.get("pais") || "").toLowerCase()
  const conEspejos = url.searchParams.get("espejos") === "1"
  const fichas = pais ? [fichaOperativa(pais)] : todasLasFichas()

  const espejos: Array<{ pais: string; sesion: string; nombre: string; rol: string; estado: string; at: string | null }> = []
  if (conEspejos) {
    for (const p of equipoOperativo(pais || undefined)) {
      const raw = await getKvValue(`wa_espejo_status_${p.sesion}`).catch(() => null)
      let st: { estado?: string; at?: string } = {}
      try { st = raw ? (JSON.parse(raw) as { estado?: string; at?: string }) : {} } catch { st = {} }
      espejos.push({ pais: p.pais, sesion: p.sesion, nombre: p.nombre, rol: p.rol, estado: st.estado || "SIN_SESION_EN_WORKER", at: st.at || null })
    }
  }
  const sinSesion = espejos.filter((e) => e.estado === "SIN_SESION_EN_WORKER")

  return NextResponse.json({
    ok: true,
    paises: PAISES_OPERATIVOS,
    fichas: fichas.map(resumenFicha),
    pendientesPorPais: Object.fromEntries(fichas.map((f) => [f.pais, f.pendientes])),
    ...(conEspejos
      ? {
          espejos,
          sinSesionEnWorker: sinSesion.map((e) => e.sesion),
          instruccion: sinSesion.length
            ? `Agregar a WA_SESSION_IDS del worker (Railway): ${sinSesion.map((e) => e.sesion).join(",")} — después generar su link del QR (vic-admin-wa-espejo).`
            : "Todas las sesiones declaradas existen en el worker.",
        }
      : {}),
  })
}
