/**
 * AUDITORÍA — ¿marcamos bien a quien NO debíamos contactar proactivamente?
 * (pregunta de Lalo 11-sep, antes de encender la campaña del ciclo de 4 toques).
 *
 * SOLO LECTURA. Por cada conversación busca la SEÑAL de "acá no se toca más"
 * que dejó el CLIENTE, la compara con la MARCA que dejó el sistema y con lo que
 * salió DESPUÉS:
 *
 *   señal   = rechazo en contexto · autorespuesta · casuística no-prospecto
 *             (cliente/soporte/trabajador/empleo/spam) · opt-out explícito
 *   marca   = vic_loop cerrado con motivo · followup_closed_reason de la
 *             conversación · kv voz_no_llamar_ / voz_excluir_ / casuistica_aplicada_
 *   después = mensajes de Vicky PROACTIVOS posteriores a la señal (assistant sin
 *             mensaje del cliente entremedio) y marcadores de campaña
 *
 * Tres veredictos, y el que importa es el tercero:
 *   · `ok`           señal marcada y nada salió después
 *   · `sin_marca`    el cliente dio la señal y el sistema no la anotó (riesgo
 *                    vivo: si algo reabre el loop, le escribimos)
 *   · `tocado_igual` se le escribió DESPUÉS de la señal (falla consumada)
 *
 * GET auth cron: ?dias=90 &max=300 &offset=0 &pais=cl &detalle=1
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"
import { posturaRechazoCliente, esAutorespuesta, ultimoMensajeCliente } from "@/lib/rechazo-cliente"
import { clasificarCasuistica } from "@/lib/casuistica-contacto"
import { testContactSet } from "@/lib/funnel-analysis"
import { FIRMAS_PRECIO } from "@/lib/precio-rut"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const CRON_SECRET = (process.env.CRON_SECRET || "").trim()

/** Motivos de cierre del loop que SÍ significan "no se toca más". */
const MOTIVOS_BUENOS = new Set([
  "opt_out", "no_interesa", "no_prospecto", "cliente_existente", "soporte",
  "perdido", "derivado", "autorespuesta",
])

async function autorizado(req: Request): Promise<boolean> {
  const url = new URL(req.url)
  const dado =
    (req.headers.get("x-cron-secret") || "").trim() ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim() ||
    (url.searchParams.get("key") || "").trim()
  if (!dado) return false
  if (CRON_SECRET && dado === CRON_SECRET) return true
  const kv = await getFollowupCronSecret().catch(() => "")
  return Boolean(kv) && dado === kv
}

async function sb<T>(ruta: string): Promise<T[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${ruta}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    cache: "no-store",
  })
  if (!r.ok) throw new Error(`supabase ${r.status} en ${ruta.split("?")[0]}`)
  return ((await r.json().catch(() => [])) as T[]) || []
}

type Conv = {
  id: string
  contact: string
  last_user_at: string | null
  followup_closed_reason: string | null
  followup_status: string | null
}
type Msg = { at: string; role: string; content: string }

/**
 * MODO INVERSO (?soporte=1) — el OTRO error del mismo clasificador.
 *
 * La auditoría de arriba mide el falso NEGATIVO: no marcamos a quien no
 * debíamos tocar. Este modo mide el falso POSITIVO: le dimos la tarjeta de
 * SOPORTE (redirección al agente de Foundry) a alguien que era PROSPECTO —
 * o sea, le apagamos la venta. Señal observable = el mensaje de Vicky con la
 * tarjeta oficial (+56 9 4401 3873 / 600 914 3819), que es el momento exacto
 * de la redirección y queda en el chat.
 *
 * Veredictos:
 *   · `cliente_real`      la casuística dice no-prospecto y no pidió precio → correcto
 *   · `intencion_despues` DESPUÉS de la tarjeta el cliente pidió precio/cotizar
 *   · `ampliacion`        casuística cliente_ampliacion = VENTA mandada a soporte
 *   · `prospecto_puro`    el clasificador lo ve prospecto y nunca vio precio
 *   · `ya_cotizado`       vio precio ANTES de la tarjeta (legítimo: cotizó y luego pidió ayuda)
 */
const PIDE_PRECIO =
  /(cu[aá]nto (cuesta|vale|sale)|precio|cotiza|cotizaci[oó]n|valor(es)?\b|presupuesto|planes?\b|tarifa)/i

async function modoSoporte(sp: URLSearchParams, t0: number): Promise<Response> {
  const dias = Math.min(Math.max(Number(sp.get("dias")) || 90, 1), 400)
  const max = Math.min(Math.max(Number(sp.get("max")) || 200, 1), 500)
  const offset = Math.max(Number(sp.get("offset")) || 0, 0)
  const desde = new Date(Date.now() - dias * 86_400_000).toISOString()
  const internos = testContactSet()

  // CICATRIZ PostgREST: el `or=` va con encodeURIComponent y NADA más.
  const or = encodeURIComponent("(content.ilike.*4401 3873*,content.ilike.*600 914 3819*)")
  const tarjetas = await sb<{ conversation_id: string; at: string }>(
    `vic_v3_messages?role=eq.assistant&at=gte.${desde}&or=${or}` +
      `&select=conversation_id,at&order=at.asc&limit=2000`,
  )
  const primeraTarjeta = new Map<string, string>()
  for (const m of tarjetas) if (!primeraTarjeta.has(m.conversation_id)) primeraTarjeta.set(m.conversation_id, m.at)

  const ids = [...primeraTarjeta.keys()].slice(offset, offset + max)
  const convs: Conv[] = []
  for (let i = 0; i < ids.length; i += 60) {
    const lote = await sb<Conv>(
      `vic_v3_conversations?id=in.(${ids.slice(i, i + 60).join(",")})&country=eq.cl` +
        `&select=id,contact,last_user_at,followup_closed_reason,followup_status`,
    ).catch(() => [] as Conv[])
    convs.push(...lote)
  }
  const vivos = convs.filter(
    (c) => !internos.has(String(c.contact || "")) && /^56\d{8,11}$/.test(String(c.contact || "")),
  )

  const filas: Array<Record<string, unknown>> = []
  const resumen = {
    conTarjeta: primeraTarjeta.size, revisadas: 0, cliente_real: 0, ya_cotizado: 0,
    intencion_despues: 0, ampliacion: 0, prospecto_puro: 0, truncado: false,
  }
  const porTipo: Record<string, number> = {}

  for (const c of vivos) {
    if (Date.now() - t0 > 235_000) { resumen.truncado = true; break }
    resumen.revisadas++
    let msgs: Msg[] = []
    try {
      msgs = await sb<Msg>(
        `vic_v3_messages?conversation_id=eq.${c.id}&select=at,role,content&order=at.asc&limit=80`,
      )
    } catch { continue }
    const tarjetaAt = Date.parse(primeraTarjeta.get(c.id) || "") || 0
    const delCliente = msgs
      .filter((m) => m.role === "user")
      .map((m) => String(m.content || ""))
      .filter((t) => !t.startsWith("[REGISTRO INTERNO"))
    const cas = clasificarCasuistica(delCliente)
    porTipo[cas.tipo] = (porTipo[cas.tipo] || 0) + 1

    const tienePrecio = (t: string) => FIRMAS_PRECIO.some((f) => t.includes(f))
    const precioAntes = msgs.some(
      (m) => m.role === "assistant" && Date.parse(m.at) < tarjetaAt && tienePrecio(String(m.content || "")),
    )
    const precioDespues = msgs.some(
      (m) => m.role === "assistant" && Date.parse(m.at) > tarjetaAt && tienePrecio(String(m.content || "")),
    )
    const pedidos = msgs.filter(
      (m) =>
        m.role === "user" &&
        Date.parse(m.at) > tarjetaAt &&
        !String(m.content || "").startsWith("[REGISTRO INTERNO") &&
        PIDE_PRECIO.test(String(m.content || "")),
    )

    let veredicto: keyof typeof resumen
    if (precioAntes) veredicto = "ya_cotizado"
    else if (pedidos.length) veredicto = "intencion_despues"
    else if (cas.tipo === "cliente_ampliacion") veredicto = "ampliacion"
    else if (cas.esProspecto) veredicto = "prospecto_puro"
    else veredicto = "cliente_real"
    resumen[veredicto] = (resumen[veredicto] as number) + 1

    if (veredicto !== "cliente_real" || sp.get("detalle") === "1") {
      filas.push({
        contact: c.contact,
        veredicto,
        casuistica: `${cas.tipo}${cas.esProspecto ? " (prospecto)" : ""}`,
        evidencia: cas.evidencia.slice(0, 3),
        tarjetaAt: (primeraTarjeta.get(c.id) || "").slice(0, 16),
        precioAntes, precioDespues,
        convCerrada: c.followup_closed_reason || null,
        pidioDespues: pedidos[0]
          ? `${pedidos[0].at.slice(0, 16)} · ${String(pedidos[0].content || "").replace(/\s+/g, " ").slice(0, 120)}`
          : null,
      })
    }
  }

  const dudosos = resumen.intencion_despues + resumen.ampliacion + resumen.prospecto_puro
  return NextResponse.json({
    ok: true,
    modo: "soporte_falsos_positivos",
    nota: "solo lectura · tarjeta de soporte (Foundry) entregada en el chat · ¿era cliente o era prospecto?",
    dias, offset, max, ms: Date.now() - t0,
    resumen, porTipo, dudosos,
    tasaAciertoSoporte: resumen.revisadas
      ? `${Math.round(((resumen.cliente_real + resumen.ya_cotizado) * 100) / resumen.revisadas)}%`
      : "—",
    filas: filas.slice(0, 120),
  })
}

/**
 * MODO POSTVENTA (?postventa=1) — la otra mitad de la misma confusión de fase.
 *
 * El caso que nombró Lalo: "se le escapan mensajes de 'déjame dejarte el mejor
 * precio posible' a un cliente que YA PAGÓ". Universo = contactos con marca de
 * pago (`pago_online_` / `comprobante_ok_`, las dos llevan {at}); se leen los
 * mensajes de Vicky POSTERIORES a ese instante y se busca lenguaje COMERCIAL.
 * No mira relojes ni gates: mira lo que el cliente LEYÓ.
 */
const COMERCIAL_POST_PAGO =
  /(mejor precio|precio especial|descuento|te cotizo|cotizaci[oó]n actualizada|sigues? interesad|te interesa avanzar|oferta|promoci[oó]n|rebaja|\bdcto\b)/i

async function modoPostventa(sp: URLSearchParams, t0: number): Promise<Response> {
  const dias = Math.min(Math.max(Number(sp.get("dias")) || 90, 1), 400)
  const max = Math.min(Math.max(Number(sp.get("max")) || 200, 1), 500)
  const desde = new Date(Date.now() - dias * 86_400_000).toISOString()
  const internos = testContactSet()

  // Dos consultas simples: el `or=` con dos LIKE comodín devolvía 500.
  // REGLA: no tragar el fallo de la consulta — un catch mudo devolvía 0 pagos
  // y el informe habría dicho "no hay nada que revisar".
  const fallas: string[] = []
  const leer = async (prefijo: string) => {
    try {
      return await sb<{ key: string; value: string }>(
        `vic_kv?key=like.${prefijo}*&select=key,value&limit=2000`,
      )
    } catch (e) {
      fallas.push(`${prefijo}: ${e instanceof Error ? e.message : String(e)}`)
      return [] as Array<{ key: string; value: string }>
    }
  }
  const [pagosMp, pagosTransf] = await Promise.all([leer("pago_online_"), leer("comprobante_ok_")])
  const pagos = [...pagosMp, ...pagosTransf]
  // El pago se fecha con el {at} del JSON; sin él no se puede ubicar y se omite.
  const pagoAt = new Map<string, string>()
  for (const k of pagos) {
    const tel = (String(k.key).match(/(\d{8,15})$/) || [])[1] || ""
    if (!tel || internos.has(tel) || !/^56\d{8,11}$/.test(tel)) continue
    let at = ""
    try { at = String((JSON.parse(String(k.value || "{}")) as { at?: string }).at || "") } catch { /* texto plano */ }
    // sin {at} legible no se puede fechar el pago: se omite
    if (!at || at < desde) continue
    const previo = pagoAt.get(tel)
    if (!previo || at < previo) pagoAt.set(tel, at) // el PRIMER pago: todo lo posterior ya es postventa
  }

  const tels = [...pagoAt.keys()].slice(0, max)
  const filas: Array<Record<string, unknown>> = []
  const resumen = { conPago: pagoAt.size, revisadas: 0, limpios: 0, con_mensaje_comercial: 0, truncado: false }
  const porTipo: Record<string, number> = {}

  for (let i = 0; i < tels.length; i += 60) {
    if (Date.now() - t0 > 230_000) { resumen.truncado = true; break }
    const lote = tels.slice(i, i + 60)
    const convs = await sb<{ id: string; contact: string }>(
      `vic_v3_conversations?contact=in.(${lote.join(",")})&select=id,contact`,
    ).catch(() => [] as Array<{ id: string; contact: string }>)
    for (const c of convs) {
      if (Date.now() - t0 > 235_000) { resumen.truncado = true; break }
      const at = pagoAt.get(String(c.contact)) || ""
      if (!at) continue
      resumen.revisadas++
      let msgs: Msg[] = []
      try {
        msgs = await sb<Msg>(
          `vic_v3_messages?conversation_id=eq.${c.id}&role=eq.assistant&at=gt.${at}` +
            `&select=at,role,content&order=at.asc&limit=40`,
        )
      } catch { continue }
      const malos = msgs.filter((m) => {
        const txt = String(m.content || "")
        if (txt.startsWith("[REGISTRO INTERNO")) return /campa/i.test(txt)
        return COMERCIAL_POST_PAGO.test(txt) || FIRMAS_PRECIO.some((f) => txt.includes(f))
      })
      if (!malos.length) { resumen.limpios++; continue }
      resumen.con_mensaje_comercial++
      for (const m of malos) {
        const t = String(m.content || "")
        const tipo = /campa/i.test(t) && t.startsWith("[REGISTRO INTERNO")
          ? "campana"
          : /descuento|dcto|mejor precio|precio especial|rebaja/i.test(t)
            ? "descuento"
            : FIRMAS_PRECIO.some((f) => t.includes(f))
              ? "bloque_precio"
              : "reenganche"
        porTipo[tipo] = (porTipo[tipo] || 0) + 1
      }
      filas.push({
        contact: c.contact,
        pagoAt: at.slice(0, 16),
        mensajes: malos.length,
        horasDespues: Math.round((Date.parse(malos[0].at) - Date.parse(at)) / 3_600_000),
        ejemplo: `${malos[0].at.slice(0, 16)} · ${String(malos[0].content || "").replace(/\s+/g, " ").slice(0, 150)}`,
      })
    }
  }

  return NextResponse.json({
    ok: true,
    modo: "postventa_mensajes_comerciales",
    nota: "solo lectura · mensajes de Vicky POSTERIORES a la marca de pago con lenguaje comercial",
    dias, max, ms: Date.now() - t0,
    resumen, porTipo, fallas,
    tasaLimpia: resumen.revisadas ? `${Math.round((resumen.limpios * 100) / resumen.revisadas)}%` : "—",
    filas: filas.slice(0, 120),
  })
}

/**
 * MODO LOOPS (?loops=1) — qué pasaría HOY con las guardas nuevas del cron de
 * toques, ANTES de que salga un solo mensaje. Recorre los loops VIVOS y los
 * clasifica con el mismo clasificador que ahora corre en vic-loop-cron:
 * `caeria` = la guarda lo va a cerrar en vez de tocarlo (eso es lo que
 * queremos) · `sigue` = recibe sus toques como siempre.
 */
async function modoLoops(sp: URLSearchParams, t0: number): Promise<Response> {
  const max = Math.min(Math.max(Number(sp.get("max")) || 300, 1), 1000)
  const loops = await sb<{ contact: string; estado: string; stage: string | null; touch_count: number | null }>(
    `vic_loop?estado=in.(activo,pausado_compromiso)&select=contact,estado,stage,touch_count&limit=${max}`,
  )
  const internos = testContactSet()
  const vivos = loops.filter((l) => !internos.has(String(l.contact || "")) && /^\d{8,15}$/.test(String(l.contact || "")))
  const resumen = { loopsVivos: loops.length, revisados: 0, caeria: 0, sigue: 0, truncado: false }
  const porTipo: Record<string, number> = {}
  const filas: Array<Record<string, unknown>> = []

  for (const l of vivos) {
    if (Date.now() - t0 > 235_000) { resumen.truncado = true; break }
    resumen.revisados++
    let msgs: Msg[] = []
    let conv: Array<{ id: string }> = []
    try {
      conv = await sb<{ id: string }>(`vic_v3_conversations?contact=eq.${l.contact}&select=id&limit=1`)
    } catch { continue }
    if (!conv[0]) continue
    try {
      msgs = await sb<Msg>(
        `vic_v3_messages?conversation_id=eq.${conv[0].id}&select=at,role,content&order=at.desc&limit=40`,
      )
    } catch { continue }
    msgs.reverse()
    const delCliente = msgs
      .filter((m) => m.role === "user")
      .map((m) => String(m.content || ""))
      .filter((t) => !t.startsWith("[REGISTRO INTERNO"))
    const cas = clasificarCasuistica(delCliente)
    if (cas.esProspecto) { resumen.sigue++; continue }
    resumen.caeria++
    porTipo[cas.tipo] = (porTipo[cas.tipo] || 0) + 1
    filas.push({
      contact: l.contact,
      estado: l.estado,
      stage: l.stage || "-",
      toques: l.touch_count ?? 0,
      casuistica: cas.tipo,
      evidencia: cas.evidencia.slice(0, 3),
      ultimoDelCliente: String(delCliente[delCliente.length - 1] || "").replace(/\s+/g, " ").slice(0, 100),
    })
  }

  return NextResponse.json({
    ok: true,
    modo: "loops_guarda_nueva",
    nota: "solo lectura · caeria = la guarda de casuistica lo cierra en vez de tocarlo",
    ms: Date.now() - t0,
    resumen, porTipo,
    filas: filas.slice(0, 120),
  })
}

/**
 * MODO INSISTENCIA (?insistencia=1) — el tercer eje (pedido de Lalo 11-sep:
 * "casos donde Vicky sonó demasiado insistente… el cliente pidió recontactar
 * en fecha específica o se entendía que necesitaba más tiempo y le volvió a
 * hablar a los 10 minutos preguntando por el pago"; y los reclamos de "muy
 * insistente" o "los voy a bloquear").
 *
 * Dos señales BLANDAS del cliente (no son el "no gracias" duro que ya cubre
 * `posturaRechazoCliente`):
 *   · QUEJA     — "muy insistente", "dejen de escribirme", "los bloqueo", "spam"
 *   · ESPERA    — "lo estamos evaluando", "está en revisión", "te confirmo",
 *                 "lo veo con mi jefe" + las fechas que entiende
 *                 `clasificarSenalEspera` ("el 15 de septiembre", "en octubre")
 *
 * Y mide lo que Vicky hizo DESPUÉS: cuántos mensajes proactivos, a los cuántos
 * minutos el primero, y si alguno hablaba de PAGO. Veredictos:
 *   · `queja`              el cliente se quejó de la insistencia (lo peor)
 *   · `atropello_fecha`    pidió fecha concreta y se le escribió ANTES
 *   · `toque_10min`        pidió tiempo y el primer toque salió a ≤60 min
 *   · `insistente`         3 o más toques proactivos tras el pedido de tiempo
 *   · `respetado`          nada, o el toque llegó después de la fecha pedida
 */
const QUEJA_INSISTENCIA =
  /(muy insistente|son insistentes|demasiado insistente|deja(r|n)? de (escribir|molestar|insistir)|no me escrib|no escriban|dejen de|los? voy a bloquear|te voy a bloquear|bloquear este numero|es spam|esto es spam|parece spam|ya te dije|ya les dije|cuantas veces|acoso|me estan acosando|basta)/i
const PIDE_TIEMPO =
  /(en revision|lo estamos? (revisando|evaluando|viendo|analizando)|estamos evaluando|necesito (mas )?tiempo|dame (unos )?dias|denme (unos )?dias|te confirmo|les confirmo|lo veo con (mi|el|la) (jefe|jefa|socio|gerente|contador|directorio|equipo)|lo tengo que ver con|estoy de vacaciones|mas adelante|despues te|la proxima semana|el proximo mes)/i
const HABLA_DE_PAGO =
  /(link de pago|pagar|pago|paga (acá|aca|aquí|aqui)|transferencia|abonar|completar el pago|quedó pendiente el pago|puedes pagar)/i

async function modoInsistencia(sp: URLSearchParams, t0: number): Promise<Response> {
  const dias = Math.min(Math.max(Number(sp.get("dias")) || 90, 1), 400)
  const max = Math.min(Math.max(Number(sp.get("max")) || 300, 1), 1000)
  const offset = Math.max(Number(sp.get("offset")) || 0, 0)
  const desde = new Date(Date.now() - dias * 86_400_000).toISOString()
  const internos = testContactSet()
  const { clasificarSenalEspera } = await import("@/lib/loop-v2")

  const convs = await sb<Conv>(
    `vic_v3_conversations?country=eq.cl&last_user_at=gte.${desde}` +
      `&select=id,contact,last_user_at,followup_closed_reason,followup_status` +
      `&order=last_user_at.desc&limit=${max}&offset=${offset}`,
  )
  const vivos = convs.filter(
    (c) => !internos.has(String(c.contact || "")) && /^\d{8,15}$/.test(String(c.contact || "")),
  )

  const resumen = {
    revisadas: 0, sin_senal: 0, respetado: 0, toque_10min: 0,
    atropello_fecha: 0, insistente: 0, queja: 0, truncado: false,
  }
  const filas: Array<Record<string, unknown>> = []

  for (const c of vivos) {
    if (Date.now() - t0 > 235_000) { resumen.truncado = true; break }
    resumen.revisadas++
    let msgs: Msg[] = []
    try {
      msgs = await sb<Msg>(
        `vic_v3_messages?conversation_id=eq.${c.id}&select=at,role,content&order=at.desc&limit=40`,
      )
    } catch { continue }
    msgs.reverse()

    // La señal se busca en TODOS los mensajes del cliente, y se toma la
    // PRIMERA (lo que pasó después de ella es lo que se juzga).
    let senalAt = 0
    let senalTxt = ""
    let tipo: "queja" | "espera" | "" = ""
    let fechaPedida: Date | null = null
    for (const m of msgs) {
      if (m.role !== "user") continue
      const txt = String(m.content || "")
      if (txt.startsWith("[REGISTRO INTERNO")) continue
      const esQueja = QUEJA_INSISTENCIA.test(txt)
      const esEspera = PIDE_TIEMPO.test(txt)
      const conFecha = clasificarSenalEspera(txt, "cl", c.contact, new Date(m.at))
      if (!esQueja && !esEspera && !conFecha) continue
      senalAt = Date.parse(m.at)
      senalTxt = txt.replace(/\s+/g, " ").slice(0, 120)
      tipo = esQueja ? "queja" : "espera"
      fechaPedida = conFecha ? conFecha.cuando : null
      break
    }
    if (!senalAt) { resumen.sin_senal++; continue }

    // Proactividad posterior: mismo discriminador de hueco que el modo
    // principal (la respuesta del mismo turno es reactiva y legítima).
    const proactivos: Array<{ at: string; gapMin: number; pago: boolean; txt: string }> = []
    let ultimoUserAt = 0
    for (const m of msgs) {
      const at = Date.parse(m.at)
      if (m.role === "user") { ultimoUserAt = at; continue }
      if (m.role !== "assistant" || at <= senalAt) continue
      const txt = String(m.content || "")
      if (txt.startsWith("[REGISTRO INTERNO")) continue
      const gapMin = ultimoUserAt ? Math.round((at - ultimoUserAt) / 60_000) : 9999
      if (gapMin <= 5) continue
      proactivos.push({ at: m.at, gapMin, pago: HABLA_DE_PAGO.test(txt), txt: txt.replace(/\s+/g, " ").slice(0, 120) })
    }

    const primero = proactivos[0]
    const antesDeLaFecha = Boolean(fechaPedida && primero && Date.parse(primero.at) < fechaPedida.getTime())
    let veredicto: keyof typeof resumen
    if (tipo === "queja") veredicto = "queja"
    else if (antesDeLaFecha) veredicto = "atropello_fecha"
    else if (primero && primero.gapMin <= 60) veredicto = "toque_10min"
    else if (proactivos.length >= 3) veredicto = "insistente"
    else veredicto = "respetado"
    resumen[veredicto] = (resumen[veredicto] as number) + 1

    if (veredicto !== "respetado" || sp.get("detalle") === "1") {
      filas.push({
        contact: c.contact,
        veredicto,
        senal: tipo,
        senalAt: new Date(senalAt).toISOString().slice(0, 16),
        loQueDijo: senalTxt,
        fechaPedida: fechaPedida ? fechaPedida.toISOString().slice(0, 10) : null,
        toquesDespues: proactivos.length,
        primerToqueMin: primero ? primero.gapMin : null,
        hablabaDePago: proactivos.some((p) => p.pago),
        ejemplo: primero ? `${primero.at.slice(0, 16)} (+${primero.gapMin} min) · ${primero.txt}` : null,
      })
    }
  }

  const conSenal = resumen.revisadas - resumen.sin_senal
  return NextResponse.json({
    ok: true,
    modo: "insistencia",
    nota: "solo lectura · señal BLANDA del cliente (queja o pedido de tiempo) vs lo que Vicky mandó después",
    dias, offset, max, ms: Date.now() - t0,
    resumen, conSenal,
    tasaRespeto: conSenal ? `${Math.round((resumen.respetado * 100) / conSenal)}%` : "—",
    filas: filas.slice(0, 120),
  })
}

export async function GET(req: Request): Promise<Response> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  const sp = new URL(req.url).searchParams
  if (sp.get("soporte") === "1") return modoSoporte(sp, Date.now())
  if (sp.get("postventa") === "1") return modoPostventa(sp, Date.now())
  if (sp.get("loops") === "1") return modoLoops(sp, Date.now())
  if (sp.get("insistencia") === "1") return modoInsistencia(sp, Date.now())
  const dias = Math.min(Math.max(Number(sp.get("dias")) || 90, 1), 400)
  const max = Math.min(Math.max(Number(sp.get("max")) || 300, 1), 1000)
  const offset = Math.max(Number(sp.get("offset")) || 0, 0)
  const pais = (sp.get("pais") || "cl").toLowerCase()
  const conDetalle = sp.get("detalle") === "1"
  const desde = new Date(Date.now() - dias * 86_400_000).toISOString()
  const t0 = Date.now()
  const internos = testContactSet()

  const convs = await sb<Conv>(
    `vic_v3_conversations?country=eq.${pais}&last_user_at=gte.${desde}` +
      `&select=id,contact,last_user_at,followup_closed_reason,followup_status` +
      `&order=last_user_at.desc&limit=${max}&offset=${offset}`,
  )
  const vivos = convs.filter(
    (c) => !internos.has(String(c.contact || "")) && /^\d{8,15}$/.test(String(c.contact || "")),
  )

  // Estado marcado en lote: loops y kv de opt-out / exclusión / casuística.
  const loopPor = new Map<string, { estado: string; motivo_cierre: string | null }>()
  const kvPor = new Map<string, string[]>()
  for (let i = 0; i < vivos.length; i += 80) {
    const lote = vivos.slice(i, i + 80).map((c) => c.contact)
    const inList = lote.join(",")
    const keys = lote
      .flatMap((t) => [`"voz_no_llamar_${t}"`, `"voz_excluir_${t}"`, `"casuistica_aplicada_${t}"`])
      .join(",")
    const [loops, kvs] = await Promise.all([
      sb<{ contact: string; estado: string; motivo_cierre: string | null }>(
        `vic_loop?contact=in.(${inList})&select=contact,estado,motivo_cierre`,
      ).catch(() => [] as Array<{ contact: string; estado: string; motivo_cierre: string | null }>),
      sb<{ key: string }>(`vic_kv?key=in.(${keys})&select=key`).catch(() => [] as Array<{ key: string }>),
    ])
    for (const l of loops) loopPor.set(String(l.contact), { estado: l.estado, motivo_cierre: l.motivo_cierre })
    for (const k of kvs) {
      const key = String(k.key)
      const tel = (key.match(/(\d{8,15})$/) || [])[1] || ""
      if (!tel) continue
      const familia = key.replace(`_${tel}`, "")
      kvPor.set(tel, [...(kvPor.get(tel) || []), familia])
    }
  }

  const filas: Array<Record<string, unknown>> = []
  const resumen = { revisadas: 0, sin_senal: 0, ok: 0, sin_marca: 0, tocado_igual: 0, truncado: false }
  const porSenal: Record<string, number> = {}

  for (const c of vivos) {
    if (Date.now() - t0 > 235_000) { resumen.truncado = true; break }
    resumen.revisadas++
    let msgs: Msg[] = []
    try {
      msgs = await sb<Msg>(
        `vic_v3_messages?conversation_id=eq.${c.id}&select=at,role,content&order=at.desc&limit=24`,
      )
    } catch { continue }
    msgs.reverse()
    const delCliente = msgs.filter((m) => m.role === "user").map((m) => String(m.content || ""))
    if (!delCliente.length) { resumen.sin_senal++; continue }

    // ── SEÑAL del cliente ───────────────────────────────────────────────
    const paraPostura = msgs.map((m) => ({ role: m.role, content: m.content }))
    const postura = posturaRechazoCliente(paraPostura)
    const ultimo = ultimoMensajeCliente(paraPostura)
    const auto = ultimo ? esAutorespuesta(ultimo) : false
    const cas = clasificarCasuistica(delCliente)
    const kvs = kvPor.get(c.contact) || []
    const optOut = c.followup_closed_reason === "opt_out" || kvs.includes("voz_no_llamar")
    const senales: string[] = []
    if (postura) senales.push("rechazo")
    if (auto) senales.push("autorespuesta")
    if (!cas.esProspecto) senales.push(`no_prospecto:${cas.tipo}`)
    if (optOut) senales.push("opt_out")
    if (!senales.length) { resumen.sin_senal++; continue }
    for (const s of senales) porSenal[s] = (porSenal[s] || 0) + 1

    // Corte conservador: el último mensaje del cliente (la postura se evalúa
    // hacia atrás desde ahí saltando cortesías).
    const ultimoUser = [...msgs].reverse().find((m) => m.role === "user")
    const senalAt = ultimoUser ? Date.parse(ultimoUser.at) : 0

    // ── ¿Qué salió DESPUÉS? ──────────────────────────────────────────────
    // CUIDADO: la RESPUESTA al mensaje que trae el rechazo es reactiva y
    // legítima ("gracias, quedo atenta") — la primera versión de esta auditoría
    // la contaba como proactividad y daba 0 % de acierto con 44 falsos
    // positivos. El discriminador es el HUECO: el webhook contesta en segundos,
    // y el toque más temprano del loop es a los 10 minutos.
    const GAP_PROACTIVO_MIN = 5
    const proactivos: Array<Msg & { gapMin: number }> = []
    let ultimoUserAt = 0
    for (const m of msgs) {
      const at = Date.parse(m.at)
      if (m.role === "user") { ultimoUserAt = at; continue }
      if (m.role !== "assistant" || at <= senalAt) continue
      const txt = String(m.content || "")
      const gapMin = ultimoUserAt ? Math.round((at - ultimoUserAt) / 60_000) : 9999
      if (txt.startsWith("[REGISTRO INTERNO")) {
        if (/campa/i.test(txt)) proactivos.push({ ...m, gapMin })
        continue
      }
      if (gapMin > GAP_PROACTIVO_MIN) proactivos.push({ ...m, gapMin })
    }

    // ── MARCA del sistema ───────────────────────────────────────────────
    const loop = loopPor.get(c.contact)
    const motivo = String(loop?.motivo_cierre || "")
    const cerrada = String(c.followup_closed_reason || "")
    const marcado =
      optOut ||
      kvs.includes("voz_excluir") ||
      kvs.includes("casuistica_aplicada") ||
      (Boolean(loop) && loop!.estado !== "activo" && MOTIVOS_BUENOS.has(motivo)) ||
      ["opt_out", "perdido", "soporte", "rechazo"].includes(cerrada)

    const veredicto = proactivos.length ? "tocado_igual" : marcado ? "ok" : "sin_marca"
    resumen[veredicto as "ok" | "sin_marca" | "tocado_igual"]++
    if (veredicto !== "ok" || conDetalle) {
      filas.push({
        contact: c.contact,
        veredicto,
        senales,
        senalAt: ultimoUser?.at || null,
        ultimoDelCliente: String(ultimo || "").replace(/\s+/g, " ").slice(0, 90),
        loop: loop ? `${loop.estado}/${motivo || "-"}` : "sin fila",
        convCerrada: cerrada || null,
        kv: kvs,
        proactivosDespues: proactivos.length,
        ejemplo: proactivos[0]
          ? `${proactivos[0].at.slice(0, 16)} (+${proactivos[0].gapMin} min) · ${String(proactivos[0].content || "").replace(/\s+/g, " ").slice(0, 130)}`
          : null,
      })
    }
  }

  const conSenal = resumen.ok + resumen.sin_marca + resumen.tocado_igual
  return NextResponse.json({
    ok: true,
    nota: "solo lectura · señal = lo que dijo el cliente · marca = lo que anotó el sistema · tocado_igual = le escribimos después",
    dias, pais, offset, max,
    ms: Date.now() - t0,
    resumen,
    porSenal,
    conSenal,
    tasaAciertoMarcacion: conSenal ? `${Math.round((resumen.ok * 100) / conSenal)}%` : "—",
    filas: filas.slice(0, 120),
  })
}
