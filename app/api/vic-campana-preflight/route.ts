/**
 * PRE-FLIGHT DEL LUNES DE LA CAMPAÑA DE REACTIVACIÓN, CON FRENO AUTOMÁTICO
 * (ofrecido el 10-sep, ordenado por Lalo el 11-sep).
 *
 * Nace de lo que pasó el 11-sep: dos consultas rotas (`created_at` a vic_kv y
 * `at` a vic_llamadas) dejaron 444 de 450 contactos en `no_evaluable` y la
 * campaña estaba MUERTA sin que nadie lo notara — falla segura pero MUDA, y
 * solo el dry run la delataba. Este endpoint convierte ese dry run en rutina:
 * corre el lunes, mira el volumen del martes ANTES de que salga, lo compara
 * con la semana pasada y FRENA la campaña si algo se sale de rango.
 *
 * QUÉ HACE (en orden):
 *   1. dispara el dry run del martes contra el runner real
 *      (`vic-campana-reactivacion?dry=1&dia=wsp&forzarHora=1`)
 *   2. resume: cuántos saldrían, cuántos se evaluaron, y los motivos de
 *      exclusión nombrados uno por uno
 *   3. compara el volumen con el pre-flight anterior (histórico en vic_kv)
 *   4. FRENA si se cumple cualquiera de estas (todas con env de override):
 *        · el dry run falla o no responde                → ciego
 *        · nadie se evaluó habiendo universo             → el caso del 11-sep
 *        · `no_evaluable` sobre el 20 % del universo     → consultas rotas
 *        · saldrían más de CAMPANA_PREFLIGHT_TOPE (60)   → masa inesperada
 *        · saldrían >3× la semana pasada y más de 15      → salto anómalo
 *      Frenar = vic_kv `campana_react_enabled` = "off" + `campana_react_freno`
 *      con el motivo. El runner ya respeta ese interruptor, así que el martes
 *      no sale nada y nadie tiene que estar despierto a las 11.
 *   5. manda el reporte por correo a VICKY_CIERRE_TO (siempre, frene o no) y
 *      deja el resultado en vic_kv `campana_preflight_ultimo` para el dash.
 *
 * GET auth cron (?key= | x-cron-secret | Bearer):
 *   ?forzar=1   corre aunque no sea lunes y salta la idempotencia semanal
 *   ?dry=1      simula el pre-flight: NO frena, NO escribe kv, NO manda correo
 *   ?max=N      tope de filas del dry run del runner (default 150)
 *   ?dias=N     antigüedad del universo (default 90)
 *
 * Despachado por JOBS_HUERFANOS; la ventana es 8-11 CL del lunes, para que el
 * freno quede puesto ANTES de las 11:00 del martes.
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret, getKvValue, setKvValue } from "@/lib/supabase-persistence-v3"
import { getZohoAccessToken } from "@/lib/zoho-token"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const CRON_SECRET = (process.env.CRON_SECRET || "").trim()
const ZOHO_API = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
const MAIL_ANCHOR = (process.env.VIC_DASH_MAIL_ANCHOR || "Contacts/3525045000645054553").trim()
const FROM_EMAIL = (process.env.VICKY_FROM_EMAIL || "vicky@geovictoria.com").trim()
const DESTINOS = (process.env.VICKY_CIERRE_TO || "egomez@geovictoria.com,rlewit@geovictoria.com")
  .split(",").map((s) => s.trim()).filter(Boolean)

/** Umbrales del freno (todos con override sin deploy vía env). */
const TOPE_ENVIOS = Number(process.env.CAMPANA_PREFLIGHT_TOPE || 60)
const FACTOR_SALTO = Number(process.env.CAMPANA_PREFLIGHT_FACTOR || 3)
const PISO_SALTO = Number(process.env.CAMPANA_PREFLIGHT_PISO || 15)
const PCT_NO_EVALUABLE = Number(process.env.CAMPANA_PREFLIGHT_PCT_CIEGO || 20)

const KV_HIST = "campana_preflight_hist"
const KV_ULTIMO = "campana_preflight_ultimo"

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

type FilaRunner = {
  contact: string
  empresa: string | null
  casilla: number | null
  accion?: string
  omitido?: string
  ultimaActividad?: string
}
type RespuestaRunner = {
  ok?: boolean
  evaluados?: number
  resumen?: Record<string, number>
  filas?: FilaRunner[]
  apagada?: boolean
  error?: string
}

type Corrida = {
  semana: string
  at: string
  universo: number
  evaluados: number
  seEnviaria: number
  noEvaluable: number
  truncado: boolean
}

function lunesDe(ahora: Date): string {
  // Lunes de la semana en curso, en fecha de Chile (la campaña es CL).
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago" }).format(ahora)
  const d = new Date(`${ymd}T12:00:00Z`)
  const dow = d.getUTCDay() || 7 // domingo = 7
  return new Date(d.getTime() - (dow - 1) * 86_400_000).toISOString().slice(0, 10)
}

function diaSemanaCl(ahora: Date): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/Santiago", weekday: "short" }).format(ahora)
}

function horaCl(ahora: Date): number {
  const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Santiago", hour: "numeric", hour12: false }).format(ahora))
  return h === 24 ? 0 : h
}

function esc(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

async function leerHistorico(): Promise<Corrida[]> {
  const raw = (await getKvValue(KV_HIST).catch(() => "")) || ""
  if (!raw.trim()) return []
  try {
    const j = JSON.parse(raw)
    return Array.isArray(j) ? (j as Corrida[]) : []
  } catch {
    return []
  }
}

async function correo(asunto: string, html: string): Promise<boolean> {
  const token = await getZohoAccessToken().catch(() => "")
  if (!token) return false
  const r = await fetch(`${ZOHO_API}/crm/v3/${MAIL_ANCHOR}/actions/send_mail`, {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      data: [{ from: { email: FROM_EMAIL }, to: DESTINOS.map((email) => ({ email })), subject: asunto, content: html, mail_format: "html" }],
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null)
  if (!r || !r.ok) {
    console.error("[preflight] send_mail falló", r?.status, (await r?.text().catch(() => "")) || "")
    return false
  }
  return true
}

export async function GET(req: Request): Promise<Response> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  const url = new URL(req.url)
  const sp = url.searchParams
  const ahora = new Date()
  const forzar = sp.get("forzar") === "1"
  const dry = sp.get("dry") === "1"
  const max = Math.min(Math.max(Number(sp.get("max")) || 150, 10), 150)
  const dias = Math.min(Math.max(Number(sp.get("dias")) || 90, 7), 365)
  const semana = lunesDe(ahora)

  if (!forzar) {
    const dia = diaSemanaCl(ahora)
    const hora = horaCl(ahora)
    if (dia !== "Mon") return NextResponse.json({ ok: true, saltado: "no_es_lunes", dia })
    if (hora < 8 || hora > 11) return NextResponse.json({ ok: true, saltado: "fuera_de_ventana", hora })
    const hecho = (await getKvValue(`preflight_campana_${semana}`).catch(() => "")) || ""
    if (hecho.trim()) return NextResponse.json({ ok: true, saltado: "ya_corrio_esta_semana", semana, hecho })
  }

  const enabledAntes = ((await getKvValue("campana_react_enabled").catch(() => "")) || "").trim().toLowerCase() === "on"

  // 1. El dry run del martes, contra el runner REAL (misma lógica que enviará).
  const secreto = (await getFollowupCronSecret().catch(() => "")) || CRON_SECRET
  const rr = await fetch(
    `${url.origin}/api/vic-campana-reactivacion?dry=1&dia=wsp&forzarHora=1&max=${max}&dias=${dias}`,
    { headers: { "x-cron-secret": secreto }, cache: "no-store", signal: AbortSignal.timeout(280_000) },
  ).catch((e) => { console.error("[preflight] dry run no respondió", e); return null })
  const j: RespuestaRunner | null = rr ? ((await rr.json().catch(() => null)) as RespuestaRunner | null) : null

  const filas = j?.filas || []
  const resumen = j?.resumen || {}
  const universo = filas.length
  const evaluados = Number(j?.evaluados || 0)
  const seEnviaria = Number(resumen["se_enviaria"] || 0)
  const noEvaluable = Object.entries(resumen)
    .filter(([k]) => k.startsWith("no_evaluable"))
    .reduce((a, [, v]) => a + v, 0)
  const truncado = Boolean(resumen["presupuesto_de_tiempo"]) || universo >= max * 3
  const corridaOk = Boolean(rr && rr.ok && j && j.ok !== false)

  // 2. Comparación con la semana pasada.
  const hist = await leerHistorico()
  const previa = hist.filter((c) => c.semana !== semana).slice(-1)[0] || null

  // 3. FRENO: cada regla nombrada, para que el correo diga POR QUÉ.
  const frenos: string[] = []
  if (!corridaOk) frenos.push(`el dry run del martes no respondió bien (${rr?.status || "sin respuesta"}${j?.error ? ` · ${j.error}` : ""}) — la campaña queda ciega`)
  else {
    if (universo > 0 && evaluados === 0) frenos.push(`universo de ${universo} y CERO evaluados — es el patrón del 11-sep (consulta rota que deja todo en no_evaluable)`)
    if (universo > 0 && noEvaluable * 100 > universo * PCT_NO_EVALUABLE) frenos.push(`${noEvaluable} de ${universo} quedaron en no_evaluable (${Math.round((noEvaluable / universo) * 100)} %, tope ${PCT_NO_EVALUABLE} %) — hay consultas fallando`)
    if (seEnviaria > TOPE_ENVIOS) frenos.push(`saldrían ${seEnviaria} toques, sobre el tope de ${TOPE_ENVIOS}`)
    if (previa && seEnviaria > PISO_SALTO && seEnviaria > previa.seEnviaria * FACTOR_SALTO) frenos.push(`saldrían ${seEnviaria} contra ${previa.seEnviaria} de la semana del ${previa.semana} (más de ${FACTOR_SALTO}×)`)
  }

  // 4. Frenar de verdad: el interruptor que el runner ya respeta.
  let freno: { aplicado: boolean; motivos: string[]; nota?: string } = { aplicado: false, motivos: frenos }
  if (frenos.length && !dry) {
    if (!enabledAntes) freno = { aplicado: false, motivos: frenos, nota: "la campaña ya estaba apagada — no había nada que frenar" }
    else {
      await setKvValue("campana_react_enabled", "off").catch((e) => console.error("[preflight] no se pudo apagar", e))
      await setKvValue("campana_react_freno", JSON.stringify({ at: ahora.toISOString(), semana, motivos: frenos, seEnviaria, universo, evaluados, noEvaluable })).catch(() => {})
      freno = { aplicado: true, motivos: frenos }
    }
  }

  // 5. Motivos de exclusión ordenados, que es lo que se lee de verdad.
  const motivos = Object.entries(resumen)
    .filter(([k]) => k !== "se_enviaria")
    .sort((a, b) => b[1] - a[1])
  const ejemplos = filas.filter((f) => (f.accion || "").startsWith("SE ENVIARÍA")).slice(0, 20)

  const corrida: Corrida = { semana, at: ahora.toISOString(), universo, evaluados, seEnviaria, noEvaluable, truncado }

  const estado = frenos.length
    ? (freno.aplicado ? "🛑 FRENADA" : "⚠️ CON HALLAZGOS")
    : (enabledAntes ? "✅ LISTA PARA EL MARTES" : "✅ SIN HALLAZGOS (campaña apagada)")
  const html = `<div style="font-family:'Segoe UI',system-ui,sans-serif;color:#2d3748;max-width:720px">
  <h2 style="margin:0 0 4px">Pre-flight de la campaña de reactivación · semana del ${semana}</h2>
  <div style="color:#6b7280;font-size:13px;margin-bottom:14px">Simulación del toque del martes corrida hoy lunes. ${esc(estado)}</div>
  ${frenos.length ? `<div style="background:#fef2f2;border-left:4px solid #dc2626;padding:10px 14px;border-radius:8px;margin-bottom:14px">
    <b>${freno.aplicado ? "La campaña quedó APAGADA" : "Hallazgos sin freno"}</b>
    <ul style="margin:6px 0 0 16px;padding:0">${frenos.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>
    ${freno.nota ? `<div style="color:#6b7280;font-size:12.5px;margin-top:6px">${esc(freno.nota)}</div>` : `<div style="color:#6b7280;font-size:12.5px;margin-top:6px">Para reencender: vic_kv <code>campana_react_enabled</code> = "on" después de revisar.</div>`}
  </div>` : ""}
  <table style="border-collapse:collapse;font-size:14px;margin-bottom:14px">
    <tr><td style="padding:3px 12px 3px 0;color:#6b7280">Saldrían el martes</td><td style="padding:3px 0"><b>${seEnviaria}</b>${previa ? ` <span style="color:#6b7280">(semana del ${previa.semana}: ${previa.seEnviaria})</span>` : ""}</td></tr>
    <tr><td style="padding:3px 12px 3px 0;color:#6b7280">Candidatos revisados</td><td style="padding:3px 0">${universo}${truncado ? ' <span style="color:#b45309">· cortado por tiempo, la cifra es un piso</span>' : ""}</td></tr>
    <tr><td style="padding:3px 12px 3px 0;color:#6b7280">Pasaron a evaluación</td><td style="padding:3px 0">${evaluados}</td></tr>
    <tr><td style="padding:3px 12px 3px 0;color:#6b7280">No evaluables</td><td style="padding:3px 0">${noEvaluable}</td></tr>
    <tr><td style="padding:3px 12px 3px 0;color:#6b7280">Interruptor</td><td style="padding:3px 0">${enabledAntes ? "encendido" : "apagado"}${freno.aplicado ? " → <b>apagado por el freno</b>" : ""}</td></tr>
  </table>
  <h3 style="margin:0 0 6px;font-size:15px">Por qué queda fuera el resto</h3>
  <table style="border-collapse:collapse;font-size:13.5px">${motivos.map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0">${esc(k)}</td><td style="padding:2px 0;text-align:right"><b>${v}</b></td></tr>`).join("") || '<tr><td style="color:#6b7280">sin exclusiones</td></tr>'}</table>
  ${ejemplos.length ? `<h3 style="margin:16px 0 6px;font-size:15px">A quiénes les llegaría</h3>
  <table style="border-collapse:collapse;font-size:13px">${ejemplos.map((f) => `<tr><td style="padding:2px 12px 2px 0">${esc(f.empresa || "—")}</td><td style="padding:2px 12px 2px 0">+${esc(f.contact)}</td><td style="padding:2px 12px 2px 0">toque ${f.casilla ?? "?"}</td><td style="padding:2px 0;color:#6b7280">${esc(f.ultimaActividad || "")}</td></tr>`).join("")}</table>
  ${seEnviaria > ejemplos.length ? `<div style="color:#6b7280;font-size:12.5px;margin-top:4px">… y ${seEnviaria - ejemplos.length} más.</div>` : ""}` : ""}
  <div style="color:#8a949c;font-size:12px;margin-top:16px">Umbrales del freno: tope ${TOPE_ENVIOS} envíos · salto ${FACTOR_SALTO}× sobre ${PISO_SALTO} · no evaluables ${PCT_NO_EVALUABLE} %. Simulación, no se envió nada.</div>
</div>`

  let correoOk = false
  if (!dry) {
    correoOk = await correo(`Pre-flight campaña de reactivación · ${estado} · saldrían ${seEnviaria}`, html)
    await setKvValue(KV_ULTIMO, JSON.stringify({ ...corrida, estado, frenos, frenoAplicado: freno.aplicado })).catch(() => {})
    await setKvValue(KV_HIST, JSON.stringify([...hist.filter((c) => c.semana !== semana), corrida].slice(-12))).catch(() => {})
    await setKvValue(`preflight_campana_${semana}`, ahora.toISOString()).catch(() => {})
  }

  return NextResponse.json({
    ok: true, dry, semana, estado, enabledAntes, corridaOk, truncado,
    universo, evaluados, seEnviaria, noEvaluable,
    previa, frenos, freno, motivos, correoOk,
    seEnviarianA: ejemplos,
  })
}
