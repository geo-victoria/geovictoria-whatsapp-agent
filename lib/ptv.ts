/**
 * PTV — Proceso de Traspaso a Vendedor (doc "Vicky paso a paso", Rodrigo
 * 30-jul-2026, revisado por Victoria Luna). Reglas implementadas:
 *
 *   TTV (tiempo sin respuesta del cliente que gatilla el traspaso):
 *     - SIN precio mostrado → 120 minutos.
 *     - CON precio mostrado → 15 minutos.
 *     - Pausa anunciada por el cliente ("háblame mañana") suspende el TTV:
 *       el compromiso vigente en vic_loop (compromiso_at futuro) manda.
 *   El TTV solo corre en HORARIO HÁBIL del país (L-V no feriado, 8-18 h);
 *   fuera de hábil el reloj queda congelado hasta la siguiente hora hábil.
 *
 *   PTV al gatillar: elegir vendedor (tómbola por país — interinos hasta la
 *   tómbola definitiva de Victoria), presentárselo al prospecto por WhatsApp,
 *   asignar el lead/deal en Zoho, y alertar internamente para que llame en
 *   <5 minutos. El script de la conversación ya vive en las notas de Zoho
 *   (nota de transcripción de crm-hitos). El link de pago sobrevive: los
 *   punteros de cotización quedan intactos.
 *
 *   Chequeo de calidad: 9 horas hábiles después, Vicky le pregunta al
 *   prospecto cómo le fue (solo si la ventana de 24 h de Meta está abierta;
 *   si no, se registra como sin_respuesta y se reintenta al siguiente hito).
 *
 * "Conversación se enreda" (3 turnos sin avanzar / pregunta repetida /
 * frustración / X minutos): FASE 2 — falta el valor de X y requiere señal del
 * análisis conversacional. El camino "pide vendedor" ya existe hoy vía las
 * tools de derivación/callback.
 *
 * Flag: VICKY_PTV_ENABLED (apagado por defecto). Todo best-effort, por el
 * canal trasero: jamás bloquea ni retrasa una respuesta al cliente.
 */

const FLAG = "VICKY_PTV_ENABLED"

export const TTV_SIN_PRECIO_MIN = 120
export const TTV_CON_PRECIO_MIN = 15

/** Vendedores de la tómbola por país. Interinos (mismos responsables de
 * país) hasta que Victoria entregue la tómbola definitiva; se reemplaza por
 * env VICKY_PTV_VENDEDORES_<CC>="email:zohoId,email:zohoId". */
const VENDEDORES_DEFAULT: Record<string, string> = {
  cl: "emujica@geovictoria.com:3525045000000211283",
  co: "agordillo@geovictoria.com:3525045000203758005",
  mx: "ysegura@geovictoria.com:3525045000308323003",
}

export function ptvHabilitado(): boolean {
  return (process.env[FLAG] || "").trim() === "on"
}

export function vendedoresDePais(pais: "cl" | "co" | "mx"): Array<{ email: string; zohoId: string }> {
  const raw =
    (process.env[`VICKY_PTV_VENDEDORES_${pais.toUpperCase()}`] || "").trim() ||
    VENDEDORES_DEFAULT[pais]
  return raw
    .split(",")
    .map((s) => {
      const [email, zohoId] = s.split(":").map((x) => x.trim())
      return { email, zohoId: zohoId || "" }
    })
    .filter((v) => v.email)
}

const TZ_POR_PAIS: Record<string, string> = {
  cl: "America/Santiago",
  co: "America/Bogota",
  mx: "America/Mexico_City",
}

/** Hora local (0-23) y día de semana (0=domingo) del país. */
function horaLocal(pais: string, ahora: Date): { hora: number; dia: number } {
  const tz = TZ_POR_PAIS[pais] || "America/Santiago"
  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    hour12: false,
    weekday: "short",
  }).formatToParts(ahora)
  const hora = Number(partes.find((p) => p.type === "hour")?.value || 0)
  const diaTxt = partes.find((p) => p.type === "weekday")?.value || "Mon"
  const dias = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
  return { hora: hora === 24 ? 0 : hora, dia: dias.indexOf(diaTxt) }
}

/**
 * Horario hábil del doc: L-V no feriado, 8:00-18:00 hora del país. Los
 * feriados los aporta el caller (tabla vic_holidays) como set "YYYY-MM-DD".
 */
export function esHorarioHabil(pais: string, ahora: Date, feriados: Set<string> = new Set()): boolean {
  const { hora, dia } = horaLocal(pais, ahora)
  if (dia === 0 || dia === 6) return false
  if (hora < 8 || hora >= 18) return false
  const tz = TZ_POR_PAIS[pais] || "America/Santiago"
  const fechaLocal = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(ahora)
  if (feriados.has(fechaLocal)) return false
  return true
}

/** TTV aplicable según si el prospecto ya vio precio. */
export function ttvMinutos(precioMostrado: boolean): number {
  return precioMostrado ? TTV_CON_PRECIO_MIN : TTV_SIN_PRECIO_MIN
}

/**
 * Decide si corresponde gatillar el PTV para una conversación:
 *   - el último mensaje es de Vicky (el cliente no ha respondido),
 *   - pasaron TTV minutos desde el último mensaje del CLIENTE (los toques
 *     del Loop actualizan la conversación pero NO reinician este reloj),
 *   - estamos en horario hábil del país (el doc: fuera de hábil se espera),
 *   - no hay pausa anunciada vigente (compromisoAt futuro suspende),
 *   - no hay un traspaso activo previo.
 */
export function debeTraspasar(params: {
  /** Referencia del reloj TTV: el silencio se mide desde el último mensaje
   * del CLIENTE (si Vicky ya respondió) — los toques del Loop NO reinician
   * el TTV (brecha detectada 30-jul: cada toque empujaba el traspaso). */
  referenciaRelojAt: Date
  clienteRespondioDespues: boolean
  precioMostrado: boolean
  pais: "cl" | "co" | "mx"
  ahora: Date
  feriados?: Set<string>
  compromisoAt?: Date | null
  traspasoActivo: boolean
}): { traspasar: boolean; motivo?: string; ttv?: number } {
  const { referenciaRelojAt, clienteRespondioDespues, precioMostrado, pais, ahora, feriados, compromisoAt, traspasoActivo } = params
  if (traspasoActivo) return { traspasar: false }
  if (clienteRespondioDespues) return { traspasar: false }
  if (compromisoAt && compromisoAt.getTime() > ahora.getTime()) return { traspasar: false }
  if (!esHorarioHabil(pais, ahora, feriados)) return { traspasar: false }
  const ttv = ttvMinutos(precioMostrado)
  // Si hubo pausa anunciada ya vencida, el TTV corre desde su vencimiento.
  const desde = compromisoAt && compromisoAt.getTime() > referenciaRelojAt.getTime()
    ? compromisoAt
    : referenciaRelojAt
  const minutos = (ahora.getTime() - desde.getTime()) / 60000
  if (minutos < ttv) return { traspasar: false }
  return { traspasar: true, motivo: "ttv_sin_respuesta", ttv }
}

/** Presentación del vendedor al prospecto, por país (reglas de estilo de
 * Vicky). SIEMPRE con los datos de contacto del vendedor cuando se conocen
 * (Lalo 31-jul): el cliente debe poder escribirle o llamarlo directo. */
export function mensajePresentacion(
  pais: "cl" | "co" | "mx",
  nombreVendedor: string,
  contacto?: { email?: string; whatsapp?: string },
): string {
  const base = `Te cuento: para acompañarte mejor con tu cotización, desde ahora te atiende ${nombreVendedor} de nuestro equipo comercial — te va a llamar muy pronto para resolverlo todo de una. Ya tiene el detalle completo de nuestra conversación, así que no tendrás que repetir nada`
  const lineas = [
    contacto?.email ? `✉️ ${contacto.email}` : "",
    contacto?.whatsapp ? `📱 WhatsApp: ${contacto.whatsapp}` : "",
  ].filter(Boolean)
  const datos = lineas.length ? `.\n\n${lineas.join("\n")}\n\n` : ". "
  if (pais === "co") return `¡Hola! ${base}${datos}Cualquier cosa igual me puedes escribir por aquí 🙌`
  if (pais === "mx") return `¡Hola! ${base}${datos}Por aquí sigo atenta a lo que necesites 🙌`
  return `¡Hola! ${base}${datos}Cualquier cosa me escribes por aquí 🙌`
}

/** Pregunta del chequeo de calidad (9 h hábiles post-traspaso). */
export function mensajeChequeo(pais: "cl" | "co" | "mx", nombreVendedor: string): string {
  if (pais === "co") return `¡Hola! Soy Vicky otra vez 😊 ¿Cómo te fue con ${nombreVendedor}? ¿Pudieron hablar y resolver tus dudas?`
  if (pais === "mx") return `¡Hola! Soy Vicky de nuevo 😊 ¿Cómo te fue con ${nombreVendedor}? ¿Ya pudieron platicar y resolver tus dudas?`
  return `¡Hola! Soy Vicky de nuevo 😊 ¿Cómo te fue con ${nombreVendedor}? ¿Alcanzaron a hablar y resolver tus dudas?`
}

/** Suma 9 horas hábiles (bloques de 8-18, L-V) a un instante — el "un día
 * hábil después" del doc para el chequeo. Aproximación por horas enteras. */
export function sumarHorasHabiles(desde: Date, horas: number, pais: string, feriados: Set<string> = new Set()): Date {
  const cursor = new Date(desde)
  let restantes = horas
  let guardia = 0
  while (restantes > 0 && guardia < 24 * 30) {
    cursor.setTime(cursor.getTime() + 3600_000)
    guardia++
    if (esHorarioHabil(pais, cursor, feriados)) restantes--
  }
  return cursor
}
