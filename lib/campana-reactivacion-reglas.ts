/**
 * Reglas PURAS de la campaña de reactivación (sin red, testeables con
 * node --test). Las decisiones que necesitan Supabase/Zoho viven en
 * lib/campana-reactivacion.ts, que re-exporta estas.
 */

export const TOQUES_MAX = 4

/**
 * "2 días hábiles" (Lalo 10-sep): lunes a viernes menos feriados, de 9:00 a
 * 18:00 → 2 × 9 h = 1.080 minutos hábiles. OJO: distinto del reloj de
 * traspaso (8-18); por eso el cálculo pasa HORA_INICIO_CAMPANA explícita.
 */
export const HORA_INICIO_CAMPANA = 9
export const DIAS_HABILES_INACTIVIDAD = Number(process.env.CAMPANA_REACT_DIAS_HABILES || 2)
export const MINUTOS_HABILES_INACTIVIDAD = DIAS_HABILES_INACTIVIDAD * (18 - HORA_INICIO_CAMPANA) * 60
export type Casilla = 1 | 2 | 3 | 4
export type Canal = "wsp" | "mail" | "call"

export type FilaCasillas = {
  contact: string
  pais: string
  quote_id: string | null
  empresa: string | null
  toque1_wsp_at: string | null; toque1_mail_at: string | null; toque1_call_at: string | null
  toque2_wsp_at: string | null; toque2_mail_at: string | null; toque2_call_at: string | null
  toque3_wsp_at: string | null; toque3_mail_at: string | null; toque3_call_at: string | null
  toque4_wsp_at: string | null; toque4_mail_at: string | null; toque4_call_at: string | null
  ultima_eval_at: string | null
  ultima_eval_motivo: string | null
}

// ── helpers puros ───────────────────────────────────────────────────────────

/** Primera casilla en falso (1..4) o null si las cuatro ya salieron. */
export function siguienteCasilla(fila: Partial<FilaCasillas> | null | undefined): Casilla | null {
  for (const n of [1, 2, 3, 4] as Casilla[]) {
    if (!fila || !fila[`toque${n}_wsp_at` as keyof FilaCasillas]) return n
  }
  return null
}

/** Casilla ABIERTA esta semana: la última con WhatsApp enviado dentro de la
 * ventana (por defecto 6 días) — es la que recibe el correo y la llamada. */
export function casillaAbierta(
  fila: Partial<FilaCasillas> | null | undefined,
  ahora: Date,
  ventanaDias = 6,
): Casilla | null {
  if (!fila) return null
  for (const n of [4, 3, 2, 1] as Casilla[]) {
    const iso = fila[`toque${n}_wsp_at` as keyof FilaCasillas] as string | null | undefined
    if (!iso) continue
    const ms = Date.parse(iso)
    if (Number.isFinite(ms) && ahora.getTime() - ms <= ventanaDias * 86_400_000) return n
    return null
  }
  return null
}

/** Día de campaña según el calendario local del país: martes → wsp,
 * miércoles → mail, jueves → call; otros días → null. */
export function canalDelDia(pais: string, ahora: Date): Canal | null {
  const tz = pais === "co" ? "America/Bogota" : pais === "mx" ? "America/Mexico_City" : pais === "pe" ? "America/Lima" : "America/Santiago"
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(ahora)
  if (wd === "Tue") return "wsp"
  if (wd === "Wed") return "mail"
  if (wd === "Thu") return "call"
  return null
}

/** Hora local 0-23 del país. */
export function horaLocalDe(pais: string, ahora: Date): number {
  const tz = pais === "co" ? "America/Bogota" : pais === "mx" ? "America/Mexico_City" : pais === "pe" ? "America/Lima" : "America/Santiago"
  const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(ahora))
  return h === 24 ? 0 : h
}

