/**
 * RASTRO DE LA NOTIFICACIÓN AL EJECUTIVO (Lalo 11-sep).
 *
 * "Lo importante es que al momento que prometemos que lo van a contactar, o
 * por tiempo de traspaso, SIEMPRE haya una notificación/asignación del deal al
 * ejecutivo… con eso el sistema cumple y la pelota pasa al ejecutivo. Sobre
 * eso yo mandaría un correo que notifique si el cliente se queja — pero si
 * mandamos ese correo y la falla de notificación fue NUESTRA…".
 *
 * Ese "pero" es el motivo de este módulo. El código llamaba a las dos
 * notificaciones (`notificarTraspasoDeal` con deal, `notificarTraspasoLeadEmail`
 * con lead) en todas las ramas del traspaso, pero las llamaba con
 * `.catch(() => {})` y sin dejar rastro: era imposible saber si el correo
 * SALIÓ. Sin ese dato, un correo de reclamo es injusto por construcción —
 * puede estar apurando a alguien que nunca supo que tenía el caso.
 *
 * Acá se estampa el resultado (kv `notif_traspaso_<fono>`, se conserva el
 * último) y `veredictoNotificacion` lo traduce a tres estados, porque "no
 * sabemos" no es lo mismo que "falló":
 *   ok             → hubo notificación exitosa DESPUÉS del traspaso: la pelota
 *                    está del lado del ejecutivo y el reclamo es para él.
 *   fallo          → la notificación se intentó y no salió: la falla es
 *                    NUESTRA; el ejecutivo no puede ser el destinatario del
 *                    reclamo hasta que le avisemos de verdad.
 *   sin_evidencia  → traspaso anterior a este rastro (o rastro ilegible): no
 *                    se acusa a nadie, se dice que no hay evidencia.
 */

import { getKvValue, setKvValue } from "./supabase-persistence-v3"

export type EvidenciaNotificacion = {
  /** Cuándo se intentó (ISO). */
  at: string
  tipo: "deal" | "lead"
  /** Id del registro de Zoho al que se notificó. */
  registro: string
  ownerEmail?: string
  ok: boolean
  /** Por qué no salió, cuando ok=false. */
  error?: string
}

export type VeredictoNotificacion = "ok" | "fallo" | "sin_evidencia"

/** Margen: la notificación puede estamparse segundos antes que la fila vic_ptv. */
const MARGEN_MS = 10 * 60 * 1000

const clave = (contact: string) => `notif_traspaso_${(contact || "").replace(/\D/g, "")}`

export async function estamparNotificacionTraspaso(
  contact: string,
  datos: Omit<EvidenciaNotificacion, "at">,
): Promise<void> {
  const fono = (contact || "").replace(/\D/g, "")
  if (!fono || !datos.registro) return
  try {
    await setKvValue(
      clave(fono),
      JSON.stringify({ at: new Date().toISOString(), ...datos } satisfies EvidenciaNotificacion),
    )
  } catch {
    /* best-effort: el rastro jamás bloquea un traspaso */
  }
}

export async function leerNotificacionTraspaso(contact: string): Promise<EvidenciaNotificacion | null> {
  const fono = (contact || "").replace(/\D/g, "")
  if (!fono) return null
  try {
    const crudo = await getKvValue(clave(fono))
    if (!crudo) return null
    const ev = JSON.parse(crudo) as EvidenciaNotificacion
    return ev && typeof ev.ok === "boolean" && ev.at ? ev : null
  } catch {
    return null
  }
}

/**
 * PURA. `traspasadoAt` es el momento en que el caso pasó a manos del ejecutivo
 * vigente: una notificación ANTERIOR a ese momento no lo cubre (es del dueño
 * anterior, por ejemplo tras un re-sorteo), así que cuenta como sin evidencia.
 */
export function veredictoNotificacion(
  ev: EvidenciaNotificacion | null,
  traspasadoAt?: string | null,
): VeredictoNotificacion {
  if (!ev) return "sin_evidencia"
  if (!ev.ok) return "fallo"
  const corte = traspasadoAt ? Date.parse(traspasadoAt) : NaN
  const cuando = Date.parse(ev.at)
  if (!Number.isFinite(cuando)) return "sin_evidencia"
  if (Number.isFinite(corte) && cuando < corte - MARGEN_MS) return "sin_evidencia"
  return "ok"
}
