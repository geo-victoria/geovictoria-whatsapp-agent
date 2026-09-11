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
  const [pagosMp, pagosTransf] = await Promise.all([
    sb<{ key: string; value: string; created_at?: string }>(
      `vic_kv?key=like.pago_online_*&select=key,value,created_at&limit=2000`,
    ).catch(() => [] as Array<{ key: string; value: string; created_at?: string }>),
    sb<{ key: string; value: string; created_at?: string }>(
      `vic_kv?key=like.comprobante_ok_*&select=key,value,created_at&limit=2000`,
    ).catch(() => [] as Array<{ key: string; value: string; created_at?: string }>),
  ])
  const pagos = [...pagosMp, ...pagosTransf]
  // {at} del JSON manda; si no hay, updated_at de la fila.
  const pagoAt = new Map<string, string>()
  for (const k of pagos) {
    const tel = (String(k.key).match(/(\d{8,15})$/) || [])[1] || ""
    if (!tel || internos.has(tel) || !/^56\d{8,11}$/.test(tel)) continue
    let at = ""
    try { at = String((JSON.parse(String(k.value || "{}")) as { at?: string }).at || "") } catch { /* texto plano */ }
    if (!at) at = String(k.created_at || "")
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
    resumen, porTipo,
    tasaLimpia: resumen.revisadas ? `${Math.round((resumen.limpios * 100) / resumen.revisadas)}%` : "—",
    filas: filas.slice(0, 120),
  })
}

export async function GET(req: Request): Promise<Response> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  const sp = new URL(req.url).searchParams
  if (sp.get("soporte") === "1") return modoSoporte(sp, Date.now())
  if (sp.get("postventa") === "1") return modoPostventa(sp, Date.now())
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
