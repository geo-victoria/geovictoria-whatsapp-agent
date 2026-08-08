/**
 * Umbral de venta autónoma (orden de Lalo 08-ago — cambio del doc "Vicky paso
 * a paso 3.0"): Vicky DA PRECIOS solo hasta N trabajadores según el ORIGEN de
 * la conversación — inbound 20, outbound 10. Sobre el umbral (y hasta 50, el
 * tope del sistema) el precio lo entrega un ejecutivo: la derivación
 * derivar_a_soporte(fuera_de_rango_trabajadores) crea lead + deal y la
 * tómbola de deals sortea EN EL ACTO; Vicky no se despide — ACOMPAÑA la venta
 * sin precios (lo aprendido con el candado v3: nunca dejar solo al vendedor,
 * la venta es trabajo en equipo — su loop de seguimiento sigue vivo). Los >50
 * conservan su flujo enterprise intacto (loop cerrado motivo mas_de_50,
 * fuera de los relojes de traspaso).
 *
 * Origen OUTBOUND = el contacto tiene fila en vic_outbound_cadence (toque 0
 * enviado por vic-outbound-lead) — el MISMO criterio del dashboard funnel.
 * Sin fila = inbound. El origen es inmutable: el toque 0 solo se envía a
 * contactos sin conversación previa, y la fila nunca se borra (solo cambia
 * su status), así que se cachea en memoria por instancia.
 *
 * Si Supabase no responde se asume INBOUND (el umbral más amplio de los dos
 * nuevos): la verificación jamás degrada la conversación (principio 24-jul).
 *
 * Solo CHILE: CO/MX/PE mantienen sus reglas de país (los llamadores filtran
 * por prefijo 56 antes de consultar).
 *
 * Envs: VICKY_UMBRAL_INBOUND / VICKY_UMBRAL_OUTBOUND (overrides numéricos) ·
 * VICKY_UMBRAL_CLASICO=1 → rollback total al comportamiento previo (50/50).
 */

/** Tope duro del sistema: catálogo, tools y cotizador llegan hasta aquí. */
export const SCOPE_MAX_SISTEMA = 50

export type OrigenConversacion = "inbound" | "outbound"

function envNum(name: string, fallback: number): number {
  const v = Number((process.env[name] || "").trim())
  return Number.isFinite(v) && v >= 1 && v <= SCOPE_MAX_SISTEMA ? v : fallback
}

function modoClasico(): boolean {
  return (process.env.VICKY_UMBRAL_CLASICO || "").trim() === "1"
}

export function umbralInbound(): number {
  return modoClasico() ? SCOPE_MAX_SISTEMA : envNum("VICKY_UMBRAL_INBOUND", 20)
}

export function umbralOutbound(): number {
  return modoClasico() ? SCOPE_MAX_SISTEMA : envNum("VICKY_UMBRAL_OUTBOUND", 10)
}

// Cache por instancia (origen inmutable). Cap defensivo para lambdas vivas.
const origenCache = new Map<string, OrigenConversacion>()
const ORIGEN_CACHE_MAX = 500

async function origenDeContacto(contact: string): Promise<OrigenConversacion> {
  const clean = contact.replace(/\D/g, "")
  const cacheado = origenCache.get(clean)
  if (cacheado) return cacheado
  const url = (process.env.SUPABASE_URL || "").replace(/\/$/, "")
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || ""
  if (!url || !key) return "inbound"
  try {
    const res = await fetch(
      `${url}/rest/v1/vic_outbound_cadence?contact=eq.${encodeURIComponent(clean)}&select=contact&limit=1`,
      {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
        cache: "no-store",
      },
    )
    if (!res.ok) return "inbound"
    const rows = (await res.json().catch(() => [])) as unknown[]
    const origen: OrigenConversacion = Array.isArray(rows) && rows.length > 0 ? "outbound" : "inbound"
    if (origenCache.size >= ORIGEN_CACHE_MAX) origenCache.clear()
    origenCache.set(clean, origen)
    return origen
  } catch {
    return "inbound"
  }
}

/**
 * Umbral de precios vigente para un contacto (CL). Fail-open a inbound: un
 * error de red jamás bloquea más de lo que la regla nueva ya bloquea.
 */
export async function umbralPrecios(
  contact: string,
): Promise<{ umbral: number; origen: OrigenConversacion }> {
  if (modoClasico()) return { umbral: SCOPE_MAX_SISTEMA, origen: "inbound" }
  const origen = await origenDeContacto(contact)
  return { umbral: origen === "outbound" ? umbralOutbound() : umbralInbound(), origen }
}

/**
 * Detección DETERMINISTA de dotación sobre el umbral en el mensaje entrante
 * ("30 trabajadores", "somos 25 personas", "45 empleados"). La E2E del 08-ago
 * mostró que el guion de venta le gana a las reglas del prompt: con el número
 * detectado por código se inyecta una directiva imperativa AL FINAL del
 * prompt (recencia) para ese turno. Toma el número MAYOR mencionado junto a
 * una palabra de dotación; si nada supera el umbral devuelve null (el guard
 * de tools del agent-loop sigue de red de fondo).
 */
export function dotacionSobreUmbral(mensaje: string, umbral: number): number | null {
  const texto = String(mensaje || "").toLowerCase()
  const re = /(\d{1,4})\s*(?:trabajador|trabajadores|personas?\b|empleados?\b|colaborador(?:es)?|funcionarios?\b)/g
  let mayor = 0
  for (const m of texto.matchAll(re)) {
    const n = Number(m[1])
    if (Number.isFinite(n) && n > mayor) mayor = n
  }
  return mayor > umbral ? mayor : null
}

/**
 * Directiva cuando la CONVERSACIÓN declaró dotación sobre el umbral (se
 * escanea el mensaje actual + los mensajes previos del cliente, así la
 * directiva persiste todos los turnos siguientes). Va AL FINAL del system
 * prompt: la instrucción más cercana a la respuesta. Es idempotente: ordena
 * derivar solo si aún no se ha derivado en la conversación.
 */
export function formatDirectivaSobreUmbral(n: number, umbral: number): string {
  return (
    `\n\nATENCIÓN (detección automática): este cliente declaró ${n} trabajadores, MÁS que tu umbral de precios (${umbral}). Reglas OBLIGATORIAS de aquí en adelante:\n` +
    `- NO sigas el flujo de cotización (nada de preguntar marcaje, puntos ni módulos) y NO des ni prometas precios en ninguna respuesta.\n` +
    `- Si AÚN no has derivado en esta conversación: con nombre, email y empresa llama derivar_a_soporte motivo "fuera_de_rango_trabajadores" AHORA MISMO, pasando nombre, email, empresa y trabajadores. NO necesitas el RUT para derivar (el RUT lo captura el ejecutivo) — no lo pidas antes de derivar. Si falta alguno de los TRES datos (nombre, email, empresa), pídelos todos en una sola pregunta y deriva apenas lleguen; los datos que el cliente YA entregó se usan tal cual, SIN pedirle que los confirme. Después de llamar la tool, en ese MISMO turno SIEMPRE respóndele al cliente: copia el mensajeSugeridoUsuario de la tool (o parafrasea el anuncio del ejecutivo) y ofrece el siguiente paso — JAMÁS dejes la respuesta vacía.\n` +
    `- Si la derivación ya venía hecha de un turno ANTERIOR (el anuncio del ejecutivo ya aparece en mensajes previos del historial): NO vuelvas a llamar derivar_a_soporte ni repitas el anuncio. Solo acompaña: responde dudas de producto/implementación, ofrece agendar reunión con agendar_reunion y empuja el siguiente paso, siempre sin precios.\n`
  )
}

/**
 * Bloque inyectable al inicio del system prompt CL. Vacío en modo clásico
 * (umbral = 50): el prompt base ya dice 1-50 y no hay nada que acotar.
 */
export function formatUmbralParaPrompt(umbral: number, origen: OrigenConversacion): string {
  if (umbral >= SCOPE_MAX_SISTEMA) return ""
  return (
    `UMBRAL DE PRECIOS DE ESTA CONVERSACIÓN (proceso 08-ago — esta regla GANA sobre cualquier mención de "1 a 50" más abajo):\n` +
    `- Esta conversación es ${origen.toUpperCase()}. Puedes DAR PRECIOS (estimados, referenciales, descuentos, cotización formal) SOLO hasta ${umbral} trabajadores.\n` +
    `- APENAS sepas que son MÁS de ${umbral} trabajadores (aunque sean 50 o menos): DETÉN el flujo de cotización en ese mismo turno — NO preguntes cómo marcan, ni puntos, ni módulos, y NO prometas "armarte el valor", porque el precio NO lo entregas tú. Tampoco des precios de memoria ni del catálogo de este prompt.\n` +
    `- En su lugar: pide SOLO lo que te falte de nombre, email y empresa (una sola pregunta), y con los datos completos deriva EN ESE MISMO TURNO con derivar_a_soporte motivo "fuera_de_rango_trabajadores" pasando nombre, email, empresa y trabajadores — el trato entra AL ACTO a la tómbola del equipo y un ejecutivo entrega el precio a la brevedad. Si ya tienes los cuatro datos (por ejemplo del formulario o del primer mensaje), deriva DE INMEDIATO, sin ninguna pregunta previa.\n` +
    `- Después de derivar NO te despidas ni desaparezcas: ACOMPAÑA la venta. Responde todas las dudas (producto, funcionalidades, implementación, hardware, prueba), ofrece agendar una reunión con agendar_reunion, y empuja el cierre EN EQUIPO con el ejecutivo. Lo ÚNICO que pasa al ejecutivo es el precio — todo lo demás sigue contigo.\n` +
    `- El flujo de MÁS de 50 trabajadores no cambia (Modo Lead de siempre).\n\n`
  )
}
