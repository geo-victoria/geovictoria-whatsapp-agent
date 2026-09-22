/**
 * Cálculo PURO de la anualidad para PE/CO (Lalo 21-sep: "anualidad: sí
 * ofrezcamos, igualemos a Chile"). Misma regla que lib/tools/anualizar-
 * cotizacion.ts (CL, 01-sep): TODO lo recurrente se cobra por adelantado en un
 * solo pago de 12 meses al MISMO precio; el descuento comiteado del plan se
 * aplica los `meses` de su vigencia (0 = indefinido = 12) y el arriendo del
 * equipo va a lista los 12 meses.
 *
 * Sin imports: lo consumen lib/paises/anualizar-pais.ts y los tests.
 */
export type FilaRecurrente = {
  codigo: string
  nombre: string
  /** Subtotal mensual a precio de LISTA, en la moneda del país. */
  subtotal: number
  /** Modalidad Zoho ("Recurrente" | "Único" | "Arriendo" | "Venta"). */
  modalidad: string
  esRecurrente: boolean
}

export type ResultadoAnual = {
  /** Plan anual (12 meses, con el descuento en los meses de vigencia). */
  planAnual: number
  /** Arriendo/alquiler anual del equipo (12 × lista). */
  arriendoAnual: number
  planMensual: number
  arriendoMensual: number
  pct: number
  meses: number
}

export function esFilaPlanRecurrente(f: { codigo: string; nombre: string; modalidad: string; esRecurrente: boolean }): boolean {
  if (!f.esRecurrente) return false
  const c = String(f.codigo || "").toLowerCase()
  if (c.startsWith("plan")) return true
  if (/reloj|equipo|hardware|arriendo/.test(c)) return false
  if (/arriendo/i.test(String(f.modalidad || ""))) return false
  return /asistencia|plan/.test(String(f.nombre || "").toLowerCase())
}

export function esFilaArriendo(f: { codigo: string; modalidad: string; esRecurrente: boolean }): boolean {
  if (!f.esRecurrente) return false
  return /arriendo/i.test(String(f.modalidad || "")) || /reloj|equipo|hardware|arriendo/.test(String(f.codigo || "").toLowerCase())
}

/**
 * @param decimales 2 en Perú (soles con centavos), 0 en Colombia (COP enteros).
 */
export function calcularAnualPais(filas: FilaRecurrente[], pct: number, mesesVigencia: number, decimales: 0 | 2): ResultadoAnual {
  const r = (v: number) => (decimales === 2 ? Math.round(v * 100) / 100 : Math.round(v))
  const p = Math.max(0, Math.min(100, Number(pct) || 0))
  let meses = Number.isFinite(Number(mesesVigencia)) && Number(mesesVigencia) >= 0 ? Math.floor(Number(mesesVigencia)) : 6
  if (meses === 0 || meses > 12) meses = 12
  let planMensual = 0
  let arriendoMensual = 0
  for (const f of filas) {
    if (esFilaPlanRecurrente(f)) planMensual += Number(f.subtotal || 0)
    else if (esFilaArriendo(f)) arriendoMensual += Number(f.subtotal || 0)
  }
  const planConDcto = planMensual * (1 - p / 100)
  const planAnual = r(planConDcto * meses + planMensual * (12 - meses))
  const arriendoAnual = r(arriendoMensual * 12)
  return { planAnual, arriendoAnual, planMensual: r(planMensual), arriendoMensual: r(arriendoMensual), pct: p, meses }
}
