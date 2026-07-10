/**
 * Registro de perfiles de país.
 *
 * La ruta HTTP de cada línea de WhatsApp declara su país y lo resuelve acá
 * (vic-botmaker-v3 → "cl", vic-botmaker-co → "co"). Los crons lo leen desde
 * la columna `country` de la conversación. Nunca se infiere del prefijo del
 * teléfono del cliente: la línea manda, el prefijo asesora.
 */

import type { CodigoPais, PerfilPais } from "./tipos"
import { PERFIL_CL } from "./cl"
import { PERFIL_CO } from "./co"

export type { CodigoPais, PerfilPais } from "./tipos"

const PERFILES: Record<string, PerfilPais> = {
  cl: PERFIL_CL,
  co: PERFIL_CO,
}

/** Perfil por código. Lanza si el código no existe (error de configuración, no de datos). */
export function getPerfil(codigo: string): PerfilPais {
  const p = PERFILES[(codigo || "").trim().toLowerCase()]
  if (!p) throw new Error(`Perfil de país desconocido: '${codigo}'`)
  return p
}

/** Perfil para una conversación ya persistida (columna country; default histórico cl). */
export function getPerfilDeConversacion(country: string | null | undefined): PerfilPais {
  return getPerfil(country || "cl")
}

export function esPaisSoportado(codigo: string): codigo is CodigoPais {
  return (codigo || "").trim().toLowerCase() in PERFILES
}
