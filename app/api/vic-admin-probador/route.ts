/**
 * Endpoint ADMIN: marca (o desmarca) un contacto como PROBADOR de otro país.
 *
 * Existe porque el país que atiende a un contacto lo decide su prefijo, y para
 * probar Perú de punta a punta hace falta un +51 — los teléfonos del equipo son
 * chilenos. La marca CADUCA sola para que un olvido no deje a nadie atendido
 * por el país equivocado.
 *
 *   POST ?key=<cron>  {contact, pais:"pe"|"cl"|"co"|"mx", horas?}  → marca
 *   POST ?key=<cron>  {contact, pais:"off"}                         → limpia
 *   GET  ?key=<cron>&contact=<fono>                                 → estado
 *
 * Lista blanca: solo contactos internos (metricsContactSet) — jamás un cliente,
 * porque la marca cambia la moneda y el identificador tributario que se le pide.
 */

import { NextResponse } from "next/server"
import { getKvValue, setKvValue, getFollowupCronSecret } from "@/lib/supabase-persistence-v3"
import { clave, HORAS_PROBADOR, paisProbador } from "@/lib/probador-pais"
import { metricsContactSet } from "@/lib/funnel-analysis"
import { channelIdPorPais, paisDeNumero } from "@/lib/linea-por-pais"

export const dynamic = "force-dynamic"
export const maxDuration = 30

async function autorizado(req: Request): Promise<boolean> {
  const url = new URL(req.url)
  const key = (url.searchParams.get("key") || "").trim()
  const header = (req.headers.get("x-cron-secret") || "").trim()
  const env = (process.env.CRON_SECRET || "").trim()
  const kv = await getFollowupCronSecret().catch(() => "")
  const ok = (v: string) => Boolean(v) && (v === env || (Boolean(kv) && v === kv))
  return ok(key) || ok(header)
}

export async function GET(req: Request): Promise<Response> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  const contact = (new URL(req.url).searchParams.get("contact") || "").replace(/\D/g, "")
  if (!contact) return NextResponse.json({ ok: false, error: "falta contact" }, { status: 400 })
  const raw = (await getKvValue(clave(contact)).catch(() => null)) || ""
  return NextResponse.json({ ok: true, contact, marca: raw || null, vigente: await paisProbador(contact) })
}

export async function POST(req: Request): Promise<Response> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  const body = (await req.json().catch(() => null)) as { contact?: string; pais?: string; horas?: number } | null
  const contact = String(body?.contact || "").replace(/\D/g, "")
  const pais = String(body?.pais || "").trim().toLowerCase()
  if (!contact || !pais) return NextResponse.json({ ok: false, error: "contact y pais requeridos" }, { status: 400 })

  if (pais === "off" || pais === "-") {
    await setKvValue(clave(contact), "")
    // Al desmarcar, la línea de salida vuelve a la del prefijo del número.
    const propio = paisDeNumero(contact)
    if (propio !== "otro") await setKvValue(`canal_origen_${contact}`, channelIdPorPais(propio)).catch(() => {})
    return NextResponse.json({ ok: true, contact, marca: null })
  }
  if (!["cl", "co", "mx", "pe"].includes(pais)) {
    return NextResponse.json({ ok: false, error: "pais debe ser cl|co|mx|pe|off" }, { status: 400 })
  }
  // metricsContactSet, NO testContactSet: Lalo y Rodrigo salieron de la
  // OPERATIVA el 10-ago justo para poder probar el flujo real con sus
  // teléfonos, así que ahí no están — la de métricas sí los incluye.
  const internos = metricsContactSet()
  if (internos.size > 0 && !internos.has(contact)) {
    return NextResponse.json(
      { ok: false, error: "contact no está en la lista de contactos internos", contact },
      { status: 403 },
    )
  }
  const horas = Math.min(168, Math.max(1, Number(body?.horas) || HORAS_PROBADOR))
  const hasta = new Date(Date.now() + horas * 3600e3).toISOString()
  await setKvValue(clave(contact), JSON.stringify({ pais, hasta }))
  // LA LÍNEA DE SALIDA TAMBIÉN CAMBIA (21-sep, prueba de Lalo): el probador
  // cambiaba el país que ATIENDE, pero la respuesta salía por la línea del
  // prefijo (`canal_origen_` seguía en la chilena). Lalo escribió "Holaa" a la
  // línea +51, Vicky Perú respondió en el mismo segundo… por la línea de
  // Chile, y en el chat de Vicky Perú no apareció nada. Además el push
  // rechaza una plantilla del bot Perú si el canal de origen es el chileno
  // (plantilla_de_otro_pais), así que el formulario del alta tampoco salía.
  await setKvValue(`canal_origen_${contact}`, channelIdPorPais(pais as "cl" | "co" | "mx" | "pe")).catch(() => {})
  return NextResponse.json({ ok: true, contact, pais, hasta, horas, canalOrigen: channelIdPorPais(pais as "cl" | "co" | "mx" | "pe") })
}
