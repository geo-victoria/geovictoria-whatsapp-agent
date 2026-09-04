/**
 * CIERRE DIARIO DE VICKY — la foto del día y el correo de las 07:30.
 *
 * Lalo pidió (02-sep, mockups del panel y del correo) un reporte diario con lo
 * que Vicky vendió, lo que no vendió y por qué, y las fallas técnicas del día.
 * Los mockups prometían secciones que la data todavía no tiene (categoría de
 * objeción, cita textual, MRR en juego); esto entrega TODO lo que sí se puede
 * sostener con la base de hoy, y declara en el propio correo lo que falta.
 *
 * FUENTE ÚNICA: la foto se calcula acá, se guarda en vic_kv `foto_dia_<fecha>`
 * y de ahí la leen el correo y la vista del dash — así nunca muestran números
 * distintos, que es lo que el mockup promete en su pie.
 *
 * GET /api/vic-cierre-diario?key=<cron>            → HTML del cierre de AYER
 *   &fecha=YYYY-MM-DD   otra fecha
 *   &json=1             la foto cruda
 *   &enviar=1           manda el correo (idempotente por día; ventana 07-10 CL)
 *   &forzar=1           salta la ventana horaria (no salta la idempotencia)
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"
import { getZohoAccessToken } from "@/lib/zoho-token"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const ZOHO_API = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
const QUOTE_MODULE = (process.env.ZOHO_QUOTE_MODULE || "Cotizaciones_GeoVictoria").trim()
const MAIL_ANCHOR = (process.env.VIC_DASH_MAIL_ANCHOR || "Contacts/3525045000645054553").trim()
const FROM_EMAIL = (process.env.VICKY_FROM_EMAIL || "vicky@geovictoria.com").trim()
const DESTINOS = (process.env.VICKY_CIERRE_TO || "egomez@geovictoria.com,rlewit@geovictoria.com")
  .split(",").map((s) => s.trim()).filter(Boolean)

const H = () => ({ apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" })
const esc = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
const clp = (n: number) => `$${Math.round(n).toLocaleString("es-CL")}`
const fechaCL = (d: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago", year: "numeric", month: "2-digit", day: "2-digit" }).format(d)
const horaCL = (d: Date) => Number(new Intl.DateTimeFormat("es-CL", { timeZone: "America/Santiago", hour: "2-digit", hour12: false }).format(d))
const largo = (f: string) =>
  new Intl.DateTimeFormat("es-CL", { timeZone: "America/Santiago", weekday: "long", day: "numeric", month: "long" }).format(new Date(`${f}T12:00:00-04:00`))

async function autorizado(req: Request): Promise<boolean> {
  const secreto = await getFollowupCronSecret().catch(() => "")
  const cron = (process.env.CRON_SECRET || "").trim()
  const url = new URL(req.url)
  const auth = req.headers.get("authorization") || ""
  const dado =
    req.headers.get("x-cron-secret") || (auth.startsWith("Bearer ") ? auth.slice(7) : "") || url.searchParams.get("key") || ""
  return Boolean(dado) && (dado === secreto || (Boolean(cron) && dado === cron))
}

const sb = async <T,>(path: string): Promise<T[]> => {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: H(), cache: "no-store" })
  return r.ok ? ((await r.json().catch(() => [])) as T[]) : []
}
const mediana = (xs: number[]) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

type Foto = {
  fecha: string
  conversaciones: number
  nuevas: number
  formales: number
  medInicioFormal: number | null
  /** SOLO canal Vicky. El canal ejecutivo va aparte — ver ventasEjecutivo. */
  ventas: Array<{ cot: string; empresa: string; monto: number; dueno: string }>
  montoVentas: number
  /** Ventas del día del CANAL EJECUTIVO (cotizadora del dash), informativas. */
  ventasEjecutivo: number
  montoVentasEjecutivo: number
  /** Ventas que no se pudieron clasificar (Zoho no respondió): se declaran. */
  ventasSinClasificar: number
  motivos: Array<{ motivo: string; casos: Array<{ contact: string; resumen: string; accionable: string }> }>
  fallas: Array<{ contact: string; hora: string; mensajes: number }>
  traspasos: { total: number; sinContacto: number }
  generadoAt: string
}

async function construirFoto(fecha: string): Promise<Foto> {
  const d0 = `${fecha}T00:00:00-04:00`
  const d1 = `${fecha}T23:59:59-04:00`
  const rango = (col: string) => `${col}=gte.${encodeURIComponent(d0)}&${col}=lte.${encodeURIComponent(d1)}`

  // Conversaciones del día: contactos con mensaje del CLIENTE ese día.
  const msgs = await sb<{ conversation_id: string; role: string; at: string }>(
    `vic_v3_messages?select=conversation_id,role,at&${rango("at")}&limit=8000`,
  )
  const convsDia = new Set(msgs.filter((m) => m.role === "user").map((m) => m.conversation_id))
  const convs = await sb<{ id: string; contact: string; first_user_at: string; pref_escalon_at: string; formal_quote_at: string }>(
    `vic_v3_conversations?select=id,contact,first_user_at,pref_escalon_at,formal_quote_at&limit=4000&order=updated_at.desc`,
  )
  // El día es el día de CHILE, no el UTC: comparar el prefijo del ISO metía en
  // el día siguiente todo lo ocurrido después de las 20:00.
  const enDia = (iso?: string) => {
    const t = Date.parse(String(iso || ""))
    return Number.isFinite(t) && fechaCL(new Date(t)) === fecha
  }
  const nuevas = convs.filter((c) => enDia(c.first_user_at)).length
  const formal = convs.filter((c) => enDia(c.formal_quote_at))
  const mins = (a?: string, b?: string) =>
    a && b ? Math.round((Date.parse(b) - Date.parse(a)) / 60000) : null
  // Tiempo de la máquina: desde que el cliente escribe hasta que tiene su
  // cotización formal en la mano. (`pref_escalon_at` casi no se estampa —el
  // 02-sep, 2 veces contra 23 formales— así que un embudo apoyado en él
  // mentía: "2 vieron precio · 23 formales · 1150%".)
  const m1 = mediana(formal.map((c) => mins(c.first_user_at, c.formal_quote_at)).filter((n): n is number => n !== null && n >= 0))

  // Motivos de no-cierre del clasificador, con su accionable.
  // DOS LISTAS, porque el clasificador corre en rueda y va ATRASADO respecto
  // del día: `analyzed_at` es cuándo lo analizó, no cuándo pasó (el 02-sep
  // analizó 136 conversaciones habiendo 39, casi todas viejas), y de las 39 de
  // ese día solo 3 tenían motivo al día siguiente. Filtrar solo por el día
  // dejaba el correo en 2 casos; filtrar solo por analyzed_at lo llenaba de
  // conversaciones de otra semana disfrazadas de "hoy". Así que se dice cuál
  // es cuál: primero los del día, después el resto de lo revisado.
  const contactosDia = new Set(
    convs.filter((c) => convsDia.has(c.id)).map((c) => c.contact).filter(Boolean),
  )
  type Fila = { contact: string; motivo_no_cierre: string; resumen: string; accionable: string }
  const campos = "contact,motivo_no_cierre,resumen,accionable"
  const analisis = await sb<Fila>(
    `vic_v3_conversation_analysis?select=${campos}&${rango("analyzed_at")}&motivo_no_cierre=not.is.null&limit=400`,
  )
  const delDia: Fila[] = []
  if (contactosDia.size) {
    const lote = [...contactosDia].slice(0, 120).map((t) => `"${t}"`).join(",")
    delDia.push(
      ...(await sb<Fila>(
        `vic_v3_conversation_analysis?select=${campos}&contact=in.(${lote})&motivo_no_cierre=not.is.null&order=analyzed_at.desc&limit=200`,
      )),
    )
  }
  const porMotivo = new Map<string, Foto["motivos"][number]["casos"]>()
  const yaVisto = new Set<string>()
  // Los del día primero: si un contacto aparece en las dos listas, gana su
  // análisis más reciente y no se cuenta dos veces.
  for (const a of [...delDia, ...analisis]) {
    const k = String(a.motivo_no_cierre || "").trim()
    if (!k || yaVisto.has(a.contact)) continue
    yaVisto.add(a.contact)
    const esDelDia = contactosDia.has(a.contact)
    const clave = esDelDia ? k : `otros:${k}`
    const arr = porMotivo.get(clave) || []
    arr.push({ contact: a.contact, resumen: String(a.resumen || "").slice(0, 240), accionable: String(a.accionable || "").slice(0, 240) })
    porMotivo.set(clave, arr)
  }

  // FALLAS TÉCNICAS reales: los mensajes de error que Vicky mandó ese día.
  // Nacieron de la caída de la API del 03-sep: si Vicky no pudo responderle a
  // alguien, el cierre del día tiene que decirlo con nombre y hora.
  const errores = await sb<{ conversation_id: string; content: string; at: string }>(
    `vic_v3_messages?select=conversation_id,content,at&role=eq.assistant&${rango("at")}&content=like.*problema%20t*&limit=200`,
  )
  const convContacto = new Map(convs.map((c) => [c.id, c.contact]))
  const porContacto = new Map<string, { hora: string; n: number }>()
  for (const e of errores) {
    const c = convContacto.get(e.conversation_id) || "?"
    const prev = porContacto.get(c)
    porContacto.set(c, { hora: prev?.hora || e.at, n: (prev?.n || 0) + 1 })
  }

  // Traspasos del día y cuántos siguen sin contacto del vendedor.
  const ptv = await sb<{ contact: string; vendedor_email: string; traspasado_at: string }>(
    `vic_ptv?select=contact,vendedor_email,traspasado_at&${rango("traspasado_at")}&limit=200`,
  )
  const telsPtv = [...new Set(ptv.map((p) => p.contact))]
  let sinContacto = 0
  if (telsPtv.length) {
    const lote = telsPtv.map((t) => `"${t}"`).join(",")
    const espejo = await sb<{ telefono_chat: string; enviado_at: string }>(
      `vic_wa_espejo_mensajes?select=telefono_chat,enviado_at&from_me=eq.true&telefono_chat=in.(${lote})&enviado_at=gte.${encodeURIComponent(d0)}&limit=2000`,
    )
    const tocados = new Set(espejo.map((m) => m.telefono_chat))
    sinContacto = telsPtv.filter((t) => !tocados.has(t)).length
  }

  // VENTAS DEL DÍA — misma fuente que la Caja del dash (vic_kv `venta_dash_v3_`),
  // no una consulta propia. El primer intento filtraba Zoho por Modified_Time y
  // devolvía 15 "ventas" de $0 el 02-sep (cualquier cotización Pagada que un
  // cron hubiera tocado ese día) cuando las reales eran 5 por $257.289. El kv
  // lo escribe construirVentasCerradas SOLO con pago verificado y monto > 0
  // (recurrente + único del subform, con IVA), así que acá el número del correo
  // y el de la Caja no pueden discrepar.
  const ventas: Array<Foto["ventas"][number] & { canal?: string }> = []
  try {
    const filas = await sb<{ key: string; value: string }>(
      `vic_kv?select=key,value&key=like.venta_dash_v3_*&limit=3000`,
    )
    const delDia: Array<Foto["ventas"][number] & { _t: number; canal?: string }> = []
    for (const f of filas) {
      let v: { empresa?: string; numero?: string; pagoIso?: string; montoClp?: number } = {}
      try {
        v = JSON.parse(String(f.value || "{}"))
      } catch {
        continue
      }
      const t = Date.parse(String(v.pagoIso || ""))
      if (!Number.isFinite(t) || fechaCL(new Date(t)) !== fecha) continue
      delDia.push({
        cot: String(v.numero || "—"),
        empresa: String(v.empresa || "(sin nombre)"),
        monto: Number(v.montoClp || 0),
        dueno: "",
        _t: t,
      })
    }
    delDia.sort((a, b) => a._t - b._t)
    for (const v of delDia) ventas.push({ cot: v.cot, empresa: v.empresa, monto: v.monto, dueno: v.dueno })
  } catch (e) {
    console.warn("[cierre] ventas kv:", e instanceof Error ? e.message : e)
  }
  // Dueño de cada venta: una sola consulta a Zoho por los números del día.
  // Es un adorno — si Zoho no responde, la venta se muestra igual sin nombre.
  if (ventas.length) {
    try {
      const nums = ventas.map((v) => `'${v.cot.replace(/'/g, "")}'`).join(",")
      const token = await getZohoAccessToken()
      const r = await fetch(`${ZOHO_API}/crm/v8/coql`, {
        method: "POST",
        headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          select_query:
            `select Numero_Cotizacion, Owner.first_name, Owner.last_name, Intervenci_n_Humana from ${QUOTE_MODULE} ` +
            `where Numero_Cotizacion in (${nums}) limit 60`,
        }),
      })
      if (r.status === 200) {
        const dd = (await r.json().catch(() => ({}))) as {
          data?: Array<Record<string, unknown>>
        }
        const por = new Map<string, string>()
        const canalDe = new Map<string, string>()
        for (const q of dd.data || []) {
          const nom = `${String(q["Owner.first_name"] || "")} ${String(q["Owner.last_name"] || "")}`.trim()
          const cot = String(q.Numero_Cotizacion || "")
          por.set(cot, nom)
          canalDe.set(cot, String(q["Intervenci_n_Humana"] || ""))
        }
        for (const v of ventas) {
          v.dueno = por.get(v.cot) || ""
          v.canal = canalDe.get(v.cot) || ""
        }
      }
    } catch (e) {
      console.warn("[cierre] dueños:", e instanceof Error ? e.message : e)
    }
  }

  // SEPARAR CANAL (04-sep, correccion de Lalo). `venta_dash_v3_` es la Caja del
  // dash y ahi caen los DOS canales: el 03-sep tenia 7 pagos y solo UNO era de
  // Vicky (los otros 6 los cerraron Grey, Anderson y Ana Lopez desde la
  // cotizadora). El correo se llama "cierre de Vicky" y reportaba los 7 — sobre
  // esa foto contaminada se discutio media manana si la caida era real. El
  // discriminador oficial es `Intervenci_n_Humana` ('100% Vicky' vs 'Con
  // intervencion humana'), el mismo que usa el correo de PAGADA del cotizador.
  //
  // Sin clasificacion (Zoho no respondio) NO se atribuye a nadie: esas ventas
  // se cuentan aparte y el correo lo declara. Antes que inflar a Vicky,
  // decirlo.
  const esVicky = (v: { canal?: string }) => String(v.canal || "").startsWith("100%")
  const clasificadas = ventas.filter((v) => String(v.canal || "").trim() !== "")
  const deVicky = clasificadas.filter(esVicky)
  const deEjecutivo = clasificadas.filter((v) => !esVicky(v))

  return {
    fecha,
    conversaciones: convsDia.size,
    nuevas,
    formales: formal.length,
    medInicioFormal: m1,
    ventas: deVicky.map((v) => ({ cot: v.cot, empresa: v.empresa, monto: v.monto, dueno: v.dueno })),
    montoVentas: deVicky.reduce((s, v) => s + v.monto, 0),
    ventasEjecutivo: deEjecutivo.length,
    montoVentasEjecutivo: deEjecutivo.reduce((s, v) => s + v.monto, 0),
    ventasSinClasificar: ventas.length - clasificadas.length,
    motivos: [...porMotivo.entries()]
      .map(([motivo, casos]) => ({ motivo, casos }))
      .sort((a, b) => Number(a.motivo.startsWith("otros:")) - Number(b.motivo.startsWith("otros:")) || b.casos.length - a.casos.length),
    fallas: [...porContacto.entries()].map(([contact, v]) => ({ contact, hora: v.hora, mensajes: v.n })),
    traspasos: { total: telsPtv.length, sinContacto },
    generadoAt: new Date().toISOString(),
  }
}

const ETIQUETA_MOTIVO: Record<string, string> = {
  faltaron_datos: "Faltaron datos para cotizar",
  silencio: "Silencio después del precio",
  evaluando: "Está evaluando / lo ve con otro",
  precio: "Precio",
  prefirio_humano: "Pidió hablar con una persona",
  proveedor_actual: "Tiene otro proveedor",
  hardware: "Hardware o compatibilidad",
}

/** El prefijo `otros:` marca los casos que el clasificador revisó ese día pero
 * cuya conversación es de otro día — se muestran, pero dichos como lo que son. */
function etiquetaMotivo(k: string): string {
  const base = k.replace(/^otros:/, "")
  return ETIQUETA_MOTIVO[base] || base
}

function render(f: Foto, paraCorreo: boolean): string {
  const hhmm = (iso: string) =>
    new Intl.DateTimeFormat("es-CL", { timeZone: "America/Santiago", hour: "2-digit", minute: "2-digit" }).format(new Date(iso))
  const tasa = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—")
  const kpi = (n: string, l: string) =>
    `<td style="padding:0 16px 0 0;vertical-align:top"><div style="font-size:22px;font-weight:700;color:#0e8a6d">${n}</div><div style="font-size:11px;color:#6b7683">${l}</div></td>`
  const secc = (t: string, cuerpo: string) =>
    `<h3 style="font-size:14px;margin:22px 0 8px;color:#171d22">${t}</h3>${cuerpo}`
  const p = (t: string) => `<p style="margin:0 0 8px;font-size:13.5px;color:#39434a">${t}</p>`

  const ventas = f.ventas.length
    ? `<table style="width:100%;border-collapse:collapse;font-size:13px">${f.ventas
        .map(
          (v) =>
            `<tr><td style="padding:5px 8px 5px 0;border-bottom:1px solid #eceeec"><b>${esc(v.empresa)}</b> <span style="color:#7d8890">${esc(v.cot)}</span></td>` +
            `<td style="padding:5px 0;border-bottom:1px solid #eceeec;text-align:right">${v.monto ? clp(v.monto) : "—"}</td>` +
            `<td style="padding:5px 0 5px 12px;border-bottom:1px solid #eceeec;color:#7d8890">${esc(v.dueno)}</td></tr>`,
        )
        .join("")}</table>`
    : p("Ninguna cotización pasó a Pagada ese día.")

  const motivos = f.motivos.length
    ? f.motivos
        .map(
          (m) =>
            `<p style="margin:10px 0 4px;font-size:13.5px"><b>${esc(etiquetaMotivo(m.motivo))}</b> · ${m.casos.length} ${m.casos.length === 1 ? "caso" : "casos"}${m.motivo.startsWith("otros:") ? ` <span style="color:#9aa0a8">(revisado ese día, conversación de otro día)</span>` : ""}</p>` +
            `<ul style="margin:0 0 6px;padding-left:18px;font-size:13px;color:#39434a">${m.casos
              .slice(0, 4)
              .map((c) => `<li>+${esc(c.contact)} — ${esc(c.resumen || "sin resumen")}${c.accionable ? `<br><span style="color:#7d8890">Accionable: ${esc(c.accionable)}</span>` : ""}</li>`)
              .join("")}${m.casos.length > 4 ? `<li>y ${m.casos.length - 4} más</li>` : ""}</ul>`,
        )
        .join("")
    : p("El clasificador no marcó motivos de no-cierre ese día.")

  const fallas = f.fallas.length
    ? `<ul style="margin:0;padding-left:18px;font-size:13px;color:#39434a">${f.fallas
        .map((x) => `<li>+${esc(x.contact)} — ${x.mensajes} ${x.mensajes === 1 ? "mensaje" : "mensajes"} de error, desde las ${hhmm(x.hora)}</li>`)
        .join("")}</ul>`
    : p("Vicky respondió sin fallas técnicas ese día.")

  return `<div style="font-family:'IBM Plex Sans',Arial,sans-serif;max-width:680px;margin:0 auto;background:#fff;color:#1c2429;padding:22px 24px 30px">
  <div style="border-bottom:2px solid #0e8a6d;padding-bottom:12px;margin-bottom:16px">
    <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#7d8890">Cierre diario de Vicky</div>
    <h1 style="margin:4px 0 0;font-size:20px">${largo(f.fecha)}</h1>
    <div style="font-size:13px;color:#39434a;margin-top:4px">${f.ventas.length} ${f.ventas.length === 1 ? "venta" : "ventas"} de Vicky · ${clp(f.montoVentas)} cobrados · ${f.conversaciones} conversaciones · ${f.formales} formales</div>
    ${f.ventasEjecutivo ? `<div style="font-size:12px;color:#7d8890;margin-top:3px">Ese día el canal ejecutivo (cotizadora del dash) cerró además ${f.ventasEjecutivo} ${f.ventasEjecutivo === 1 ? "venta" : "ventas"} por ${clp(f.montoVentasEjecutivo)} — no entran en las cifras de Vicky.</div>` : ""}
    ${f.ventasSinClasificar ? `<div style="font-size:12px;color:#b26a00;margin-top:3px">${f.ventasSinClasificar} ${f.ventasSinClasificar === 1 ? "venta quedó" : "ventas quedaron"} sin clasificar por canal (Zoho no respondió): no se cuentan como de Vicky.</div>` : ""}
  </div>
  <table style="border-collapse:collapse;margin-bottom:4px"><tr>
    ${kpi(String(f.conversaciones), "conversaciones")}
    ${kpi(String(f.nuevas), "nuevas")}
    ${kpi(`${f.formales}`, `formales · ${tasa(f.formales, f.conversaciones)}`)}
    ${kpi(String(f.ventas.length), "ventas")}
  </tr></table>
  ${p(`Del primer mensaje del cliente a su cotización formal: <b>${f.medInicioFormal ?? "—"} min</b> (mediana). Cierre del día: <b>${tasa(f.ventas.length, f.formales)}</b> de las formales.`)}
  ${secc("Qué vendió", ventas)}
  ${secc("Qué no vendió, y por qué", motivos)}
  ${secc("Fallas técnicas del día", fallas)}
  ${secc("Traspasos al equipo", p(`${f.traspasos.total} conversaciones traspasadas ese día; ${f.traspasos.sinContacto} sin WhatsApp del ejecutivo en el resto del día. El detalle vive en el panel de Traspasos.`))}
  <p style="margin:22px 0 0;font-size:11.5px;color:#7d8890;border-top:1px solid #e5e7e6;padding-top:10px">
  Generado desde la foto del día que guarda el sistema, así que el panel y este correo muestran los mismos números.
  Lo que todavía NO trae: la categoría de cada objeción con la cita textual del cliente y el MRR en juego — el clasificador guarda hoy un motivo grueso, y enriquecerlo es el siguiente paso.
  ${paraCorreo ? "" : `<br>Foto calculada a las ${hhmm(f.generadoAt)}`}</p>
</div>`
}

async function yaEnviado(fecha: string): Promise<boolean> {
  const r = await sb<{ key: string }>(`vic_kv?key=eq.cierre_enviado_${fecha}&select=key&limit=1`)
  return r.length > 0
}

export async function GET(req: Request): Promise<NextResponse | Response> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  const url = new URL(req.url)
  const fecha = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("fecha") || "")
    ? String(url.searchParams.get("fecha"))
    : fechaCL(new Date(Date.now() - 86_400_000))
  const foto = await construirFoto(fecha)
  // La foto queda guardada: el panel y el correo leen de acá, nunca recalculan
  // por su cuenta (así no se contradicen entre sí).
  await fetch(`${SUPABASE_URL}/rest/v1/vic_kv?on_conflict=key`, {
    method: "POST",
    headers: { ...H(), Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ key: `foto_dia_${fecha}`, value: JSON.stringify(foto), expires_at: new Date(Date.now() + 400 * 86_400_000).toISOString() }),
  }).catch(() => {})

  if (url.searchParams.get("json") === "1") return NextResponse.json({ ok: true, foto })

  const html = render(foto, false)
  if (url.searchParams.get("enviar") !== "1") {
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } })
  }

  // ── Envío: una vez al día, en la ventana de la mañana ───────────────────
  const forzar = url.searchParams.get("forzar") === "1"
  const h = horaCL(new Date())
  if (!forzar && (h < 7 || h > 10)) return NextResponse.json({ ok: true, enviado: false, motivo: `fuera de ventana (hora CL ${h})` })
  if (await yaEnviado(fecha)) return NextResponse.json({ ok: true, enviado: false, motivo: "ya se envió el cierre de ese día" })

  const asunto = `Vicky · cierre ${largo(fecha)}: ${foto.ventas.length} ${foto.ventas.length === 1 ? "venta" : "ventas"} de Vicky · ${clp(foto.montoVentas)}`
  let ok = false
  try {
    const token = await getZohoAccessToken()
    const r = await fetch(`${ZOHO_API}/crm/v3/${MAIL_ANCHOR}/actions/send_mail`, {
      method: "POST",
      headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        data: [{ from: { email: FROM_EMAIL }, to: DESTINOS.map((email) => ({ email })), subject: asunto, content: render(foto, true), mail_format: "html" }],
      }),
    })
    ok = r.ok
    if (!r.ok) console.error("[cierre] send_mail", r.status, (await r.text().catch(() => "")).slice(0, 300))
  } catch (e) {
    console.error("[cierre] envío:", e instanceof Error ? e.message : e)
  }
  if (ok) {
    await fetch(`${SUPABASE_URL}/rest/v1/vic_kv?on_conflict=key`, {
      method: "POST",
      headers: { ...H(), Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ key: `cierre_enviado_${fecha}`, value: new Date().toISOString(), expires_at: new Date(Date.now() + 90 * 86_400_000).toISOString() }),
    }).catch(() => {})
  }
  return NextResponse.json({ ok: true, enviado: ok, fecha, destinos: DESTINOS, asunto })
}
