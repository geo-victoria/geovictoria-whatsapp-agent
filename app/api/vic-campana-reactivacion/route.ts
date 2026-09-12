/**
 * RUNNER de la CAMPAÑA DE REACTIVACIÓN (Lalo 10-sep; reglas en
 * lib/campana-reactivacion.ts).
 *
 *   martes 11:00    → WhatsApp (plantilla) a la PRIMERA casilla en falso
 *   miércoles 11:00 → correo a quien recibió el WhatsApp de esta semana y
 *                     SIGUE sin actividad
 *
 * La LLAMADA del jueves salió del ciclo (Lalo 11-sep: "ya no haremos llamadas
 * de Dapta"). Las columnas toque*_call_at siguen en la tabla, sin uso.
 *
 * GET auth cron (?key= | x-cron-secret):
 *   ?dry=1            simulación explícita: lista sin enviar (siempre permitido)
 *   ?dia=wsp|mail    fuerza el canal (default: el del día local)
 *   ?max=N            tope de envíos/filas por corrida (default 40)
 *   ?dias=N           antigüedad del universo (default 90)
 *   ?contact=569…     evalúa UN contacto y explica el veredicto
 *   ?forzarHora=1     salta la ventana 11:00-11:59 (solo con dry o pruebas)
 *
 * MODO REAL solo con vic_kv `campana_react_enabled`="on" y sin ?dry=1. Sin el
 * kv, la corrida automática (despachador) responde `apagada` y no evalúa
 * nada — el primer encendido lo da Lalo después de mirar las listas.
 *
 * Registro: casillas en vic_campana_reactivacion (por CLIENTE), evento en
 * vic_campanas (campana "react_t<N>") y [REGISTRO INTERNO] en el chat al
 * salir el WhatsApp para que Vicky sepa por qué le escriben.
 */

import { NextResponse } from "next/server"
import { appendAssistantV3, getFollowupCronSecret, getKvValue } from "@/lib/supabase-persistence-v3"
import { sendBotmakerTemplate } from "@/lib/botmaker-push-v3"
import { linkCortoDe } from "@/lib/link-cotizacion"
import { getUFActual } from "@/lib/uf"
import { evaluarGateProactividad } from "@/lib/gate-proactividad"
import { montoDelBloque } from "@/lib/precio-bloque"
import { claveCampana } from "@/lib/campana-descuento"
import { setKvValue } from "@/lib/supabase-persistence-v3"
import {
  anotarEvaluacion,
  canalDelDia,
  debeDescansar,
  ganchoParaToque2,
  planDeToque,
  precioTextoClp,
  ultimoToqueCampana,
  DESCANSO_DIAS,
  MINUTOS_HABILES_INACTIVIDAD,
  TABLA,
  casillaAbierta,
  contactosConChatReciente,
  evaluarGrupo1,
  feriadosDe,
  horaLocalDe,
  leerCasillasLote,
  marcarCasilla,
  siguienteCasilla,
  universoCampana,
  type Canal,
  type Casilla,
  type EvaluacionGrupo1,
  type FilaCasillas,
} from "@/lib/campana-reactivacion"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const CRON_SECRET = (process.env.CRON_SECRET || "").trim()
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const ZOHO_API = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
const QUOTE_MODULE = (process.env.ZOHO_QUOTE_MODULE || "Cotizaciones_GeoVictoria").trim()
const FROM_EMAIL = (process.env.VICKY_FROM_EMAIL || "vicky@geovictoria.com").trim()
const TPL_CON_NOMBRE = (process.env.REMK_TEMPLATE_CON_NOMBRE || "vicky_reactivacion_cotizacion_cl_v4").trim()
const TPL_SIN_NOMBRE = (process.env.REMK_TEMPLATE_SIN_NOMBRE || "vicky_reactivacion_sin_nombre_cl_v4").trim()
const WA_VICKY = "https://wa.me/56967308227?text=Quiero%20retomar%20mi%20cotizaci%C3%B3n"
const HORA_CAMPANA = 11

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

type Fila = {
  contact: string
  empresa: string | null
  quoteId: string | null
  origen?: string
  casilla: Casilla | null
  canal: Canal
  accion?: string
  omitido?: string
  ultimaActividad?: string
}

function nombrePila(raw: string | null | undefined): string {
  const s = String(raw || "").trim().split(/\s+/)[0] || ""
  if (!/^[A-Za-zÁÉÍÓÚÑáéíóúñ]{3,}$/.test(s)) return ""
  if (/^(prospecto|cliente|sr|sra|don|do[ñn]a|gerente|admin|rrhh|spa|ltda|eirl|contacto|usuario)$/i.test(s)) return ""
  return s[0].toUpperCase() + s.slice(1).toLowerCase()
}

async function zohoHeaders(): Promise<Record<string, string>> {
  const { getZohoAccessToken } = await import("@/lib/zoho-token")
  const token = await getZohoAccessToken()
  return { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }
}

async function datosContacto(H: Record<string, string>, contact: string, quoteId: string | null): Promise<{ nombre: string; email: string; empresa: string }> {
  const nueve = contact.slice(-9)
  let nombre = ""
  let email = ""
  let empresa = ""
  try {
    const r = await fetch(`${ZOHO_API}/crm/v8/coql`, {
      method: "POST", headers: H, cache: "no-store",
      body: JSON.stringify({ select_query: `select First_Name, Email from Contacts where Phone like '%${nueve}%' order by Modified_Time desc limit 1` }),
    })
    const c = (((await r.json().catch(() => null)) as { data?: Array<{ First_Name?: string; Email?: string }> } | null)?.data || [])[0]
    nombre = nombrePila(c?.First_Name)
    email = String(c?.Email || "").trim()
  } catch { /* sin contacto */ }
  if (quoteId) {
    try {
      const r = await fetch(`${ZOHO_API}/crm/v8/coql`, {
        method: "POST", headers: H, cache: "no-store",
        body: JSON.stringify({ select_query: `select Name, Email_Contacto from ${QUOTE_MODULE} where id = '${quoteId}'` }),
      })
      const q = (((await r.json().catch(() => null)) as { data?: Array<{ Name?: string; Email_Contacto?: string }> } | null)?.data || [])[0]
      empresa = String(q?.Name || "").replace(/^Cotización\s+/i, "").replace(/\s+-\s+\d{4}-\d{2}-\d{2}$/, "")
      if (!email) email = String(q?.Email_Contacto || "").trim()
    } catch { /* sin cotización */ }
  }
  return { nombre, email, empresa }
}

/** Último precio mostrado y motivo de no cierre, para las variables de las
 * plantillas de los toques 2 y 4. Sin monto legible el toque 4 cae al texto
 * del toque 1: jamás se manda una plantilla con la variable vacía. */
async function contextoDelChat(contact: string, uf: number): Promise<{ precio: string; motivo: string | null }> {
  const h = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  try {
    const rc = await fetch(`${SUPABASE_URL}/rest/v1/vic_v3_conversations?contact=eq.${contact}&select=id,motivo_no_cierre&limit=1`, { headers: h, cache: "no-store" })
    const conv = ((await rc.json().catch(() => [])) as Array<{ id: string; motivo_no_cierre?: string | null }>)[0]
    if (!conv) return { precio: "", motivo: null }
    const firmas = ["Resumen mensual", "Total mensual con IVA", "UF + IVA al mes", "Total mensual"]
    const orFirmas = firmas.map((f) => `content.ilike.*${encodeURIComponent(f)}*`).join(",")
    const rm = await fetch(
      `${SUPABASE_URL}/rest/v1/vic_v3_messages?conversation_id=eq.${conv.id}&role=eq.assistant&or=(${orFirmas})&select=content&order=at.desc&limit=1`,
      { headers: h, cache: "no-store" },
    )
    const msg = ((await rm.json().catch(() => [])) as Array<{ content?: string }>)[0]
    const m = montoDelBloque(String(msg?.content || ""))
    const conIva = m.clp || (m.uf && uf ? Math.round(m.uf * uf) : 0)
    return { precio: precioTextoClp(conIva), motivo: conv.motivo_no_cierre || null }
  } catch {
    return { precio: "", motivo: null }
  }
}

function esc(s: string): string {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function htmlCorreo(nombre: string, empresa: string, link: string): string {
  const saludo = nombre ? `Hola ${esc(nombre)}!` : "Hola!"
  const cta = link
    ? `<p style="text-align:center;margin:22px 0"><a href="${link}" style="background:#0087C8;color:#fff;text-decoration:none;font-weight:700;padding:12px 26px;border-radius:10px;display:inline-block;font-size:15px">Ver mi cotización</a></p>`
    : ""
  return `<!doctype html><html><body style="margin:0;background:#f4f6f8;font-family:'Segoe UI',Arial,sans-serif;color:#2d3748">
<div style="max-width:560px;margin:0 auto;padding:26px 18px">
  <div style="background:#fff;border-radius:14px;padding:28px 26px;box-shadow:0 1px 4px rgba(0,0,0,.06)">
    <p style="margin:0 0 14px;font-size:15px">${saludo} Soy <b>Vicky</b>, de GeoVictoria 👋</p>
    <p style="margin:0 0 14px;font-size:14.5px;line-height:1.6">Ayer te escribí por WhatsApp para retomar la cotización de control de asistencia${empresa ? ` de <b>${esc(empresa)}</b>` : ""}. Sigue vigente y con el mismo valor.</p>
    <p style="margin:0 0 6px;font-size:14.5px;line-height:1.6">Si quieres partir, se paga en línea y tu cuenta queda activa el mismo día; yo te acompaño con la configuración por WhatsApp.</p>
    ${cta}
    <p style="text-align:center;margin:0 0 18px"><a href="${WA_VICKY}" style="color:#25D366;font-weight:700;text-decoration:none;font-size:14px">Escribirme por WhatsApp 💬</a></p>
    <p style="margin:0;font-size:13px;color:#718096;line-height:1.6">Si ya no lo necesitas o prefieres que no te escribamos más por esta cotización, respóndeme este correo y lo dejo hasta aquí.</p>
  </div>
</div></body></html>`
}

async function enviarCorreo(H: Record<string, string>, quoteId: string | null, to: string, subject: string, html: string): Promise<boolean> {
  const anchor = quoteId ? `${QUOTE_MODULE}/${quoteId}` : (process.env.VIC_DASH_MAIL_ANCHOR || "Contacts/3525045000645054553").trim()
  const r = await fetch(`${ZOHO_API}/crm/v3/${anchor}/actions/send_mail`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ data: [{ from: { email: FROM_EMAIL }, to: [{ email: to }], subject, content: html, mail_format: "html" }] }),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  })
  return r.ok
}

async function registrarEvento(contact: string, casilla: Casilla, canal: Canal, quoteId: string | null): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/vic_campanas`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({
      contact,
      campana: `react_t${casilla}`,
      evento: canal === "wsp" ? "enviado" : canal === "mail" ? "enviado_correo" : "enviado_dapta",
      quote_id: quoteId,
      at: new Date().toISOString(),
    }),
    cache: "no-store",
  }).catch(() => {})
}

/**
 * PRUEBA DE ESCRITURA (`?probarEscritura=1&contact=569…`): marca una casilla,
 * la relee, registra el evento y BORRA todo lo que escribió. Existe porque el
 * camino de escritura del ciclo nunca había corrido en real —todos los dry
 * runs solo LEEN la tabla— y si `on_conflict=contact` no tuviera su índice
 * único, el upsert fallaría y un contacto recibiría el mismo toque cada
 * semana. Con un número sintético no se toca a ningún cliente.
 */
async function probarEscritura(contact: string, pais: string): Promise<Record<string, unknown>> {
  const pasos: Record<string, unknown> = { contact }
  try {
    await marcarCasilla(contact, 1, "wsp", { pais, empresa: "PRUEBA DE ESCRITURA - BORRAR", motivo: "prueba de escritura" })
    pasos.marcado_toque1_wsp = "ok"
  } catch (e) {
    pasos.marcado_toque1_wsp = `FALLÓ: ${e instanceof Error ? e.message : e}`
    return pasos
  }
  // Segunda escritura sobre la MISMA fila: es el upsert por on_conflict el que
  // podría no existir, y sin él el toque 2 crearía una fila nueva.
  try {
    await marcarCasilla(contact, 1, "mail", { pais, motivo: "prueba de escritura (2ª pasada)" })
    pasos.marcado_toque1_mail = "ok"
  } catch (e) {
    pasos.marcado_toque1_mail = `FALLÓ: ${e instanceof Error ? e.message : e}`
  }
  const fila = (await leerCasillasLote([contact]).catch(() => new Map())).get(contact) || null
  pasos.releido = fila ? { toque1_wsp_at: fila.toque1_wsp_at, toque1_mail_at: fila.toque1_mail_at, motivo: fila.ultima_eval_motivo } : "NO SE PUDO RELEER"
  pasos.siguienteCasilla_tras_toque1 = siguienteCasilla(fila)
  pasos.casillaAbierta = casillaAbierta(fila, new Date())
  await registrarEvento(contact, 1, "wsp", null)
  const ev = await fetch(`${SUPABASE_URL}/rest/v1/vic_campanas?contact=eq.${contact}&select=campana,evento,at`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, cache: "no-store",
  }).then((r) => r.json()).catch(() => null)
  pasos.evento_registrado = Array.isArray(ev) && ev.length ? ev[ev.length - 1] : "NO SE REGISTRÓ"
  // Limpieza: la prueba no deja rastro.
  const borrar = async (ruta: string) =>
    (await fetch(`${SUPABASE_URL}/rest/v1/${ruta}`, {
      method: "DELETE",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Prefer: "return=minimal" },
      cache: "no-store",
    }).catch(() => null))?.status
  pasos.limpieza_casillas = await borrar(`${TABLA}?contact=eq.${contact}`)
  pasos.limpieza_eventos = await borrar(`vic_campanas?contact=eq.${contact}`)
  const quedo = (await leerCasillasLote([contact]).catch(() => new Map())).get(contact) || null
  pasos.limpio = !quedo
  return pasos
}

export async function GET(req: Request): Promise<Response> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  const url = new URL(req.url)
  const sp = url.searchParams
  const ahora = new Date()
  const pais = "cl"
  const dryExplicito = sp.get("dry") === "1"
  const enabled = ((await getKvValue("campana_react_enabled").catch(() => "")) || "").trim().toLowerCase() === "on"
  const dry = dryExplicito || !enabled
  const forzarHora = sp.get("forzarHora") === "1"
  const max = Math.min(Math.max(Number(sp.get("max")) || 40, 1), 150)
  const dias = Math.min(Math.max(Number(sp.get("dias")) || 90, 7), 365)
  const soloContacto = (sp.get("contact") || "").replace(/\D/g, "")
  const canalParam = sp.get("dia") as Canal | null
  const canal: Canal | null = canalParam && ["wsp", "mail"].includes(canalParam) ? canalParam : canalDelDia(pais, ahora)

  // Corrida automática con la campaña apagada: no evalúa nada.
  if (!dryExplicito && !enabled && !soloContacto) {
    return NextResponse.json({ ok: true, apagada: true, nota: "vic_kv campana_react_enabled != on — usa ?dry=1 para simular" })
  }
  const hora = horaLocalDe(pais, ahora)
  if (!dry && !forzarHora && hora !== HORA_CAMPANA) {
    return NextResponse.json({ ok: true, fueraDeHora: true, hora, canal })
  }
  if (!canal) return NextResponse.json({ ok: true, sinCanalHoy: true, nota: "la campaña corre martes (wsp) y miércoles (mail)" })

  const H = await zohoHeaders()
  const feriados = await feriadosDe(pais)
  // La UF solo se usa para leer un bloque de precio que vino en UF sin su
  // equivalente en pesos; si la fuente falla, el toque cae al texto del T1.
  const ufDia = Math.max(0, Number(sp.get("uf") || 0)) || (await getUFActual().catch(() => 0))

  // Un solo contacto: veredicto explicado (sin enviar salvo modo real explícito con ?contact=).
  if (sp.get("probarEscritura") === "1") {
    if (!soloContacto) return NextResponse.json({ ok: false, error: "falta contact" }, { status: 400 })
    return NextResponse.json({ ok: true, prueba: await probarEscritura(soloContacto, pais) })
  }

  if (soloContacto) {
    const ev = await evaluarGrupo1(soloContacto, { pais, ahora, H, feriados })
    const casillas = await leerCasillasLote([soloContacto])
    const fila = casillas.get(soloContacto) || null
    return NextResponse.json({
      ok: true, dry: true, contact: soloContacto, canal, grupo1: ev,
      casillas: fila, siguiente: siguienteCasilla(fila), abierta: casillaAbierta(fila, ahora),
    })
  }

  const filas: Fila[] = []
  let enviados = 0
  let evaluados = 0
  const presupuestoMs = 250_000
  const t0 = Date.now()
  let censo: { chatActivo: number; aEvaluar: number; precalculados: number } | null = null

  if (canal === "wsp") {
    // MARTES: universo → grupo 1 → primera casilla en falso.
    const universo = await universoCampana({ dias, H })
    const casillas = await leerCasillasLote(universo.map((u) => u.contact))

    // CENSO DEL DRY (cero envíos, cero escrituras): dos cosas para que el
    // pre-flight informe un volumen REAL y no un piso.
    //  (1) Pre-filtro en bloque por actividad de chat: descarta de una a la
    //      mayoría sin tocar Zoho ni vic_kv.
    //  (2) Lo que queda se evalúa por tandas de 4 en paralelo (suave para
    //      Zoho: la tormenta de tokens del 01-sep vino de martillar
    //      reintentos, no de cuatro llamadas), y con presupuesto RESERVADO —
    //      la primera versión se comió los 250 s completos y el loop de
    //      reporte quedó sin nada, así que el trabajo se hizo y se botó.
    const evalPrecalc = new Map<string, EvaluacionGrupo1>()
    const chatActivo = dry
      ? await contactosConChatReciente(universo.map((u) => u.contact), { ahora, pais, feriados }).catch((e) => {
          console.error("[campana] pre-filtro de chat falló", e)
          return new Map<string, { at: Date; minutos: number }>()
        })
      : new Map<string, { at: Date; minutos: number }>()
    if (dry) {
      const aEvaluar = universo.filter((u) => {
        if (chatActivo.has(u.contact)) return false
        const f = casillas.get(u.contact) || null
        return Boolean(siguienteCasilla(f)) && !casillaAbierta(f, ahora)
      })
      const presupuestoCenso = Math.floor(presupuestoMs * 0.55)
      for (let i = 0; i < aEvaluar.length; i += 4) {
        if (Date.now() - t0 > presupuestoCenso) break
        const tanda = aEvaluar.slice(i, i + 4)
        const evs = await Promise.all(
          tanda.map((c) => evaluarGrupo1(c.contact, { pais, ahora, H, feriados }).catch(() => null)),
        )
        tanda.forEach((c, k) => { const e = evs[k]; if (e) evalPrecalc.set(c.contact, e) })
      }
      censo = { chatActivo: chatActivo.size, aEvaluar: aEvaluar.length, precalculados: evalPrecalc.size }
    }

    for (const cand of universo) {
      if (enviados >= max || filas.length >= max * 3) break
      if (Date.now() - t0 > presupuestoMs) { filas.push({ contact: "-", empresa: null, quoteId: null, casilla: null, canal, omitido: "presupuesto_de_tiempo" }); break }
      const fila = casillas.get(cand.contact) || null
      const casilla = siguienteCasilla(fila)
      const base: Fila = { contact: cand.contact, empresa: cand.empresa, quoteId: cand.quoteId, origen: cand.origen, casilla, canal }
      if (!casilla) { base.omitido = "ciclo_completo (4 toques)"; filas.push(base); continue }
      // Una casilla por semana: si el último WhatsApp salió hace menos de 6 días, esperar.
      const abierta = casillaAbierta(fila, ahora)
      if (abierta) { base.omitido = `toque_${abierta}_en_curso`; filas.push(base); continue }
      // Del pre-filtro en bloque: ya sabemos que habló hace poco, así que no
      // se gasta ni el chequeo de descanso ni la evaluación completa.
      const act = chatActivo.get(cand.contact)
      if (act) {
        base.ultimaActividad = `chat ${act.at.toISOString().slice(0, 16)}`
        base.omitido = `activo_reciente (chat, ${act.minutos} min hábiles de ${MINUTOS_HABILES_INACTIVIDAD})`
        filas.push(base)
        continue
      }
      // DESCANSO (Lalo 10-sep): el toque 1 —de este ciclo o del siguiente— solo
      // sale si el último toque de CUALQUIER campaña tiene ≥4 semanas. Dentro
      // del ciclo los toques son semanales, así que no se evalúa.
      if (casilla === 1) {
        const ult = await ultimoToqueCampana(cand.contact)
        if (ult.fallas.length && !ult.at) {
          base.omitido = `no_evaluable (descanso: ${ult.fallas[0]})`
          filas.push(base)
          continue
        }
        const d = debeDescansar(ult.at, ahora)
        if (d.descansa) {
          base.omitido = `descanso_campana (${ult.fuente}, hace ${d.diasDesde} d, faltan ${d.diasFaltan} de ${DESCANSO_DIAS})`
          filas.push(base)
          if (!dry) await anotarEvaluacion(cand.contact, base.omitido, pais)
          continue
        }
      }
      evaluados++
      const ev = evalPrecalc.get(cand.contact) || (await evaluarGrupo1(cand.contact, { pais, ahora, H, feriados }))
      base.ultimaActividad = ev.ultimaActividad.at ? `${ev.ultimaActividad.fuente} ${ev.ultimaActividad.at.toISOString().slice(0, 16)}` : "sin actividad registrada"
      if (!ev.apto) {
        base.omitido = ev.detalle ? `${ev.motivo} (${ev.detalle})` : ev.motivo
        filas.push(base)
        if (!dry) await anotarEvaluacion(cand.contact, base.omitido, pais)
        continue
      }
      const { nombre, empresa } = await datosContacto(H, cand.contact, cand.quoteId)
      const plan = planDeToque(casilla, Boolean(nombre))
      const linkQuote = cand.quoteId ? linkCortoDe(cand.quoteId) : ""
      const ctx = plan.vars.includes("precio") || plan.vars.includes("gancho")
        ? await contextoDelChat(cand.contact, ufDia)
        : { precio: "", motivo: null }
      const nombreEmpresa = empresa || cand.empresa || "tu empresa"
      const vars: Record<string, string> = {}
      for (const v of plan.vars) {
        if (v === "nombre") vars.nombre = nombre || "de nuevo"
        else if (v === "empresa") vars.empresa = nombreEmpresa
        else if (v === "link") vars.link = linkQuote
        else if (v === "precio") vars.precio = ctx.precio
        else if (v === "gancho") vars.gancho = ganchoParaToque2(ctx.motivo)
        else if (v === "contexto") vars.contexto = cand.quoteId ? `Sobre tu cotización de ${nombreEmpresa}.` : "Sobre la cotización de control de asistencia que te dejé."
      }
      // Una plantilla con variable vacía sale rota: si falta el dato del gancho
      // (link o precio), el toque cae al texto del toque 1, que no necesita nada.
      const faltan = plan.vars.filter((v) => v !== "nombre" && !String(vars[v] || "").trim())
      const planFinal = faltan.length ? planDeToque(1, Boolean(nombre)) : plan
      const varsFinal = faltan.length ? (nombre ? { nombre } : {}) : vars
      if (dry) {
        base.accion = `SE ENVIARÍA toque ${casilla} (WhatsApp ${planFinal.tpl}${faltan.length ? ` · fallback T1, faltaba ${faltan.join("/")}` : ""}) — ${planFinal.descripcion}`
        filas.push(base)
        continue
      }
      // Toque 3 = la oferta del 10 % de dcto10: el porcentaje lo aplica el TAP
      // por el camino ya probado (procesarRespuestaCampana), nunca este runner.
      if (planFinal.tipo === "dcto") {
        await setKvValue(claveCampana(cand.contact), JSON.stringify({
          campana: `react_ciclo_t${casilla}`,
          segmento: cand.quoteId ? "2" : "1",
          quoteId: cand.quoteId || undefined,
          at: ahora.toISOString(),
        })).catch(() => {})
      }
      let tpl = planFinal.tpl
      let ok = await sendBotmakerTemplate(cand.contact, tpl, varsFinal).catch(() => false)
      if (!ok && tpl !== TPL_CON_NOMBRE && tpl !== TPL_SIN_NOMBRE) {
        // Plantilla del toque sin aprobar o rechazada por Meta: sale la del
        // toque 1 (aprobada) antes que no salir nada, y queda dicho en la fila.
        tpl = nombre ? TPL_CON_NOMBRE : TPL_SIN_NOMBRE
        ok = await sendBotmakerTemplate(cand.contact, tpl, nombre ? { nombre } : {}).catch(() => false)
        if (ok) base.omitido = `plantilla_${planFinal.tpl}_no_salio (se envió ${tpl})`
      }
      if (!ok) { base.accion = "ENVÍO FALLÓ (Botmaker)"; filas.push(base); continue }
      await marcarCasilla(cand.contact, casilla, "wsp", { pais, quoteId: cand.quoteId, empresa: empresa || cand.empresa, motivo: `toque ${casilla} enviado` })
      await registrarEvento(cand.contact, casilla, "wsp", cand.quoteId)
      await appendAssistantV3(
        cand.contact,
        `[REGISTRO INTERNO] Campaña de reactivación, toque ${casilla} de 4 (${ahora.toISOString().slice(0, 10)}): se le envió la plantilla de reactivación por su cotización${empresa || cand.empresa ? ` de ${empresa || cand.empresa}` : ""}. Si responde con interés: retomar la cotización desde donde quedó, actualizar dotación si cambió y cerrar con link de pago. Si dice que no: agradecer y cerrar sin insistir. Mañana le llega un correo solo si sigue sin responder.`,
      ).catch(() => {})
      enviados++
      base.accion = `enviado toque ${casilla} (WhatsApp, ${tpl})`
      filas.push(base)
      await new Promise((r) => setTimeout(r, 900))
    }
  } else {
    // MIÉRCOLES: casillas abiertas esta semana que aún no recibieron el correo.
    const campo = "mail"
    const desde = new Date(ahora.getTime() - 6 * 86_400_000).toISOString()
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/vic_campana_reactivacion?select=*&or=(toque1_wsp_at.gt.${desde},toque2_wsp_at.gt.${desde},toque3_wsp_at.gt.${desde},toque4_wsp_at.gt.${desde})&limit=500`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, cache: "no-store" },
    )
    const abiertas = ((await r.json().catch(() => [])) as FilaCasillas[]) || []
    for (const f of abiertas) {
      if (enviados >= max) break
      if (Date.now() - t0 > presupuestoMs) break
      const casilla = casillaAbierta(f, ahora)
      if (!casilla) continue
      const base: Fila = { contact: f.contact, empresa: f.empresa, quoteId: f.quote_id, casilla, canal }
      const yaSalio = f[`toque${casilla}_${campo}_at` as keyof FilaCasillas]
      if (yaSalio) { base.omitido = `${campo}_ya_enviado`; filas.push(base); continue }
      evaluados++
      const ev = await evaluarGrupo1(f.contact, { pais, ahora, H, feriados })
      base.ultimaActividad = ev.ultimaActividad.at ? `${ev.ultimaActividad.fuente} ${ev.ultimaActividad.at.toISOString().slice(0, 16)}` : "sin actividad registrada"
      // Actividad posterior al WhatsApp del martes corta la semana.
      const wspAt = Date.parse(String(f[`toque${casilla}_wsp_at` as keyof FilaCasillas] || ""))
      const huboActividadDespues = Boolean(ev.ultimaActividad.at) && (ev.ultimaActividad.at as Date).getTime() > wspAt
      if (!ev.apto || huboActividadDespues) {
        base.omitido = huboActividadDespues ? `actividad_tras_wsp (${ev.ultimaActividad.fuente})` : (ev.detalle ? `${ev.motivo} (${ev.detalle})` : ev.motivo)
        filas.push(base)
        if (!dry) await anotarEvaluacion(f.contact, base.omitido, pais)
        continue
      }
      if (dry) { base.accion = `SE ENVIARÍA toque ${casilla} (correo)`; filas.push(base); continue }
      const { nombre, email, empresa } = await datosContacto(H, f.contact, f.quote_id)
      if (!email) { base.omitido = "sin_email"; filas.push(base); continue }
      // El correo pasa por el MISMO gate de proactividad que el WhatsApp
      // (brecha (d) del 10-sep): en sombra solo registra, con GATE_ENFORCE frena.
      const gate = await evaluarGateProactividad(f.contact, { tipo: "texto" }).catch(() => null)
      if (gate && !gate.permitir) { base.omitido = `gate (${gate.motivos.join(", ").slice(0, 80)})`; filas.push(base); continue }
      const link = f.quote_id ? linkCortoDe(f.quote_id) : ""
      const ok = await enviarCorreo(H, f.quote_id, email, `Tu cotización de control de asistencia sigue vigente${empresa || f.empresa ? ` · ${empresa || f.empresa}` : ""}`, htmlCorreo(nombre, empresa || f.empresa || "", link)).catch(() => false)
      if (!ok) { base.accion = "ENVÍO FALLÓ (correo)"; filas.push(base); continue }
      await marcarCasilla(f.contact, casilla, "mail", { pais, motivo: `toque ${casilla} correo` })
      await registrarEvento(f.contact, casilla, "mail", f.quote_id)
      enviados++
      base.accion = `enviado toque ${casilla} (correo a ${email})`
      filas.push(base)
      await new Promise((r) => setTimeout(r, 600))
    }
  }

  const resumen: Record<string, number> = {}
  for (const f of filas) {
    const k = f.accion ? (f.accion.startsWith("SE ENVIARÍA") ? "se_enviaria" : f.accion.split(" (")[0]) : String(f.omitido || "?").split(" (")[0]
    resumen[k] = (resumen[k] || 0) + 1
  }
  return NextResponse.json({ ok: true, dry, enabled, canal, hora, fecha: ahora.toISOString(), dias, universo: filas.length, evaluados, enviados, censo, resumen, filas, ms: Date.now() - t0 })
}
