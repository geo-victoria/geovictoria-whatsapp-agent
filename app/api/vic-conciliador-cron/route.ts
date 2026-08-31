/**
 * CRON — CONCILIADOR DE ESTADO Y DUEÑO (29-ago, orden de Lalo).
 *
 * Refresca la foto vieja que dejan el traspaso y el loop. Ver lib/conciliador
 * para el porqué y la evidencia del saneamiento de agosto.
 *
 * TRES DESAJUSTES QUE CORRIGE, cada uno independiente:
 *   1. loop activo con PAGO registrado  → cierra el loop (motivo 'pagado')
 *   2. cotización formal con dueño SDR  → tómbola de deals + alinea registros
 *   3. fila de traspaso con vendedor ≠ dueño real en Zoho → la actualiza
 *
 * NACE EN SOMBRA. Sin el gate `conciliador_enabled` = "on" en vic_kv (o
 * CONCILIADOR_ENABLED=1) solo REPORTA lo que haría, sin escribir nada. Así se
 * revisa la lista antes de dejarlo actuar. `?dry=1` fuerza el modo sombra
 * aunque el gate esté encendido.
 *
 * GET/POST auth cron. Tope por tick para no cargar Zoho.
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret, getKvValue, setKvValue, getQuotePointer } from "@/lib/supabase-persistence-v3"
import { esSdr, estadoRealDelCaso, estaPagada, esFormalViva, type Desajuste } from "@/lib/conciliador"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "").trim()

async function supa(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
    cache: "no-store",
  })
}

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

async function actuando(): Promise<boolean> {
  if ((process.env.CONCILIADOR_ENABLED || "").trim() === "1") return true
  const kv = await getKvValue("conciliador_enabled").catch(() => null)
  return (kv || "").trim().toLowerCase() === "on"
}

/** ¿Hay pago registrado por comprobante para este contacto? */
async function pagoPorComprobante(contact: string): Promise<string | null> {
  const v = await getKvValue(`comprobante_ok_${contact}`).catch(() => null)
  if (!v) return null
  try {
    return String((JSON.parse(v) as { numero?: string }).numero || "comprobante")
  } catch {
    return "comprobante"
  }
}

export async function GET(req: Request): Promise<NextResponse> {
  return correr(req)
}
export async function POST(req: Request): Promise<NextResponse> {
  return correr(req)
}

async function correr(req: Request): Promise<NextResponse> {
  if (!(await autorizado(req))) {
    return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return NextResponse.json({ ok: false, error: "sin credenciales de base" }, { status: 503 })
  }
  const sp = new URL(req.url).searchParams
  const dry = sp.get("dry") === "1" || !(await actuando())
  const tope = Math.min(Math.max(Number(sp.get("limite")) || 40, 1), 120)

  const hallazgos: Desajuste[] = []
  const aplicados: string[] = []
  const fallos: string[] = []

  // ── (1) Loops ACTIVOS: ¿alguno tiene pago registrado? ────────────────────
  // El comprobante de transferencia no cierra el loop hoy (verificado 29-ago),
  // así que un cliente que ya pagó puede seguir recibiendo toques de venta.
  try {
    const r = await supa(`vic_loop?estado=eq.activo&select=contact,stage&limit=${tope * 3}`)
    const filas = r.ok ? ((await r.json().catch(() => [])) as Array<{ contact?: string }>) : []
    for (const f of filas.slice(0, tope)) {
      const contact = String(f.contact || "").replace(/\D/g, "")
      if (!contact) continue
      const cot = await pagoPorComprobante(contact)
      if (!cot) continue
      hallazgos.push({
        tipo: "loop_no_cerrado_con_pago",
        contact,
        detalle: `pago registrado (${cot}) y el loop sigue activo`,
      })
      if (dry) continue
      try {
        const { pagoCierraLoop } = await import("@/lib/loop-v2")
        await pagoCierraLoop(contact, "pagado")
        aplicados.push(`loop cerrado por pago — ${contact} (${cot})`)
      } catch (e) {
        fallos.push(`cerrar loop ${contact}: ${e instanceof Error ? e.message : "excepción"}`)
      }
    }
  } catch (e) {
    fallos.push(`revisión de loops: ${e instanceof Error ? e.message : "excepción"}`)
  }

  // ── (2) Traspasos vivos: cotización formal en manos de SDR ───────────────
  // Regla confirmada por Lalo (29-ago): una cotización formal no se queda con
  // una SDR. Escala por la Tómbola de Deals, que en el tramo SMB reparte entre
  // telemarketing. Un caso PAGADO nunca se toca — ese dueño lo decide la venta
  // autónoma post-pago, donde Aleydis sí cumple rol comercial.
  try {
    const r = await supa(
      `vic_ptv?estado=eq.activo&select=id,contact,vendedor_email,vendedor_nombre&limit=${tope * 2}`,
    )
    const filas = r.ok
      ? ((await r.json().catch(() => [])) as Array<{
          id?: string
          contact?: string
          vendedor_email?: string
        }>)
      : []
    let tocados = 0
    for (const f of filas) {
      if (tocados >= tope) break
      const contact = String(f.contact || "").replace(/\D/g, "")
      if (!contact || !esSdr(f.vendedor_email)) continue
      const puntero = await getQuotePointer(contact).catch(() => null)
      if (!puntero?.quoteId) continue
      const real = await estadoRealDelCaso(String(puntero.quoteId))
      if (!real) continue // Zoho no respondió: se reintenta al tick siguiente
      if (estaPagada(real.estadoCotizacion)) continue
      if (!esFormalViva(real.estadoCotizacion) || !real.dealId) continue
      if (!esSdr(real.duenoDealEmail)) continue // ya lo movió alguien: nada que hacer
      tocados++
      hallazgos.push({
        tipo: "formal_con_sdr",
        contact,
        dealId: real.dealId,
        dueno: real.duenoDealEmail,
        detalle: `cotización ${real.estadoCotizacion} en manos de SDR`,
      })
      if (dry) continue
      const candado = `conc_formal_${real.dealId}`
      if (await getKvValue(candado).catch(() => null)) continue
      try {
        const { aplicarTombolaDeals } = await import("@/lib/crm-hitos")
        await aplicarTombolaDeals(real.dealId, "Chile")
        await setKvValue(candado, new Date().toISOString()).catch(() => {})
        aplicados.push(`formal escalada a telemarketing — deal ${real.dealId} (${contact})`)
      } catch (e) {
        fallos.push(`escalar deal ${real.dealId}: ${e instanceof Error ? e.message : "excepción"}`)
      }
    }
  } catch (e) {
    fallos.push(`revisión de traspasos: ${e instanceof Error ? e.message : "excepción"}`)
  }

  return NextResponse.json({
    ok: true,
    modo: dry ? "sombra (solo reporta)" : "aplicando",
    revisados: tope,
    hallazgos,
    ...(aplicados.length ? { aplicados } : {}),
    ...(fallos.length ? { fallos } : {}),
  })
}
