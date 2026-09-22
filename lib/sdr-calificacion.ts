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

/** Roster SDR de PERÚ (Lalo 15-sep: Ana Fiori y Priscila Quispe reciben lo
 * que Vicky no logra calificar). Mismo env que la rotación de zoho-leads
 * (VIC_SDR_INBOUND_PE, "email:zohoId,…") para que haya UNA fuente. La regla
 * es la de Chile con otras personas (Lalo 22-sep): lo que la SDR peruana
 * recibió sin calificar y Vicky calificó después vuelve a Mónica por la
 * tómbola TLMK (sin RUC) o nace deal + "Deals 2026" (con RUC). */
const ROSTER_DEFAULT_PE =
  "afiori@geovictoria.com:3525045000299130001:Ana Fiori," +
  "pquispef@geovictoria.com:3525045000576828001:Priscila Quispe"

type Sdr = { email: string; id: string }

function parseRoster(raw: string): Sdr[] {
  return raw
    .split(",")
    .map((par) => {
      const [email, id] = par.split(":").map((x) => (x || "").trim())
      return { email: (email || "").toLowerCase(), id: id || "" }
    })
    .filter((d) => d.email || d.id)
}

function roster(): Sdr[] {
  return parseRoster(process.env.VICKY_TM_CALIFICACION_DESTINOS || ROSTER_DEFAULT)
}

function rosterPE(): Sdr[] {
  return parseRoster(process.env.VIC_SDR_INBOUND_PE || ROSTER_DEFAULT_PE)
}

/** Roster SDR del territorio. Sin territorio se asume Chile (los llamadores
 * viejos no lo pasaban); Colombia/México no tienen SDR de calificación en
 * este sentido (sus dueños son fijos/RR y no se re-entregan) → roster vacío. */
export function rosterSdrPorTerritorio(territorio?: string | null): Sdr[] {
  const t = String(territorio || "Chile").trim().toLowerCase()
  if (t === "chile") return roster()
  if (t === "perú" || t === "peru") return rosterPE()
  return []
}

function enRoster(r: Sdr[], o: { ownerId?: string | null; ownerEmail?: string | null }): boolean {
  const id = String(o.ownerId || "").trim()
  const email = String(o.ownerEmail || "").trim().toLowerCase()
  if (!id && !email) return false
  return r.some((d) => (id && d.id === id) || (email && d.email === email))
}

/** ¿Este dueño es una SDR de calificación de Chile? */
export function esSdrCalificacionCL(o: { ownerId?: string | null; ownerEmail?: string | null }): boolean {
  return enRoster(roster(), o)
}

/** ¿Este dueño es una SDR de calificación del territorio dado (Chile o Perú)? */
export function esSdrCalificacion(
  territorio: string | null | undefined,
  o: { ownerId?: string | null; ownerEmail?: string | null },
): boolean {
  return enRoster(rosterSdrPorTerritorio(territorio), o)
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
  // Territorio con roster SDR (Chile, Perú); sin roster no hay re-entrega.
  if (!esSdrCalificacion(opts.territorio, opts)) return "sin_cambio"
  if (opts.ventaCerrada) return "sin_cambio"
  if (opts.hito && HITOS_POST_PAGO.has(opts.hito)) return "sin_cambio"
  if (!opts.calificado) return "sin_cambio"
  return String(opts.rut || "").trim() ? "deal_tombola" : "lead_tlmk"
}
