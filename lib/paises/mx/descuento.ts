/**
 * Escalera de descuento de MÉXICO = la chilena (decisión Lalo 24-sep:
 * "descuento igualemos con Chile"; antes 10 → 15 % y solo en el cotizador).
 *
 * Escalón 1 = 10 %, escalón 2 = 20 %, SOLO sobre el plan (la renta del
 * reloj, el envío y la instalación van a lista), por 6 meses; un escalón por
 * objeción, jamás proactivo. El primer mes cobrado por adelantado lleva el
 * mismo descuento porque ES un mes del plan.
 *
 * PURO (sin imports): lo consumen cotizar.ts, tools-unificadas.ts y los tests.
 */
export const ESCALERA_DESCUENTO_MX = Object.freeze({
  planMensual: Object.freeze([0.1, 0.2]),
  meses: 6,
})

/** Escalón saneado: 0 (sin descuento), 1 o 2. */
export function escalonDescuentoMX(escalon: unknown): number {
  return Math.max(0, Math.min(ESCALERA_DESCUENTO_MX.planMensual.length, Math.floor(Number(escalon) || 0)))
}

/** % de descuento del plan para un escalón (0 → 0, 1 → 0,1, 2 → 0,2). */
export function pctDescuentoMX(escalon: unknown): number {
  const e = escalonDescuentoMX(escalon)
  return e === 0 ? 0 : ESCALERA_DESCUENTO_MX.planMensual[e - 1]
}
