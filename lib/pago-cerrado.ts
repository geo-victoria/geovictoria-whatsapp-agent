/**
 * LA PRIMERA SEÑAL DE PAGO CIERRA EL PAGO (Lalo 26-sep, caso NelNav COT1649:
 * "¿cómo cerramos el tema del pago con la primera señal para no volver a
 * preguntar por el comprobante?" · "que la primera señal cierre el pago").
 *
 * Qué pasó: débito aprobado en Mercado Pago a las 14:27:41; el cliente escribió
 * "ya pague la cotizacion" a las 14:31:08; la verificación que registra el pago
 * tarda más de 25 s y se cortó como "no pagado"; el modelo pidió "el comprobante
 * de transferencia" justo detrás de la plantilla "tu pago quedó registrado".
 *
 * Señales (cualquiera cierra, la primera gana):
 *   - `pago_cerrado_<contacto>` (esta misma marca: una vez cerrado, cerrado)
 *   - `pago_online_<contacto>` (post-pago con pago verificado en MP)
 *   - `comprobante_ok_<contacto>` (comprobante registrado por chat o por la
 *     casilla vicky@ con aviso del banco / adjunto)
 *   - un pago APROBADO en Mercado Pago para la cotización vigente (lectura
 *     rápida de `payments/admin-lookup`, sin esperar a que se registre)
 *
 * Al cerrar se estampa `pago_cerrado_<contacto>` para que todo lo que venga
 * después (turnos, cinturones, toques) lo vea al instante.
 */

async function kv() {
  return import("./supabase-persistence-v3")
}

const COTIZADOR = (process.env.COTIZADORA_API_BASE || "https://cotizacion.geovictoria.com").replace(/\/$/, "")
const VICKY_COTIZADORA_SECRET = (process.env.VICKY_COTIZADORA_SECRET || "").trim()
/** Ventana en que una señal de pago sigue "cerrando" la conversación. */
const VIGENCIA_MS = 30 * 24 * 60 * 60 * 1000

export type SenalPago = { fuente: "pago_cerrado" | "pago_online" | "comprobante" | "mercado_pago"; at: string; quoteId?: string }

function leer(v: string | null): { at?: string; quoteId?: string; numero?: string; fuente?: string } | null {
  if (!v) return null
  try {
    return JSON.parse(v)
  } catch {
    return null
  }
}

function vigente(at?: string): boolean {
  const ms = at ? Date.parse(at) : NaN
  return Number.isFinite(ms) && Date.now() - ms < VIGENCIA_MS
}

/** ¿Hay un pago APROBADO en Mercado Pago para la cotización? Lectura rápida (no registra nada). */
export async function pagoAprobadoMercadoPago(quoteId: string, timeoutMs = 6_000): Promise<{ at: string } | null> {
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
    const j = (await r.json().catch(() => null)) as { payments?: Array<{ status?: string; date_approved?: string | null; date_created?: string }> } | null
    const ok = (j?.payments || []).find((p) => p.status === "approved")
    if (!ok) return null
    const at = new Date(ok.date_approved || ok.date_created || Date.now()).toISOString()
    return { at }
  } catch {
    return null
  }
}

/**
 * Primera señal de pago del contacto. Las marcas kv son baratas y se leen
 * siempre; Mercado Pago solo si se pasa `consultarMP` (cliente declara pago,
 * manda un adjunto, o salió al checkout) y hay cotización vigente.
 */
export async function senalDePago(
  contact: string,
  opts: { quoteId?: string | null; consultarMP?: boolean } = {},
): Promise<SenalPago | null> {
  const quoteId = (opts.quoteId || "").trim()
  const { getKvValue } = await kv()
  const [cerrado, online, comp] = await Promise.all([
    getKvValue(`pago_cerrado_${contact}`).catch(() => null),
    getKvValue(`pago_online_${contact}`).catch(() => null),
    getKvValue(`comprobante_ok_${contact}`).catch(() => null),
  ])
  const c = leer(cerrado)
  if (c && vigente(c.at) && (!quoteId || !c.quoteId || c.quoteId === quoteId)) {
    return { fuente: "pago_cerrado", at: String(c.at), quoteId: c.quoteId }
  }
  const o = leer(online)
  if (o && vigente(o.at) && (!quoteId || !o.quoteId || o.quoteId === quoteId)) {
    return { fuente: "pago_online", at: String(o.at), quoteId: o.quoteId || quoteId || undefined }
  }
  const k = leer(comp)
  if (k && vigente(k.at)) return { fuente: "comprobante", at: String(k.at), quoteId: quoteId || undefined }
  if (opts.consultarMP && quoteId) {
    const mp = await pagoAprobadoMercadoPago(quoteId)
    if (mp) {
      await cerrarPago(contact, quoteId, "mercado_pago", mp.at)
      return { fuente: "mercado_pago", at: mp.at, quoteId }
    }
  }
  return null
}

/** Estampa el cierre. Idempotente: si ya estaba cerrado conserva la primera fecha. */
export async function cerrarPago(contact: string, quoteId: string, fuente: string, at?: string): Promise<void> {
  try {
    const { getKvValue, setKvValue } = await kv()
    const previo = leer(await getKvValue(`pago_cerrado_${contact}`).catch(() => null))
    if (previo && vigente(previo.at) && previo.quoteId === quoteId) return
    await setKvValue(`pago_cerrado_${contact}`, JSON.stringify({ at: at || new Date().toISOString(), quoteId, fuente }))
  } catch {
    // best-effort: la señal igual vale para este turno
  }
}

/** La respuesta le pide al cliente comprobante o que pague (prohibido con el pago cerrado). */
export function pideComprobanteOPago(reply: string): boolean {
  const t = (reply || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
  return (
    /comprobante/.test(t) ||
    /verificacion del (pago|banco)/.test(t) ||
    /(falta|faltaria|queda|pendiente)\w*\s+(el|tu|solo el)?\s*pago/.test(t) ||
    /(realiza|realizar|completa|completar|hacer|haz)\s+(el|tu)\s+pago/.test(t) ||
    /cuando (pagues|hagas el pago|realices el pago)/.test(t)
  )
}

/** Directiva para el prompt cuando el pago está cerrado. */
export function directivaPagoCerrado(s: SenalPago): string {
  const como =
    s.fuente === "comprobante"
      ? "envió su comprobante y quedó registrado"
      : "pagó y el pago está CONFIRMADO (Mercado Pago)"
  return (
    `\n\n[DIRECTIVA POST-VENTA — obligatoria] Este contacto YA ${como}. El pago está CERRADO: JAMÁS le pidas comprobante, ` +
    `ni transferencia, ni que pague, ni digas que falta validar el pago. Si manda un comprobante o una captura del pago, ` +
    `agradécelo y confirma que ya está registrado. Estás en MODO POST-VENTA: NO cotices ni armes valores nuevos — ` +
    `acompáñalo con el alta de su cuenta y responde sus dudas. SOLO si pide EXPLÍCITAMENTE cotizar para OTRA empresa ` +
    `vuelves al flujo de venta.`
  )
}
