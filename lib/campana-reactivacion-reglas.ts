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
export type Canal = "wsp" | "mail"

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
 * miércoles → mail; otros días → null. Las LLAMADAS de voz salieron del ciclo
 * (Lalo 11-sep: "ya no haremos llamadas de Dapta"), así que el jueves ya no es
 * día de campaña; las columnas toque*_call_at quedan en la tabla sin uso. */
export function canalDelDia(pais: string, ahora: Date): Canal | null {
  const tz = pais === "co" ? "America/Bogota" : pais === "mx" ? "America/Mexico_City" : pais === "pe" ? "America/Lima" : "America/Santiago"
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(ahora)
  if (wd === "Tue") return "wsp"
  if (wd === "Wed") return "mail"
  return null
}

/** Hora local 0-23 del país. */
export function horaLocalDe(pais: string, ahora: Date): number {
  const tz = pais === "co" ? "America/Bogota" : pais === "mx" ? "America/Mexico_City" : pais === "pe" ? "America/Lima" : "America/Santiago"
  const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(ahora))
  return h === 24 ? 0 : h
}


// ── DESCANSO ENTRE CAMPAÑAS (Lalo 10-sep) ───────────────────────────────────

/**
 * "Solo si el último toque de campaña fue hace ≥4 semanas", y la regla aplica
 * TAMBIÉN al primer toque del ciclo siguiente — sin eso el ciclo 2 arrancaba
 * la semana después del toque 4. "Toque de campaña" es cualquier campaña de
 * Vicky (dcto10, remarketing, voz, correo, este ciclo); los toques del LOOP de
 * seguimiento no cuentan, son parte de la conversación viva.
 *
 * Dentro de un ciclo ya abierto los toques son SEMANALES: el descanso se
 * evalúa solo cuando toca la casilla 1.
 */
export const DESCANSO_DIAS = Number(process.env.CAMPANA_REACT_DESCANSO_DIAS || 28)

export function debeDescansar(
  ultimoToque: Date | null | undefined,
  ahora: Date,
): { descansa: boolean; diasDesde: number; diasFaltan: number } {
  if (!ultimoToque) return { descansa: false, diasDesde: Number.POSITIVE_INFINITY, diasFaltan: 0 }
  const dias = (ahora.getTime() - ultimoToque.getTime()) / 86_400_000
  const faltan = Math.max(0, Math.ceil(DESCANSO_DIAS - dias))
  return { descansa: dias < DESCANSO_DIAS, diasDesde: Math.floor(dias), diasFaltan: faltan }
}

// ── GANCHO DE CADA TOQUE (documento v23, propuesta aprobada por Lalo) ────────

/** Plantilla y variables de cada casilla. `dcto` = la plantilla de descuento
 * con quick replies: el 10 % lo aplica el tap por el camino ya probado de la
 * campaña dcto10, nunca este runner. */
export type PlanToque = {
  tpl: string
  tipo: "react" | "dcto"
  vars: Array<"nombre" | "empresa" | "link" | "precio" | "gancho" | "contexto">
  descripcion: string
}

const TPL_T1 = (process.env.CAMPANA_REACT_TPL_T1 || "vicky_reactivacion_cotizacion_cl_v4").trim()
const TPL_T1_SIN_NOMBRE = (process.env.CAMPANA_REACT_TPL_T1_SIN_NOMBRE || "vicky_reactivacion_sin_nombre_cl_v4").trim()
const TPL_T2 = (process.env.CAMPANA_REACT_TPL_T2 || "vicky_react_t2_cl").trim()
const TPL_T3 = (process.env.CAMPANA_REACT_TPL_T3 || "vicky_campana_dcto_v1").trim()
const TPL_T4 = (process.env.CAMPANA_REACT_TPL_T4 || "vicky_react_t4_cl").trim()

export function planDeToque(casilla: Casilla, conNombre: boolean): PlanToque {
  if (casilla === 2) {
    return { tpl: TPL_T2, tipo: "react", vars: ["nombre", "gancho", "empresa", "link"], descripcion: "objeción o valor que quedó abierto" }
  }
  if (casilla === 3) {
    return { tpl: TPL_T3, tipo: "dcto", vars: ["nombre", "contexto"], descripcion: "10 % adicional (el tap lo aplica)" }
  }
  if (casilla === 4) {
    return { tpl: TPL_T4, tipo: "react", vars: ["nombre", "empresa", "precio", "link"], descripcion: "cierre honesto, último recordatorio" }
  }
  return {
    tpl: conNombre ? TPL_T1 : TPL_T1_SIN_NOMBRE,
    tipo: "react",
    vars: conNombre ? ["nombre"] : [],
    descripcion: "la cotización sigue vigente",
  }
}

/** Gancho del toque 2 según por qué no cerró. El clasificador guarda un motivo
 * grueso; lo que no calza usa el gancho neutro (nunca se inventa una objeción
 * que el cliente no dijo). */
export function ganchoParaToque2(motivo: string | null | undefined): string {
  const m = String(motivo || "").toLowerCase()
  if (m.includes("precio")) return "no hay permanencia, así que puedes partir con lo justo y crecer después"
  if (m.includes("hardware") || m.includes("reloj")) return "no necesitas reloj para partir: la app con reconocimiento facial va incluida"
  if (m.includes("legal") || m.includes("normativ")) return "el sistema está autorizado por la Dirección del Trabajo (Resolución Exenta N°38)"
  if (m.includes("evaluando") || m.includes("jefe") || m.includes("interna")) return "te puedo dejar la propuesta en PDF para que la muestres, sin compromiso"
  if (m.includes("proveedor") || m.includes("competencia")) return "si ya tienes otro sistema, la migración la hacemos nosotros sin costo"
  if (m.includes("dato") || m.includes("rut") || m.includes("correo")) return "para dejarte la cotización formal me basta el RUT de la empresa y un correo"
  return "la mayoría queda operando el mismo día que paga, y no hay permanencia"
}

/** "26.765" → como lo espera la plantilla (pesos, con IVA). */
export function precioTextoClp(clp: number | null | undefined): string {
  const n = Math.round(Number(clp || 0))
  return n > 0 ? n.toLocaleString("es-CL") : ""
}
