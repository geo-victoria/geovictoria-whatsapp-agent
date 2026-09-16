/**
 * ADMIN — VENTAS DE VICKY EN CLP, partidas en AUTÓNOMA y ASISTIDA
 * (pregunta de Lalo 10-sep: "cuántas ventas tiene Vicky en CLP… pagado, o
 * autónomo o asistido").
 *
 * Definiciones, las mismas que ya usan el dash y el cierre diario:
 *   · VENTA = cotización con Estado_Cotizacion "Pagada".
 *   · DE VICKY = el teléfono conversó con Vicky (mismo criterio del dash, que
 *     rescata las reactivadas de meses anteriores).
 *   · AUTÓNOMA / ASISTIDA = actividad del equipo de TELEMARKETING (lib/
 *     gestion-venta + lib/gestion-ventas-datos). Aleydis y Aracelli son SDR:
 *     su gestión es postventa y NO hace asistida una venta.
 *   · MONTOS = los de la Caja (vic_kv `venta_dash_v3_`): `montoClp` es el pago
 *     inicial COBRADO, `recurrenteClp` el MRR y `unicoClp` los pagos únicos.
 *
 * Solo CHILE: en CO/MX/PE los montos viven en los mismos campos pero en su
 * moneda, y sumarlos daría un número falso. Las excluidas se declaran.
 *
 * GET ?key=<cron>[&maxZoho=60][&desde=2026-01-01]
 * El tope de lecturas de Zoho por llamada deja ventas en "sd": la caché es
 * compartida con el dash, así que repetir la llamada completa el cuadro.
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"
import { universoVentasVicky } from "@/lib/ventas-vicky-universo"
import { gestionDeVentas } from "@/lib/gestion-ventas-datos"
import type { GestionVenta } from "@/lib/gestion-venta"

export const dynamic = "force-dynamic"
export const maxDuration = 300


async function autorizado(req: Request): Promise<boolean> {
  const secreto = await getFollowupCronSecret().catch(() => "")
  const cron = (process.env.CRON_SECRET || "").trim()
  const auth = req.headers.get("authorization") || ""
  const url = new URL(req.url)
  const entregado =
    req.headers.get("x-cron-secret") || (auth.startsWith("Bearer ") ? auth.slice(7) : "") || url.searchParams.get("key") || ""
  return Boolean(entregado) && (entregado === secreto || (Boolean(cron) && entregado === cron))
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  const sp = new URL(req.url).searchParams
  const desde = (sp.get("desde") || "2026-01-01").trim()
  const maxZoho = Math.min(120, Math.max(0, Number(sp.get("maxZoho") || 60)))
  // 1-4) Universo compartido con el pase de re-etiquetado (lib/ventas-vicky-universo):
  // pagadas → Caja → conversó con Vicky → regla de atribución → Chile y fecha.
  const u = await universoVentasVicky({ desde })
  if (!u) return NextResponse.json({ ok: false, error: "sin supabase o sin token zoho" }, { status: 503 })
  const universo = u.universo
  const pagadasLen = u.pagadasLeidas
  let sinMontoEnCaja = 0
  const porAtribucion = new Map<string, { ventas: number; cobradoClp: number }>()

  const gestion = await gestionDeVentas(
    universo.map((q) => ({ quoteId: q.quoteId, tel: q.tel, dealId: q.dealId, fechaMs: q.fechaMs })),
    { maxZoho },
  ).catch(() => new Map<string, GestionVenta>())

  const cero = () => ({ ventas: 0, cobradoClp: 0, mrrClp: 0, unicoClp: 0 })
  const tot = { autonoma: cero(), asistida: cero(), sd: cero() }
  const porMes = new Map<string, { autonoma: number; asistida: number; sd: number }>()
  // MRR INYECTADO POR MES (pregunta de Lalo 10-sep): el recurrente NUEVO que
  // entró cada mes, con su corte autónoma/asistida, más el acumulado corrido.
  const mrrMes = new Map<string, { ventas: number; mrr: number; autonoma: number; asistida: number }>()
  const detalleSd: string[] = []
  for (const q of universo) {
    const id = q.quoteId
    const c = q.caja
    if (!c) { sinMontoEnCaja++; continue }
    const g = (gestion.get(id) || "sd") as GestionVenta
    const b = tot[g]
    b.ventas++
    b.cobradoClp += Number(c.montoClp || 0) || 0
    b.mrrClp += Number(c.recurrenteClp || 0) || 0
    b.unicoClp += Number(c.unicoClp || 0) || 0
    const mes = String(c.pagoIso || q.fechaIso || "").slice(0, 7)
    const m = porMes.get(mes) || { autonoma: 0, asistida: 0, sd: 0 }
    m[g] += Number(c.montoClp || 0) || 0
    porMes.set(mes, m)
    const rec = Number(c.recurrenteClp || 0) || 0
    const mm = mrrMes.get(mes) || { ventas: 0, mrr: 0, autonoma: 0, asistida: 0 }
    mm.ventas++
    mm.mrr += rec
    if (g === "autonoma") mm.autonoma += rec
    else if (g === "asistida") mm.asistida += rec
    mrrMes.set(mes, mm)
    if (g === "sd" && detalleSd.length < 25) detalleSd.push(q.numero)
    const a = q.atribucion
    const acc = porAtribucion.get(a) || { ventas: 0, cobradoClp: 0 }
    acc.ventas++
    acc.cobradoClp += Number(c.montoClp || 0) || 0
    porAtribucion.set(a, acc)
  }

  const suma = (k: "ventas" | "cobradoClp" | "mrrClp" | "unicoClp") => tot.autonoma[k] + tot.asistida[k] + tot.sd[k]
  return NextResponse.json({
    ok: true,
    desde,
    definiciones: {
      venta: "cotización Pagada",
      deVicky: "conversó con Vicky Y la cotización le corresponde por la regla de atribución: emitida por Vicky, reemisión del ejecutivo sobre una de Vicky (mismo deal o teléfono), o precio mostrado por Vicky antes de la emisión ejecutiva",
      autonoma: "sin actividad del equipo de telemarketing, aunque haya traspaso; las SDR son postventa",
      montos: "cobradoClp = pago inicial cobrado · mrrClp = recurrente mensual · unicoClp = pagos únicos",
      soloChile: true,
    },
    total: { ventas: suma("ventas"), cobradoClp: suma("cobradoClp"), mrrClp: suma("mrrClp"), unicoClp: suma("unicoClp") },
    autonoma: tot.autonoma,
    asistida: tot.asistida,
    sinClasificar: tot.sd,
    porMesCobradoClp: Object.fromEntries([...porMes.entries()].sort()),
    mrrInyectadoPorMes: (() => {
      let acum = 0
      return [...mrrMes.entries()].sort().map(([mes, x]) => {
        acum += x.mrr
        return { mes, ventas: x.ventas, mrrNuevoClp: x.mrr, autonomaClp: x.autonoma, asistidaClp: x.asistida, mrrAcumuladoClp: acum }
      })
    })(),
    porAtribucion: Object.fromEntries([...porAtribucion.entries()]),
    excluidas: { ...u.excluidas, sinMontoEnLaCaja: sinMontoEnCaja },
    pagadasLeidas: pagadasLen,
    sinClasificarDetalle: detalleSd,
  })
}
