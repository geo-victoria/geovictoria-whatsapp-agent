/**
 * ROSTER DE TELEMARKETING POR PAÍS, legible por máquina (28-sep, caso CERCA:
 * el correo de PAGADA del cotizador dijo "100% AUTÓNOMA" en la primera venta
 * mexicana porque su clasificador tenía el roster de Chile escrito a mano —
 * Yahel, Laura y las notas de Karen no contaban). La FICHA OPERATIVA del
 * agente es la fuente única del equipo de los 4 países; este endpoint la
 * expone para que el cotizador (y cualquier otro consumidor) lea el MISMO
 * roster en vez de copiarlo.
 *
 * GET ?key=<cron>  (o x-cron-secret / Bearer)
 * → { paises: { cl: { telemarketing:[{email,zohoId,nombre,sesion}], sdr:[…],
 *               ventaAutonoma:{…}|null }, pe:…, co:…, mx:… },
 *     telemarketing: [ …los 4 países juntos, con `pais`… ] }
 *
 * Solo lectura. Sin teléfonos ni datos de clientes.
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"
import { PAISES_OPERATIVOS, fichaOperativa, type PersonaEquipo } from "@/lib/paises/ficha-operativa"

export const dynamic = "force-dynamic"
export const maxDuration = 10

async function autorizado(req: Request): Promise<boolean> {
  const secreto = await getFollowupCronSecret()
  const url = new URL(req.url)
  const auth = req.headers.get("authorization") || ""
  const entregado =
    req.headers.get("x-cron-secret") || (auth.startsWith("Bearer ") ? auth.slice(7) : "") || url.searchParams.get("key") || ""
  return Boolean(secreto) && entregado === secreto
}

function persona(p: PersonaEquipo) {
  return { email: p.email, zohoId: p.zohoId, nombre: p.nombre, sesion: p.sesion || "" }
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  const paises: Record<string, unknown> = {}
  const telemarketing: Array<ReturnType<typeof persona> & { pais: string }> = []
  for (const pais of PAISES_OPERATIVOS) {
    const f = fichaOperativa(pais)
    const tlmk = (f.equipo.telemarketing || []).map(persona)
    paises[pais] = {
      telemarketing: tlmk,
      sdr: (f.equipo.sdr || []).map(persona),
      ventaAutonoma: f.equipo.ventaAutonoma ? persona(f.equipo.ventaAutonoma) : null,
    }
    for (const p of tlmk) telemarketing.push({ ...p, pais })
  }
  return NextResponse.json({ ok: true, generadoAt: new Date().toISOString(), paises, telemarketing })
}
