/**
 * MONTOS EN LOS DASH, POR PAÍS — con el dólar al lado para Perú.
 *
 * Lalo 21-sep: "lo que se reporte en soles en el dash agreguemos entre
 * paréntesis al lado el monto en dólares". Los montos peruanos viven en los
 * mismos campos que los pesos chilenos (uf/clp de los punteros guardan la
 * moneda local del país), así que hasta hoy un S/ 212 y un $ 212.000 se
 * pintaban con la misma lógica y nadie los hacía comparables. El dólar SUNAT
 * del día (lib/paises/pe/tc-sunat, caché diaria) es la referencia que Perú ya
 * usa para el reloj: la misma fuente para cotizar y para reportar.
 *
 * Un solo formateador para los tres sitios del dash que antes repetían el
 * ternario `pais === "pe" ? "S/ " : "$"` — el mismo principio del día: lo que
 * vive en un módulo no se desalinea.
 */

export type PaisMonto = "cl" | "co" | "mx" | "pe"

export type MontoLocal = { uf?: number | null; clp?: number | null }

const fmtCL = (n: number) => Math.round(n).toLocaleString("es-CL")

/** "(US$ 63)" para Perú; "" en los demás países o sin tipo de cambio. */
export function enDolares(soles: number, tcUsdPen?: number): string {
  if (!tcUsdPen || !Number.isFinite(tcUsdPen) || tcUsdPen <= 0 || !Number.isFinite(soles)) return ""
  return ` (US$ ${fmtCL(soles / tcUsdPen)})`
}

/**
 * Texto del monto según país. Chile prefiere UF si la tiene; los otros países
 * muestran su moneda local venga en el campo que venga (uf o clp). Perú suma
 * el equivalente en dólares cuando hay tipo de cambio.
 */
export function formatearMontoPais(m: MontoLocal | undefined, pais: PaisMonto, tcUsdPen?: number): string {
  if (!m) return "—"
  const uf = Number(m.uf) || 0
  const clp = Number(m.clp) || 0
  if (pais === "cl") {
    if (uf) return `UF ${uf.toLocaleString("es-CL", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`
    if (clp) return `$${fmtCL(clp)}`
    return "—"
  }
  const simbolo = pais === "pe" ? "S/ " : "$"
  const local = clp || uf
  if (!local) return "—"
  const extra = pais === "pe" ? enDolares(local, tcUsdPen) : ""
  return `${simbolo}${fmtCL(local)}${extra}`
}

/** Tipo de cambio para el dash: solo Perú lo necesita; en los demás, nada que resolver. */
export async function tcParaDash(pais: PaisMonto): Promise<number | undefined> {
  if (pais !== "pe") return undefined
  try {
    const { tipoCambioSunat } = await import("./paises/pe/tc-sunat.ts")
    const tc = await tipoCambioSunat()
    return tc?.venta
  } catch {
    return undefined
  }
}
