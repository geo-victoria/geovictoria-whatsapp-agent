// CONVENCIÓN DE MONEDA DEL TRATO — una sola fuente para el agente.
//
// Chile en UF (Lalo 25-sep: "para futuro en el deal para chile mantengamos
// todo en UF, valor y moneda"): supersede el CLP del 20-ago. Fuera de Chile
// cada país conserva su moneda (Perú "SOL" en el picklist de Zoho, no PEN).
// PURO: lo importan crm-hitos y los pases de limpieza.

export const MONEDA_DEAL_POR_TERRITORIO: Record<string, string> = {
  Chile: "UF",
  "Perú": "SOL",
  Peru: "SOL",
  Colombia: "COP",
  "México": "MXN",
  Mexico: "MXN",
}

export function monedaDealDeTerritorio(territorio: string | null | undefined): string {
  return MONEDA_DEAL_POR_TERRITORIO[String(territorio || "").trim()] || "UF"
}

/** Moneda esperada por el prefijo del teléfono (56 → UF). null = no se sabe. */
export function monedaDealDeTelefono(tel: string | null | undefined): string | null {
  const t = String(tel || "").replace(/\D/g, "")
  if (t.startsWith("56")) return "UF"
  if (t.startsWith("51")) return "SOL"
  if (t.startsWith("57")) return "COP"
  if (t.startsWith("52")) return "MXN"
  return null
}

type ItemSubform = { Subtotal_CLP?: number; Subtotal_UF?: number; Es_Recurrente?: boolean; Codigo_Item?: string }

/**
 * Recurrente mensual NETO del trato desde el subform de la cotización:
 * anualidad = fila plan_anual ÷ 12 (ya trae el descuento); si no, Σ filas
 * recurrentes (o asistencia/plan_asistencia) × (1 − % del plan).
 * En UF sale de Subtotal_UF con 2 decimales (Zoho no acepta más); en otra
 * moneda, de Subtotal_CLP (que guarda la moneda del país) entero.
 */
export function recurrenteNetoDeItems(items: ItemSubform[] | null | undefined, pct: number, moneda: string): number {
  const enUf = moneda === "UF"
  const campo: keyof ItemSubform = enUf ? "Subtotal_UF" : "Subtotal_CLP"
  const redondear = (n: number) => (enUf ? Math.round(n * 100) / 100 : Math.round(n))
  const filas = Array.isArray(items) ? items : []
  const anual = filas.find((i) => (i.Codigo_Item || "") === "plan_anual")
  if (anual && Number(anual[campo]) > 0) return redondear(Number(anual[campo]) / 12)
  const base = filas
    .filter((i) => i.Es_Recurrente || ["asistencia", "plan_asistencia"].includes(i.Codigo_Item || ""))
    .reduce((a, i) => a + (Number(i[campo]) || 0), 0)
  return redondear(base * (1 - (Number(pct) || 0) / 100))
}

/** Tolerancia para decidir si un valor ya está al día (UF: medio centésimo). */
export function toleranciaValor(moneda: string): number {
  return moneda === "UF" ? 0.005 : 1
}
