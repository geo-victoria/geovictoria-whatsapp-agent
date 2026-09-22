/**
 * VICKY EN MESSENGER E INSTAGRAM — receptor de la Graph API de Meta (15-sep,
 * orden de Lalo: "usemos la API de Meta Graph para que Vicky responda los
 * chats de la página de GeoVictoria de Facebook (Messenger e Instagram)").
 *
 * UNA SOLA VICKY (15-sep, orden de Lalo: "yo usaría la misma vicky para este
 * canal, solo que reemplazaría el id que en whatsapp es la línea telefónica
 * por un id que designe meta… ideal dejar funcionando la vicky que ya opera
 * en whatsapp, incluyendo los toques, los relojes, tools, conexiones,
 * automatizaciones, todo"). Este receptor NO tiene cerebro propio: cada
 * evento de Meta se traduce al contrato del webhook chileno
 * (`POST /api/vic-botmaker-v3` con contact `FB.<psid>`/`IG.<igsid>`, message,
 * imageUrl/fileUrl) y se ENTREGA a esa misma función. Ahí
 * corren los cinturones, las tools, los hitos de Zoho y el loop; la respuesta
 * sale por `sendBotmakerMessage`, que reconoce el prefijo FB./IG. y la manda
 * por la Graph API (lib/meta-graph.ts) en vez de Botmaker. El teléfono lo
 * pide Vicky en la conversación (directivaCanalMeta) y queda como alias del
 * contacto (kv `telefono_meta_<FB.x>`) + `Phone`/`Social_ID` del lead.
 *
 * Contrato con Meta:
 *   GET  ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…  → devuelve el challenge
 *   POST { object: "page" | "instagram", entry: [{ messaging: [{ sender, recipient, message }] }] }
 *        firma `X-Hub-Signature-256` = sha256 HMAC del cuerpo crudo con el App Secret.
 *        Meta exige 200 en < 20 s: se responde al tiro y se procesa con `after()`.
 * Envío: POST https://graph.facebook.com/<v>/me/messages?access_token=<PAGE_TOKEN>
 *        { recipient: { id }, messaging_type: "RESPONSE", message: { text } }
 *        (Instagram va por el mismo endpoint con el token de la Página vinculada).
 *
 * Envs: META_VERIFY_TOKEN (la que se pega en el panel de webhooks) ·
 *       META_PAGE_ACCESS_TOKEN (token de Página de larga duración, System User) ·
 *       META_APP_SECRET (para verificar la firma; sin él NO se aceptan eventos) ·
 *       META_GRAPH_VERSION (default v21.0).
 * Gate: vic_kv `meta_canal_enabled`="on" — apagado, Vicky recibe y NO contesta
 * (se registra para revisar), así el webhook se puede verificar en Meta sin
 * exponer a Vicky antes de tiempo.
 *
 * Contacto en la base: `FB.<psid>` / `IG.<igsid>` — misma convención que los
 * marcadores de país (`PE.`), fuera del radar de todos los crones (filtran
 * por prefijo 56/57/52/51).
 */

import { NextResponse, after } from "next/server"
import { createHmac, timingSafeEqual } from "node:crypto"
import { POST as webhookVickyCL } from "@/app/api/vic-botmaker-v3/route"
import { getKvValue, setKvValue } from "@/lib/supabase-persistence-v3"
import { avisarEquipoInterno } from "@/lib/alerta-interna"
import { typingMeta, perfilMeta } from "@/lib/meta-graph"

export const dynamic = "force-dynamic"
export const maxDuration = 120

// CREDENCIALES: env de Vercel manda; si falta, vic_kv (`meta_verify_token`,
// `meta_page_access_token`, `meta_app_secret`) — así se configura sin deploy
// y sin pasar por el panel de Vercel (15-sep, Lalo pegó el App Secret por
// chat y no hay acceso a las envs desde la sesión). Se leen por request.
const GRAPH = `https://graph.facebook.com/${(process.env.META_GRAPH_VERSION || "v21.0").trim()}`

type Creds = { verify: string; token: string; secret: string }
async function credenciales(): Promise<Creds> {
  const env = (k: string) => (process.env[k] || "").trim()
  const kv = async (k: string) => ((await getKvValue(k).catch(() => null)) || "").trim()
  return {
    verify: env("META_VERIFY_TOKEN") || (await kv("meta_verify_token")),
    token: env("META_PAGE_ACCESS_TOKEN") || (await kv("meta_page_access_token")),
    secret: env("META_APP_SECRET") || (await kv("meta_app_secret")),
  }
}
function firmaValida(raw: string, header: string | null, secret: string): boolean {
  if (!secret) return false
  const h = (header || "").trim()
  if (!h.startsWith("sha256=")) return false
  const esperado = createHmac("sha256", secret).update(raw, "utf8").digest("hex")
  const a = Buffer.from(h.slice(7), "hex")
  const b = Buffer.from(esperado, "hex")
  return a.length === b.length && timingSafeEqual(a, b)
}

type Adjunto = { tipo: string; url: string }
type Evento = { canal: "messenger" | "instagram"; psid: string; texto: string; mid: string; adjuntos: Adjunto[]; pageId: string }

// PAÍS POR PÁGINA (15-sep, pregunta de Lalo "¿desde Messenger tenemos cómo
// diferenciar el país del usuario?"): Messenger NO trae el país de la persona
// (pedirle su locale exige el permiso pages_user_locale y App Review). Lo que
// SÍ viene en cada evento es `entry[].id` = la PÁGINA a la que escribió, y
// las páginas son por país: GeoVictoria (146240428778861) es Chile; Brasil y
// España quedaron conectadas sin suscripción. Mapa por defecto acá + override
// sin deploy en vic_kv `meta_pagina_pais_<pageId>` ("cl"/"co"/"mx"/"pe"/"off").
// Hoy solo Chile tiene Vicky por este canal: otro país se registra y se
// descarta con aviso (un solo aviso por página por día).
const PAIS_POR_PAGINA: Record<string, string> = { "146240428778861": "cl" }
async function paisDePagina(pageId: string): Promise<string> {
  const kv = ((await getKvValue(`meta_pagina_pais_${pageId}`).catch(() => null)) || "").trim().toLowerCase()
  return kv || PAIS_POR_PAGINA[pageId] || "cl"
}

function extraerEventos(body: unknown): Evento[] {
  const out: Evento[] = []
  const b = body as { object?: string; entry?: Array<{ messaging?: Array<Record<string, unknown>> }> }
  const canal: "messenger" | "instagram" = b?.object === "instagram" ? "instagram" : "messenger"
  for (const e of b?.entry || []) {
    const pageId = String((e as { id?: string }).id || "")
    for (const m of e.messaging || []) {
      const msg = m.message as { mid?: string; text?: string; is_echo?: boolean; attachments?: Array<{ type?: string; payload?: { url?: string } }> } | undefined
      const sender = (m.sender as { id?: string } | undefined)?.id
      if (!msg || msg.is_echo || !sender) continue
      const adjuntos: Adjunto[] = (Array.isArray(msg.attachments) ? msg.attachments : [])
        .map((a) => ({ tipo: String(a?.type || ""), url: String(a?.payload?.url || "").trim() }))
        .filter((a) => a.url)
      out.push({ canal, psid: String(sender), texto: String(msg.text || "").trim(), mid: String(msg.mid || ""), adjuntos, pageId })
    }
  }
  return out
}

/**
 * Entrega el evento a la MISMA Vicky de WhatsApp Chile. El contrato del
 * webhook (BotmakerRequest) se arma tal cual lo mandaría la acción de código
 * de Botmaker: `contact` = FB.<psid>/IG.<igsid>, `message`, y el adjunto como
 * imageUrl (foto) o fileUrl (PDF/otro) — la URL del CDN de Meta es pública
 * por un rato, suficiente para que la visión la lea. Audio/video de Meta no
 * se transcriben (no viene como URL de audio compatible): se pasa el
 * placeholder que el webhook ya entiende.
 */
async function atender(ev: Evento): Promise<void> {
  const contact = `${ev.canal === "instagram" ? "IG" : "FB"}.${ev.psid}`
  const pais = await paisDePagina(ev.pageId)
  if (pais !== "cl") {
    const dia = new Date().toISOString().slice(0, 10)
    const llave = `meta_pagina_ajena_${ev.pageId}_${dia}`
    if (!(await getKvValue(llave).catch(() => null))) {
      setKvValue(llave, "1").catch(() => {})
      await avisarEquipoInterno(`ℹ️ Vicky ${ev.canal}: llegó un mensaje a la página ${ev.pageId} (país "${pais}") y por Messenger solo atendemos Chile — no se respondió. PSID ${ev.psid}: "${ev.texto.slice(0, 80)}"`).catch(() => false)
    }
    console.log(`[vic-meta] página ${ev.pageId} país=${pais}: evento descartado`)
    return
  }
  const imagen = ev.adjuntos.find((a) => a.tipo === "image")
  const archivo = ev.adjuntos.find((a) => a.tipo === "file")
  const audio = ev.adjuntos.find((a) => a.tipo === "audio" || a.tipo === "video")
  let message = ev.texto
  if (!message) {
    if (imagen) message = "__image__"
    else if (archivo) message = "__file__"
    else if (audio) message = "__audio__"
  }
  if (!message && !imagen && !archivo) return
  const body: Record<string, unknown> = { contact, message }
  if (imagen) body.imageUrl = imagen.url
  else if (archivo) body.fileUrl = archivo.url
  typingMeta(contact, true).catch(() => {})
  // Perfil de la persona (nombre/apellido/foto; locale/timezone/gender si
  // los permisos existen) — se cachea ANTES de entregar el turno para que el
  // lead nazca con nombre y Vicky pueda saludar. Fail-open, ≤6 s.
  await perfilMeta(contact).catch(() => null)
  const req = new Request("http://vicky.local/api/vic-botmaker-v3", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-secret": (process.env.BOTMAKER_SECRET || "").trim() },
    body: JSON.stringify(body),
  })
  const res = await webhookVickyCL(req)
  if (!res.ok) {
    const detalle = (await res.text().catch(() => "")).slice(0, 200)
    console.error(`[vic-meta] webhook CL respondió ${res.status} para ${contact}: ${detalle}`)
    await avisarEquipoInterno(`⚠️ Vicky ${ev.canal}: la Vicky de WhatsApp respondió ${res.status} para ${contact} — ${detalle}`).catch(() => false)
  }
}

/**
 * DIAGNÓSTICO (solo lectura, auth cron): `?diag=1&key=…` — con el token de
 * Página pregunta a Graph qué página es, qué cuenta de Instagram tiene
 * vinculada y si la página está SUSCRITA a esta app (sin la suscripción el
 * webhook está verificado pero no llega nada). Sirve para revisar la
 * configuración del panel sin adivinar.
 */
async function diagnostico(): Promise<Record<string, unknown>> {
  const c = await credenciales()
  if (!c.token) return { ok: false, error: "sin META_PAGE_ACCESS_TOKEN", envs: { verify: Boolean(c.verify), secret: Boolean(c.secret), token: false } }
  const g = async (path: string) => {
    const r = await fetch(`${GRAPH}${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(c.token)}`, { cache: "no-store" }).catch(() => null)
    if (!r) return { error: "sin respuesta" }
    return (await r.json().catch(() => ({ error: `http ${r.status}` }))) as Record<string, unknown>
  }
  // El token que genera el panel de Messenger trae SOLO `pages_messaging`
  // (verificado 15-sep con debug_token): `/me` y `/me/subscribed_apps` exigen
  // pages_read_engagement / pages_manage_metadata y responden #100/#200 aunque
  // el canal esté sano. La sonda que sí prueba el permiso que importa es
  // `/me/conversations` — si responde, la página puede recibir y enviar.
  const me = await g("/me?fields=id,name,instagram_business_account{id,username}")
  const subs = await g("/me/subscribed_apps?fields=id,name,subscribed_fields")
  const conv = await g("/me/conversations?platform=messenger&limit=1")
  const convOk = !(conv as { error?: unknown }).error
  const ultimo = (await getKvValue("meta_ultimo_evento").catch(() => null)) || ""
  return {
    ok: convOk,
    mensajeria: convOk ? "ok (pages_messaging responde en /me/conversations)" : conv,
    pagina: (me as { error?: unknown }).error ? "sin permiso pages_read_engagement (esperado con el token del panel)" : me,
    suscripciones: (subs as { error?: unknown }).error ? "sin permiso pages_manage_metadata (esperado) — verificar con un mensaje real: ver ultimoEvento" : subs,
    ultimoEvento: ultimo ? (() => { try { return JSON.parse(ultimo) } catch { return ultimo } })() : null,
    envs: { META_VERIFY_TOKEN: Boolean(c.verify), META_APP_SECRET: Boolean(c.secret), META_PAGE_ACCESS_TOKEN: Boolean(c.token) },
    gate: (await getKvValue("meta_canal_enabled").catch(() => null)) || "",
  }
}

export async function GET(req: Request): Promise<Response> {
  const sp = new URL(req.url).searchParams
  if (sp.get("diag") === "1") {
    const secreto = (process.env.CRON_SECRET || "").trim()
    const kvSecreto = (await getKvValue("followup_cron_secret").catch(() => null)) || ""
    const key = (sp.get("key") || "").trim()
    if (!key || (key !== secreto && key !== kvSecreto)) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
    // `&perfil=<psid|FB.psid>[&forzar=1]` → lee el perfil de Meta (cascada
    // completo → básico → hilo) y lo deja en caché: sirve para ver qué campos
    // entrega el token vigente sin esperar un mensaje real.
    const perfil = (sp.get("perfil") || "").trim()
    if (perfil) {
      const contact = /^(FB|IG)\./i.test(perfil) ? perfil : `FB.${perfil}`
      return NextResponse.json({ ok: true, contact, perfil: await perfilMeta(contact, { forzar: sp.get("forzar") === "1" }) })
    }
    return NextResponse.json(await diagnostico())
  }
  const c = await credenciales()
  if (sp.get("hub.mode") === "subscribe" && c.verify && sp.get("hub.verify_token") === c.verify) {
    return new Response(sp.get("hub.challenge") || "", { status: 200, headers: { "Content-Type": "text/plain" } })
  }
  return NextResponse.json({ ok: false, error: "verificación inválida" }, { status: 403 })
}

export async function POST(req: Request): Promise<Response> {
  const raw = await req.text()
  const c = await credenciales()
  if (!firmaValida(raw, req.headers.get("x-hub-signature-256"), c.secret)) {
    return NextResponse.json({ ok: false, error: "firma inválida" }, { status: 401 })
  }
  let body: unknown = null
  try { body = JSON.parse(raw) } catch { return NextResponse.json({ ok: false, error: "json" }, { status: 400 }) }
  const eventos = extraerEventos(body)
  const encendido = ((await getKvValue("meta_canal_enabled").catch(() => null)) || "").trim().toLowerCase() === "on"
  // Rastro del último evento (los runtime logs de Vercel no siempre responden):
  // así el diag puede decir "sí llegó" sin adivinar. Best-effort.
  if (eventos.length > 0) {
    const ev = eventos[eventos.length - 1]
    setKvValue("meta_ultimo_evento", JSON.stringify({ at: new Date().toISOString(), canal: ev.canal, psid: ev.psid, pageId: ev.pageId, texto: ev.texto.slice(0, 160), encendido })).catch(() => {})
  }
  if (!encendido) {
    // Apagado: Meta recibe su 200 (si no, reintenta y termina desactivando el
    // webhook) y queda rastro de lo que llegó para revisar antes de prender.
    for (const ev of eventos) console.log(`[vic-meta] (apagado) ${ev.canal} ${ev.psid}: ${ev.texto.slice(0, 120)}`)
    return NextResponse.json({ ok: true, recibidos: eventos.length, apagado: true })
  }
  after(async () => {
    for (const ev of eventos) await atender(ev).catch((e) => console.error("[vic-meta]", e instanceof Error ? e.message : e))
  })
  return NextResponse.json({ ok: true, recibidos: eventos.length })
}
