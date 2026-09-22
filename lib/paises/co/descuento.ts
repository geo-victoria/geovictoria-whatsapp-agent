/**
 * Escalera de descuento de COLOMBIA = la chilena (decisión Lalo 21-sep:
 * "permitamos descuento en colombia igual que en chile").
 *
 * Escalón 1 = 10 %, escalón 2 = 20 %, SOLO sobre el plan (el alquiler del
 * equipo, el envío y la instalación van a lista), por 6 meses; un escalón por
 * objeción, jamás proactivo. La Activación (primer mes del plan cobrado por
 * adelantado) lleva el mismo descuento porque ES un mes del plan.
 *
 * PURO (sin imports): lo consumen cotizar.ts, tools-unificadas.ts y los tests.
 */
export const ESCALERA_DESCUENTO_CO = Object.freeze({
  planMensual: Object.freeze([0.1, 0.2]),
  meses: 6,
})

/** Escalón saneado: 0 (sin descuento), 1 o 2. */
export function escalonDescuentoCO(escalon: unknown): number {
  return Math.max(0, Math.min(ESCALERA_DESCUENTO_CO.planMensual.length, Math.floor(Number(escalon) || 0)))
}

/** % de descuento del plan para un escalón (0 → 0, 1 → 0,1, 2 → 0,2). */
export function pctDescuentoCO(escalon: unknown): number {
  const e = escalonDescuentoCO(escalon)
  return e === 0 ? 0 : ESCALERA_DESCUENTO_CO.planMensual[e - 1]
}
