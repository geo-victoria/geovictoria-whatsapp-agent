/**
 * PROBADOR DE OTRO PAÍS (21-sep, Lalo "quiero poder probar desde mi teléfono").
 *
 * El país que atiende a un contacto lo decide su PREFIJO (lib/ruteo-pais), y eso
 * está bien para clientes: un +56 es chileno y le toca Vicky Chile. Pero para
 * PROBAR Perú hace falta un teléfono +51, y los del equipo son chilenos.
 *
 * Este override marca un contacto como probador de un país distinto al de su
 * prefijo. Es EXPLÍCITO (una llave por contacto, no una lista global), CADUCA
 * sola (`hasta`) y solo la escribe un endpoint admin — así una marca olvidada no
 * deja a un cliente real atendido por el país equivocado para siempre.
 *
 * vic_kv `probador_pais_<fono>` = {"pais":"pe","hasta":"<iso>"}
 */

import { getKvValue } from "./supabase-persistence-v3"
import { paisDeContacto, type PaisConLinea, type PaisContacto } from "./ruteo-pais"

export const clave = (contact: string) => `probador_pais_${String(contact || "").replace(/\D/g, "")}`

/** Horas de vida por defecto de una marca de probador. */
export const HORAS_PROBADOR = Number(process.env.VICKY_PROBADOR_HORAS || 24)

/**
 * País del override VIGENTE, o null. Una marca vencida se trata como ausente
 * (no se borra: el endpoint admin la sobrescribe o la limpia).
 */
export async function paisProbador(contact: string): Promise<PaisConLinea | null> {
  const raw = (await getKvValue(clave(contact)).catch(() => null)) || ""
  if (!raw.trim()) return null
  try {
    const j = JSON.parse(raw) as { pais?: string; hasta?: string }
    const pais = String(j.pais || "").toLowerCase()
    if (pais !== "cl" && pais !== "co" && pais !== "mx" && pais !== "pe") return null
    if (j.hasta && Date.parse(j.hasta) <= Date.now()) return null
    return pais
  } catch {
    return null
  }
}

/** País efectivo: el override del probador si está vigente, o el del prefijo. */
export async function paisEfectivo(contact: string): Promise<PaisContacto> {
  return (await paisProbador(contact)) ?? paisDeContacto(contact)
}
