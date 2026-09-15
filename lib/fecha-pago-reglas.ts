/**
 * FECHA REAL DEL PAGO en la Caja (`venta_dash_v3_<quoteId>`).
 *
 * Cicatriz (09-sep, ANTON PAAR / Clínica Talca; 15-sep, Arquiglass COT1303):
 * la Caja fechaba la venta con `Fecha_Hora_Cotizacion`, que es la fecha de
 * ACEPTACIÓN, así que una cotización aceptada el 09 y pagada el 15 aparecía
 * vendida el 09 — el dash y el cierre diario del 15 no la mostraban y el del
 * 09 la sumaba retroactivamente. Zoho no guarda la fecha del pago en la
 * cotización: la única evidencia propia son las marcas kv `pago_online_<fono>`
 * (tarjeta verificada en MP) y `comprobante_ok_<fono>` (transferencia), que
 * traen `at` y el `quoteId` al que corresponden.
 *
 * Reglas:
 *  - `fechaPagoDesdeMarcas` (pura): la marca que nombra ESTA cotización manda;
 *    con las dos, la más temprana (el primer registro del pago). Una marca de
 *    OTRA cotización del mismo teléfono no cuenta (caso Lorena: dos pagadas
 *    con el mismo número).
 *  - `refecharVenta` (pura): solo mueve `pagoIso` hacia ADELANTE y conserva la
 *    fecha original en `pagoIsoAceptacion`. Nunca borra ni recalcula montos.
 */

// PURO: sin red ni Supabase — lo importan los tests y lib/fecha-pago.ts.


type Marca = { at?: string; quoteId?: string; numero?: string }

function parseMarca(raw: string | null | undefined): Marca | null {
  if (!raw) return null
  try {
    const m = JSON.parse(raw) as Marca
    return m && typeof m === "object" ? m : null
  } catch {
    return null
  }
}

function marcaEsDe(m: Marca | null, quoteId: string): boolean {
  if (!m) return false
  const q = String(quoteId || "").trim()
  if (!q) return false
  return String(m.quoteId || "").trim() === q || String(m.numero || "").trim() === q
}

/** Fecha ISO del pago real según las marcas kv del contacto, o null. */
export function fechaPagoDesdeMarcas(
  marcas: { pagoOnline?: string | null; comprobante?: string | null },
  quoteId: string,
): string | null {
  const candidatas = [parseMarca(marcas.pagoOnline), parseMarca(marcas.comprobante)]
    .filter((m) => marcaEsDe(m, quoteId))
    .map((m) => String(m?.at || ""))
    .filter((at) => Number.isFinite(Date.parse(at)))
    .sort((a, b) => Date.parse(a) - Date.parse(b))
  return candidatas[0] || null
}

/**
 * Devuelve el JSON de la Caja con `pagoIso` movido a la fecha real, o null si
 * no hay que tocar nada (JSON ilegible, misma fecha, o fecha nueva ANTERIOR a
 * la registrada — un pago no puede ser anterior a su propia aceptación).
 */
export function refecharVenta(json: string, pagoIsoReal: string): string | null {
  let v: Record<string, unknown>
  try {
    v = JSON.parse(json) as Record<string, unknown>
  } catch {
    return null
  }
  if (!v || typeof v !== "object") return null
  const nuevo = Date.parse(pagoIsoReal)
  const actual = Date.parse(String(v.pagoIso || ""))
  if (!Number.isFinite(nuevo)) return null
  if (Number.isFinite(actual)) {
    if (Math.abs(nuevo - actual) < 60_000) return null
    if (nuevo < actual) return null
  }
  const out: Record<string, unknown> = {
    ...v,
    pagoIsoAceptacion: String(v.pagoIsoAceptacion || v.pagoIso || ""),
    pagoIso: pagoIsoReal,
  }
  return JSON.stringify(out)
}

