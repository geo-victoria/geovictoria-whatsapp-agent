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

export type MensajeBot = { contacto: string; at: number; esPlantilla: boolean; tpl: string; texto: string }

/** Todo lo SALIENTE de la ventana, indexado por contacto. */
export async function salientesDesde(
  desdeIso: string,
  opts: { presupuestoMs?: number; maxPaginas?: number } = {},
): Promise<{ porContacto: Map<string, MensajeBot[]>; total: number; truncado: boolean; error?: string }> {
  const porContacto = new Map<string, MensajeBot[]>()
  if (!BM_TOKEN) return { porContacto, total: 0, truncado: true, error: "sin BOTMAKER_ACCESS_TOKEN" }
  const t0 = Date.now()
  const presupuesto = opts.presupuestoMs ?? 45_000
  const maxPag = opts.maxPaginas ?? 20
  // Más allá de ~72 h Botmaker exige `long-term-search=true` (si no: 400
  // LONG_TERM_SEARCH_PARAM_REQUIRED). Probado 13-sep: con el parámetro una
  // ventana de 120 h devuelve miles de mensajes, así que el histórico SÍ se
  // puede rescatar. Solo se agrega cuando hace falta, para no cambiar el
  // comportamiento de las consultas cortas.
  const horasAtras = (Date.now() - (Date.parse(desdeIso) || Date.now())) / 3600e3
  const largoPlazo = horasAtras > 48 ? "&long-term-search=true" : ""
  let url = `https://api.botmaker.com/v2.0/messages?chat-platform=whatsapp&limit=250&from=${encodeURIComponent(desdeIso)}&pag=true${largoPlazo}`
  let total = 0
  let truncado = false
  let error = ""
  for (let p = 0; p < maxPag && url; p++) {
    if (Date.now() - t0 > presupuesto) { truncado = true; break }
    const r = await fetch(url, { headers: { "access-token": BM_TOKEN, Accept: "application/json" }, cache: "no-store" }).catch(() => null)
    if (!r || !r.ok) {
      truncado = true
      error = r ? `botmaker ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}` : "botmaker sin respuesta"
      break
    }
    const data = (await r.json().catch(() => ({}))) as {
      items?: Array<{
        from?: string
        creationTime?: string
        content?: { text?: string; whatsAppTemplateName?: string }
        chat?: { contactId?: string }
      }>
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
      const tpl = String(m.content?.whatsAppTemplateName || "")
      arr.push({ contacto: c, at, esPlantilla: Boolean(tpl) || /^\s*Template:/i.test(texto), tpl, texto })
      porContacto.set(c, arr)
    }
    url = String(data.nextPage || "")
    if (items.length === 0) break
    if (p === maxPag - 1 && url) truncado = true
  }
  return { porContacto, total, truncado, error: error || undefined }
}

export type EnvioAVerificar = { contacto: string; at: string | number; tpl?: string }
export type VeredictoEntrega = {
  contacto: string
  at: string
  tpl?: string
  veredicto: "salio" | "no_visto" | "sin_ventana" | "sin_datos"
  detalle?: string
}

/**
 * Margen alrededor del momento del envío donde debe aparecer el saliente.
 *
 * AMPLIO A PROPÓSITO (6 h). La primera versión usaba 15 min y dio **0 de 13**
 * en el rescate del mini-form — falso: el `Template:` de Alicia Farias estaba
 * ahí, a 69 minutos del `at` anotado. Causa: el `at` de las marcas kv NO es la
 * hora real del envío (las 13 quedaron con el mismo 19:20:00.000, la hora del
 * lote). O sea el veredicto colgaba de un timestamp que puede ser aproximado.
 * Por eso el match FUERTE es contacto + nombre de plantilla, y la hora solo
 * acota la ventana y mide el desfase.
 */
const MARGEN_MIN = Number(process.env.ENTREGA_MARGEN_MIN || 360)

/**
 * Cruza lo que CREEMOS haber enviado contra lo que Botmaker despachó.
 * `sin_ventana` = el envío es anterior al inicio de la ventana consultada, así
 * que su ausencia no prueba nada (nunca se reporta como fallo).
 */
/**
 * CICATRIZ (13-sep, dos veces en el mismo archivo): la ausencia de datos NO es
 * un hallazgo negativo. La primera corrida sobre la campaña remk_300 devolvió
 * "247 no vistos" cuando la verdad era que Botmaker había respondido 400
 * (`LONG_TERM_SEARCH_PARAM_REQUIRED`: no deja consultar más de ~72 h atrás) y
 * no se leyó ni un mensaje. Sin lectura útil, TODO es `sin_datos`.
 */
export function veredictosDeEntrega(
  envios: EnvioAVerificar[],
  salientes: Map<string, MensajeBot[]>,
  desdeMs: number,
  opts: { lecturaUtil?: boolean } = {},
): VeredictoEntrega[] {
  if (opts.lecturaUtil === false) {
    return envios.map((e) => ({
      contacto: String(e.contacto).replace(/\D/g, ""),
      at: typeof e.at === "number" ? new Date(e.at).toISOString() : String(e.at),
      tpl: e.tpl,
      veredicto: "sin_datos" as const,
      detalle: "no se pudo leer el historial de Botmaker — sin veredicto",
    }))
  }
  return envios.map((e) => {
    const contacto = String(e.contacto).replace(/\D/g, "")
    const at = typeof e.at === "number" ? e.at : Date.parse(String(e.at)) || 0
    const iso = at ? new Date(at).toISOString() : String(e.at)
    if (!at || at < desdeMs) return { contacto, at: iso, tpl: e.tpl, veredicto: "sin_ventana" as const }
    const msgs = salientes.get(contacto) || []
    const margen = MARGEN_MIN * 60_000
    const enVentana = msgs.filter((m) => Math.abs(m.at - at) <= margen)
    // Match FUERTE: misma plantilla al mismo contacto. Si no sabemos qué
    // plantilla era, basta con que haya salido alguna.
    const match =
      (e.tpl ? enVentana.find((m) => m.tpl && m.tpl === e.tpl) : undefined) ||
      enVentana.find((m) => m.esPlantilla)
    if (match) {
      const desfaseMin = Math.round((match.at - at) / 60_000)
      return {
        contacto,
        at: iso,
        tpl: e.tpl,
        veredicto: "salio" as const,
        detalle: `${match.tpl || match.texto.slice(0, 50)}${desfaseMin ? ` (${desfaseMin > 0 ? "+" : ""}${desfaseMin} min)` : ""}`,
      }
    }
    // Un saliente NO-plantilla en la ventana igual prueba que el chat estaba
    // vivo: se dice, porque cambia el diagnóstico (no es un contacto muerto).
    const otro = enVentana[0]
    return {
      contacto,
      at: iso,
      tpl: e.tpl,
      veredicto: "no_visto" as const,
      detalle: otro ? `sin plantilla, pero hubo otro saliente: ${otro.texto.slice(0, 60)}` : "sin ningún saliente en la ventana",
    }
  })
}

// ── VERIFICACIÓN AUTOMÁTICA Y PERSISTIDA ────────────────────────────────────
// El veredicto hay que guardarlo CUANDO se puede leer, no cuando se necesita:
// aunque `long-term-search=true` alcanza semanas atrás, la lectura es cara
// (7.377 mensajes para verificar una campaña de 247) y el dato no cambia. Con
// esto el cron verifica los toques recientes una vez y deja el veredicto en
// vic_kv, de donde el reporte del lunes lo lee gratis.

const SUPA_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "")
const SUPA_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()

export type EntregaPersistida = { contacto: string; casilla: string; at: string; veredicto: string; detalle?: string }

const claveEntrega = (contacto: string, campana: string, at: string) =>
  `entrega_${campana}_${contacto}_${at.slice(0, 16).replace(/[-:T]/g, "")}`

/**
 * Verifica los envíos de campaña de los últimos `dias` que aún no tienen
 * veredicto y los persiste. Idempotente: lo ya verificado no se vuelve a leer.
 */
export async function verificarYPersistirEntregas(
  dias = 3,
): Promise<{ evaluados: number; salio: number; no_visto: number; sin_datos: number; nuevos: number; detalle: EntregaPersistida[]; error?: string }> {
  const vacio = { evaluados: 0, salio: 0, no_visto: 0, sin_datos: 0, nuevos: 0, detalle: [] as EntregaPersistida[] }
  if (!SUPA_URL || !SUPA_KEY) return { ...vacio, error: "sin supabase" }
  const H = { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` }
  const desdeIso = new Date(Date.now() - dias * 86_400_000).toISOString()

  // 1. Envíos de WhatsApp de la campaña en la ventana.
  const r = await fetch(
    `${SUPA_URL}/rest/v1/vic_campanas?campana=like.react_t*&evento=eq.enviado&at=gte.${desdeIso}&select=contact,at,campana&limit=1000`,
    { headers: H, cache: "no-store" },
  ).catch(() => null)
  if (!r || !r.ok) return { ...vacio, error: `vic_campanas ${r ? r.status : "sin respuesta"}` }
  const filas = ((await r.json().catch(() => [])) as Array<{ contact: string; at: string; campana: string }>) || []
  if (!filas.length) return vacio

  // 2. Lo ya verificado se salta (una lectura en bloque, no una por fila).
  const rv = await fetch(`${SUPA_URL}/rest/v1/vic_kv?key=like.entrega_react_t*&select=key&limit=5000`, { headers: H, cache: "no-store" }).catch(() => null)
  const yaHechos = new Set(
    (((await rv?.json().catch(() => [])) as Array<{ key: string }>) || []).map((f) => f.key),
  )
  const pendientes = filas.filter((f) => !yaHechos.has(claveEntrega(f.contact, f.campana, f.at)))
  if (!pendientes.length) return { ...vacio, evaluados: filas.length }

  // 3. Una sola lectura de Botmaker para todos los pendientes.
  const { porContacto, total } = await salientesDesde(desdeIso, { presupuestoMs: 120_000, maxPaginas: 60 })
  const veredictos = veredictosDeEntrega(
    pendientes.map((f) => ({ contacto: f.contact, at: f.at, tpl: undefined })),
    porContacto,
    Date.parse(desdeIso),
    { lecturaUtil: total > 0 },
  )

  const { setKvValue } = await import("./supabase-persistence-v3")
  const out = { ...vacio, evaluados: filas.length }
  for (let i = 0; i < veredictos.length; i++) {
    const v = veredictos[i]
    const f = pendientes[i]
    // `sin_datos` NO se persiste: no es un veredicto, es una lectura fallida —
    // guardarlo congelaría la ignorancia y el reintento nunca ocurriría.
    if (v.veredicto === "sin_datos") { out.sin_datos++; continue }
    const fila: EntregaPersistida = { contacto: v.contacto, casilla: f.campana, at: f.at, veredicto: v.veredicto, detalle: v.detalle }
    await setKvValue(claveEntrega(f.contact, f.campana, f.at), JSON.stringify(fila)).catch(() => {})
    out.nuevos++
    if (v.veredicto === "salio") out.salio++
    else if (v.veredicto === "no_visto") out.no_visto++
    out.detalle.push(fila)
  }
  return out
}

/** Lee los veredictos ya persistidos (gratis, sin tocar Botmaker). */
export async function entregasPersistidas(dias = 28): Promise<EntregaPersistida[]> {
  if (!SUPA_URL || !SUPA_KEY) return []
  const r = await fetch(`${SUPA_URL}/rest/v1/vic_kv?key=like.entrega_react_t*&select=key,value&limit=5000`, {
    headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` },
    cache: "no-store",
  }).catch(() => null)
  if (!r || !r.ok) return []
  const corte = Date.now() - dias * 86_400_000
  const out: EntregaPersistida[] = []
  for (const f of ((await r.json().catch(() => [])) as Array<{ key: string; value: string }>) || []) {
    try {
      const e = JSON.parse(f.value) as EntregaPersistida
      if (Date.parse(e.at || "") >= corte) out.push(e)
    } catch { /* fila ilegible */ }
  }
  return out
}
