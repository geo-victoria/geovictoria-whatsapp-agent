/**
 * Endpoint ADMIN (solo lectura): DETALLE de por qué cada venta de Vicky quedó
 * autónoma o asistida (Lalo 30-sep, "ármalo"). El clasificador del dash
 * (lib/gestion-ventas-datos) guarda solo el veredicto; acá se muestra la
 * EVIDENCIA de cada venta:
 *   · mensajes del ejecutivo por su WhatsApp espejado (cuántos, antes/después
 *     del pago) y si el cliente le RESPONDIÓ antes del pago;
 *   · llamadas contestadas en su sesión de espejo;
 *   · notas del trato de un ejecutivo de telemarketing o del espejo (título,
 *     fecha, antes/después del pago, un trozo del contenido).
 * El roster y la regla son los mismos del dash (lib/gestion-venta): solo
 * telemarketing, las SDR no cuentan.
 *
 * GET ?key=<cron>&desde=2026-09-01&hasta=2026-10-01  (fechas en hora de Chile)
 *     [&soloAsistidas=1] [&csv=1]
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"
import { universoVentasVicky } from "@/lib/ventas-vicky-universo"
import { rosterTelemarketing, sesionesTelemarketing, esNotaDeTelemarketing } from "@/lib/gestion-venta"
import { getZohoAccessToken } from "@/lib/zoho-token"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()

async function autorizado(req: Request): Promise<boolean> {
  const secreto = await getFollowupCronSecret().catch(() => "")
  const cron = (process.env.CRON_SECRET || "").trim()
  const auth = req.headers.get("authorization") || ""
  const url = new URL(req.url)
  const entregado =
    req.headers.get("x-cron-secret") || (auth.startsWith("Bearer ") ? auth.slice(7) : "") || url.searchParams.get("key") || ""
  return Boolean(entregado) && (entregado === secreto || (Boolean(cron) && entregado === cron))
}

const fechaCL = (ms: number) =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Santiago", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(ms))
const digits = (s: unknown) => String(s ?? "").replace(/\D/g, "")

type Msg = { telefono_chat?: string; session_id?: string; from_me?: boolean; enviado_at?: string; texto?: string }
type Llam = { telefono?: string; session_id?: string; at?: string }
type Nota = { id?: string; Note_Title?: string | null; Note_Content?: string | null; Created_Time?: string; Created_By?: { id?: string; name?: string } | null }

export async function GET(req: Request): Promise<Response> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  const sp = new URL(req.url).searchParams
  const desde = (sp.get("desde") || "2026-09-01").trim()
  const hasta = (sp.get("hasta") || "2026-10-01").trim()
  const soloAsistidas = sp.get("soloAsistidas") === "1"
  const u = await universoVentasVicky({ desde: "2026-08-25" })
  if (!u) return NextResponse.json({ ok: false, error: "sin supabase o sin token zoho" }, { status: 503 })
  const ventas = u.universo.filter((v) => {
    const d = fechaCL(v.fechaMs).slice(0, 10)
    return d >= desde && d < hasta
  })

  const roster = rosterTelemarketing()
  const sesiones = sesionesTelemarketing()
  const nombreSesion = (s: string) => roster.find((r) => r.sesion === s)?.nombre || s
  const h = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }

  // Espejo: TODOS los mensajes de esos teléfonos (del ejecutivo y del cliente)
  // y las llamadas contestadas.
  const tels = [...new Set(ventas.map((v) => v.tel).filter((t) => t.length >= 9))]
  const msgs = new Map<string, Msg[]>()
  const llamadas = new Map<string, Llam[]>()
  for (let i = 0; i < tels.length; i += 40) {
    const lista = tels.slice(i, i + 40).map((t) => `"${t}"`).join(",")
    const [rm, rl] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/vic_wa_espejo_mensajes?telefono_chat=in.(${lista})&es_grupo=eq.false&select=telefono_chat,session_id,from_me,enviado_at,texto&order=enviado_at.asc&limit=10000`, { headers: h, cache: "no-store" }).catch(() => null),
      fetch(`${SUPABASE_URL}/rest/v1/vic_wa_espejo_llamadas?telefono=in.(${lista})&estado=eq.accept&select=telefono,session_id,at&limit=2000`, { headers: h, cache: "no-store" }).catch(() => null),
    ])
    if (rm?.ok) for (const m of ((await rm.json().catch(() => [])) as Msg[]) || []) {
      const t = digits(m.telefono_chat); if (!msgs.has(t)) msgs.set(t, []); msgs.get(t)!.push(m)
    }
    if (rl?.ok) for (const l of ((await rl.json().catch(() => [])) as Llam[]) || []) {
      const t = digits(l.telefono); if (!llamadas.has(t)) llamadas.set(t, []); llamadas.get(t)!.push(l)
    }
  }

  // Notas del trato (todas: el detalle muestra también las que NO cuentan).
  const token = await getZohoAccessToken().catch(() => "")
  const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
  const notasPorDeal = new Map<string, Nota[] | null>()
  const deals = [...new Set(ventas.map((v) => v.dealId).filter(Boolean))]
  for (let i = 0; i < deals.length; i += 8) {
    await Promise.all(deals.slice(i, i + 8).map(async (d) => {
      const r = await fetch(`${api}/crm/v3/Deals/${d}/Notes?fields=Note_Title,Note_Content,Created_By,Created_Time&per_page=100`, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` }, cache: "no-store",
      }).catch(() => null)
      if (!r) return notasPorDeal.set(d, null)
      if (r.status === 204) return notasPorDeal.set(d, [])
      const j = (await r.json().catch(() => ({}))) as { data?: Nota[] }
      notasPorDeal.set(d, r.ok ? j.data || [] : null)
    }))
  }

  const filas = ventas.map((v) => {
    const pago = v.fechaMs
    const ms = (s?: string) => Date.parse(String(s || ""))
    const todos = msgs.get(v.tel) || []
    const deEjec = todos.filter((m) => m.from_me && sesiones.has(String(m.session_id || "").toLowerCase()))
    const ejecAntes = deEjec.filter((m) => ms(m.enviado_at) <= pago)
    const primeroEjec = deEjec.length ? ms(deEjec[0].enviado_at) : NaN
    const respuestaAntes = Number.isFinite(primeroEjec)
      ? todos.some((m) => !m.from_me && ms(m.enviado_at) > primeroEjec && ms(m.enviado_at) <= pago)
      : false
    const llam = (llamadas.get(v.tel) || []).filter((l) => sesiones.has(String(l.session_id || "").toLowerCase()))
    const notas = notasPorDeal.get(v.dealId)
    const notasTlmk = (notas || []).filter((n) => esNotaDeTelemarketing(n))
    const notasTlmkAntes = notasTlmk.filter((n) => ms(n.Created_Time) <= pago)
    const ejecutivos = new Set<string>()
    for (const m of deEjec) ejecutivos.add(nombreSesion(String(m.session_id || "").toLowerCase()))
    for (const l of llam) ejecutivos.add(nombreSesion(String(l.session_id || "").toLowerCase()))
    // Nota humana → su autor del roster; nota-espejo (la crea el robot) → la
    // sesión o el nombre que trae el título "WhatsApp <sesión> ↔ cliente (espejo…)".
    const sinTilde = (x: string) => x.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    for (const n of notasTlmk) {
      const porAutor = roster.find((r) => r.id === n.Created_By?.id)
      const titulo = sinTilde(String(n.Note_Title || ""))
      const porTitulo = roster.find((r) => (r.sesion && titulo.includes(r.sesion)) || (r.nombre && titulo.includes(sinTilde(r.nombre))))
      const quien = porAutor || porTitulo
      if (quien) ejecutivos.add(quien.nombre)
    }

    const senales: string[] = []
    if (deEjec.length) senales.push("whatsapp_espejo")
    if (llam.length) senales.push("llamada")
    if (notasTlmk.length) senales.push("nota")
    const veredicto = senales.length ? "asistida" : notas === null && !deEjec.length ? "sd" : "autonoma"
    const antesDelPago = ejecAntes.length > 0 || llam.some((l) => ms(l.at) <= pago) || notasTlmkAntes.length > 0

    return {
      numero: v.numero,
      empresa: v.empresa,
      telefono: v.tel,
      pagoCL: fechaCL(pago),
      cobradoClp: Number(v.caja?.montoClp || 0),
      atribucion: v.atribucion,
      veredicto,
      ejecutivos: [...ejecutivos].join(", "),
      senales: senales.join("+") || "-",
      actividadAntesDelPago: antesDelPago,
      clienteRespondioAntesDelPago: respuestaAntes,
      whatsappEjecutivo: { total: deEjec.length, antesDelPago: ejecAntes.length, primero: deEjec.length ? fechaCL(primeroEjec) : "" },
      llamadasContestadas: { total: llam.length, antesDelPago: llam.filter((l) => ms(l.at) <= pago).length },
      notasTelemarketing: notasTlmk.map((n) => ({
        fecha: fechaCL(ms(n.Created_Time)),
        antesDelPago: ms(n.Created_Time) <= pago,
        autor: n.Created_By?.name || "",
        titulo: String(n.Note_Title || "").slice(0, 80),
        contenido: String(n.Note_Content || "").replace(/\s+/g, " ").slice(0, 160),
      })),
      notasLeidas: notas === null ? "error" : (notas || []).length,
    }
  }).filter((f) => !soloAsistidas || f.veredicto === "asistida")

  const asist = filas.filter((f) => f.veredicto === "asistida")
  const resumen = {
    ventas: filas.length,
    asistidas: asist.length,
    autonomas: filas.filter((f) => f.veredicto === "autonoma").length,
    sd: filas.filter((f) => f.veredicto === "sd").length,
    asistidas_porSenal: asist.reduce<Record<string, number>>((a, f) => ((a[f.senales] = (a[f.senales] || 0) + 1), a), {}),
    asistidas_conActividadAntesDelPago: asist.filter((f) => f.actividadAntesDelPago).length,
    asistidas_soloActividadDespuesDelPago: asist.filter((f) => !f.actividadAntesDelPago).length,
    asistidas_conRespuestaDelClienteAntesDelPago: asist.filter((f) => f.clienteRespondioAntesDelPago).length,
    asistidas_porEjecutivo: asist.reduce<Record<string, number>>((a, f) => {
      for (const e of f.ejecutivos.split(", ").filter(Boolean)) a[e] = (a[e] || 0) + 1
      return a
    }, {}),
  }

  if (sp.get("csv") === "1") {
    const cab = ["numero", "empresa", "telefono", "pagoCL", "cobradoClp", "atribucion", "veredicto", "ejecutivos", "senales", "actividadAntesDelPago", "clienteRespondioAntesDelPago", "wspEjecutivo", "wspAntesPago", "llamadas", "notasTlmk", "notasAntesPago", "notas"]
    const q = (s: unknown) => `"${String(s ?? "").replace(/"/g, '""')}"`
    const lineas = filas.map((f) => [
      f.numero, f.empresa, f.telefono, f.pagoCL, f.cobradoClp, f.atribucion, f.veredicto, f.ejecutivos, f.senales,
      f.actividadAntesDelPago ? "si" : "no", f.clienteRespondioAntesDelPago ? "si" : "no",
      f.whatsappEjecutivo.total, f.whatsappEjecutivo.antesDelPago, f.llamadasContestadas.total,
      f.notasTelemarketing.length, f.notasTelemarketing.filter((n) => n.antesDelPago).length,
      f.notasTelemarketing.map((n) => `${n.fecha} ${n.autor}: ${n.titulo} — ${n.contenido}`).join(" | "),
    ].map(q).join(","))
    return new Response([cab.join(","), ...lineas].join("\n"), { headers: { "Content-Type": "text/csv; charset=utf-8" } })
  }
  return NextResponse.json({ ok: true, desde, hasta, resumen, filas })
}
