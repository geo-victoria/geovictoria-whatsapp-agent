/**
 * ¿LA PLANTILLA SALIÓ DE VERDAD? (13-sep)
 *
 * `sendBotmakerTemplate` recibe **202 = "encargo aceptado"**, no "entregado", y
 * hasta hoy eso era todo lo que sabíamos: un envío frenado por el pacing de
 * Meta o por el tope de mensajes de MARKETING por usuario se anotaba como
 * ÉXITO. Con las 7 plantillas del ciclo de reactivación categorizadas como
 * MARKETING (verificado 13-sep), ese riesgo dejó de ser teórico — y corrompe la
 * medición entera: si Meta bota un tercio, la tasa de respuesta se lee como
 * "la campaña no funciona" cuando en realidad no llegó.
 *
 * La señal existe y no hacía falta infraestructura nueva: la API de mensajes de
 * Botmaker lista lo SALIENTE (`from: "bot"`) y las plantillas aparecen con el
 * prefijo `Template:` (verificado contra el rescate del mini-form del 11-sep).
 * Si mandamos una plantilla y no hay rastro en su ventana, Botmaker nunca la
 * despachó.
 *
 * LÍMITE QUE HAY QUE DECIR SIEMPRE: esto cierra "Botmaker no la despachó". Si
 * Botmaker la despachó y META la botó, lo más probable es que igual figure acá
 * — eso solo lo cerraría un webhook de estado de entrega, que hoy no existe.
 * Es estrictamente mejor que el 202 a ciegas, y no es prueba de recepción
 * (misma regla que lib/honestidad-entrega para el correo).
 */

const BM_TOKEN = (process.env.BOTMAKER_ACCESS_TOKEN || "").trim()

export type MensajeBot = { contacto: string; at: number; esPlantilla: boolean; texto: string }

/** Todo lo SALIENTE de la ventana, indexado por contacto. */
export async function salientesDesde(
  desdeIso: string,
  opts: { presupuestoMs?: number; maxPaginas?: number } = {},
): Promise<{ porContacto: Map<string, MensajeBot[]>; total: number; truncado: boolean }> {
  const porContacto = new Map<string, MensajeBot[]>()
  if (!BM_TOKEN) return { porContacto, total: 0, truncado: true }
  const t0 = Date.now()
  const presupuesto = opts.presupuestoMs ?? 45_000
  const maxPag = opts.maxPaginas ?? 20
  let url = `https://api.botmaker.com/v2.0/messages?chat-platform=whatsapp&limit=250&from=${encodeURIComponent(desdeIso)}&pag=true`
  let total = 0
  let truncado = false
  for (let p = 0; p < maxPag && url; p++) {
    if (Date.now() - t0 > presupuesto) { truncado = true; break }
    const r = await fetch(url, { headers: { "access-token": BM_TOKEN, Accept: "application/json" }, cache: "no-store" }).catch(() => null)
    if (!r || !r.ok) { truncado = true; break }
    const data = (await r.json().catch(() => ({}))) as {
      items?: Array<{ from?: string; creationTime?: string; content?: { text?: string }; chat?: { contactId?: string } }>
      nextPage?: string
    }
    const items = Array.isArray(data.items) ? data.items : []
    for (const m of items) {
      total++
      if (m.from !== "bot") continue
      const c = String(m.chat?.contactId || "").replace(/\D/g, "")
      if (!c) continue
      const texto = String(m.content?.text || "")
      const at = Date.parse(String(m.creationTime || "")) || 0
      const arr = porContacto.get(c) || []
      arr.push({ contacto: c, at, esPlantilla: /^\s*Template:/i.test(texto), texto })
      porContacto.set(c, arr)
    }
    url = String(data.nextPage || "")
    if (items.length === 0) break
    if (p === maxPag - 1 && url) truncado = true
  }
  return { porContacto, total, truncado }
}

export type EnvioAVerificar = { contacto: string; at: string | number; tpl?: string }
export type VeredictoEntrega = {
  contacto: string
  at: string
  tpl?: string
  veredicto: "salio" | "no_visto" | "sin_ventana"
  detalle?: string
}

/** Margen alrededor del momento del envío donde debe aparecer el saliente. */
const MARGEN_MIN = Number(process.env.ENTREGA_MARGEN_MIN || 15)

/**
 * Cruza lo que CREEMOS haber enviado contra lo que Botmaker despachó.
 * `sin_ventana` = el envío es anterior al inicio de la ventana consultada, así
 * que su ausencia no prueba nada (nunca se reporta como fallo).
 */
export function veredictosDeEntrega(
  envios: EnvioAVerificar[],
  salientes: Map<string, MensajeBot[]>,
  desdeMs: number,
): VeredictoEntrega[] {
  return envios.map((e) => {
    const contacto = String(e.contacto).replace(/\D/g, "")
    const at = typeof e.at === "number" ? e.at : Date.parse(String(e.at)) || 0
    const iso = at ? new Date(at).toISOString() : String(e.at)
    if (!at || at < desdeMs) return { contacto, at: iso, tpl: e.tpl, veredicto: "sin_ventana" as const }
    const msgs = salientes.get(contacto) || []
    const margen = MARGEN_MIN * 60_000
    const match = msgs.find((m) => m.esPlantilla && Math.abs(m.at - at) <= margen)
    if (match) return { contacto, at: iso, tpl: e.tpl, veredicto: "salio" as const, detalle: match.texto.slice(0, 80) }
    // Un saliente NO-plantilla en la ventana igual prueba que el chat estaba
    // vivo: se dice, porque cambia el diagnóstico (no es un contacto muerto).
    const otro = msgs.find((m) => Math.abs(m.at - at) <= margen)
    return {
      contacto,
      at: iso,
      tpl: e.tpl,
      veredicto: "no_visto" as const,
      detalle: otro ? `sin plantilla, pero hubo otro saliente: ${otro.texto.slice(0, 60)}` : "sin ningún saliente en la ventana",
    }
  })
}
