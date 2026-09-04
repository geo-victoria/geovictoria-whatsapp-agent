/**
 * MUDO TEMPORAL POR CONTACTO (04-sep, pedido de Lalo).
 *
 * "Reenvío todo a Vicky para que lo leas… y que Vicky no me responda en ese
 * lapso." El material que llega por WhatsApp —capturas, PDFs, notas de voz—
 * ya se transcribe en el webhook antes de llegar al modelo, así que la línea
 * de Vicky sirve de buzón: lo que entra queda en el historial en texto y se
 * puede leer después. Lo único que sobra es que ella conteste.
 *
 * El mudo se pone en vic_kv `vicky_mudo_<fono>` y su valor es la HORA DE
 * VENCIMIENTO en ISO. Se comprueba contra el reloj, no contra `expires_at` de
 * la tabla: `getKvValue` no filtra filas vencidas, así que un mudo apoyado en
 * el TTL de Supabase duraría para siempre. Con la fecha adentro, un mudo
 * olvidado se apaga solo.
 *
 * Tope de 12 horas por construcción: esto es una herramienta de trabajo entre
 * dos personas, no un estado del sistema. Si algún día se le aplica por error
 * a un cliente real, el daño tiene fecha de término.
 */

import { getKvValue, setKvValue } from "./supabase-persistence-v3"

export const MUDO_MAX_HORAS = 12

const clave = (contact: string) => `vicky_mudo_${(contact || "").replace(/\D/g, "")}`

/** ¿Este contacto está en mudo AHORA? Fail-open: ante duda, Vicky responde. */
export async function contactoEnMudo(contact: string): Promise<boolean> {
  try {
    const hasta = (await getKvValue(clave(contact))) || ""
    const t = Date.parse(hasta.trim())
    return Number.isFinite(t) && t > Date.now()
  } catch {
    return false
  }
}

/** Enmudece por `horas` (tope MUDO_MAX_HORAS). Devuelve hasta cuándo. */
export async function enmudecer(contact: string, horas: number): Promise<string> {
  const h = Math.min(Math.max(Number(horas) || 1, 0.25), MUDO_MAX_HORAS)
  const hasta = new Date(Date.now() + h * 3600e3).toISOString()
  await setKvValue(clave(contact), hasta)
  return hasta
}

/** Devuelve la voz de inmediato (vence el mudo poniéndolo en el pasado). */
export async function desenmudecer(contact: string): Promise<void> {
  await setKvValue(clave(contact), new Date(Date.now() - 1000).toISOString())
}
