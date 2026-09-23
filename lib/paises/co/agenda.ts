/**
 * AGENDA DE COLOMBIA EN CAL.COM (Lalo 23-sep): un evento de host único por
 * telemarketera del tramo 1-199, creados por Lalo el 23-sep con él como host
 * interino ("les envié invitación a Cal.com para que cuando se hayan creado
 * cuenta y conectado el calendario yo les cambie el participante; el evento
 * es el mismo") — el id sobrevive al cambio de host. Los tres verificados
 * contra la API el 23-sep: 101 slots en 6 días cada uno (disponibilidad de
 * Lalo mientras sea el host), en la zona horaria de la ficha CO.
 *
 * Misma mecánica que Chile/Perú: el agent-loop inyecta el evento del DUEÑO
 * del deal/lead (mapa de lib/eventos-seguimiento); cuando la reunión llega
 * antes de que haya dueño humano, `eventoAgendaCO()` da el evento por
 * defecto: vic_kv `cal_evento_co` (un evento fijo, sin deploy) → env
 * `CAL_EVENT_TYPE_ID_CO` → rotación entre las tres (kv `cal_rr_co`), que es
 * el equivalente del round-robin chileno con las personas de Colombia.
 *
 * PURO en su parte síncrona (lo cargan ficha, turno y tests); la rotación es
 * async y usa el kv por import dinámico. Los correos y los ids de evento NO
 * viven acá: salen de la FICHA OPERATIVA (`calEventoId` de cada persona del
 * roster de telemarketing CO) — fuente única, candado
 * tests/ficha-operativa-fuente-unica.
 */
import { rosterTelemarketingOperativo } from "../ficha-operativa.ts"

export const EVENTOS_AGENDA_CO: Record<string, string> = Object.fromEntries(
  rosterTelemarketingOperativo("co")
    .filter((p) => /^\d{3,}$/.test(String(p.calEventoId || "")))
    .map((p) => [p.email.toLowerCase(), String(p.calEventoId)]),
)

/** Interruptor: env VICKY_AGENDA_CO="off" apaga la agenda en línea (vuelve a "la coordina el ejecutivo"). */
export function agendaCoActiva(): boolean {
  const v = String(process.env.VICKY_AGENDA_CO || "").trim().toLowerCase()
  return !(v === "off" || v === "0" || v === "false")
}

export async function eventoAgendaCO(): Promise<string> {
  const ids = Object.values(EVENTOS_AGENDA_CO)
  try {
    const { getKvValue, setKvValue } = await import("../../supabase-persistence-v3.ts")
    const fijo = String((await getKvValue("cal_evento_co").catch(() => null)) || "").trim()
    if (/^\d{3,}$/.test(fijo)) return fijo
    const env = (process.env.CAL_EVENT_TYPE_ID_CO || "").trim()
    if (/^\d{3,}$/.test(env)) return env
    const last = parseInt(String((await getKvValue("cal_rr_co").catch(() => null)) || "-1"), 10)
    const idx = (Number.isNaN(last) ? 0 : last + 1) % ids.length
    await setKvValue("cal_rr_co", String(idx)).catch(() => {})
    return ids[idx]
  } catch {
    const env = (process.env.CAL_EVENT_TYPE_ID_CO || "").trim()
    return /^\d{3,}$/.test(env) ? env : ids[0]
  }
}
