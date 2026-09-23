import { NextResponse } from "next/server"
import { personaPorEmail, sesionesEspejoOperativas } from "@/lib/paises/ficha-operativa"
import { getFollowupCronSecret, getKvValue, setKvValue } from "@/lib/supabase-persistence-v3"
import { getZohoAccessToken } from "@/lib/zoho-token"
import { avisarEquipoInterno } from "@/lib/alerta-interna"

export const dynamic = "force-dynamic"
export const maxDuration = 60

/**
 * ALARMA DE ESPEJOS CAÍDOS (Lalo 16-sep: "no les habíamos dado un panel?" →
 * sí, pero era de CONSULTA: Daniela estuvo 12 días sin vincular y nadie se
 * enteró; Eddyluz lleva desde el 14-sep). El panel 🪞 Espejos sigue igual;
 * esto es la alarma que faltaba.
 *
 * Cada hora (JOBS_HUERFANOS) lee vic_kv `wa_espejo_status_<sesión>` de cada
 * ejecutivo del roster (usuarios Zoho activos con perfil Ejecutivo Comercial /
 * Telemarketing, sesión = parte local del correo) y:
 *   - estado ≠ conectado hace más de VICKY_ESPEJO_ALERTA_MIN (60') → correo
 *     al ejecutivo (con su link personal del QR) + copia a
 *     VICKY_ESPEJO_ALERTA_CC (default egomez@). Se repite cada
 *     VICKY_ESPEJO_REALERTA_H (24 h) mientras siga caído — candado
 *     `espejo_alerta_<sesión>` = ISO del último aviso.
 *   - vuelve a conectado con candado vivo → correo corto de recuperación
 *     SOLO a la copia, y se limpia el candado.
 *   - sin sesión en el worker (sin kv de estado: hoy aaraque/asepulveda) →
 *     aviso interno una vez al día (`espejo_alerta_sinsesion_<sesión>`), sin
 *     correo: crear la sesión es lado Railway, no del ejecutivo.
 *
 * LÍMITE que hay que decir: `at` del estado se estampa al CAMBIAR de estado,
 * no es un latido. Si el worker entero se cae, todas las filas siguen
 * diciendo "conectado" con una hora vieja — eso esta alarma no lo ve.
 *
 * `?dry=1` lista lo que haría sin mandar nada ni escribir candados.
 */

const CRON_SECRET = (process.env.CRON_SECRET || "").trim()
const ZOHO_API_DOMAIN = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
const FROM_EMAIL = (process.env.VICKY_FROM_EMAIL || "vicky@geovictoria.com").trim()
const MAIL_ANCHOR = (process.env.VIC_DASH_MAIL_ANCHOR || "Contacts/3525045000645054553").trim()
const CC = (process.env.VICKY_ESPEJO_ALERTA_CC || "egomez@geovictoria.com")
  .toLowerCase()
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
const UMBRAL_MIN = Math.max(15, Number(process.env.VICKY_ESPEJO_ALERTA_MIN || 60) || 60)
const REALERTA_H = Math.max(1, Number(process.env.VICKY_ESPEJO_REALERTA_H || 24) || 24)
const BASE_URL = (
  process.env.VICKY_PUBLIC_URL ||
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "") ||
  "https://geovictoria-whatsapp-agent-git-vicky-v3-geo-victoria.vercel.app"
).replace(/\/$/, "")
const PERFILES = new Set(["Ejecutivo Comercial", "Telemarketing"])
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()

/** Sesiones que el WORKER conoce (kv wa_espejo_status_<sesión>) + las que
 *  deberían existir y no existen (env VICKY_ESPEJO_SESIONES_EXTRA, default las
 *  dos SDR). OJO: espejo_link_ NO sirve de filtro — el panel admin genera token
 *  para los ~70 comerciales de todos los países. */
// Default = TODO el equipo comercial declarado en la ficha operativa de cada
// país (telemarketing + SDR + venta autónoma): una persona nueva o un país
// nuevo entra a la alarma por su ficha, sin tocar este archivo. Mientras su
// sesión no exista en el worker, la alarma lo declara todos los días.
const SESIONES_EXTRA = (process.env.VICKY_ESPEJO_SESIONES_EXTRA || sesionesEspejoOperativas().join(",")).split(",").map((s) => s.trim()).filter(Boolean)
async function sesionesConLink(): Promise<Set<string>> {
  const out = new Set<string>(SESIONES_EXTRA)
  if (!SUPABASE_URL || !SUPABASE_KEY) return out
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/vic_kv?key=like.wa_espejo_status_*&select=key&limit=500`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      cache: "no-store",
    })
    for (const f of ((await r.json().catch(() => [])) as Array<{ key: string }>) || []) out.add(String(f.key).replace(/^wa_espejo_status_/, ""))
  } catch { /* sin kv → roster vacío, el endpoint lo declara */ }
  return out
}

async function autorizado(req: Request): Promise<boolean> {
  const key = (new URL(req.url).searchParams.get("key") || "").trim()
  const hdr = (req.headers.get("x-cron-secret") || "").trim()
  const dado = key || hdr
  if (!dado) return false
  if (CRON_SECRET && dado === CRON_SECRET) return true
  const kvSecret = await getFollowupCronSecret().catch(() => "")
  return Boolean(kvSecret && dado === kvSecret)
}

type Usuario = { nombre: string; email: string; sesion: string; pais?: string }

async function rosterEspejos(token: string): Promise<Usuario[]> {
  const out: Usuario[] = []
  for (let page = 1; page <= 5; page++) {
    const r = await fetch(`${ZOHO_API_DOMAIN}/crm/v3/users?type=ActiveUsers&per_page=100&page=${page}`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      cache: "no-store",
    })
    if (!r.ok || r.status === 204) break
    const cuerpo = (await r.json().catch(() => null)) as {
      users?: Array<{ full_name?: string; email?: string; profile?: { name?: string } | null }>
      info?: { more_records?: boolean }
    } | null
    for (const u of cuerpo?.users || []) {
      const email = String(u.email || "").toLowerCase()
      if (!email) continue
      const sesion = email.split("@")[0]
      if (!PERFILES.has(String(u.profile?.name || "")) && !SESIONES_EXTRA.includes(sesion)) continue
      out.push({ nombre: String(u.full_name || email), email, sesion, pais: personaPorEmail(email)?.pais })
    }
    if (!cuerpo?.info?.more_records) break
  }
  return out
}

function etiquetaEstado(estado: string): string {
  if (estado === "en_pausa_sin_vincular") return "sin vincular: hay que escanear el QR de nuevo"
  if (estado === "esperando_qr") return "esperando que escanees el QR"
  if (estado === "conectando") return "intentando conectar"
  return estado || "desconocido"
}

function horasTexto(ms: number): string {
  const h = ms / 3_600_000
  if (h < 1.5) return `${Math.round(ms / 60_000)} minutos`
  if (h < 48) return `${Math.round(h)} horas`
  return `${Math.round(h / 24)} días`
}

async function enviarCorreo(
  token: string,
  to: string[],
  cc: string[],
  subject: string,
  html: string,
): Promise<{ ok: boolean; error?: string }> {
  const ccLimpio = cc.filter((c) => !to.includes(c))
  try {
    const res = await fetch(`${ZOHO_API_DOMAIN}/crm/v3/${MAIL_ANCHOR}/actions/send_mail`, {
      method: "POST",
      headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        data: [
          {
            from: { email: FROM_EMAIL },
            to: to.map((email) => ({ email })),
            ...(ccLimpio.length ? { cc: ccLimpio.map((email) => ({ email })) } : {}),
            subject,
            content: html,
            mail_format: "html",
          },
        ],
      }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      console.error(`[espejo-alerta] send_mail ${res.status} a ${to.join(",")}:`, body.slice(0, 300))
      return { ok: false, error: `${res.status}: ${body.slice(0, 200)}` }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "excepción" }
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] || c)
}

function htmlCaido(u: Usuario, estado: string, desde: string, link: string): string {
  const nombre = u.nombre.split(" ")[0]
  return `<!doctype html><html><body style="font-family:system-ui,Segoe UI,Arial;max-width:560px;margin:0 auto;color:#1f2937;line-height:1.5">
<h2 style="margin:0 0 8px;color:#b91c1c">🪞 Tu espejo de WhatsApp está desconectado</h2>
<p>${esc(nombre)}, tu WhatsApp lleva <b>${esc(desde)}</b> sin espejarse (${esc(etiquetaEstado(estado))}).</p>
<p>Mientras esté así, lo que gestionas por tu WhatsApp <b>no queda registrado</b>: tus traspasos aparecen como "sin contactar", los comprobantes que te manden los clientes no se leen y tus ventas pueden clasificarse como autónomas.</p>
<p style="margin:18px 0"><a href="${esc(link)}" style="background:#0284c7;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:700">Volver a vincular mi WhatsApp</a></p>
<p style="color:#4b5563;font-size:14px">Abre el link, y en tu celular: WhatsApp → Dispositivos vinculados → Vincular un dispositivo → escanea el QR. Tarda menos de un minuto. Si el link dice "Conectado", ya quedó.</p>
<p style="margin:24px 0 0;color:#6b7280;font-size:13px">Vicky · GeoVictoria. Este aviso se repite una vez al día mientras el espejo siga caído.</p>
</body></html>`
}

function htmlRecuperado(u: Usuario, caidoDesde: string): string {
  return `<!doctype html><html><body style="font-family:system-ui,Segoe UI,Arial;max-width:560px;margin:0 auto;color:#1f2937;line-height:1.5">
<h2 style="margin:0 0 8px;color:#15803d">🪞 Espejo de ${esc(u.nombre)} reconectado</h2>
<p>Volvió a conectarse. Estuvo caído desde el ${esc(caidoDesde)}: lo que gestionó por WhatsApp en ese lapso no quedó espejado.</p>
<p style="margin:24px 0 0;color:#6b7280;font-size:13px">Vicky · GeoVictoria</p>
</body></html>`
}

function fechaCL(iso: string): string {
  try {
    return new Date(iso).toLocaleString("es-CL", { timeZone: "America/Santiago", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
  } catch {
    return iso
  }
}

export async function GET(req: Request) {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  const dry = new URL(req.url).searchParams.get("dry") === "1"
  const ahora = Date.now()
  const hoy = new Date(ahora).toISOString().slice(0, 10)

  let token = ""
  try {
    token = await getZohoAccessToken()
  } catch (e) {
    return NextResponse.json({ ok: false, error: `zoho token: ${e instanceof Error ? e.message : e}` }, { status: 502 })
  }
  const [todos, conLink] = await Promise.all([rosterEspejos(token).catch(() => [] as Usuario[]), sesionesConLink()])
  const roster = todos.filter((u) => conLink.has(u.sesion))
  if (!roster.length) return NextResponse.json({ ok: false, error: "roster vacío (Zoho users o kv espejo_link_ no respondieron)", zohoUsuarios: todos.length, conLink: conLink.size }, { status: 502 })

  const filas: Array<Record<string, unknown>> = []
  let alertas = 0
  let recuperados = 0
  let sinSesion = 0

  for (const u of roster) {
    const raw = await getKvValue(`wa_espejo_status_${u.sesion}`).catch(() => null)
    let st: { estado?: string; at?: string } = {}
    try {
      st = raw ? (JSON.parse(raw) as { estado?: string; at?: string }) : {}
    } catch {
      st = {}
    }
    const candado = (await getKvValue(`espejo_alerta_${u.sesion}`).catch(() => null)) || ""
    const fila: Record<string, unknown> = { sesion: u.sesion, nombre: u.nombre, estado: st.estado || "sin_sesion", at: st.at || null }

    if (!st.estado) {
      sinSesion++
      const marca = (await getKvValue(`espejo_alerta_sinsesion_${u.sesion}`).catch(() => null)) || ""
      if (marca.slice(0, 10) !== hoy) {
        fila.accion = "aviso_interno_sin_sesion"
        if (!dry) {
          await avisarEquipoInterno(`🪞 ${u.nombre} (${u.sesion}${u.pais ? `, ${u.pais.toUpperCase()}` : ""}) no tiene sesión de espejo en el worker. Hay que crearla en Railway (WA_SESSION_IDS += "${u.sesion}") y mandarle su link del QR. Sin espejo su gestión no cuenta (candado v3, panel de traspasos, ventas asistidas).`).catch(() => false)
          await setKvValue(`espejo_alerta_sinsesion_${u.sesion}`, new Date(ahora).toISOString()).catch(() => {})
        }
      } else fila.accion = "sin_sesion_ya_avisado_hoy"
      filas.push(fila)
      continue
    }

    // `at` NO sirve para medir la caída: el auto-rescate del worker (~5 min)
    // re-estampa "en_pausa_sin_vincular" con hora nueva, así que "hace 1 minuto"
    // era Eddyluz caída desde el 14-sep. Se mide desde la PRIMERA vez que ESTA
    // alarma la vio caída (kv espejo_caido_desde_<s>), y se limpia al conectar.
    const caidaDesdeKey = `espejo_caido_desde_${u.sesion}`
    let caidaDesde = (await getKvValue(caidaDesdeKey).catch(() => null)) || ""

    if (st.estado === "conectado") {
      if (caidaDesde && !dry) await setKvValue(caidaDesdeKey, "").catch(() => {})
      if (candado) {
        recuperados++
        fila.accion = "recuperado"
        if (!dry) {
          await enviarCorreo(token, CC, [], `🪞 Espejo de ${u.nombre} reconectado`, htmlRecuperado(u, fechaCL(candado)))
          await setKvValue(`espejo_alerta_${u.sesion}`, "").catch(() => {})
          await setKvValue(`espejo_alerta_ultimo_${u.sesion}`, "").catch(() => {})
        }
      } else fila.accion = "ok"
      filas.push(fila)
      continue
    }

    // Desconectado.
    if (!Number.isFinite(Date.parse(caidaDesde))) {
      caidaDesde = st.at && Number.isFinite(Date.parse(st.at)) ? String(st.at) : new Date(ahora).toISOString()
      if (!dry) await setKvValue(caidaDesdeKey, caidaDesde).catch(() => {})
    }
    const caidoMs = ahora - Date.parse(caidaDesde)
    fila.caidoDesde = caidaDesde
    fila.caidoHace = horasTexto(caidoMs)
    if (caidoMs < UMBRAL_MIN * 60_000) {
      fila.accion = `caido_reciente_espera_${UMBRAL_MIN}min`
      filas.push(fila)
      continue
    }
    // Dos llaves: `espejo_alerta_<s>` = cuándo EMPEZÓ la caída (para el correo
    // de recuperación) · `espejo_alerta_ultimo_<s>` = último correo enviado
    // (para repetir cada REALERTA_H y no cada hora).
    const ultimoRaw = (await getKvValue(`espejo_alerta_ultimo_${u.sesion}`).catch(() => null)) || ""
    const ultimoAviso = Date.parse(ultimoRaw)
    if (candado && Number.isFinite(ultimoAviso) && ahora - ultimoAviso < REALERTA_H * 3_600_000) {
      fila.accion = `avisado_${fechaCL(ultimoRaw)}`
      filas.push(fila)
      continue
    }
    alertas++
    fila.accion = candado ? "re_alerta" : "alerta"
    if (!dry) {
      const tokenLink = (await getKvValue(`espejo_link_${u.sesion}`).catch(() => null)) || ""
      const link = tokenLink
        ? `${BASE_URL}/api/vic-admin-wa-espejo?session=${encodeURIComponent(u.sesion)}&t=${encodeURIComponent(tokenLink)}`
        : `${BASE_URL}/oportunidades?vista=espejos`
      const desde = horasTexto(caidoMs)
      const r = await enviarCorreo(
        token,
        [u.email],
        CC,
        `🪞 Tu espejo de WhatsApp lleva ${desde} desconectado — vuelve a vincularlo`,
        htmlCaido(u, String(st.estado), desde, link),
      )
      fila.correo = r.ok ? "enviado" : `fallo: ${r.error}`
      // El candado se escribe aunque el correo falle: el aviso interno queda
      // igual y no se martilla a Zoho cada hora con un 400.
      if (!candado) await setKvValue(`espejo_alerta_${u.sesion}`, caidaDesde).catch(() => {})
      await setKvValue(`espejo_alerta_ultimo_${u.sesion}`, new Date(ahora).toISOString()).catch(() => {})
      await avisarEquipoInterno(`🪞 Espejo de ${u.nombre} (${u.sesion}) ${etiquetaEstado(String(st.estado))} hace ${desde}. Correo ${r.ok ? "enviado" : "FALLÓ: " + (r.error || "")}.`).catch(() => false)
    }
    filas.push(fila)
  }

  return NextResponse.json({ ok: true, dry, umbralMin: UMBRAL_MIN, realertaH: REALERTA_H, roster: roster.length, alertas, recuperados, sinSesion, filas })
}
