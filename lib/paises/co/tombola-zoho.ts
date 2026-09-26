/**
 * INTERRUPTOR: ¿Colombia se entrega por las REGLAS DE ZOHO como Chile y Perú?
 *
 * Lalo 23-sep, tras leer el workflow "SF. TOMBOLA DEALS COLOMBIA 2024" y la
 * entrada 34 de la regla global de marketing: el equipo de Colombia son
 * telemarketeros (María Paula Corredor · Silvana Navarro Builes · Diana
 * Carolina Rodríguez para 1-199) y SDR (Mauricio Sanabria Torres · Jhon
 * Nariño Chavarro · Eddy Galindo), y van a las MISMAS tres reglas globales
 * que usa Vicky con su entrada "Territorio = Colombia":
 *   · "Deals 2026" (…322005)                          → tómbola de deals
 *   · "Asignación Leads Vicky TLMK" (…066001)         → lead calificado
 *   · "Asignación Leads Sin calificar Vicky SDR" (…043111) → lead sin calificar
 *
 * Mientras las entradas no existan en Zoho, un PUT con `lar_id` deja el
 * registro en el robot (ninguna entrada calza) y la mecánica cae a los
 * fallbacks; por eso el cambio vive detrás de este interruptor y Colombia
 * sigue con los fijos del 05-ago (Galindo / Gordillo, "el primero se lo
 * queda") hasta que se prenda.
 *
 * Es un módulo PURO y SÍNCRONO a propósito: lo consultan `territorioConTombola`
 * (crm-hitos), `rosterSdrPorTerritorio` (sdr-calificacion, que cargan los
 * tests) y los mapas de reglas del ptv-cron, que se evalúan al cargar el
 * módulo. Por eso no es un kv (asíncrono): es env `VICKY_TOMBOLA_ZOHO_CO`
 * ("on"/"off") y, sin env, esta constante. Encender = env en Vercel + deploy,
 * o cambiar la constante y desplegar.
 */
// 23-sep 18:xx UTC: ENCENDIDO. Lalo creó las tres entradas Colombia el mismo
// día — Deals 2026 (6: 1-199 → Corredor/Navarro Builes/Rodríguez · 7: ≥200 →
// 13 ejecutivos · 8: resto → los tres del 6), TLMK (3) y SDR (3).
import { paisTieneProceso, reglaZoho } from "../ficha-operativa.ts"

export const TOMBOLA_ZOHO_CO_DEFAULT = true

export function tombolaZohoCoActiva(): boolean {
  // 26-sep: el interruptor es un PROCESO de la ficha operativa (env VICKY_TOMBOLA_ZOHO_CO manda igual).
  return paisTieneProceso("co", "tombolaZoho")
}

/** Ids de las tres reglas globales (las mismas de Chile/Perú), con override por env. */
export const REGLA_DEALS_GLOBAL = reglaZoho("mx", "deals")
