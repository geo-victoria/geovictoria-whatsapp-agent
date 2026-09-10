/**
 * LAS SDR DE CALIFICACIÓN NO RECIBEN DEALS (regla de Lalo 10-sep).
 *
 * Aleydis Araque y Aracelli Sepúlveda reciben SOLO dos cosas:
 *   (a) LEADS que Vicky no logró calificar (su trabajo es calificarlos), y
 *   (b) VENTAS AUTÓNOMAS de Vicky, para la gestión comercial posterior.
 *
 * Lo que NO deben recibir: un caso que Vicky YA calificó. Si el lead se les
 * entregó porque Vicky no había podido calificar y DESPUÉS Vicky lo logró,
 * corresponde re-entregarlo:
 *   · con RUT  → nace el DEAL y lo reparte la Tómbola de Deals (sus entradas
 *                ≤300 son justamente el roster de telemarketing);
 *   · sin RUT  → el LEAD cambia de dueño por la tómbola de telemarketing.
 *
 * El código trataba a las SDR como "dueño humano real", y a un dueño humano
 * real nunca se lo re-sortea (regla del 04-ago, nacida para proteger la
 * cartera de los ejecutivos). Ese candado, aplicado a las SDR, dejaba el caso
 * calificado en sus manos: 4 deals de Aleydis nacidos de derivaciones sobre
 * el umbral (Patiño, Cancino, MSS Asesores, Cafetería) y 3 de Aracelli
 * heredados de sus leads (Haddad, Loumar, Prix).
 *
 * Módulo PURO: solo decide. Quien ejecuta la re-entrega es crm-hitos (deal +
 * tómbola) o zoho-leads (lead + tómbola TLMK).
 */

/** Roster de calificación CL, en el formato de VICKY_TM_CALIFICACION_DESTINOS
 * ("email:zohoId:Nombre,..."), que es la fuente única de esa dupla. */
const ROSTER_DEFAULT =
  "aaraque@geovictoria.com:3525045000583802005:Aleydis Araque," +
  "asepulveda@geovictoria.com:3525045000594735052:Aracelli Sepúlveda"

function roster(): Array<{ email: string; id: string }> {
  return (process.env.VICKY_TM_CALIFICACION_DESTINOS || ROSTER_DEFAULT)
    .split(",")
    .map((par) => {
      const [email, id] = par.split(":").map((x) => (x || "").trim())
      return { email: (email || "").toLowerCase(), id: id || "" }
    })
    .filter((d) => d.email || d.id)
}

/** ¿Este dueño es una SDR de calificación de Chile? */
export function esSdrCalificacionCL(o: { ownerId?: string | null; ownerEmail?: string | null }): boolean {
  const id = String(o.ownerId || "").trim()
  const email = String(o.ownerEmail || "").trim().toLowerCase()
  if (!id && !email) return false
  return roster().some((d) => (id && d.id === id) || (email && d.email === email))
}

/** Hitos POSTERIORES al pago: ahí el caso ya se vendió y la asignación de la
 * SDR es su rol legítimo (venta autónoma) — jamás se re-sortea. */
const HITOS_POST_PAGO = new Set(["aceptada", "onboarding_listo"])

export type DestinoSdr = "deal_tombola" | "lead_tlmk" | "sin_cambio"

/**
 * Qué hacer con un caso que está en manos de una SDR de calificación.
 * "sin_cambio" = su asignación es legítima y se respeta.
 */
export function destinoTrasCalificar(opts: {
  territorio?: string | null
  ownerId?: string | null
  ownerEmail?: string | null
  /** Vicky ya lo calificó: dotación conocida (registro o chat) o precio dado. */
  calificado: boolean
  rut?: string | null
  /** Hito que dispara la evaluación; los post-pago nunca re-sortean. */
  hito?: string | null
  /** Venta pagada/aceptada por otra vía (kv de pago, deal en 6/7/8). */
  ventaCerrada?: boolean
}): DestinoSdr {
  if (opts.territorio && opts.territorio !== "Chile") return "sin_cambio"
  if (!esSdrCalificacionCL(opts)) return "sin_cambio"
  if (opts.ventaCerrada) return "sin_cambio"
  if (opts.hito && HITOS_POST_PAGO.has(opts.hito)) return "sin_cambio"
  if (!opts.calificado) return "sin_cambio"
  return String(opts.rut || "").trim() ? "deal_tombola" : "lead_tlmk"
}
