/**
 * BARRIDO — tareas y llamadas que quedaron a nombre del ROBOT (29-ago).
 *
 * El fix del traspaso (lib/reasignar-pendientes-lead) cubre de aquí en
 * adelante: cada entrega por tómbola arrastra sus pendientes. Este endpoint
 * cubre la COLA ARRASTRADA —y los caminos que no pasan por esas tómbolas,
 * como la Tómbola de Deals— barriendo las actividades que siguen en manos del
 * robot mientras su lead o su trato YA tiene dueño humano.
 *
 * Criterio (conservador, para no revolver el CRM):
 *   · solo tareas ABIERTAS y llamadas de la ventana reciente (`dias`, def. 30);
 *   · solo si el registro padre (lead o trato) tiene dueño PERSONA — si sigue
 *     en Vicky, la actividad se queda con ella, que es lo correcto: todavía no
 *     hay a quién entregársela;
 *   · nunca toca actividades que ya son de una persona.
 *
 * POST (auth cron) { dryRun?: boolean, limite?: number, dias?: number }
 * `dryRun: true` cuenta y muestra ejemplos sin escribir nada.
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"
import { getZohoAccessToken } from "@/lib/zoho-token"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const IDS_ROBOT = (process.env.VICKY_OWNERS_ROBOT || "3525045000484500876,3525045000000200013")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)

async function autorizado(req: Request): Promise<boolean> {
  const secreto = await getFollowupCronSecret().catch(() => "")
  const cron = (process.env.CRON_SECRET || "").trim()
  const auth = req.headers.get("authorization") || ""
  const entregado =
    req.headers.get("x-cron-secret") ||
    (auth.startsWith("Bearer ") ? auth.slice(7) : "") ||
    new URL(req.url).searchParams.get("key") ||
    ""
  return Boolean(entregado) && (entregado === secreto || (Boolean(cron) && entregado === cron))
}

type Actividad = {
  id?: string
  What_Id?: { id?: string; name?: string }
  $se_module?: string
  Created_Time?: string
}

/** El despachador de huérfanos dispara por GET: misma pasada, sin parámetros. */
export async function GET(req: Request): Promise<NextResponse> {
  return POST(req)
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!(await autorizado(req))) {
    return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  }
  const sp = new URL(req.url).searchParams
  const body = (await req.json().catch(() => ({}))) as { dryRun?: boolean; limite?: number; dias?: number }
  const dryRun = body.dryRun === true || sp.get("dryRun") === "1"
  const limite = Math.min(Math.max(Number(body.limite || sp.get("limite")) || 200, 1), 400)
  const dias = Math.min(Math.max(Number(body.dias || sp.get("dias")) || 30, 1), 365)
  const desde = new Date(Date.now() - dias * 86_400_000).toISOString().slice(0, 19) + "-04:00"

  const token = await getZohoAccessToken()
  const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
  const H = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }

  const coql = async (q: string): Promise<Actividad[]> => {
    const r = await fetch(`${api}/crm/v8/coql`, {
      method: "POST",
      headers: H,
      cache: "no-store",
      body: JSON.stringify({ select_query: q }),
    })
    if (r.status === 204) return []
    if (!r.ok) {
      console.warn(`[pendientes-robot] COQL ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`)
      return []
    }
    return (((await r.json().catch(() => ({}))) as { data?: Actividad[] }).data || [])
  }

  const robots = IDS_ROBOT.map((i) => `'${i}'`).join(",")
  const pendientes: Record<"Tasks" | "Calls", Actividad[]> = {
    Tasks: await coql(
      `select id, What_Id, '$se_module', Created_Time from Tasks ` +
        `where Owner in (${robots}) and Status = 'No iniciado' and Created_Time > '${desde}' ` +
        `order by Created_Time desc limit ${limite}`,
    ),
    Calls: await coql(
      `select id, What_Id, '$se_module', Created_Time from Calls ` +
        `where Owner in (${robots}) and Created_Time > '${desde}' ` +
        `order by Created_Time desc limit ${limite}`,
    ),
  }

  // Dueño actual de cada registro padre, en una consulta por módulo.
  const padres = new Map<string, { modulo: string; ownerId?: string; ownerEmail?: string }>()
  for (const modulo of ["Leads", "Deals"] as const) {
    const ids = new Set<string>()
    for (const lista of Object.values(pendientes)) {
      for (const a of lista) {
        if (a.$se_module === modulo && a.What_Id?.id) ids.add(a.What_Id.id)
      }
    }
    for (let i = 0; i < [...ids].length; i += 100) {
      const lote = [...ids].slice(i, i + 100)
      if (lote.length === 0) continue
      const filas = (await coql(
        `select id, Owner from ${modulo} where id in (${lote.map((x) => `'${x}'`).join(",")}) limit 100`,
      )) as Array<{ id?: string; Owner?: { id?: string; email?: string } }>
      for (const f of filas) {
        if (f.id) padres.set(f.id, { modulo, ownerId: f.Owner?.id, ownerEmail: f.Owner?.email })
      }
    }
  }

  const porDueno = new Map<string, { modulo: "Tasks" | "Calls"; ids: string[]; email: string }>()
  const ejemplos: Array<{ modulo: string; actividad: string; padre: string; dueno: string }> = []
  let sinDuenoHumano = 0
  for (const modulo of ["Tasks", "Calls"] as const) {
    for (const a of pendientes[modulo]) {
      const padre = a.What_Id?.id ? padres.get(a.What_Id.id) : undefined
      const ownerId = padre?.ownerId || ""
      if (!a.id || !ownerId || IDS_ROBOT.includes(ownerId)) {
        sinDuenoHumano++
        continue
      }
      const clave = `${modulo}:${ownerId}`
      const acc = porDueno.get(clave) || { modulo, ids: [], email: padre?.ownerEmail || ownerId }
      acc.ids.push(a.id)
      porDueno.set(clave, acc)
      if (ejemplos.length < 12) {
        ejemplos.push({
          modulo,
          actividad: a.id,
          padre: a.What_Id?.name || "",
          dueno: padre?.ownerEmail || ownerId,
        })
      }
    }
  }

  const aMover = [...porDueno.values()].reduce((n, g) => n + g.ids.length, 0)
  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      ventanaDias: dias,
      revisadas: { tareas: pendientes.Tasks.length, llamadas: pendientes.Calls.length },
      aMover,
      seQuedanConVicky: sinDuenoHumano,
      ejemplos,
    })
  }

  let movidas = 0
  const fallos: string[] = []
  for (const [clave, grupo] of porDueno) {
    const ownerId = clave.split(":")[1]
    for (let i = 0; i < grupo.ids.length; i += 100) {
      const lote = grupo.ids.slice(i, i + 100)
      const put = await fetch(`${api}/crm/v3/${grupo.modulo}`, {
        method: "PUT",
        headers: H,
        cache: "no-store",
        body: JSON.stringify({ data: lote.map((id) => ({ id, Owner: { id: ownerId } })) }),
      })
      const resp = (await put.json().catch(() => ({}))) as { data?: Array<{ status?: string; message?: string }> }
      const ok = (resp.data || []).filter((r) => r?.status === "success").length
      movidas += ok
      if (ok !== lote.length) fallos.push(`${grupo.modulo}→${grupo.email}: ${ok}/${lote.length}`)
    }
  }

  console.log(`[pendientes-robot] ${movidas} actividad(es) movidas a su dueño real (ventana ${dias}d)`)
  return NextResponse.json({
    ok: true,
    ventanaDias: dias,
    revisadas: { tareas: pendientes.Tasks.length, llamadas: pendientes.Calls.length },
    movidas,
    seQuedanConVicky: sinDuenoHumano,
    ...(fallos.length ? { fallos } : {}),
  })
}
