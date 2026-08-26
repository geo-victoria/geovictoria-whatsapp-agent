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
}

function textoEsSi(t: string): boolean {
  return t === "campana_dcto_si" || t === "quiero el descuento"
}
function textoEsNo(t: string): boolean {
  return t === "campana_dcto_no" || t === "no quiero el descuento"
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
    }
    if (!r.ok || !d.ok) throw new Error(`descuento-ejecutivo ${r.status}`)

    st.pctAplicado = Number(d.pct_aplicado ?? nuevo)
    st.linkUrl = d.acceptance_url || st.linkUrl
    st.aplicadoAt = new Date().toISOString()
    await setKvValue(claveCampana(fono), JSON.stringify(st)).catch(() => {})
    await registrarRespuesta(fono, st, "si_aplicado")
    return {
      atendida: true,
      respuesta:
        `¡Listo! 🎉 Quedó aplicado: tu plan con ${st.pctAplicado}% de descuento por los primeros 6 meses.` +
        (st.linkUrl ? `\n\nAquí lo revisas y pagas: ${st.linkUrl}` : "") +
        `\n\nY apenas pagues, activamos tu cuenta por este mismo chat 😊`,
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
    // La emision nueva puede salir con 0% aunque el cliente YA tuviera un
    // escalon negociado en el preform: manda el mayor entre lo comiteado en
    // la quote y lo sembrado por el runner (pctPrevio), mas los 10 de campana.
    const base = Math.max(q ? q.dcto : 0, Number(st.pctPrevio || 0))
    const nuevo = Math.min(base + 10, TOPE_CAMPANA)
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
    console.log(`[campana-dcto] aplicado ${st.pctAplicado}% a quote nueva ${quoteId} de ${fono}`)
  } catch (e) {
    console.error(`[campana-dcto] hook emision fallo ${fono}/${quoteId}:`, e instanceof Error ? e.message : e)
    await avisarEquipoInterno(
      `⚠️ CAMPAÑA 10%: la formal ${quoteId} de +${fono} se emitió pero el descuento de campaña NO quedó aplicado — aplicar a mano.`,
    ).catch(() => {})
  }
}
