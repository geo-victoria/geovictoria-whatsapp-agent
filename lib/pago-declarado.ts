/**
 * PAGO DECLARADO POR EL CLIENTE → VERIFICAR, NUNCA CREER (Lalo 10-sep, caso
 * Eduardo Guzmán 56963021761): el cliente salió al checkout de Mercado Pago y
 * a los 2 minutos escribió "Ya está pagado". El pago aún no había llegado a
 * Zoho y el modelo respondió "Ya veo que el pago está procesado 😊" + un
 * instructivo INVENTADO (descarga la app, app.geovictoria.com, "tus
 * credenciales", "la contraseña salió por correo"). Tres minutos después el
 * cliente dijo "no ha llegado la contraseña" y Vicky "se la reenvió".
 *
 * Reglas duras (Lalo): (1) "primero confirma que haya pagado y luego invoca a
 * Vicky Onboarding"; (2) "nunca podemos dar instrucciones como esa" — en fase
 * de VENTA la cuenta no existe: el acceso nace con el formulario del alta y
 * la contraseña la manda la plataforma, no Vicky.
 *
 * Detectores PUROS (testeables) + una verificación de red contra el
 * cotizador (`reconcile-pending?quoteId=`, modo puntual del 10-sep) que
 * consulta Mercado Pago y, si el pago está aprobado, deja la cotización
 * Pagada y dispara el post-pago (kickoff del alta) por su propio camino.
 */

const COTIZADOR = (process.env.COTIZADORA_API_BASE || "https://cotizacion.geovictoria.com").replace(/\/$/, "")
const VICKY_COTIZADORA_SECRET = (process.env.VICKY_COTIZADORA_SECRET || "").trim()

/** Minúsculas y sin tildes: `\b` de JS no entiende "é" como letra. */
function norm(t: string): string {
  return (t || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
}

/** El cliente afirma que ya pagó (sin que exista pago verificado). */
export function clienteDeclaraPago(texto: string): boolean {
  const t = norm(texto)
  return (
    /\b(ya|listo|recien|reci[eé]n)\s+(esta\s+)?pag(ue|ado)\b/.test(t) ||
    /\b(ya\s+)?(hice|realice|efectue|complete)\s+(el|la|mi)\s+(pago|transferencia|compra)\b/.test(t) ||
    /\b(ya\s+)?transferi\b/.test(t) ||
    /\b(pago|transferencia)\s+(esta\s+|quedo\s+)?(listo|lista|hecho|hecha|realizad[oa])\b/.test(t) ||
    /\besta\s+pagad[oa]\b/.test(t) ||
    /\bpague\s+(con|por)\s+(tarjeta|transferencia|webpay|mercado\s*pago)\b/.test(t)
  )
}

/** Vicky afirma que el pago está confirmado/procesado/registrado. */
export function afirmaPagoConfirmado(reply: string): boolean {
  const t = norm(reply)
  return (
    /\b(veo|vi|confirmo|me\s+aparece|me\s+figura)\s+(que\s+)?(tu\s+|el\s+)?pago\s+(ya\s+)?(esta|quedo|fue)\s+(procesad|confirmad|registrad|aprobad|acreditad)/.test(t) ||
    /\bpago\s+(procesado|confirmado|recibido|acreditado|aprobado)\b/.test(t) ||
    /\b(ya\s+)?(quedo|esta)\s+(registrad|confirmad|procesad)[oa]\s+(tu|el)\s+pago\b/.test(t) ||
    /\btu\s+(cuenta|plataforma)\s+(ya\s+)?(esta|quedo)\s+(activa|creada|lista|habilitada)\b/.test(t)
  )
}

/** Vicky afirma que la CUENTA del cliente ya existe o que ya se le mandó el
 * acceso: eso es teatro aunque el cliente no haya declarado pago. Explicar
 * cómo funciona el producto ("cada persona entra con su usuario y
 * contraseña") NO lo es — caso Katherine/ABL Alpstein 25-sep: la explicación
 * de la app se reemplazó dos veces por "todavía no me llega la confirmación
 * del pago" a quien ni siquiera tenía cotización. */
export function afirmaCuentaExistente(reply: string): boolean {
  const t = norm(reply)
  const marca =
    /\b(tus|sus)\s+credenciales\b/.test(t) ||
    /\b(ya\s+)?(te\s+)?(llego|salio|enviamos|envie|mande)\s+(tu|la|el)\s+(contrasena|clave|acceso|usuario)\b/.test(t) ||
    /\b(contrasena|clave)\s+(ya\s+)?(te\s+)?(llego|salio|va)\s+(por|al)\s+correo\b/.test(t) ||
    /\bempezamos\s+a\s+cargar\s+(a\s+)?tus\b/.test(t) ||
    /\bconfiguracion\s+inicial\s+de\s+tu\s+cuenta\b/.test(t) ||
    /\bingres(a|es|ar)\s+a\s+tu\s+cuenta\b/.test(t)
  if (!marca) return false
  // Caso Montajes Eléctricos (29-sep, reclamo de Mónica): a "¿cómo se procede
  // para contratar?" el modelo explicó los PASOS ("aceptas, pagas, apenas se
  // confirme te llega el formulario y tu contraseña para ingresar a tu cuenta")
  // y el cinturón lo leyó como cuenta existente → le respondió "todavía no me
  // llega la confirmación del pago" a alguien que nunca habló de pagar. Una
  // explicación del proceso en futuro/condicional NO es teatro; teatro es
  // afirmar en pasado/presente que el acceso ya existe.
  const explicaProceso =
    /\b(apenas|cuando|una\s+vez(\s+que)?|despues\s+de|luego\s+de|tras)\s+(se\s+)?(confirm|pag|acept|complet|quede|este)/.test(t) ||
    /\b(te\s+)?(llega|llegara|enviamos|enviaremos|mando|mandare|envio|enviare)\s+(un|el)\s+formulario\b/.test(t) ||
    /\b(podras|vas\s+a\s+poder|recibiras|recibes)\b/.test(t) ||
    /\b(el\s+proceso|los\s+pasos|para\s+contratar|asi\s+funciona)\b/.test(t)
  const afirmaPasado =
    /\bya\s+(te\s+)?(llego|salio|quedo|esta|enviamos|envie|mande)\b/.test(t) ||
    /\bempezamos\s+a\s+cargar\b/.test(t) ||
    /\bquedo\s+(creada|activa|lista)\b/.test(t)
  return !(explicaProceso && !afirmaPasado)
}

/** Instrucciones de ACCESO a la plataforma: prohibidas en fase de venta. */
export function pareceInstruccionDeAcceso(reply: string): boolean {
  const t = norm(reply)
  return (
    /\bdescarga(r)?\s+la\s+app\b/.test(t) ||
    /\bapp\.geovictoria\.com\b/.test(t) ||
    /\b(tus|sus|las)\s+credenciales\b/.test(t) ||
    /\bcontrasena\b/.test(t) ||
    /\bingres(a|es|ar)\s+a\s+tu\s+cuenta\b/.test(t) ||
    /\bconfiguracion\s+inicial\s+de\s+tu\s+cuenta\b/.test(t) ||
    /\b(usuario|user)\s*:\s*(el\s+correo|tu\s+correo)\b/.test(t) ||
    /\bempezamos\s+a\s+cargar\s+(a\s+)?tus\b/.test(t)
  )
}

export function textoPagoNoVerificado(opts: { link?: string | null } = {}): string {
  const link = (opts.link || "").trim()
  return (
    "Gracias por avisarme 🙏 Todavía no me llega la confirmación del pago, así que déjame verificarlo antes de seguir.\n\n" +
    "Si pagaste con tarjeta, en unos minutos se confirma solo y te aviso por aquí. Si fue por transferencia, mándame el comprobante (foto o PDF) y lo dejo registrado de inmediato." +
    (link ? `\n\nSi aún no alcanzaste a pagar, el link es este: ${link}` : "") +
    "\n\nApenas quede confirmado te mando un formulario cortito para crear tu cuenta — ahí nace tu acceso, no antes 😊"
  )
}

/** El modelo iba a hacer teatro de acceso pero el cliente NO declaró pago:
 * se le explica el proceso real, sin agradecerle un aviso que no dio. */
export function textoProcesoSinPago(opts: { link?: string | null } = {}): string {
  const link = (opts.link || "").trim()
  return (
    "Es simple 😊 Aceptas la cotización en el link y ahí mismo pagas, con tarjeta o transferencia." +
    (link ? `\n\nEste es el link: ${link}` : "") +
    "\n\nApenas se confirme el pago te mando un formulario cortito (2 minutos) para crear tu cuenta con los datos de tu empresa — ahí nace tu acceso, no antes. Y te acompaño yo con la configuración por este mismo chat."
  )
}

export function textoPagoConfirmado(): string {
  return (
    "¡Confirmado, tu pago ya quedó registrado! 🎉\n\n" +
    "En un momento te llega un formulario cortito (2 minutos) para crear tu cuenta con los datos de tu empresa. Cuando lo completes, la plataforma te envía tu acceso al correo y seguimos la configuración por aquí 😊"
  )
}

/**
 * Verifica UNA cotización contra Mercado Pago vía el cotizador. Si el pago
 * está aprobado, el cotizador la deja Pagada y notifica al agente (post-pago
 * + kickoff del alta) — acá solo se lee el veredicto. Best-effort: sin
 * secreto, sin red o timeout → false (jamás se afirma un pago sin verlo).
 */
export async function verificarPagoDeclarado(quoteId: string, timeoutMs = 25_000): Promise<{ pagado: boolean; motivo: string }> {
  const id = (quoteId || "").trim()
  if (!id || !VICKY_COTIZADORA_SECRET) return { pagado: false, motivo: "sin_config" }
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    const r = await fetch(`${COTIZADOR}/api/payments/reconcile-pending?quoteId=${encodeURIComponent(id)}`, {
      headers: { "x-vicky-secret": VICKY_COTIZADORA_SECRET },
      cache: "no-store",
      signal: ctl.signal,
    }).finally(() => clearTimeout(timer))
    if (!r.ok) return { pagado: false, motivo: `http_${r.status}` }
    const j = (await r.json().catch(() => null)) as { resultados?: Array<{ quoteId?: string; finalized?: boolean; reason?: string; error?: string }> } | null
    // La fila DEBE ser la de esta cotización: el fallback a resultados[0] podía
    // traer el veredicto de OTRA cotización del barrido y declarar pagado a
    // quien no pagó.
    const fila = (j?.resultados || []).find((x) => String(x.quoteId || "") === id)
    if (!fila) return { pagado: false, motivo: "sin_resultado" }
    if (fila.finalized || fila.reason === "ya_finalizada") return { pagado: true, motivo: fila.finalized ? "finalizada" : "pagada" }
    return { pagado: false, motivo: fila.reason || fila.error || "pago_no_aprobado" }
  } catch (e) {
    return { pagado: false, motivo: e instanceof Error && e.name === "AbortError" ? "timeout" : "error" }
  }
}

/**
 * ¿Cuántos intentos de pago tiene la cotización en Mercado Pago? (24-sep, caso
 * B-ram). Lee `payments/admin-lookup` del cotizador. null = no se pudo leer
 * (el llamador NO debe concluir nada de un null).
 */
export async function intentosMercadoPago(quoteId: string, timeoutMs = 12_000): Promise<number | null> {
  const id = (quoteId || "").trim()
  if (!id || !VICKY_COTIZADORA_SECRET) return null
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    const r = await fetch(`${COTIZADOR}/api/payments/admin-lookup?quoteId=${encodeURIComponent(id)}`, {
      headers: { "x-vicky-secret": VICKY_COTIZADORA_SECRET },
      cache: "no-store",
      signal: ctl.signal,
    }).finally(() => clearTimeout(timer))
    if (!r.ok) return null
    const j = (await r.json().catch(() => null)) as { count?: number } | null
    return typeof j?.count === "number" ? j.count : null
  } catch {
    return null
  }
}
