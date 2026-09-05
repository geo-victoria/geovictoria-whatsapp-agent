/**
 * ¿Este contacto entra al onboarding por chat?
 *
 * Dos puertas, y las dos valen en TODOS los puntos de enrolamiento (pago
 * online, comprobante de transferencia, gate del webhook):
 *   - la env global VICKY_ONBOARDING_ENABLED=on (go-live: todo cliente CL), o
 *   - el contacto está en vic_kv `onboarding_piloto` (teléfonos separados por
 *     coma), que se maneja sin deploy.
 *
 * Hasta el 05-sep el piloto solo lo miraba el GATE del webhook: el contacto
 * piloto era atendido por el agente de onboarding si su fase ya estaba
 * puesta, pero el PAGO (las dos vías de enrolamiento) solo miraba la env. En
 * la prueba E2E de Lalo el comprobante lo mandó al wizard web en vez del alta
 * por chat. Este módulo es la definición única para que no vuelva a pasar.
 *
 * No es puro (lee vic_kv): vive fuera de lib/onboarding/ a propósito.
 */

import { onboardingEnabled } from "./onboarding/fase"
import { getKvValue } from "./supabase-persistence-v3"

export async function esContactoPiloto(contact: string): Promise<boolean> {
  try {
    const lista = (await getKvValue("onboarding_piloto")) || ""
    const fono = (contact || "").replace(/\D/g, "")
    if (!fono) return false
    return lista
      .split(",")
      .map((s) => s.replace(/\D/g, ""))
      .filter(Boolean)
      .includes(fono)
  } catch (e) {
    console.warn(`[onboarding-gate] esContactoPiloto FALLÓ para ${contact}:`, e instanceof Error ? e.message : e)
    return false
  }
}

/** Env global encendida, o contacto en el piloto. */
export async function onboardingActivoPara(contact: string): Promise<boolean> {
  if (onboardingEnabled()) return true
  return esContactoPiloto(contact)
}
