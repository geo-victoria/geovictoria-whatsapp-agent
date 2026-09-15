/** Lado con red de lib/fecha-pago-reglas.ts: lee las marcas kv y re-fecha la Caja. */

import { getKvValue, setKvValue } from "./supabase-persistence-v3"
import { fechaPagoDesdeMarcas, refecharVenta } from "./fecha-pago-reglas"

export { fechaPagoDesdeMarcas, refecharVenta }

/** Lee las dos marcas del contacto y resuelve la fecha real del pago. */
export async function fechaPagoReal(contact: string, quoteId: string): Promise<string | null> {
  const c = String(contact || "").replace(/\D/g, "")
  if (!c || !quoteId) return null
  const [pagoOnline, comprobante] = await Promise.all([
    getKvValue(`pago_online_${c}`).catch(() => null),
    getKvValue(`comprobante_ok_${c}`).catch(() => null),
  ])
  return fechaPagoDesdeMarcas({ pagoOnline, comprobante }, quoteId)
}

/** Re-fecha la Caja de una cotización a la fecha real del pago (best-effort). */
export async function refecharCajaVenta(
  quoteId: string,
  pagoIsoReal: string,
): Promise<"refechada" | "sin_caja" | "sin_cambio"> {
  const key = `venta_dash_v3_${quoteId}`
  const actual = await getKvValue(key).catch(() => null)
  if (!actual) return "sin_caja"
  const nuevo = refecharVenta(actual, pagoIsoReal)
  if (!nuevo) return "sin_cambio"
  await setKvValue(key, nuevo)
  return "refechada"
}
