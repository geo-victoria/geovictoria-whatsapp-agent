/**
 * CADENCIA DE CONTENIDO — el estado terminal del ciclo (artefacto 836b5316).
 *
 * Quien terminó los 4 toques del ciclo comercial sin dar señales sale de ventas
 * y pasa a esta cadencia: UNA pieza útil por correo cada 30 días, sin precio y
 * sin llamado a comprar. Las tres decisiones que el artefacto dejaba abiertas
 * (línea, frecuencia, opt-out) están tomadas y explicadas en
 * lib/contenido-cadencia.ts; Lalo (13-sep): "partamos con algo y luego que ella
 * valide lo que se implementó".
 *
 *   jueves 11:00 CL → una pieza a quien cumpla 30 días desde la anterior
 *
 * El jueves es día propio a propósito: el ciclo comercial usa martes (WhatsApp)
 * y miércoles (correo), así que nadie recibe dos cosas nuestras el mismo día
 * aunque alguna vez se crucen los universos.
 *
 * VUELTA A VENTAS: el runner evalúa el MISMO `evaluarGrupo1` de la campaña. Si
 * el contacto volvió a dar señales, no sale contenido y se avisa al equipo
 * (nombrando a su ejecutivo si tiene uno) — la cadencia se pausa sola mientras
 * esté activo y se retoma si vuelve a quedar en silencio. No hay marca
 * permanente: el estado E no es un hoyo negro.
 *
 * GET auth cron (?key= | x-cron-secret):
 *   ?dry=1             simula sin enviar (siempre permitido)
 *   ?max=N             tope de envíos por corrida (default 40)
 *   ?contact=569…      evalúa UNO y explica el veredicto
 *   ?forzarDia=1       corre fuera del jueves 11:00 (solo simulación/pruebas)
 *   ?probarCorreo=1&to=<email>[&pieza=<id>]   manda el correo REAL a una
 *                      dirección elegida, sin tocar clientes ni marcar nada
 *
 * MODO REAL solo con vic_kv `contenido_enabled`="on".
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret, getKvValue, setKvValue } from "@/lib/supabase-persistence-v3"
import { evaluarGateProactividad } from "@/lib/gate-proactividad"
import { avisarEquipoInterno } from "@/lib/alerta-interna"
import {
  CONTENIDO_DIAS,
  PIEZAS,
  correoDeContenido,
  siguientePieza,
  tocaContenido,
  type Pieza,
} from "@/lib/contenido-cadencia"
import {
  DESCANSO_DIAS,
  debeDescansar,
  evaluarGrupo1,
  feriadosDe,
  horaLocalDe,
  siguienteCasilla,
  ultimoToqueCampana,
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
const WA_VICKY = "https://wa.me/56967308227?text=Hola%20Vicky"
const HORA = 11
const DIA = "Thu"

type Estado = { at: string; piezas: string[] }

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

async function zohoHeaders(): Promise<Record<string, string>> {
  const { getZohoAccessToken } = await import("@/lib/zoho-token")
  const token = await getZohoAccessToken()
  return { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }
}

function nombrePila(raw: string | null | undefined): string {
  const s = String(raw || "").trim().split(/\s+/)[0] || ""
  if (!/^[A-Za-zÁÉÍÓÚÑáéíóúñ]{3,}$/.test(s)) return ""
  if (/^(prospecto|cliente|sr|sra|don|do[ñn]a|gerente|admin|rrhh|spa|ltda|eirl|contacto|usuario)$/i.test(s)) return ""
  return s[0].toUpperCase() + s.slice(1).toLowerCase()
}

async function datosContacto(H: Record<string, string>, contact: string, quoteId: string | null): Promise<{ nombre: string; email: string }> {
  const nueve = contact.slice(-9)
  let nombre = ""
  let email = ""
  try {
    const r = await fetch(`${ZOHO_API}/crm/v8/coql`, {
      method: "POST", headers: H, cache: "no-store",
      body: JSON.stringify({ select_query: `select First_Name, Email from Contacts where Phone like '%${nueve}%' order by Modified_Time desc limit 1` }),
    })
    const c = (((await r.json().catch(() => null)) as { data?: Array<{ First_Name?: string; Email?: string }> } | null)?.data || [])[0]
    nombre = nombrePila(c?.First_Name)
    email = String(c?.Email || "").trim()
  } catch { /* sin contacto */ }
  if (!email && quoteId) {
    try {
      const r = await fetch(`${ZOHO_API}/crm/v8/coql`, {
        method: "POST", headers: H, cache: "no-store",
        body: JSON.stringify({ select_query: `select Email_Contacto from ${QUOTE_MODULE} where id = '${quoteId}'` }),
      })
      const q = (((await r.json().catch(() => null)) as { data?: Array<{ Email_Contacto?: string }> } | null)?.data || [])[0]
      email = String(q?.Email_Contacto || "").trim()
    } catch { /* sin cotización */ }
  }
  return { nombre, email }
}

async function motivoNoCierre(contact: string): Promise<string | null> {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/vic_v3_conversations?contact=eq.${contact}&select=motivo_no_cierre&limit=1`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, cache: "no-store",
    })
    const f = ((await r.json().catch(() => [])) as Array<{ motivo_no_cierre?: string | null }>)[0]
    return f?.motivo_no_cierre || null
  } catch { return null }
}

async function ejecutivoDe(contact: string): Promise<string> {
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/vic_ptv?contact=eq.${contact}&estado=eq.activo&select=vendedor_nombre,vendedor_email&order=traspasado_at.desc&limit=1`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, cache: "no-store" },
    )
    const f = ((await r.json().catch(() => [])) as Array<{ vendedor_nombre?: string; vendedor_email?: string }>)[0]
    return (f?.vendedor_nombre || "").trim() || (f?.vendedor_email || "").split("@")[0] || ""
  } catch { return "" }
}

async function enviarCorreo(H: Record<string, string>, to: string, subject: string, html: string): Promise<boolean> {
  const anchor = (process.env.VIC_DASH_MAIL_ANCHOR || "Contacts/3525045000645054553").trim()
  const r = await fetch(`${ZOHO_API}/crm/v3/${anchor}/actions/send_mail`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ data: [{ from: { email: FROM_EMAIL }, to: [{ email: to }], subject, content: html, mail_format: "html" }] }),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  })
  return r.ok
}

async function registrarEvento(contact: string, n: number, piezaId: string): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/vic_campanas`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ contact, campana: `contenido_${n}`, evento: `enviado_correo:${piezaId}`, at: new Date().toISOString() }),
    cache: "no-store",
  }).catch(() => {})
}

type Fila = {
  contact: string
  empresa: string | null
  pieza?: string
  accion?: string
  omitido?: string
  piezasPrevias?: number
}

export async function GET(req: Request): Promise<Response> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  const sp = new URL(req.url).searchParams
  const ahora = new Date()
  const pais = "cl"
  const dryExplicito = sp.get("dry") === "1"
  const enabled = ((await getKvValue("contenido_enabled").catch(() => "")) || "").trim().toLowerCase() === "on"
  const dry = dryExplicito || !enabled
  const max = Math.min(Math.max(Number(sp.get("max")) || Number(process.env.CONTENIDO_MAX) || 40, 1), 150)
  const soloContacto = (sp.get("contact") || "").replace(/\D/g, "")
  const modoPrueba = sp.get("probarCorreo") === "1"

  // PRUEBA DEL CORREO: manda el cuerpo REAL a una dirección elegida. Exenta de
  // los tres gates (apagada · día · hora) — la verificación tiene que poder
  // correr ANTES de encender y cualquier día, que es justo lo que se rompió en
  // la campaña de reactivación al encenderla (13-sep).
  if (modoPrueba) {
    const to = (sp.get("to") || "").trim()
    if (!/^[^@\s]+@[^@\s]+$/.test(to)) return NextResponse.json({ ok: false, error: "falta to=<email>" }, { status: 400 })
    const pieza: Pieza = PIEZAS.find((p) => p.id === (sp.get("pieza") || "").trim()) || PIEZAS[0]
    const H = await zohoHeaders().catch(() => null)
    if (!H) return NextResponse.json({ ok: false, error: "sin token Zoho" }, { status: 503 })
    const { asunto, html } = correoDeContenido({ nombre: "Lalo", pieza, fromEmail: FROM_EMAIL, waUrl: WA_VICKY })
    const ok = await enviarCorreo(H, to, `PRUEBA · ${asunto}`, html).catch(() => false)
    return NextResponse.json({ ok, to, pieza: pieza.id, asunto, piezas: PIEZAS.map((p) => p.id) })
  }

  if (!dryExplicito && !enabled && !soloContacto) {
    return NextResponse.json({ ok: true, apagada: true, nota: "vic_kv contenido_enabled != on — usa ?dry=1 para simular" })
  }
  const forzar = sp.get("forzarDia") === "1"
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: "America/Santiago", weekday: "short" }).format(ahora)
  const hora = horaLocalDe(pais, ahora)
  if (!dry && !forzar && (wd !== DIA || hora !== HORA)) {
    return NextResponse.json({ ok: true, fueraDeVentana: true, dia: wd, hora, nota: `la cadencia de contenido corre ${DIA} ${HORA}:00 CL` })
  }

  const H = await zohoHeaders()
  const feriados = await feriadosDe(pais)

  // UNIVERSO = quienes completaron el ciclo de 4 toques. Con las casillas
  // llenándose en orden, `toque4_wsp_at` poblado ES el ciclo completo.
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/vic_campana_reactivacion?select=*&toque4_wsp_at=not.is.null&limit=2000`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, cache: "no-store" },
  )
  // Un 400 de PostgREST leído con `.catch(() => [])` se ve EXACTAMENTE igual
  // que "no hay nadie en el estado terminal" — y es el error que ya tuvo a la
  // campaña de reactivación apagada de hecho (11-sep) y que hizo declarar "247
  // no vistos" a un verificador que no había leído nada (13-sep). La ausencia
  // de datos no es un hallazgo: si la consulta falla, se dice.
  if (!r.ok) {
    const detalle = (await r.text().catch(() => "")).slice(0, 200)
    return NextResponse.json({ ok: false, error: `universo ilegible: supabase ${r.status}`, detalle }, { status: 502 })
  }
  // `total` separa las dos lecturas: cuántos hay en la tabla del ciclo y
  // cuántos llegaron al estado terminal.
  const rTotal = await fetch(`${SUPABASE_URL}/rest/v1/vic_campana_reactivacion?select=contact&limit=1`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Prefer: "count=exact" }, cache: "no-store",
  }).catch(() => null)
  const enCiclo = Number(String(rTotal?.headers.get("content-range") || "").split("/")[1] || "") || 0
  let universo = ((await r.json().catch(() => [])) as FilaCasillas[]) || []
  if (soloContacto) universo = universo.filter((f) => f.contact === soloContacto)

  const filas: Fila[] = []
  let enviados = 0
  const t0 = Date.now()
  const presupuestoMs = 250_000

  for (const f of universo) {
    if (enviados >= max || filas.length >= Math.max(max * 3, 200)) break
    if (Date.now() - t0 > presupuestoMs) { filas.push({ contact: "-", empresa: null, omitido: "presupuesto_de_tiempo" }); break }
    const base: Fila = { contact: f.contact, empresa: f.empresa }
    if (siguienteCasilla(f)) { base.omitido = "ciclo_incompleto"; filas.push(base); continue }

    const estadoRaw = await getKvValue(`contenido_${f.contact}`).catch(() => null)
    let estado: Estado = { at: "", piezas: [] }
    try { if (estadoRaw) estado = JSON.parse(estadoRaw) as Estado } catch { /* estado ilegible = empezar */ }
    base.piezasPrevias = estado.piezas.length

    const t = tocaContenido(estado.at || null, ahora)
    if (!t.toca) { base.omitido = `espera_frecuencia (hace ${t.diasDesde} d, faltan ${t.diasFaltan} de ${CONTENIDO_DIAS})`; filas.push(base); continue }

    // La PRIMERA pieza respeta el descanso de 4 semanas desde el último toque
    // comercial: pasar del toque 4 al contenido la semana siguiente sería el
    // mismo acoso con otra cara. Después manda el reloj mensual.
    if (!estado.piezas.length) {
      const ult = await ultimoToqueCampana(f.contact)
      if (ult.fallas.length && !ult.at) { base.omitido = `no_evaluable (descanso: ${ult.fallas[0]})`; filas.push(base); continue }
      const d = debeDescansar(ult.at, ahora)
      if (d.descansa) { base.omitido = `descanso_campana (hace ${d.diasDesde} d, faltan ${d.diasFaltan} de ${DESCANSO_DIAS})`; filas.push(base); continue }
    }

    // Baja propia del contenido (la pide el lector; se estampa a mano o desde
    // la respuesta al correo). El resto del opt-out lo comparte con la campaña.
    if (await getKvValue(`contenido_baja_${f.contact}`).catch(() => null)) { base.omitido = "baja_contenido"; filas.push(base); continue }

    const ev = await evaluarGrupo1(f.contact, { pais, ahora, H, feriados })
    if (!ev.apto) {
      base.omitido = ev.detalle ? `${ev.motivo} (${ev.detalle})` : ev.motivo
      // VOLVIÓ A DAR SEÑALES: sale de contenido y es de ventas otra vez. Se
      // avisa UNA vez (candado 30 d) nombrando a su ejecutivo si tiene uno; la
      // cadencia se pausa sola y se retoma si vuelve a quedar en silencio.
      if (ev.motivo === "activo_reciente" && !dry) {
        // vic_kv no tiene TTL, así que la ventana de 30 d se mide en código
        // sobre el `at` del propio valor.
        const ya = await getKvValue(`contenido_vuelta_${f.contact}`).catch(() => null)
        let avisadoHace = Number.POSITIVE_INFINITY
        try { avisadoHace = (ahora.getTime() - Date.parse((JSON.parse(String(ya || "{}")) as { at?: string }).at || "")) / 86_400_000 } catch { /* ilegible = avisar */ }
        if (!ya || !Number.isFinite(avisadoHace) || avisadoHace >= 30) {
          const ejec = await ejecutivoDe(f.contact)
          await avisarEquipoInterno(
            `📚➡️💬 Contenido: +${f.contact}${f.empresa ? ` (${f.empresa})` : ""} volvió a dar señales (${ev.ultimaActividad.fuente}) y sale de la cadencia de contenido.${ejec ? ` Su ejecutivo es ${ejec}.` : " Sin ejecutivo asignado."}`,
          ).catch(() => {})
          await setKvValue(`contenido_vuelta_${f.contact}`, JSON.stringify({ at: ahora.toISOString(), fuente: ev.ultimaActividad.fuente })).catch(() => {})
        }
      }
      filas.push(base)
      continue
    }

    const pieza = siguientePieza(estado.piezas, await motivoNoCierre(f.contact))
    if (!pieza) { base.omitido = "catalogo_agotado"; filas.push(base); continue }
    base.pieza = pieza.id

    if (dry) { base.accion = `SE ENVIARÍA "${pieza.titulo}"`; filas.push(base); continue }

    const { nombre, email } = await datosContacto(H, f.contact, f.quote_id)
    if (!email) { base.omitido = "sin_email"; filas.push(base); continue }
    // Mismo gate de proactividad que el WhatsApp y el correo de la campaña.
    const gate = await evaluarGateProactividad(f.contact, { tipo: "texto" }).catch(() => null)
    if (gate && !gate.permitir) { base.omitido = `gate (${gate.motivos.join(", ").slice(0, 80)})`; filas.push(base); continue }

    const { asunto, html } = correoDeContenido({ nombre, empresa: f.empresa, pieza, fromEmail: FROM_EMAIL, waUrl: WA_VICKY })
    const ok = await enviarCorreo(H, email, asunto, html).catch(() => false)
    if (!ok) { base.accion = "ENVÍO FALLÓ (correo)"; filas.push(base); continue }
    const n = estado.piezas.length + 1
    await setKvValue(`contenido_${f.contact}`, JSON.stringify({ at: ahora.toISOString(), piezas: [...estado.piezas, pieza.id] })).catch(() => {})
    await registrarEvento(f.contact, n, pieza.id)
    enviados++
    base.accion = `enviada pieza ${n} "${pieza.titulo}" a ${email}`
    filas.push(base)
    await new Promise((res) => setTimeout(res, 600))
  }

  const resumen: Record<string, number> = {}
  for (const f of filas) {
    const k = f.accion ? (f.accion.startsWith("SE ENVIARÍA") ? "se_enviaria" : f.accion.split(" (")[0].split(" \"")[0]) : String(f.omitido || "?").split(" (")[0]
    resumen[k] = (resumen[k] || 0) + 1
  }
  return NextResponse.json({ ok: true, dry, enabled, dia: wd, hora, enCiclo, universo: universo.length, revisados: filas.length, enviados, frecuenciaDias: CONTENIDO_DIAS, piezasCatalogo: PIEZAS.length, resumen, filas, ms: Date.now() - t0 })
}
