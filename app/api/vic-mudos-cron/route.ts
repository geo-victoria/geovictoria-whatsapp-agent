/**
 * DETECTOR "VICKY MUDA" (pedido Lalo 08-ago).
 *
 * Cada tick barre el feed de mensajes de Botmaker (la ÚNICA fuente que ve lo
 * que el cliente escribió aunque la acción de código no haya corrido) y lo
 * cruza contra vic_v3_messages. Todo mensaje de cliente que NO llegó a Vicky
 * dispara una alerta por correo a Lalo y Rodrigo, UNA sola vez por mensaje
 * (dedupe en vic_kv, TTL 7 días).
 *
 * Contexto: auditoría 08-ago encontró ~417 mensajes silenciados desde el
 * 11-jul — chats TOMADOS por agentes en la consola de Botmaker (vendedores
 * post-PTV, Mesa de Ayuda) donde el bot queda muteado y nadie atiende. El
 * detalle de cada alerta incluye QUIÉN tiene tomado el chat.
 *
 * Ventana: últimos 90 min con 10 min de gracia (un mensaje en pleno
 * procesamiento no es un mudo). Cron cada 30 min → solape 3x, el dedupe
 * absorbe la repetición.
 *
 * Auth: Bearer/key CRON_SECRET o secreto operativo de vic_kv.
 */

import { NextResponse } from "next/server"
import { createHash } from "crypto"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"
import { getZohoAccessToken } from "@/lib/zoho-token"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const BM_TOKEN = (process.env.BOTMAKER_ACCESS_TOKEN || "").trim()
const CRON_SECRET = (process.env.CRON_SECRET || "").trim()
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim().replace(/\/$/, "")
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const ZOHO_API_DOMAIN = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
const FROM_EMAIL = (process.env.VICKY_FROM_EMAIL || "vicky@geovictoria.com").trim()
const MAIL_ANCHOR = (process.env.VIC_DASH_MAIL_ANCHOR || "Contacts/3525045000645054553").trim()
const DESTINOS = (process.env.VICKY_MUDOS_ALERTA_TO || "egomez@geovictoria.com,rlewit@geovictoria.com")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
// Solo las líneas que VICKY atiende: en las demás (p. ej. soporte 56927526890)
// responden humanos y un "sin respuesta de Vicky" no significa nada. El primer
// tick real (08-ago) alertó justo un caso de la línea de soporte — ruido.
const CANALES_VICKY = (process.env.VICKY_MUDOS_CANALES || "56967308227,573181070737,5215659778486,51922067167")
  .split(",")
  .map((s) => s.trim().replace(/\D/g, ""))
  .filter(Boolean)

const BM_HEADERS = { "access-token": BM_TOKEN, Accept: "application/json" }
const SB_HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
}

type BmItem = {
  creationTime?: string
  from?: string
  content?: { type?: string; text?: string }
  chat?: { chatId?: string; channelId?: string; contactId?: string }
}

type Mudo = { contact: string; canal: string; fecha: string; texto: string; tomadoPor: string; reinyectado?: boolean }

// AUTO-REMEDIACIÓN (Lalo 11-ago, "corrige para que no vuelva a pasar"): un
// mudo confirmado ya no solo se alerta — su mensaje se RE-INYECTA al webhook
// de Vicky (mismo contrato que la acción de código: contact/message/channelId
// + x-secret) para que ella lo procese y responda por la API push, que
// entrega aunque el chat esté tomado en la consola. Candados: solo mensajes
// de TEXTO, una sola vez por mensaje (kv TTL 7d), tope por tick, y JAMÁS si
// alguien (agente o bot) ya respondió después del mensaje del cliente.
// Rollback sin deploy: env VICKY_MUDOS_REINYECTA=0.
const REINYECTA = (process.env.VICKY_MUDOS_REINYECTA || "1").trim() !== "0"
const REINYECTA_MAX_POR_TICK = Math.max(1, Number(process.env.VICKY_MUDOS_REINYECTA_MAX || 5) || 5)
const BOTMAKER_SECRET = (process.env.BOTMAKER_SECRET || "").trim()

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase()
const sha = (s: string) => createHash("sha1").update(s).digest("hex")

async function autorizado(req: Request): Promise<boolean> {
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim()
  if (CRON_SECRET && bearer === CRON_SECRET) return true
  const key = (new URL(req.url).searchParams.get("key") || "").trim()
  if (CRON_SECRET && key === CRON_SECRET) return true
  if (key) {
    const kvSecret = await getFollowupCronSecret().catch(() => "")
    if (kvSecret && key === kvSecret) return true
  }
  return false
}

/** Feed de Botmaker en la ventana [from, to], siguiendo nextPage. */
async function feedBotmaker(fromIso: string, toIso: string): Promise<BmItem[]> {
  let url = `https://api.botmaker.com/v2.0/messages?limit=250&long-term-search=false&from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}&offset=0&pag=true`
  const items: BmItem[] = []
  for (let page = 0; page < 8 && url; page++) {
    const r = await fetch(url, { headers: BM_HEADERS, cache: "no-store" })
    if (!r.ok) throw new Error(`Botmaker ${r.status} en página ${page + 1}`)
    const j = (await r.json().catch(() => null)) as { items?: BmItem[]; nextPage?: string } | null
    items.push(...(Array.isArray(j?.items) ? j.items : []))
    url = String(j?.nextPage || "")
    if (!Array.isArray(j?.items) || j.items.length === 0) break
  }
  return items
}

/** User messages nuestros desde una fecha, por contacto (paginado de a 1000 —
 * PostgREST capa las respuestas). */
async function nuestrosPorContacto(fromIso: string): Promise<Map<string, string[]>> {
  const porConvId = new Map<string, string>()
  for (let page = 0; page < 10; page++) {
    const convs = (await fetch(
      `${SUPABASE_URL}/rest/v1/vic_v3_conversations?select=id,contact&order=id.asc&limit=1000&offset=${page * 1000}`,
      { headers: SB_HEADERS, cache: "no-store" },
    ).then((r) => (r.ok ? r.json() : [])).catch(() => [])) as Array<{ id: string; contact: string }>
    for (const c of convs) porConvId.set(c.id, c.contact)
    if (convs.length < 1000) break
  }
  const out = new Map<string, string[]>()
  for (let page = 0; page < 10; page++) {
    const rows = (await fetch(
      `${SUPABASE_URL}/rest/v1/vic_v3_messages?role=eq.user&at=gte.${encodeURIComponent(fromIso)}&select=conversation_id,content&order=at.asc&limit=1000&offset=${page * 1000}`,
      { headers: SB_HEADERS, cache: "no-store" },
    ).then((r) => (r.ok ? r.json() : [])).catch(() => [])) as Array<{ conversation_id: string; content: string }>
    for (const r of rows) {
      const contact = porConvId.get(r.conversation_id)
      if (!contact) continue
      const arr = out.get(contact) || []
      arr.push(norm(String(r.content || "")))
      out.set(contact, arr)
    }
    if (rows.length < 1000) break
  }
  return out
}

/** ¿Ya alertamos este mensaje? Marca con TTL 7d si no. */
async function yaAlertado(clave: string): Promise<boolean> {
  const key = `mudo_${sha(clave)}`
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/vic_kv?key=eq.${encodeURIComponent(key)}&select=key&limit=1`,
    { headers: SB_HEADERS, cache: "no-store" },
  ).then((x) => (x.ok ? x.json() : [])).catch(() => []) as Array<{ key: string }>
  if (r.length) return true
  await fetch(`${SUPABASE_URL}/rest/v1/vic_kv?on_conflict=key`, {
    method: "POST",
    headers: { ...SB_HEADERS, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      key,
      value: new Date().toISOString(),
      expires_at: new Date(Date.now() + 7 * 24 * 3600e3).toISOString(),
    }),
  }).catch(() => {})
  return false
}

/** Quién tiene TOMADO el chat en Botmaker (email del agente, o ""). */
async function tomadoPor(contact: string, canal: string, agentes: Map<string, string>): Promise<string> {
  try {
    const r = await fetch(
      `https://api.botmaker.com/v2.0/chats?contact-id=${encodeURIComponent(contact)}&channel-id=${encodeURIComponent(canal)}`,
      { headers: BM_HEADERS, cache: "no-store" },
    )
    if (!r.ok) return ""
    const j = (await r.json().catch(() => null)) as { items?: Array<{ agentId?: string }> } | null
    const agentId = String(j?.items?.[0]?.agentId || "")
    if (!agentId) return ""
    return agentes.get(agentId) || agentId
  } catch {
    return ""
  }
}

async function rosterAgentes(): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  try {
    const r = await fetch("https://api.botmaker.com/v2.0/agents", { headers: BM_HEADERS, cache: "no-store" })
    if (!r.ok) return out
    const j = (await r.json().catch(() => null)) as { items?: Array<{ id?: string; email?: string }> } | null
    for (const a of j?.items || []) if (a.id && a.email) out.set(a.id, a.email)
  } catch { /* best-effort */ }
  return out
}

async function enviarAlerta(mudos: Mudo[]): Promise<boolean> {
  const filas = mudos
    .map(
      (m) => `<tr>
<td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;white-space:nowrap"><a href="https://wa.me/${m.contact}">+${m.contact}</a></td>
<td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;white-space:nowrap">${m.fecha.replace("T", " ").slice(5, 16)}</td>
<td style="padding:6px 10px;border-bottom:1px solid #e2e8f0">${m.texto.replace(/</g, "&lt;").slice(0, 200)}</td>
<td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;white-space:nowrap">${m.tomadoPor || "—"}</td>
<td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;white-space:nowrap">${m.reinyectado ? '<span style="color:#15803d">re-inyectado ✓ (Vicky responde)</span>' : "—"}</td>
</tr>`,
    )
    .join("")
  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#2d3748;line-height:1.5">
<h2 style="color:#b91c1c;margin:0 0 6px">⚠️ Vicky muda: ${mudos.length} mensaje(s) de cliente sin respuesta</h2>
<p style="margin:0 0 14px">Estos mensajes llegaron a Botmaker pero <b>nunca a Vicky</b> (la acción de código no corrió — típicamente el chat está tomado por un agente en la consola). El cliente sigue esperando.</p>
<table style="border-collapse:collapse;font-size:13px"><thead><tr>
<th style="text-align:left;padding:6px 10px;border-bottom:2px solid #cbd5e0">Cliente</th>
<th style="text-align:left;padding:6px 10px;border-bottom:2px solid #cbd5e0">Hora (UTC)</th>
<th style="text-align:left;padding:6px 10px;border-bottom:2px solid #cbd5e0">Mensaje</th>
<th style="text-align:left;padding:6px 10px;border-bottom:2px solid #cbd5e0">Chat tomado por</th>
<th style="text-align:left;padding:6px 10px;border-bottom:2px solid #cbd5e0">Auto-respuesta</th>
</tr></thead><tbody>${filas}</tbody></table>
<p style="margin:16px 0 0;color:#718096">Detector vic-mudos-cron · corre cada 30 min · Vicky · GeoVictoria</p>
</body></html>`
  try {
    const token = await getZohoAccessToken()
    const res = await fetch(`${ZOHO_API_DOMAIN}/crm/v3/${MAIL_ANCHOR}/actions/send_mail`, {
      method: "POST",
      headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        data: [
          {
            from: { email: FROM_EMAIL },
            to: DESTINOS.map((email) => ({ email })),
            subject: `⚠️ Vicky muda: ${mudos.length} mensaje(s) de cliente sin respuesta`,
            content: html,
            mail_format: "html",
          },
        ],
      }),
    })
    if (!res.ok) {
      console.error(`[mudos-cron] send_mail ${res.status}:`, (await res.text().catch(() => "")).slice(0, 250))
      return false
    }
    return true
  } catch (e) {
    console.error("[mudos-cron] send_mail lanzó:", e instanceof Error ? e.message : e)
    return false
  }
}

export async function GET(req: Request): Promise<Response> {
  if (!(await autorizado(req))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }
  if (!BM_TOKEN) {
    return NextResponse.json({ ok: false, error: "BOTMAKER_ACCESS_TOKEN no configurado" }, { status: 500 })
  }

  const ahora = Date.now()
  const GRACIA_MIN = 10
  const VENTANA_MIN = 90
  const sp = new URL(req.url).searchParams
  // Modo AUDITORÍA (?desde=ISO&hasta=ISO&dry=1): ventana libre de hasta 24 h
  // para barrer historia, sin correo, sin marcas kv y sin re-inyección — solo
  // lista lo que habría detectado. Lo usa la revisión de reportes.
  const dry = sp.get("dry") === "1"
  const desdeParam = Date.parse(sp.get("desde") || "")
  const hastaParam = Date.parse(sp.get("hasta") || "")
  const ventanaCustom = Number.isFinite(desdeParam) && Number.isFinite(hastaParam) && desdeParam < hastaParam &&
    hastaParam - desdeParam <= 24 * 3600e3
  const fromIso = ventanaCustom ? new Date(desdeParam).toISOString() : new Date(ahora - VENTANA_MIN * 60e3).toISOString()
  const toIso = ventanaCustom ? new Date(hastaParam).toISOString() : new Date(ahora - GRACIA_MIN * 60e3).toISOString()

  // Simulacro (?simulacro=1): valida el camino del correo sin esperar un mudo real.
  if (new URL(req.url).searchParams.get("simulacro")) {
    const enviado = await enviarAlerta([
      {
        contact: "56900000000",
        canal: "GeoVictoriaEspaol-whatsapp-56967308227",
        fecha: new Date().toISOString(),
        texto: "[SIMULACRO] Así se verá la alerta cuando un cliente hable y Vicky no responda.",
        tomadoPor: "prueba@geovictoria.com",
      },
    ])
    return NextResponse.json({ ok: true, simulacro: true, alerta_enviada: enviado })
  }

  let feed: BmItem[] = []
  try {
    feed = await feedBotmaker(fromIso, toIso)
    await fetch(`${SUPABASE_URL}/rest/v1/vic_kv?on_conflict=key`, {
      method: "POST",
      headers: { ...SB_HEADERS, Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ key: "mudos_feed_fails", value: "0" }),
    }).catch(() => {})
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[mudos-cron]", msg)
    // CEGUERA (pregunta de Lalo 08-ago: ¿y si el problema es Botmaker?): si su
    // API falla 3 ticks seguidos (~90 min), el detector no puede ver nada —
    // eso TAMBIÉN se alerta, porque un Botmaker caído significa además que
    // los mensajes de clientes pueden no estar llegando a la acción de código.
    try {
      const row = (await fetch(
        `${SUPABASE_URL}/rest/v1/vic_kv?key=eq.mudos_feed_fails&select=value&limit=1`,
        { headers: SB_HEADERS, cache: "no-store" },
      ).then((r) => (r.ok ? r.json() : []))) as Array<{ value: string }>
      const fails = (Number(row[0]?.value || 0) || 0) + 1
      await fetch(`${SUPABASE_URL}/rest/v1/vic_kv?on_conflict=key`, {
        method: "POST",
        headers: { ...SB_HEADERS, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ key: "mudos_feed_fails", value: String(fails) }),
      })
      if (fails === 3) {
        await enviarAlerta([
          {
            contact: "0",
            canal: "API de Botmaker",
            fecha: new Date().toISOString(),
            texto: `⛔ DETECTOR CIEGO: la API de Botmaker lleva ${fails} ticks fallando (${msg}). Mientras dure, no podemos ver si hay clientes sin respuesta.`,
            tomadoPor: "",
          },
        ])
      }
    } catch { /* best-effort */ }
    return NextResponse.json({ ok: false, error: msg }, { status: 502 })
  }

  const nuestros = await nuestrosPorContacto(fromIso)
  // RESPUESTAS EN CONSOLA (fix 11-ago): el feed también trae los mensajes de
  // agentes/bot. Si alguien respondió DESPUÉS del mensaje del cliente, ese
  // cliente está atendido — ni alerta ni re-inyección (antes alertábamos
  // igual y el "chat tomado por" era en realidad un agente atendiendo).
  const respuestasPorContacto = new Map<string, number[]>()
  for (const it of feed) {
    if (String(it.from || "").toLowerCase() === "user") continue
    const canalNum = String(it.chat?.channelId || "").replace(/\D/g, "")
    if (!CANALES_VICKY.some((c) => canalNum.endsWith(c))) continue
    const cid = String(it.chat?.contactId || "").trim()
    const t = Date.parse(String(it.creationTime || ""))
    if (!cid || !Number.isFinite(t)) continue
    const arr = respuestasPorContacto.get(cid) || []
    arr.push(t)
    respuestasPorContacto.set(cid, arr)
  }

  type Candidato = Omit<Mudo, "tomadoPor"> & { textoCrudo: string; esTexto: boolean }
  const candidatos: Candidato[] = []
  let atendidosEnConsola = 0
  for (const it of feed) {
    if (String(it.from || "").toLowerCase() !== "user") continue
    const canalNum = String(it.chat?.channelId || "").replace(/\D/g, "")
    if (!CANALES_VICKY.some((c) => canalNum.endsWith(c))) continue
    const cid = String(it.chat?.contactId || "").trim()
    if (!cid || /[^\d]/.test(cid)) continue
    const tipo = String(it.content?.type || "")
    const textoCrudo = String(it.content?.text || "").trim()
    let texto = textoCrudo
    // Los botones de plantilla llegan como texto JSON {"button":...} — se
    // reportan legibles; cualquier otro tipo (audio/imagen) se identifica.
    if (texto.startsWith('{"button"')) {
      try {
        texto = `[botón] ${String((JSON.parse(texto) as { button?: string }).button || texto)}`
      } catch { /* se deja crudo */ }
    }
    if (!texto && tipo !== "text") texto = `[${tipo || "adjunto"}]`
    if (!texto) continue
    const registrados = nuestros.get(cid) || []
    const n = norm(texto)
    if (registrados.some((rg) => rg.includes(n))) continue
    // ADJUNTOS (caso Jazmin 11-ago): un PDF/imagen entra al feed como "[file]"
    // pero Vicky lo registra enriquecido ("[El cliente envió un DOCUMENTO…]").
    // Si el tipo no es texto y Vicky tiene registrado ALGÚN adjunto de este
    // contacto en la ventana, se da por recibido — el texto literal no calza
    // nunca y alertaba conversaciones perfectamente atendidas.
    if (tipo !== "text" && registrados.some((rg) => rg.includes("el cliente envió") || rg.startsWith("["))) continue
    // ¿Alguien (agente en consola o bot) respondió después de este mensaje?
    const tMsg = Date.parse(String(it.creationTime || ""))
    const respuestas = respuestasPorContacto.get(cid) || []
    if (Number.isFinite(tMsg) && respuestas.some((tr) => tr > tMsg)) {
      atendidosEnConsola++
      continue
    }
    candidatos.push({
      contact: cid,
      canal: String(it.chat?.channelId || ""),
      fecha: String(it.creationTime || ""),
      texto,
      textoCrudo,
      esTexto: tipo === "text" && !!textoCrudo,
    })
  }

  // Modo auditoría: lista completa con "tomado por", sin marcas ni acciones.
  if (dry) {
    const agentes = await rosterAgentes()
    const porContactoCanal = new Map<string, string>()
    const lista: Mudo[] = []
    for (const c of candidatos) {
      const k = `${c.contact}|${c.canal}`
      if (!porContactoCanal.has(k)) porContactoCanal.set(k, await tomadoPor(c.contact, c.canal, agentes))
      lista.push({ contact: c.contact, canal: c.canal, fecha: c.fecha, texto: c.texto, tomadoPor: porContactoCanal.get(k) || "" })
    }
    // CONVERSACIONES CRUZADAS (Lalo 11-ago): contacto cuyo mensaje ENTRÓ por
    // una línea pero cuyas respuestas SALIERON solo por OTRA — Meta rechaza el
    // envío sin sesión en esa línea y el cliente no recibe nada. Se computa
    // sobre TODO el feed (sin filtro de canal): entrada = líneas con mensajes
    // del cliente; salida = líneas con mensajes nuestros posteriores.
    const linea = (canal: string) => (String(canal).match(/(\d{6,})\s*$/) || [])[1] || ""
    const entradas = new Map<string, Set<string>>()
    const salidas = new Map<string, Set<string>>()
    for (const it of feed) {
      const cid = String(it.chat?.contactId || "").trim()
      const ln = linea(String(it.chat?.channelId || ""))
      if (!cid || !ln || /[^\d]/.test(cid)) continue
      const mapa = String(it.from || "").toLowerCase() === "user" ? entradas : salidas
      const set = mapa.get(cid) || new Set<string>()
      set.add(ln)
      mapa.set(cid, set)
    }
    const cruzados: Array<{ contact: string; entro_por: string[]; salio_por: string[] }> = []
    for (const [cid, ent] of entradas) {
      const sal = salidas.get(cid)
      if (!sal || !sal.size) continue
      // Cruce REAL: ninguna de las salidas usó una línea por la que el
      // cliente entró (si al menos una salida fue por su línea, sí recibió).
      const algunaCoincide = [...sal].some((s) => ent.has(s))
      if (!algunaCoincide) cruzados.push({ contact: cid, entro_por: [...ent], salio_por: [...sal] })
    }
    return NextResponse.json({
      ok: true, dry: true,
      ventana: { from: fromIso, to: toIso },
      feed: feed.length, atendidos_en_consola: atendidosEnConsola,
      cruzados,
      mudos: lista,
    })
  }

  // Dedupe (una alerta por mensaje, para siempre dentro del TTL).
  const nuevos: Candidato[] = []
  for (const c of candidatos) {
    if (!(await yaAlertado(`${c.contact}|${c.fecha}|${c.texto}`))) nuevos.push(c)
  }

  // ── RE-INYECCIÓN: el mudo confirmado vuelve al pipeline de Vicky ──
  // Se agrupan los mensajes de texto por contacto (en orden) y se mandan al
  // webhook CL, que rutea CO/MX/PE por prefijo. La respuesta sale por la API
  // push (entrega aunque el chat esté tomado). Una vez por mensaje (kv),
  // tope por tick, y la alerta informa si se auto-remedió.
  const reinyectados = new Set<string>()
  if (REINYECTA && BOTMAKER_SECRET && nuevos.length) {
    const origin = new URL(req.url).origin
    const porContacto = new Map<string, Candidato[]>()
    for (const c of nuevos) {
      if (!c.esTexto) continue
      const arr = porContacto.get(c.contact) || []
      arr.push(c)
      porContacto.set(c.contact, arr)
    }
    let inyectados = 0
    for (const [contact, msgs] of porContacto) {
      if (inyectados >= REINYECTA_MAX_POR_TICK) break
      // Candado por mensaje: si TODOS los mensajes de este contacto ya se
      // re-inyectaron alguna vez, no repetir.
      const marcas = await Promise.all(msgs.map((m) => yaAlertado(`reinj|${m.contact}|${m.fecha}|${m.texto}`)))
      if (marcas.every(Boolean)) continue
      msgs.sort((a, b) => a.fecha.localeCompare(b.fecha))
      const mensaje = msgs.map((m) => m.textoCrudo).join("\n")
      const canal = msgs[msgs.length - 1].canal
      inyectados++
      try {
        // Timeout corto A PROPÓSITO: el webhook procesa en su propia invocación
        // (siga o no viva esta conexión) y puede tardar 30-60 s en responder.
        // Con entregar el request basta; el abort NO cancela el procesamiento.
        const r = await fetch(`${origin}/api/vic-botmaker-v3`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-secret": BOTMAKER_SECRET },
          body: JSON.stringify({ contact, message: mensaje, channelId: canal }),
          cache: "no-store",
          signal: AbortSignal.timeout(8000),
        })
        if (r.ok) {
          for (const m of msgs) reinyectados.add(`${m.contact}|${m.fecha}`)
          console.log(`[mudos-cron] re-inyectado ${contact} (${msgs.length} msg) → Vicky respondió (${r.status})`)
        } else {
          console.error(`[mudos-cron] re-inyección de ${contact} falló: HTTP ${r.status}`)
        }
      } catch (e) {
        const esTimeout = e instanceof Error && e.name === "TimeoutError"
        if (esTimeout) {
          // El request LLEGÓ (la conexión se estableció); el webhook sigue
          // procesando por su cuenta — se cuenta como re-inyectado.
          for (const m of msgs) reinyectados.add(`${m.contact}|${m.fecha}`)
          console.log(`[mudos-cron] re-inyectado ${contact} (${msgs.length} msg) — el webhook sigue procesando (timeout local esperado)`)
        } else {
          console.error(`[mudos-cron] re-inyección de ${contact} lanzó:`, e instanceof Error ? e.message : e)
        }
      }
    }
  }

  let enviado = false
  const mudos: Mudo[] = []
  if (nuevos.length) {
    const agentes = await rosterAgentes()
    const porContactoCanal = new Map<string, string>()
    for (const c of nuevos) {
      const k = `${c.contact}|${c.canal}`
      if (!porContactoCanal.has(k)) porContactoCanal.set(k, await tomadoPor(c.contact, c.canal, agentes))
      mudos.push({
        contact: c.contact, canal: c.canal, fecha: c.fecha, texto: c.texto,
        tomadoPor: porContactoCanal.get(k) || "",
        reinyectado: reinyectados.has(`${c.contact}|${c.fecha}`),
      })
    }
    enviado = await enviarAlerta(mudos)
    console.log(`[mudos-cron] ${mudos.length} mudos nuevos (${reinyectados.size} re-inyectados), alerta ${enviado ? "enviada" : "FALLÓ"}:`,
      mudos.map((m) => `${m.contact}@${m.fecha}`).join(", "))
  }

  return NextResponse.json({
    ok: true,
    ventana: { from: fromIso, to: toIso },
    feed: feed.length,
    candidatos: candidatos.length,
    atendidos_en_consola: atendidosEnConsola,
    nuevos: nuevos.length,
    reinyectados: reinyectados.size,
    alerta_enviada: enviado,
    mudos,
  })
}
