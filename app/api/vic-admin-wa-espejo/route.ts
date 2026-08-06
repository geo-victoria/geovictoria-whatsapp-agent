/**
 * Endpoint ADMIN: GET /api/vic-admin-wa-espejo?session=<id>&key=<CRON_SECRET>
 *
 * Página de vinculación del espejo de WhatsApp de un ejecutivo (worker
 * workers/wa-espejo). Muestra el QR vigente (publicado por el worker en
 * vic_kv `wa_espejo_qr_<session>`) y el estado de la sesión; se refresca sola
 * cada 5 s porque el QR de WhatsApp rota ~cada minuto.
 *
 * Auth: ?key= == CRON_SECRET o header x-cron-secret == vic_kv.followup_cron_secret
 * (mismo modelo que el resto de los endpoints admin; ?key= permite abrirla en
 * el navegador para mostrarle el QR al ejecutivo).
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"

export const dynamic = "force-dynamic"

const CRON_SECRET = (process.env.CRON_SECRET || "").trim()
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()

async function kvGet(key: string): Promise<string> {
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/vic_kv?key=eq.${encodeURIComponent(key)}&select=value,expires_at&limit=1`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, cache: "no-store" },
    )
    const rows = (await r.json().catch(() => [])) as Array<{ value?: string; expires_at?: string | null }>
    const row = rows[0]
    if (!row) return ""
    if (row.expires_at && Date.parse(row.expires_at) < Date.now()) return ""
    return String(row.value || "")
  } catch {
    return ""
  }
}

// Señal "alguien está mirando la página del QR": el worker solo abre socket de
// pareo para sesiones sin vincular mientras esta llave esté fresca (QR bajo
// demanda, 06-ago — los loops de QR eternos gatillaban rechazos de Meta).
async function kvSet(key: string, value: string, ttlMinutos: number): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/vic_kv?on_conflict=key`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify({ key, value, expires_at: new Date(Date.now() + ttlMinutos * 60_000).toISOString() }),
    cache: "no-store",
  }).catch(() => {})
}

async function authorized(req: Request): Promise<boolean> {
  const url = new URL(req.url)
  const key = (url.searchParams.get("key") || "").trim()
  if (CRON_SECRET && key === CRON_SECRET) return true
  // La página se abre en un navegador para mostrarle el QR al ejecutivo:
  // se acepta el secreto operativo también por ?key= (no solo por header).
  const xcron = (req.headers.get("x-cron-secret") || "").trim()
  if (xcron || key) {
    const expected = await getFollowupCronSecret().catch(() => "")
    if (expected && (xcron === expected || key === expected)) return true
  }
  return false
}

export async function GET(req: Request): Promise<Response> {
  if (!(await authorized(req))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }
  const url = new URL(req.url)
  const session = (url.searchParams.get("session") || "").trim().replace(/[^a-zA-Z0-9_-]/g, "")
  if (!session) {
    return NextResponse.json({ ok: false, error: "Falta ?session=<WA_SESSION_ID>" }, { status: 400 })
  }

  // Visor en vivo: ?ver=chats lista las conversaciones; ?chat=<jid> abre una.
  const chatJid = (url.searchParams.get("chat") || "").trim()
  if (chatJid || url.searchParams.get("ver") === "chats") {
    const key = (url.searchParams.get("key") || "").trim()
    return chatJid ? verChat(session, chatJid, key) : verChats(session, key)
  }

  const [qr, statusRaw] = await Promise.all([
    kvGet(`wa_espejo_qr_${session}`),
    kvGet(`wa_espejo_status_${session}`),
    // Despierta el pareo de esta sesión mientras la página esté abierta (el
    // auto-refresh de 5s renueva la señal; TTL corto para que al cerrar la
    // página el worker se estacione solo).
    kvSet(`wa_espejo_wake_${session}`, new Date().toISOString(), 2),
  ])
  let estado = "sin señal del worker"
  let detalle = ""
  try {
    const st = JSON.parse(statusRaw || "{}") as { estado?: string; numero?: string; at?: string }
    if (st.estado) {
      estado = st.estado
      detalle = [st.numero, st.at ? new Date(st.at).toLocaleString("es-CL", { timeZone: "America/Santiago" }) : ""]
        .filter(Boolean)
        .join(" · ")
    }
  } catch {
    /* sin estado aún */
  }

  const cuerpo =
    estado === "conectado"
      ? `<div class="ok">✅ Conectado</div><p class="sub">${detalle}</p><p>El espejo está activo. No hay nada más que hacer.</p>`
      : qr
        ? `<img src="${qr}" alt="QR de vinculación" width="360" height="360"/><p>En el celular del ejecutivo: <b>WhatsApp Business → Dispositivos vinculados → Vincular dispositivo</b> y escanear este código. Se renueva solo.</p>`
        : `<div class="warn">⏳ ${estado}</div><p class="sub">${detalle}</p><p>Sin QR publicado. Si el worker está recién desplegado, espera unos segundos; esta página se refresca sola.</p>`

  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"/>
<meta http-equiv="refresh" content="5"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Espejo WhatsApp — ${session}</title>
<style>
body{font-family:Arial,Helvetica,sans-serif;color:#333;max-width:480px;margin:40px auto;padding:0 16px;text-align:center}
h1{color:#00AFF2;font-size:20px}
.ok{color:#1b7f3a;font-size:22px;font-weight:bold}
.warn{color:#b26a00;font-size:18px;font-weight:bold}
.sub{color:#888;font-size:12px}
img{border:1px solid #ddd;border-radius:8px}
</style></head><body>
<h1>Espejo WhatsApp — sesión "${session}"</h1>
${cuerpo}
</body></html>`
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })
}

// ── Visor en vivo del espejo ────────────────────────────────────────────────

type FilaEspejo = {
  chat_jid: string
  from_me: boolean
  autor: string | null
  telefono_chat: string | null
  es_grupo: boolean
  tipo: string | null
  texto: string | null
  enviado_at: string
}

const escHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

const fmtCL = (iso: string) =>
  iso ? new Date(iso).toLocaleString("es-CL", { timeZone: "America/Santiago", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : ""

async function mensajesDe(session: string, extra: string, limit: number): Promise<FilaEspejo[]> {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/vic_wa_espejo_mensajes?session_id=eq.${encodeURIComponent(session)}${extra}&select=chat_jid,from_me,autor,telefono_chat,es_grupo,tipo,texto,enviado_at&order=enviado_at.desc&limit=${limit}`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, cache: "no-store" },
  )
  return r.ok ? ((await r.json().catch(() => [])) as FilaEspejo[]) : []
}

const paginaVisor = (titulo: string, cuerpo: string) =>
  new Response(
    `<!doctype html><html lang="es"><head><meta charset="utf-8"/><meta http-equiv="refresh" content="10"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/><title>${escHtml(titulo)}</title>
<style>
body{font-family:Arial,Helvetica,sans-serif;color:#333;max-width:720px;margin:20px auto;padding:0 14px}
h1{color:#00AFF2;font-size:18px}
a{color:#0077b6;text-decoration:none} a:hover{text-decoration:underline}
.chat{border-bottom:1px solid #e5e5e5;padding:9px 4px}
.chat .nom{font-weight:bold}
.chat .ult{color:#666;font-size:13px;margin-top:2px}
.chat .meta{color:#999;font-size:11px;float:right}
.b{max-width:78%;margin:5px 0;padding:8px 11px;border-radius:10px;font-size:14px;white-space:pre-wrap;word-break:break-word}
.yo{background:#dcf8c6;margin-left:auto}
.el{background:#f1f1f1;margin-right:auto}
.b .meta{display:block;color:#8a8a8a;font-size:10.5px;margin-top:3px}
.cols{display:flex;flex-direction:column}
.sub{color:#999;font-size:12px}
</style></head><body>${cuerpo}<p class="sub" style="margin-top:14px">Se refresca sola cada 10 s · hora de Chile</p></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  )

async function verChats(session: string, key: string): Promise<Response> {
  const filas = await mensajesDe(session, "", 300)
  const porChat = new Map<string, { ultima: FilaEspejo; n: number }>()
  for (const f of filas) {
    const ya = porChat.get(f.chat_jid)
    if (ya) ya.n += 1
    else porChat.set(f.chat_jid, { ultima: f, n: 1 })
  }
  const items = [...porChat.entries()]
    .sort((a, b) => b[1].ultima.enviado_at.localeCompare(a[1].ultima.enviado_at))
    .map(([jid, { ultima, n }]) => {
      const nombre = ultima.es_grupo
        ? `👥 ${ultima.autor || "Grupo"}`
        : ultima.telefono_chat
          ? `+${ultima.telefono_chat}${!ultima.from_me && ultima.autor ? ` · ${ultima.autor}` : ""}`
          : jid
      const href = `?session=${encodeURIComponent(session)}&chat=${encodeURIComponent(jid)}&key=${encodeURIComponent(key)}`
      const resumen = `${ultima.from_me ? "Tú: " : ""}${ultima.texto || `[${ultima.tipo || "mensaje"}]`}`
      return `<div class="chat"><span class="meta">${fmtCL(ultima.enviado_at)} · ${n} msj</span><div class="nom"><a href="${href}">${escHtml(nombre)}</a></div><div class="ult">${escHtml(resumen.slice(0, 120))}</div></div>`
    })
  return paginaVisor(
    `Espejo ${session} — chats`,
    `<h1>💬 Conversaciones espejadas — ${escHtml(session)}</h1>${items.join("") || "<p>Aún no hay mensajes capturados.</p>"}`,
  )
}

async function verChat(session: string, chatJid: string, key: string): Promise<Response> {
  const filas = await mensajesDe(session, `&chat_jid=eq.${encodeURIComponent(chatJid)}`, 100)
  const orden = filas.reverse()
  const titulo = orden.length
    ? orden[orden.length - 1].es_grupo
      ? `👥 ${orden.find((f) => f.es_grupo && f.autor)?.autor || "Grupo"}`
      : `+${orden[orden.length - 1].telefono_chat || chatJid}`
    : chatJid
  const burbujas = orden
    .map((f) => {
      const quien = f.from_me ? "" : f.es_grupo && f.autor ? `${escHtml(f.autor)} · ` : ""
      const cuerpo = f.texto ? escHtml(f.texto) : `<i>[${escHtml(f.tipo || "mensaje")}]</i>`
      return `<div class="b ${f.from_me ? "yo" : "el"}">${cuerpo}<span class="meta">${quien}${fmtCL(f.enviado_at)}</span></div>`
    })
    .join("")
  const volver = `?session=${encodeURIComponent(session)}&ver=chats&key=${encodeURIComponent(key)}`
  return paginaVisor(
    `Espejo ${session} — chat`,
    `<h1><a href="${volver}">←</a> ${escHtml(titulo)}</h1><div class="cols">${burbujas || "<p>Sin mensajes en este chat.</p>"}</div>`,
  )
}
