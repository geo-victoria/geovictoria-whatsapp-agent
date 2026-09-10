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
    const fila = (j?.resultados || []).find((x) => String(x.quoteId || "") === id) || j?.resultados?.[0]
    if (!fila) return { pagado: false, motivo: "sin_resultado" }
    if (fila.finalized || fila.reason === "ya_finalizada") return { pagado: true, motivo: fila.finalized ? "finalizada" : "pagada" }
    return { pagado: false, motivo: fila.reason || fila.error || "pago_no_aprobado" }
  } catch (e) {
    return { pagado: false, motivo: e instanceof Error && e.name === "AbortError" ? "timeout" : "error" }
  }
}
