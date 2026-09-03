/**
 * CANARIO DEL CAMINO DE ORO + ALARMA DE CIERRE INTRADÍA (Rodrigo 03-sep).
 *
 * Nace del incidente 01→03 sep: un cinturón de teléfonos sin bordes rompió el
 * LINK DE PAGO durante ~44 horas (COT1105/COT1151/COT1162) y solo se descubrió
 * leyendo conversaciones, con el cierre diario ya desplomado (11→6→3→1).
 * Dos guardias para que el próximo se detecte en minutos, no en días:
 *
 *  1. CANARIO (cada corrida): pasa mensajes sintéticos —los tres casos REALES
 *     del incidente incluidos— por la MISMA tubería de cinturones que usa
 *     vic-botmaker-v3 (corrección de teléfonos → voseo/formato → blindaje
 *     comercial → blindaje de soporte) y exige que todo link /q/… y todo
 *     quote-acceptance…token=… salga BYTE A BYTE intacto. Incluye un control
 *     positivo: un número equivocado junto a "Tamara" DEBE corregirse — si el
 *     cinturón murió en silencio, también es falla. Y una sonda viva: el
 *     acceptance_url del último puntero de cotización debe responder 200.
 *
 *  2. ALARMA DE CIERRE (corrida de las 18h de Chile, o &alarma=1): si HOY hay
 *     ≥8 contactos que vieron precio y ≤1 pagada, correo inmediato — el
 *     patrón exacto del incidente (entrada récord, último metro muerto).
 *     Umbrales por env: VIC_ALARMA_MIN_PRECIO / VIC_ALARMA_MAX_PAGADAS.
 *
 * Cualquier falla del canario ⇒ correo inmediato a VICKY_CIERRE_TO (candado
 * kv 1/día por tipo) + kv `canario_estado` con el último resultado (para el
 * dash). La corrida es barata (<2 s sin fallas): corre cada hora por cron y
 * se puede invocar a mano tras CADA deploy que toque la salida de texto.
 *
 * GET /api/vic-canario            → corre canario (+alarma si es la hora)
 *   &alarma=1                     → evalúa el cierre fuera de la ventana
 *   &probar=correo                → manda un correo de prueba (sin candado)
 * Auth: x-cron-secret / Bearer / ?key= (followup secret o CRON_SECRET) — el
 * cron de Vercel llega con Bearer CRON_SECRET, igual que los demás crones.
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"
import { getZohoAccessToken } from "@/lib/zoho-token"
import {
  sanitizarVoseo,
  normalizarFormatoWhatsApp,
  quitarSignosApertura,
  blindarContactoComercial,
  blindarSoporteInventado,
} from "@/lib/voseo-v3"
import { corregirTelefonosEjecutivos, directorioEjecutivos } from "@/lib/directorio-ejecutivos"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const ZOHO_API = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
const QUOTE_MODULE = (process.env.ZOHO_QUOTE_MODULE || "Cotizaciones_GeoVictoria").trim()
const VICKY_ID = (process.env.ZOHO_VICKY_OWNER_ID || "3525045000484500876").trim()
const MAIL_ANCHOR = (process.env.VIC_DASH_MAIL_ANCHOR || "Contacts/3525045000645054553").trim()
const FROM_EMAIL = (process.env.VICKY_FROM_EMAIL || "vicky@geovictoria.com").trim()
const DESTINOS = (process.env.VICKY_CIERRE_TO || "egomez@geovictoria.com,rlewit@geovictoria.com")
  .split(",").map((s) => s.trim()).filter(Boolean)
const MIN_PRECIO = Number(process.env.VIC_ALARMA_MIN_PRECIO || 8)
const MAX_PAGADAS = Number(process.env.VIC_ALARMA_MAX_PAGADAS || 1)

const H = () => ({ apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" })
const fechaCL = (d: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago", year: "numeric", month: "2-digit", day: "2-digit" }).format(d)
const horaCL = (d: Date) =>
  Number(new Intl.DateTimeFormat("es-CL", { timeZone: "America/Santiago", hour: "2-digit", hour12: false }).format(d))

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

async function kvSet(key: string, value: string, dias = 90): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/vic_kv?on_conflict=key`, {
    method: "POST",
    headers: { ...H(), Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ key, value, expires_at: new Date(Date.now() + dias * 86_400_000).toISOString() }),
  }).catch(() => {})
}

async function kvGet(key: string): Promise<string> {
  const rows = await sb<{ value: string }>(`vic_kv?key=eq.${encodeURIComponent(key)}&select=value&limit=1`)
  return rows[0]?.value || ""
}

async function coql(query: string): Promise<Array<Record<string, unknown>>> {
  try {
    const token = await getZohoAccessToken()
    const r = await fetch(`${ZOHO_API}/crm/v3/coql`, {
      method: "POST",
      headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ select_query: query }),
    })
    if (r.status === 204) return []
    if (!r.ok) return []
    return (((await r.json().catch(() => ({}))) as { data?: Array<Record<string, unknown>> }).data) || []
  } catch {
    return []
  }
}

async function correo(asunto: string, html: string): Promise<boolean> {
  try {
    const token = await getZohoAccessToken()
    const r = await fetch(`${ZOHO_API}/crm/v3/${MAIL_ANCHOR}/actions/send_mail`, {
      method: "POST",
      headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        data: [{ from: { email: FROM_EMAIL }, to: DESTINOS.map((email) => ({ email })), subject: asunto, content: html, mail_format: "html" }],
      }),
    })
    if (!r.ok) console.error("[canario] send_mail", r.status, (await r.text().catch(() => "")).slice(0, 300))
    return r.ok
  } catch (e) {
    console.error("[canario] correo:", e instanceof Error ? e.message : e)
    return false
  }
}

// ── Guardia 1: la tubería de salida no puede tocar links ────────────────────
// Misma secuencia de cinturones que vic-botmaker-v3 aplica a cada respuesta.
function tuberia(texto: string): string {
  let t = corregirTelefonosEjecutivos(texto, new Set()).reply
  t = quitarSignosApertura(normalizarFormatoWhatsApp(sanitizarVoseo(t)))
  t = blindarContactoComercial(t, false)
  t = blindarSoporteInventado(t)
  return t
}

const URL_RE = /https?:\/\/[^\s<>"]+/g

type Falla = { caso: string; detalle: string }

function correrCanario(): { casos: number; fallas: Falla[] } {
  const fallas: Falla[] = []
  // Los tres links REALES del incidente 01→03 sep + un token JWT largo.
  const LINKS = [
    "https://cotizacion.geovictoria.com/q/3525045000657868552-50234689d5",
    "https://cotizacion.geovictoria.com/q/3525045000658072979-f47e3a8833",
    "https://cotizacion.geovictoria.com/q/3525045000655372983-8fb601c6e6",
    "https://cotizacion.geovictoria.com/quote-acceptance.html?token=eyJxdW90ZUlkIjoiMzUyNTA0NTAwMDY1NzU2NjE5NyIsImRlYWxJZCI6IjM1MjUwNDUwMDA2NTc1MzEwMDEifQ.abc-DEF_123",
  ]
  // Nombres que gatillan los cinturones (clientas reales se llaman así).
  const casos: Array<[string, string]> = [
    ["cliente Ana + /q/", `Lista tu cotización, Ana! 🎉 Revísala, acéptala y paga aquí: ${LINKS[0]}`],
    ["cliente Ana María + /q/", `Ana Maria, quedó actualizada 🙌 En el mismo link: ${LINKS[1]}`],
    ["ejecutiva Tamara + /q/", `Te acompaña Tamara Martinez de nuestro equipo. Tu cotización sigue aquí: ${LINKS[2]}`],
    ["token de aceptación + Paola", `Paola te va a llamar. Mientras, tu link de pago: ${LINKS[3]}`],
    ["dos ejecutivas + los 4 links", `Daniela y Tamara te acompañan. Links: ${LINKS.join(" y ")}`],
  ]
  for (const [nombre, texto] of casos) {
    const antes = texto.match(URL_RE) || []
    const salida = tuberia(texto)
    for (const url of antes) {
      if (!salida.includes(url)) {
        fallas.push({ caso: nombre, detalle: `link alterado: ${url} → salida: ${salida.slice(0, 240)}` })
      }
    }
  }
  // Control positivo: el cinturón debe SEGUIR corrigiendo un número equivocado
  // junto a una ejecutiva (si dejó de corregir, murió en silencio).
  const tamara = directorioEjecutivos().find((f) => /tamara/i.test(f.nombre))
  if (tamara) {
    const malo = "Escríbele a Tamara al +56 9 1111 2222 y te ayuda con todo."
    const { reply, correcciones } = corregirTelefonosEjecutivos(malo, new Set())
    if (!correcciones.length || reply.includes("1111 2222")) {
      fallas.push({ caso: "control positivo", detalle: "el cinturón ya NO corrige números equivocados de ejecutivos" })
    }
  }
  return { casos: casos.length + 1, fallas }
}

// Sonda viva: el link de aceptación del último puntero debe responder 200.
async function sondaLinkVivo(): Promise<{ ok: boolean; detalle: string }> {
  const filas = await sb<{ quote_id: string; acceptance_url: string }>(
    "vic_v3_quote_pointers?select=quote_id,acceptance_url&order=created_at.desc&limit=1",
  )
  const url = filas[0]?.acceptance_url || ""
  if (!url) return { ok: true, detalle: "sin punteros que sondear" }
  try {
    const r = await fetch(url, { cache: "no-store", redirect: "follow" })
    return r.ok
      ? { ok: true, detalle: `HTTP ${r.status} · ${filas[0].quote_id}` }
      : { ok: false, detalle: `acceptance_url del puntero ${filas[0].quote_id} respondió HTTP ${r.status}` }
  } catch (e) {
    return { ok: false, detalle: `acceptance_url inalcanzable: ${e instanceof Error ? e.message : e}` }
  }
}

// ── Guardia 2: alarma de cierre intradía ────────────────────────────────────
async function medirCierreHoy(): Promise<{ vieronPrecio: number; formales: number; pagadas: number }> {
  const hoy = fechaCL(new Date())
  const ini = `${hoy}T00:00:00-04:00`
  const fin = `${hoy}T23:59:59-04:00`
  // Preforms de hoy (misma señal de precio del dash), por conversación.
  const msgs = await sb<{ conversation_id: string }>(
    `vic_v3_messages?role=eq.assistant&or=(content.ilike.*Resumen%20mensual*,content.ilike.*Total%20mensual%20con%20IVA*)&at=gte.${encodeURIComponent(ini)}&select=conversation_id&limit=1000`,
  )
  const preforms = new Set(msgs.map((m) => m.conversation_id)).size
  const formales = (
    await coql(`select id from ${QUOTE_MODULE} where ((Created_By = ${VICKY_ID}) and (Created_Time between '${ini}' and '${fin}')) limit 200`)
  ).length
  const pagadas = (
    await coql(
      `select id from ${QUOTE_MODULE} where (((Created_By = ${VICKY_ID}) and (Estado_Cotizacion = 'Pagada')) and (Fecha_Hora_Cotizacion between '${ini}' and '${fin}')) limit 200`,
    )
  ).length
  return { vieronPrecio: Math.max(preforms, formales), formales, pagadas }
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  const { searchParams } = new URL(req.url)
  const hoy = fechaCL(new Date())

  if (searchParams.get("probar") === "correo") {
    const ok = await correo("[Vicky canario] Correo de prueba", "<p>El canario puede enviar correos. Nada está fallando.</p>")
    return NextResponse.json({ ok, prueba: "correo", destinos: DESTINOS })
  }

  // Guardia 1 — canario de la tubería + sonda del link vivo.
  const canario = correrCanario()
  const sonda = await sondaLinkVivo()
  if (!sonda.ok) canario.fallas.push({ caso: "sonda link vivo", detalle: sonda.detalle })

  if (canario.fallas.length) {
    console.error(`[canario] FALLA: ${JSON.stringify(canario.fallas).slice(0, 800)}`)
    const candado = `canario_alerta_${hoy}`
    if (!(await kvGet(candado))) {
      const html = `<p><b>🚨 El canario del camino de oro FALLÓ.</b> El link de pago (u otro cinturón de salida) puede estar roto EN PRODUCCIÓN ahora mismo — mismo patrón del incidente del 01-03 sep.</p>
<ul>${canario.fallas.map((f) => `<li><b>${f.caso}</b>: ${f.detalle.replace(/</g, "&lt;")}</li>`).join("")}</ul>
<p>Qué hacer: revisar el último deploy que tocó lib/voseo-v3.ts, lib/directorio-ejecutivos.ts o vic-botmaker-v3, y correr <code>npm test</code> (tests/link-cotizacion-intacto.test.ts). Mientras no pase el canario, cada cotización que Vicky entregue puede salir con link muerto.</p>`
      const enviado = await correo(`[Vicky canario] 🚨 Falla en la tubería de salida (${canario.fallas.length})`, html)
      if (enviado) await kvSet(candado, new Date().toISOString(), 7)
    }
  }
  await kvSet(
    "canario_estado",
    JSON.stringify({ at: new Date().toISOString(), ok: !canario.fallas.length, fallas: canario.fallas.slice(0, 5), sonda: sonda.detalle }),
    30,
  )

  // Guardia 2 — alarma de cierre: corrida de las 18h CL (o &alarma=1).
  let alarma: Record<string, unknown> | undefined
  const esVentana = horaCL(new Date()) === 18
  if (esVentana || searchParams.get("alarma") === "1") {
    const m = await medirCierreHoy()
    const dispara = m.vieronPrecio >= MIN_PRECIO && m.pagadas <= MAX_PAGADAS
    alarma = { ...m, umbral: `≥${MIN_PRECIO} precio y ≤${MAX_PAGADAS} pagadas`, dispara }
    const candado = `alarma_cierre_${hoy}`
    if (dispara && !(await kvGet(candado))) {
      const html = `<p><b>⚠️ Alarma de cierre de Vicky (${hoy}):</b> hoy <b>${m.vieronPrecio}</b> contactos vieron precio (${m.formales} formales emitidas) y solo <b>${m.pagadas}</b> pagó.</p>
<p>Es el patrón del incidente del 01-03 sep (entrada sana, último metro muerto). Revisar primero: que el link de pago llegue INTACTO en los chats de hoy, el estado del canario (kv <code>canario_estado</code>) y los últimos deploys del agente y del cotizador.</p>
<p>Umbral configurado: ≥${MIN_PRECIO} vieron precio y ≤${MAX_PAGADAS} pagadas a las 18:00. Se ajusta con VIC_ALARMA_MIN_PRECIO / VIC_ALARMA_MAX_PAGADAS.</p>`
      const enviado = await correo(`[Vicky alarma] ⚠️ ${m.vieronPrecio} vieron precio y ${m.pagadas} pagaron hoy`, html)
      if (enviado) await kvSet(candado, new Date().toISOString(), 7)
      alarma.correo = enviado
    }
  }

  return NextResponse.json({
    ok: !canario.fallas.length,
    canario: { casos: canario.casos, fallas: canario.fallas, sondaLink: sonda.detalle },
    ...(alarma ? { alarma } : {}),
  })
}
