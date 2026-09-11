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

export async function GET(req: Request): Promise<Response> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  const sp = new URL(req.url).searchParams
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
