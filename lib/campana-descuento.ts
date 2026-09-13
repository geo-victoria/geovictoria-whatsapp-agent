/**
 * CAMPAÑA DE DESCUENTO ADICIONAL (Lalo 26-ago, campañas del 18 y 28).
 *
 * Maneja la respuesta a la plantilla `vicky_campana_dcto_v1` (botones Payload
 * Webhook `campana_dcto_si` / `campana_dcto_no`) de forma DETERMINISTA: el
 * modelo jamás decide el porcentaje. Reglas selladas con Lalo:
 *
 *   - +10 puntos sobre el descuento COMITEADO actual (fuente de verdad = la
 *     cotización en Zoho, no el kv de la escalera), con TOPE 30.
 *   - Solo asistencia (el % va por el descuento estándar del plan).
 *   - Vigencia 6 meses (corre desde que paga: son las primeras 6 facturas).
 *   - Cotización del canal ejecutivo ("Con intervención humana") NO se toca
 *     automático: alerta al equipo para que el vendedor lo aplique él.
 *   - Idempotente: doble tap devuelve el mismo link sin re-sumar.
 *   - Máximo 2 campañas por contacto: el contador vive en vic_campanas y se
 *     estampa AL ENVIAR (el runner); acá solo se registra la respuesta.
 *
 * El estado por contacto vive en vic_kv `campana_dcto_<fono>` (lo siembra el
 * runner del envío con segmento y quoteId). Sin ese kv, un texto que calce con
 * los payloads sigue al flujo normal — nadie puede gatillar descuentos
 * escribiendo el payload a mano.
 */

import { getKvValue, setKvValue } from "./supabase-persistence-v3"
import { avisarEquipoInterno } from "./alerta-interna"

const COTIZADOR = (process.env.COTIZADORA_API_BASE || "https://cotizacion.geovictoria.com").replace(/\/$/, "")
const VICKY_COTIZADORA_SECRET = (process.env.VICKY_COTIZADORA_SECRET || "").trim()
const TOPE_CAMPANA = 30
/** Tope de la escalera de cara al CLIENTE (10→20): lo que Vicky puede ofrecer
 * sin pasar por un ejecutivo. Es el gancho del toque 4 del ciclo. */
const TOPE_ESCALERA_CLIENTE = Number(process.env.CAMPANA_REACT_TOPE_PCT || 20)
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()

export const claveCampana = (fono: string) => `campana_dcto_${fono.replace(/\D/g, "")}`

export type EstadoCampana = {
  /** Identificador de la corrida, ej. "dcto10_2026-08". */
  campana?: string
  /** 1 = vio precio sin formal · 2 = formal sin aceptar · 3 = aceptada. */
  segmento?: string
  quoteId?: string
  /** Descuento que el cliente YA tenia visto/negociado (lo siembra el runner). */
  pctPrevio?: number
  respuesta?: "si" | "no"
  respondidoAt?: string
  pctAplicado?: number
  linkUrl?: string
  aplicadoAt?: string
  /** Reintentos del vigía (26-ago). 99 = caso cerrado para el vigía. */
  vigiaIntentos?: number
  vigiaAviso?: boolean
}

/** Normaliza para matchear variantes humanas del texto pre-escrito del link
 * (27-ago, ola de correo): sin tildes, sin signos ni emojis, espacios
 * colapsados. Solo corre para contactos CON campaña sembrada, así que el
 * riesgo de falso positivo es bajo — igual se exige la frase completa. */
function normalizar(t: string): string {
  return t
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zñ0-9\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
}
function textoEsSi(t: string): boolean {
  if (t === "campana_dcto_si") return true
  const n = normalizar(t)
  return /^(hola\s+)?(si\s+)?(quiero|acepto)\s+(el|mi|ese|un)?\s*(10\s*)?(%\s*de\s*)?descuento$/.test(n) || n === "quiero el 10" || n === "si quiero"
}
function textoEsNo(t: string): boolean {
  if (t === "campana_dcto_no") return true
  const n = normalizar(t)
  return /^(hola\s+)?no\s+(quiero|me\s+interesa)\s*(el|mi|ese|un)?\s*descuento$/.test(n) || n === "no quiero" || n === "no me interesa"
}

async function registrarRespuesta(fono: string, st: EstadoCampana, respuesta: string): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return
  await fetch(`${SUPABASE_URL}/rest/v1/vic_campanas`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify([{
      contact: fono,
      campana: st.campana || "dcto10",
      evento: "respuesta",
      respuesta,
      quote_id: st.quoteId || null,
      pct_aplicado: st.pctAplicado ?? null,
    }]),
    cache: "no-store",
  }).catch(() => undefined)
}

/**
 * ENTREGA DE LA ACTUALIZACIÓN (Lalo 26-ago, "ideal que le llegue correo a
 * todos con su actualización en PDF" + "dejarle el PDF por WhatsApp"): tras
 * aplicar el descuento, el cliente recibe (a) el correo con el PDF adjunto
 * (send-reactivation-email con forzar) y (b) el PDF directo por WhatsApp.
 * Todo best-effort: si algo falla, el link del chat sigue siendo la entrega.
 */
async function entregarActualizacion(fono: string, quoteId: string, linkPdf?: string): Promise<void> {
  fetch(`${COTIZADOR}/api/quote-acceptance/send-reactivation-email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(VICKY_COTIZADORA_SECRET ? { "x-vicky-secret": VICKY_COTIZADORA_SECRET } : {}),
    },
    body: JSON.stringify({ quoteId, forzar: true }),
    cache: "no-store",
    signal: AbortSignal.timeout(30000),
  }).catch(() => undefined)
  if (linkPdf) {
    try {
      const { sendBotmakerMedia } = await import("./botmaker-push-v3")
      await sendBotmakerMedia(fono, linkPdf, { filename: "cotizacion_actualizada.pdf" })
    } catch {
      /* el link del chat basta */
    }
  }
}

async function leerQuote(quoteId: string): Promise<{ estado: string; dcto: number; canal: string } | null> {
  try {
    const { getZohoAccessToken } = await import("./zoho-token")
    const token = await getZohoAccessToken()
    const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
    const r = await fetch(
      `${api}/crm/v3/Cotizaciones_GeoVictoria/${quoteId}?fields=Estado_Cotizacion,Descuento_Recurrente_Pct,Intervenci_n_Humana`,
      { headers: { Authorization: `Zoho-oauthtoken ${token}` }, cache: "no-store" },
    )
    if (r.status !== 200) return null
    const d = ((await r.json().catch(() => ({}))) as {
      data?: Array<{ Estado_Cotizacion?: string; Descuento_Recurrente_Pct?: number; Intervenci_n_Humana?: string }>
    }).data?.[0]
    if (!d) return null
    return {
      estado: String(d.Estado_Cotizacion || ""),
      dcto: Number(d.Descuento_Recurrente_Pct || 0),
      canal: String(d.Intervenci_n_Humana || ""),
    }
  } catch {
    return null
  }
}

/**
 * Punto de entrada desde el webhook. Devuelve atendida=true cuando el mensaje
 * ES una respuesta de campaña y ya quedó resuelta (la respuesta al cliente va
 * en `respuesta`); atendida=false = no es de campaña, sigue el flujo normal.
 */
export async function procesarRespuestaCampana(
  contact: string,
  mensaje: string,
): Promise<{ atendida: boolean; respuesta?: string }> {
  // Los QUICK_REPLY de plantilla llegan como JSON {"button":"Quiero el
  // descuento",...} — se extrae el texto del botón antes de matchear.
  let crudo = String(mensaje || "").trim()
  if (crudo.startsWith("{")) {
    try {
      const j = JSON.parse(crudo) as { button?: unknown }
      if (j && typeof j.button === "string" && j.button.trim()) crudo = j.button.trim()
    } catch {
      /* no era JSON */
    }
  }
  const texto = crudo.toLowerCase()
  const si = textoEsSi(texto)
  const no = textoEsNo(texto)
  if (!si && !no) return { atendida: false }

  const fono = contact.replace(/\D/g, "")
  const raw = await getKvValue(claveCampana(fono)).catch(() => null)
  if (!raw) return { atendida: false }
  let st: EstadoCampana
  try {
    st = JSON.parse(raw) as EstadoCampana
  } catch {
    return { atendida: false }
  }

  const ahora = new Date().toISOString()

  if (no) {
    st.respuesta = "no"
    st.respondidoAt = ahora
    await setKvValue(claveCampana(fono), JSON.stringify(st)).catch(() => {})
    await registrarRespuesta(fono, st, "no")
    return {
      atendida: true,
      respuesta:
        "Perfecto, sin problema 😊 Tu cotización queda igual disponible por si más adelante te sirve. Cualquier cosa, aquí estoy.",
    }
  }

  // ── SÍ quiere el descuento ──

  // Idempotencia: ya aplicado → mismo link, sin re-sumar.
  if (st.pctAplicado && st.linkUrl) {
    return {
      atendida: true,
      respuesta: `Tu descuento ya quedó aplicado (${st.pctAplicado}% en el plan por los primeros 6 meses) 😊 Aquí lo revisas y pagas: ${st.linkUrl}`,
    }
  }

  st.respuesta = "si"
  st.respondidoAt = ahora

  // Segmento 1 (sin formal): el agente pide lo que falte y emite; el hook
  // post-emisión de agent-loop aplica el % exacto leyendo este kv.
  if (!st.quoteId) {
    await setKvValue(claveCampana(fono), JSON.stringify(st)).catch(() => {})
    await registrarRespuesta(fono, st, "si")
    return {
      atendida: true,
      respuesta:
        "¡Buenísima! 🎉 Para dejarte la cotización formal con tu descuento aplicado solo necesito el RUT de la empresa y tu correo. ¿Me los pasas?",
    }
  }

  const q = await leerQuote(st.quoteId)
  if (q && /pagada/i.test(q.estado)) {
    await setKvValue(claveCampana(fono), JSON.stringify(st)).catch(() => {})
    await registrarRespuesta(fono, st, "si_pagada")
    return {
      atendida: true,
      respuesta: "¡Veo que tu cotización ya quedó pagada! 🎉 Si necesitas cualquier cosa con la activación, me dices por aquí.",
    }
  }

  // Canal ejecutivo: jamás repreciar automático — el vendedor decide.
  if (q && /intervención humana/i.test(q.canal)) {
    await setKvValue(claveCampana(fono), JSON.stringify(st)).catch(() => {})
    await registrarRespuesta(fono, st, "si_ejecutivo")
    await avisarEquipoInterno(
      `💸 CAMPAÑA 10%: +${fono} ACEPTÓ el descuento adicional pero su cotización ${st.quoteId} es del canal EJECUTIVO (dcto actual ${q.dcto}%). Aplicarlo a mano desde el editor (${q.dcto}% → ${Math.min(q.dcto + 10, TOPE_CAMPANA)}%, vigencia 6 meses) y contactar al cliente.`,
    ).catch(() => {})
    return {
      atendida: true,
      respuesta:
        "¡Buenísima! 🎉 Le aviso a tu ejecutivo para dejarte el descuento aplicado en tu cotización y te confirmamos al tiro por aquí.",
    }
  }

  const actual = q ? q.dcto : 0
  const nuevo = Math.min(actual + 10, TOPE_CAMPANA)

  try {
    const r = await fetch(`${COTIZADOR}/api/quote-acceptance/descuento-ejecutivo`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(VICKY_COTIZADORA_SECRET ? { "x-vicky-secret": VICKY_COTIZADORA_SECRET } : {}),
      },
      body: JSON.stringify({ quoteId: st.quoteId, pct: nuevo, meses: 6, regenerarPdf: true }),
      cache: "no-store",
      signal: AbortSignal.timeout(45000),
    })
    const d = (await r.json().catch(() => ({}))) as {
      ok?: boolean
      pct_aplicado?: number
      acceptance_url?: string
      link_pdf?: string
    }
    if (!r.ok || !d.ok) throw new Error(`descuento-ejecutivo ${r.status}`)

    st.pctAplicado = Number(d.pct_aplicado ?? nuevo)
    st.linkUrl = d.acceptance_url || st.linkUrl
    st.aplicadoAt = new Date().toISOString()
    await setKvValue(claveCampana(fono), JSON.stringify(st)).catch(() => {})
    await registrarRespuesta(fono, st, "si_aplicado")
    await entregarActualizacion(fono, st.quoteId!, d.link_pdf).catch(() => {})
    return {
      atendida: true,
      respuesta:
        `¡Listo! 🎉 Quedó aplicado: tu plan con ${st.pctAplicado}% de descuento por los primeros 6 meses.` +
        (st.linkUrl ? `\n\nAquí lo revisas y pagas: ${st.linkUrl}` : "") +
        `\n\nTe dejé el PDF actualizado aquí mismo y también te lo enviamos a tu correo. Y apenas pagues, activamos tu cuenta por este mismo chat 😊`,
    }
  } catch (e) {
    // Jamás dejar al cliente sin respuesta: promesa honesta + rescate manual.
    console.error(`[campana-dcto] fallo aplicando a ${fono} quote=${st.quoteId}:`, e instanceof Error ? e.message : e)
    await setKvValue(claveCampana(fono), JSON.stringify(st)).catch(() => {})
    await registrarRespuesta(fono, st, "si_error")
    await avisarEquipoInterno(
      `⚠️ CAMPAÑA 10%: +${fono} aceptó el descuento pero la aplicación FALLÓ (quote ${st.quoteId}, ${actual}% → ${nuevo}%). Aplicar a mano vía descuento-ejecutivo y mandarle el link.`,
    ).catch(() => {})
    return {
      atendida: true,
      respuesta:
        "¡Buenísima! 🎉 Estoy dejando tu descuento aplicado, te confirmo por aquí con el link en unos minutos.",
    }
  }
}

/**
 * HOOK POST-EMISIÓN (segmento 1): tras generar la formal por el flujo normal,
 * si el contacto tiene campaña aceptada sin aplicar, se aplica el % exacto a
 * la cotización recién emitida. Lo llama agent-loop, best-effort.
 */
export async function aplicarCampanaAQuoteNueva(contact: string, quoteId: string): Promise<void> {
  const fono = contact.replace(/\D/g, "")
  try {
    const raw = await getKvValue(claveCampana(fono))
    if (!raw) return
    const st = JSON.parse(raw) as EstadoCampana
    if (st.respuesta !== "si" || st.pctAplicado || !quoteId) return
    const q = await leerQuote(quoteId)
    // La promesa de la campaña es +10 puntos SOBRE LO QUE TENÍA AL ACEPTARLA
    // (pctPrevio) — jamás sobre un descuento negociado DESPUÉS en el chat
    // (31-ago, caso Rodrigo: negoció 20% y este hook lo subió a 30%). Si la
    // emisión ya salió con un descuento igual o mejor, la promesa está
    // cumplida y no se toca nada.
    const nuevo = Math.min(Number(st.pctPrevio || 0) + 10, TOPE_CAMPANA)
    if (q && q.dcto >= nuevo) {
      st.quoteId = quoteId
      st.pctAplicado = q.dcto
      st.aplicadoAt = new Date().toISOString()
      await setKvValue(claveCampana(fono), JSON.stringify(st)).catch(() => {})
      console.log(`[campana-dcto] ${fono}: la formal ${quoteId} ya trae ${q.dcto}% (promesa ${nuevo}%) — sin cambios.`)
      return
    }
    const r = await fetch(`${COTIZADOR}/api/quote-acceptance/descuento-ejecutivo`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(VICKY_COTIZADORA_SECRET ? { "x-vicky-secret": VICKY_COTIZADORA_SECRET } : {}),
      },
      body: JSON.stringify({ quoteId, pct: nuevo, meses: 6, regenerarPdf: true }),
      cache: "no-store",
      signal: AbortSignal.timeout(45000),
    })
    const d = (await r.json().catch(() => ({}))) as { ok?: boolean; pct_aplicado?: number; acceptance_url?: string }
    if (!r.ok || !d.ok) throw new Error(`descuento-ejecutivo ${r.status}`)
    st.quoteId = quoteId
    st.pctAplicado = Number(d.pct_aplicado ?? nuevo)
    st.linkUrl = d.acceptance_url || st.linkUrl
    st.aplicadoAt = new Date().toISOString()
    await setKvValue(claveCampana(fono), JSON.stringify(st)).catch(() => {})
    await registrarRespuesta(fono, st, "si_aplicado_emision")
    await entregarActualizacion(fono, quoteId, (d as { link_pdf?: string }).link_pdf).catch(() => {})
    console.log(`[campana-dcto] aplicado ${st.pctAplicado}% a quote nueva ${quoteId} de ${fono}`)
  } catch (e) {
    console.error(`[campana-dcto] hook emision fallo ${fono}/${quoteId}:`, e instanceof Error ? e.message : e)
    await avisarEquipoInterno(
      `⚠️ CAMPAÑA 10%: la formal ${quoteId} de +${fono} se emitió pero el descuento de campaña NO quedó aplicado — aplicar a mano.`,
    ).catch(() => {})
  }
}

/**
 * VIGÍA DE DESCUENTOS DE CAMPAÑA (orden de Lalo 26-ago: "un agente vigía que
 * vaya corrigiendo los errores de vicky al aplicar descuentos"). Corre en el
 * latido de 2 min: busca aceptaciones (respuesta "si") que quedaron SIN
 * descuento aplicado y las repara solo:
 *
 *   - Con quoteId y sin pctAplicado → reintenta la aplicación (máx 5 veces;
 *     al 3er fallo avisa al equipo una sola vez). Al lograrlo manda al
 *     cliente el link con el descuento — la promesa "te confirmo por aquí"
 *     del fallback se cumple sola.
 *   - Sin quoteId (segmento 1) pero con formal emitida DESPUÉS de aceptar
 *     (el hook post-emisión falló) → adopta la cotización del puntero y
 *     aplica.
 *   - Cotización pagada o del canal ejecutivo → cierra el caso (99): ahí no
 *     hay nada que automatizar de más.
 */
export async function reintentarDescuentosCampana(): Promise<{ candidatos: number; aplicados: number }> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return { candidatos: 0, aplicados: 0 }
  const cab = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/vic_kv?key=like.campana_dcto_*&select=key,value&limit=300`,
    { headers: cab, cache: "no-store" },
  ).catch(() => null)
  if (!r || !r.ok) return { candidatos: 0, aplicados: 0 }
  const filas = ((await r.json().catch(() => [])) as Array<{ key: string; value: string }>) || []

  let candidatos = 0
  let aplicados = 0
  const ahora = Date.now()

  for (const fila of filas) {
    let st: EstadoCampana
    try {
      st = JSON.parse(fila.value) as EstadoCampana
    } catch {
      continue
    }
    const fono = fila.key.replace("campana_dcto_", "")
    if (st.respuesta !== "si" || st.pctAplicado) continue
    if ((st.vigiaIntentos || 0) >= 5) continue
    const desde = Date.parse(st.respondidoAt || "") || 0
    if (!desde || ahora - desde < 3 * 60_000) continue

    // Segmento 1 sin cotización: solo actuar si nació una formal DESPUÉS de
    // la aceptación (hook post-emisión caído); si no, el agente sigue
    // conversando y no hay nada que reparar.
    if (!st.quoteId) {
      const rp = await fetch(
        `${SUPABASE_URL}/rest/v1/vic_v3_quote_pointers?contact=eq.${fono}&select=quote_id,updated_at&limit=1`,
        { headers: cab, cache: "no-store" },
      ).catch(() => null)
      const p = rp && rp.ok ? (((await rp.json().catch(() => [])) as Array<{ quote_id?: string; updated_at?: string }>)[0] ?? null) : null
      const emitidaAt = Date.parse(p?.updated_at || "") || 0
      if (!p?.quote_id || emitidaAt <= desde) continue
      st.quoteId = p.quote_id
    }

    candidatos++
    st.vigiaIntentos = (st.vigiaIntentos || 0) + 1
    await setKvValue(fila.key, JSON.stringify(st)).catch(() => {})

    try {
      const q = await leerQuote(st.quoteId!)
      if (q && /pagada/i.test(q.estado)) {
        st.vigiaIntentos = 99
        await setKvValue(fila.key, JSON.stringify(st)).catch(() => {})
        continue
      }
      if (q && /intervención humana/i.test(q.canal)) {
        st.vigiaIntentos = 99
        await setKvValue(fila.key, JSON.stringify(st)).catch(() => {})
        continue
      }
      // La promesa de la campaña es +10 puntos SOBRE LO QUE TENÍA AL ACEPTARLA
      // (pctPrevio) — jamás sobre un descuento negociado DESPUÉS en el chat.
      // Caso Rodrigo 31-ago: negoció 20% por WhatsApp y el vigía, sumando
      // sobre el dcto vigente, lo subió a 30%. Si la cotización ya tiene un
      // descuento igual o mejor que la promesa, no hay nada que reparar.
      const nuevo = Math.min(Number(st.pctPrevio || 0) + 10, TOPE_CAMPANA)
      if (q && q.dcto >= nuevo) {
        st.pctAplicado = q.dcto
        st.aplicadoAt = new Date().toISOString()
        await setKvValue(fila.key, JSON.stringify(st)).catch(() => {})
        console.log(`[campana-vigia] ${fono}: dcto vigente ${q.dcto}% ya cubre la promesa (${nuevo}%) — sin reparación.`)
        continue
      }
      const ra = await fetch(`${COTIZADOR}/api/quote-acceptance/descuento-ejecutivo`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(VICKY_COTIZADORA_SECRET ? { "x-vicky-secret": VICKY_COTIZADORA_SECRET } : {}),
        },
        body: JSON.stringify({ quoteId: st.quoteId, pct: nuevo, meses: 6, regenerarPdf: true }),
        cache: "no-store",
        signal: AbortSignal.timeout(45000),
      })
      const d = (await ra.json().catch(() => ({}))) as { ok?: boolean; pct_aplicado?: number; acceptance_url?: string }
      if (!ra.ok || !d.ok) throw new Error(`descuento-ejecutivo ${ra.status}`)

      st.pctAplicado = Number(d.pct_aplicado ?? nuevo)
      st.linkUrl = d.acceptance_url || st.linkUrl
      st.aplicadoAt = new Date().toISOString()
      await setKvValue(fila.key, JSON.stringify(st)).catch(() => {})
      await registrarRespuesta(fono, st, "si_aplicado_vigia")
      await entregarActualizacion(fono, st.quoteId!, (d as { link_pdf?: string }).link_pdf).catch(() => {})
      const msg =
        `¡Listo! 🎉 Quedó aplicado: tu plan con ${st.pctAplicado}% de descuento por los primeros 6 meses.` +
        (st.linkUrl ? `\n\nAquí lo revisas y pagas: ${st.linkUrl}` : "") +
        `\n\nTe dejé el PDF actualizado aquí mismo y también te lo enviamos a tu correo. Y apenas pagues, activamos tu cuenta por este mismo chat 😊`
      const { sendBotmakerMessage } = await import("./botmaker-push-v3")
      const { appendTurnV3 } = await import("./supabase-persistence-v3")
      await sendBotmakerMessage(fono, msg).catch(() => {})
      await appendTurnV3(fono, "(vigía campaña: descuento reparado)", msg, "cl").catch(() => {})
      aplicados++
      console.log(`[campana-vigia] reparado ${fono} quote=${st.quoteId} → ${st.pctAplicado}%`)
    } catch (e) {
      console.error(`[campana-vigia] reintento fallo ${fono}/${st.quoteId}:`, e instanceof Error ? e.message : e)
      if ((st.vigiaIntentos || 0) >= 3 && !st.vigiaAviso) {
        st.vigiaAviso = true
        await setKvValue(fila.key, JSON.stringify(st)).catch(() => {})
        await avisarEquipoInterno(
          `⚠️ CAMPAÑA 10%: el vigía lleva ${st.vigiaIntentos} intentos sin poder aplicar el descuento de +${fono} (quote ${st.quoteId}). Revisar descuento-ejecutivo / aplicar a mano.`,
        ).catch(() => {})
      }
    }
  }
  return { candidatos, aplicados }
}

/**
 * TOPE DE LA ESCALERA PARA EL TOQUE 4 DEL CICLO (Lalo 13-sep, "crea la
 * plantilla nueva del 20%").
 *
 * El toque 4 es el último recordatorio y ofrece el TOPE que Vicky maneja de
 * cara al cliente: 20 % en el plan por 6 meses. A diferencia del toque 3 (que
 * es la plantilla con quick reply y aplica +10 al TAP), acá la plantilla manda
 * el link de la cotización — así que el descuento tiene que estar APLICADO
 * ANTES de enviarla: si no, el cliente abre el link y ve el precio viejo, y la
 * promesa de la plantilla es falsa.
 *
 * Se niega (y el runner cae a la plantilla sin %) cuando: no hay cotización,
 * la cotización ya está pagada o aceptada, es del canal EJECUTIVO (jamás
 * repreciar la cotización de un vendedor por automático) o la aplicación
 * falla. Si ya trae 20 % o más, la promesa está cumplida sin escribir nada.
 */
export async function aplicarTopeParaToque4(
  quoteId: string | null | undefined,
): Promise<{ ok: boolean; pct: number; linkUrl?: string; motivo: string }> {
  if (!quoteId) return { ok: false, pct: 0, motivo: "sin_cotizacion" }
  const q = await leerQuote(quoteId)
  if (!q) return { ok: false, pct: 0, motivo: "cotizacion_ilegible" }
  if (/pagada|aceptada/i.test(q.estado)) return { ok: false, pct: q.dcto, motivo: `estado_${q.estado}` }
  if (/intervención humana/i.test(q.canal)) return { ok: false, pct: q.dcto, motivo: "canal_ejecutivo" }
  if (q.dcto >= TOPE_ESCALERA_CLIENTE) return { ok: true, pct: q.dcto, motivo: "ya_tenia_el_tope" }
  try {
    const r = await fetch(`${COTIZADOR}/api/quote-acceptance/descuento-ejecutivo`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(VICKY_COTIZADORA_SECRET ? { "x-vicky-secret": VICKY_COTIZADORA_SECRET } : {}),
      },
      body: JSON.stringify({ quoteId, pct: TOPE_ESCALERA_CLIENTE, meses: 6, regenerarPdf: true }),
      cache: "no-store",
      signal: AbortSignal.timeout(45000),
    })
    const d = (await r.json().catch(() => ({}))) as { ok?: boolean; pct_aplicado?: number; acceptance_url?: string }
    if (!r.ok || !d.ok) throw new Error(`descuento-ejecutivo ${r.status}`)
    return {
      ok: true,
      pct: Number(d.pct_aplicado ?? TOPE_ESCALERA_CLIENTE),
      linkUrl: d.acceptance_url || undefined,
      motivo: "aplicado",
    }
  } catch (e) {
    console.error(`[campana-t4] fallo aplicando ${TOPE_ESCALERA_CLIENTE}% a ${quoteId}:`, e instanceof Error ? e.message : e)
    return { ok: false, pct: q.dcto, motivo: "aplicacion_fallo" }
  }
}

/**
 * Descuento REAL vigente en la cotización (lectura, sin escribir nada). Lo usa
 * el correo del toque 4: solo puede nombrar el 20 % si está aplicado de verdad
 * —si `aplicarTopeParaToque4` se negó, el link muestra el precio de lista y
 * prometerlo sería mentir—. Devuelve null si la cotización no se puede leer.
 */
export async function descuentoDeCotizacion(
  quoteId: string | null | undefined,
): Promise<{ pct: number; estado: string; canal: string } | null> {
  if (!quoteId) return null
  const q = await leerQuote(quoteId)
  return q ? { pct: q.dcto, estado: q.estado, canal: q.canal } : null
}
