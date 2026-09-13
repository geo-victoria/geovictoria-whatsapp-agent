import { NextResponse } from "next/server"
import { getFollowupCronSecret, setKvValue } from "@/lib/supabase-persistence-v3"

export const runtime = "nodejs"
export const maxDuration = 60

/**
 * CONFIGURAR EL WEBHOOK DE ESTADOS DE BOTMAKER (13-sep, pedido de Lalo).
 *
 * El webhook que apunta a `vic-botmaker-status` está ACTIVO y recibiendo
 * (último payload verificado 11-sep), pero su `channelsIds` NO incluye
 * **56967308227**, la línea principal de Vicky Chile — por eso no vemos los
 * fallos de Meta de las campañas chilenas, que es justo donde Lalo los notó.
 *
 * Escribe SOLO con `?confirmo=1`. Antes de tocar nada guarda la configuración
 * completa en vic_kv `bm_webhooks_backup_<ts>` para poder revertir, y después
 * RELEE para confirmar que quedó como se pidió (sin la relectura, un PUT que
 * responde 200 y no persiste se ve igual que uno exitoso).
 */

const BM = "https://api.botmaker.com"

export async function POST(req: Request): Promise<Response> {
  const sp = new URL(req.url).searchParams
  const key = (sp.get("key") || req.headers.get("x-cron-secret") || "").trim()
  const secreto = (process.env.FOLLOWUP_CRON_SECRET || "").trim() || (await getFollowupCronSecret().catch(() => "")) || ""
  if (!key || !secreto || key !== secreto) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })

  const token = (process.env.BOTMAKER_ACCESS_TOKEN || "").trim()
  if (!token) return NextResponse.json({ ok: false, error: "sin BOTMAKER_ACCESS_TOKEN" }, { status: 503 })
  const H = { "access-token": token, Accept: "application/json", "Content-Type": "application/json" }

  const body = (await req.json().catch(() => ({}))) as {
    id?: string
    agregarCanal?: string
    notifyStatusChanges?: boolean
  }
  const id = (body.id || "").trim()
  if (!id) return NextResponse.json({ ok: false, error: "falta id del webhook" }, { status: 400 })

  // 1. Leer todo y respaldar.
  const rl = await fetch(`${BM}/v2.0/webhooks`, { headers: H, cache: "no-store" })
  if (!rl.ok) return NextResponse.json({ ok: false, error: `listar ${rl.status}` }, { status: 502 })
  const lista = (await rl.json().catch(() => ({}))) as { items?: Array<Record<string, unknown>> }
  const items = Array.isArray(lista.items) ? lista.items : []
  await setKvValue(`bm_webhooks_backup_${Date.now()}`, JSON.stringify(items).slice(0, 20_000)).catch(() => {})

  const actual = items.find((w) => String(w.id) === id)
  if (!actual) return NextResponse.json({ ok: false, error: "no existe ese webhook", ids: items.map((w) => w.id) }, { status: 404 })

  // 2. Merge conservador: se parte del objeto COMPLETO que devolvió Botmaker y
  //    solo se tocan los campos pedidos. Nada de reconstruirlo a mano.
  const notif = { ...((actual.messagesNotifications || {}) as Record<string, unknown>) }
  const canales = Array.isArray(notif.channelsIds) ? [...(notif.channelsIds as string[])] : []
  const canal = (body.agregarCanal || "").trim()
  if (canal && !canales.includes(canal)) canales.push(canal)
  notif.channelsIds = canales
  if (typeof body.notifyStatusChanges === "boolean") notif.notifyStatusChanges = body.notifyStatusChanges
  const propuesto = { ...actual, messagesNotifications: notif }

  if (sp.get("confirmo") !== "1") {
    return NextResponse.json({
      ok: true,
      dry: true,
      nota: "nada escrito — repetir con ?confirmo=1",
      antes: actual.messagesNotifications,
      despues: notif,
    })
  }

  // 3. Escribir y RELEER (un 200 que no persiste se ve igual que un éxito).
  const rp = await fetch(`${BM}/v2.0/webhooks`, { method: "PUT", headers: H, body: JSON.stringify(propuesto), cache: "no-store" })
  const respuesta = await rp.text().catch(() => "")
  const rl2 = await fetch(`${BM}/v2.0/webhooks`, { headers: H, cache: "no-store" })
  const lista2 = (await rl2.json().catch(() => ({}))) as { items?: Array<Record<string, unknown>> }
  const despues = (Array.isArray(lista2.items) ? lista2.items : []).find((w) => String(w.id) === id)
  const quedo = despues?.messagesNotifications as { channelsIds?: string[]; notifyStatusChanges?: boolean } | undefined
  const persistio = Boolean(canal ? quedo?.channelsIds?.includes(canal) : true)

  return NextResponse.json({
    ok: rp.ok && persistio,
    statusPut: rp.status,
    respuesta: respuesta.slice(0, 400),
    persistio,
    quedo,
    nota: persistio ? "verificado releyendo" : "el PUT no persistió — revisar método/forma del body",
  })
}
