/**
 * Punto de entrada del catálogo de productos.
 *
 * Las tools NUNCA hardcodean precios ni IDs. Siempre consumen el catálogo
 * a través de los helpers exportados acá. Si un producto no existe o no
 * tiene `disponibleParaVicky === true`, los helpers devuelven null y las
 * tools fallan con error legible.
 *
 * Premisa rectora del repo:
 *   "Solo se cotiza lo que existe en el catálogo Y está habilitado."
 */

import { CATALOGO_MODULOS } from "./modulos"
import { CATALOGO_HARDWARE } from "./hardware"
import type { ModuloSoftware, Hardware, TierPrecio } from "./tipos"

// ─── Re-exports ──────────────────────────────────────────────────────────
export { CATALOGO_MODULOS } from "./modulos"
export { CATALOGO_HARDWARE } from "./hardware"
export type * from "./tipos"

// ─── Helpers para MÓDULOS ────────────────────────────────────────────────

/**
 * Busca un módulo por id. Devuelve null si no existe.
 * NO valida disponibleParaVicky — usar getModuloDisponibleParaVicky para eso.
 */
export function getModuloById(id: string): ModuloSoftware | null {
  return CATALOGO_MODULOS.find((m) => m.id === id) || null
}

/**
 * Busca un módulo por id pero solo lo devuelve si está habilitado para Vicky.
 * Devuelve null si no existe o si está deshabilitado.
 *
 * Este es el helper que deben usar las tools de Vicky para garantizar
 * que solo se cotice lo habilitado.
 */
export function getModuloDisponibleParaVicky(id: string): ModuloSoftware | null {
  const m = getModuloById(id)
  if (!m) return null
  if (!m.disponibleParaVicky) return null
  return m
}

/**
 * Devuelve la lista completa de módulos habilitados para Vicky.
 * Útil para que el modelo conozca el catálogo disponible en su contexto.
 */
export function getModulosDisponiblesParaVicky(): ModuloSoftware[] {
  return CATALOGO_MODULOS.filter((m) => m.disponibleParaVicky)
}

/**
 * Busca el tier de precio que aplica para un módulo dado un userCount.
 * Si el módulo tiene `minUsuariosTotal` y el userCount no llega, devuelve null.
 * Si no hay ningún tier que cubra el userCount, también devuelve null.
 */
export function obtenerTierAplicable(modulo: ModuloSoftware, userCount: number): TierPrecio | null {
  if (modulo.minUsuariosTotal !== undefined && userCount < modulo.minUsuariosTotal) {
    return null
  }
  return modulo.tiers.find((t) => userCount >= t.minUsuarios && userCount <= t.maxUsuarios) ?? null
}

/**
 * Valida que un módulo aplique para una cantidad de usuarios dada.
 * Devuelve null si todo OK, o un string con el motivo del rechazo.
 */
export function validarRangoModulo(modulo: ModuloSoftware, userCount: number): string | null {
  if (modulo.minUsuariosTotal !== undefined && userCount < modulo.minUsuariosTotal) {
    return `${modulo.nombre} requiere mínimo ${modulo.minUsuariosTotal} trabajadores (la empresa tiene ${userCount}).`
  }
  const tier = obtenerTierAplicable(modulo, userCount)
  if (!tier) {
    const rangos = modulo.tiers.map((t) => `${t.minUsuarios}-${t.maxUsuarios}`).join(", ")
    return `${modulo.nombre} no tiene tier definido para ${userCount} trabajadores. Rangos cubiertos: ${rangos}.`
  }
  return null
}

// ─── Helpers para HARDWARE ───────────────────────────────────────────────

export function getHardwareById(id: string): Hardware | null {
  return CATALOGO_HARDWARE.find((h) => h.id === id) || null
}

/**
 * Busca hardware por id solo si está habilitado para Vicky.
 */
export function getHardwareDisponibleParaVicky(id: string): Hardware | null {
  const h = getHardwareById(id)
  if (!h) return null
  if (!h.disponibleParaVicky) return null
  return h
}

/**
 * Devuelve la lista de hardware habilitado para Vicky.
 */
export function getHardwareDisponiblesParaVicky(): Hardware[] {
  return CATALOGO_HARDWARE.filter((h) => h.disponibleParaVicky)
}
