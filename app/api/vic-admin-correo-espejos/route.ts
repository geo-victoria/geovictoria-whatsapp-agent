/**
 * Endpoint ADMIN: correo por país para que el equipo comercial vincule su
 * espejo de WhatsApp (26-sep, Lalo: "armemos un correo por país para que
 * vinculen los espejos pendientes, con copia a Rodrigo y los líderes
 * comerciales").
 *
 * Todo sale de la FICHA OPERATIVA del país (proceso global, variables por
 * país): a quién (personas con sesión de espejo que no está conectada), sus
 * links personales (vic_kv espejo_link_<sesión>) y la copia (líder, líder SDR,
 * Rodrigo). Sirve igual para cualquier país nuevo.
 *
 *   GET  ?key=&pais=co            → vista previa (HTML + destinatarios), no envía
 *   POST ?key=&pais=co&confirmo=1 → envía desde vicky@ (send_mail anclado)
 *        &forzar=1                → envía aunque haya sesiones que el worker aún
 *                                    no conoce (sin eso se niega: el QR no
 *                                    aparecería y el correo haría perder el tiempo)
 *        &soloA=<email>           → manda la vista a una sola casilla (prueba)
 */
import { NextResponse } from "next/server"
import { getFollowupCronSecret, getKvValue } from "@/lib/supabase-persistence-v3"
import { equipoOperativo, fichaOperativa } from "@/lib/paises/ficha-operativa"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const CRON_SECRET = (process.env.CRON_SECRET || "").trim()
const MAIL_ANCHOR = (process.env.VIC_DASH_MAIL_ANCHOR || "Contacts/3525045000645054553").trim()
const FROM_EMAIL = (process.env.VICKY_FROM_EMAIL || "vicky@geovictoria.com").trim()
const ZOHO_API_DOMAIN = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
const BASE = (process.env.VICKY_AGENT_BASE_URL || "https://geovictoria-whatsapp-agent-git-vicky-v3-geo-victoria.vercel.app").replace(/\/$/, "")
const CC_FIJA = (process.env.VICKY_CORREO_ESPEJOS_CC || "rlewit@geovictoria.com")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean)

async function autorizado(req: Request): Promise<boolean> {
  const url = new URL(req.url)
  const entregado = req.headers.get("x-cron-secret") || url.searchParams.get("key") || ""
  if (!entregado) return false
  const kv = await getFollowupCronSecret().catch(() => "")
  return entregado === CRON_SECRET || (Boolean(kv) && entregado === kv)
}

type Pendiente = { nombre: string; email: string; sesion: string; estado: string; link: string }

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

async function armar(pais: string, firma = "Vicky · GeoVictoria") {
  const ficha = fichaOperativa(pais)
  const pendientes: Pendiente[] = []
  for (const p of equipoOperativo(pais)) {
    if (!p.sesion) continue // gestora de venta autónoma sin espejo (decisión por país)
    const st = String((await getKvValue(`wa_espejo_status_${p.sesion}`).catch(() => null)) || "")
    let estado = "sin_sesion_en_worker"
    try {
      if (st) estado = String((JSON.parse(st) as { estado?: string }).estado || "desconocido")
    } catch {
      /* ilegible */
    }
    if (estado === "conectado") continue
    const token = String((await getKvValue(`espejo_link_${p.sesion}`).catch(() => null)) || "")
    const link = token ? `${BASE}/api/vic-admin-wa-espejo?session=${encodeURIComponent(p.sesion)}&t=${encodeURIComponent(token)}` : ""
    pendientes.push({ nombre: p.nombre, email: p.email, sesion: p.sesion, estado, link })
  }
  const lideres = [ficha.equipo.lider, ficha.equipo.liderSdr].filter(Boolean).map((e) => String(e).toLowerCase())
  const to = pendientes.map((p) => p.email)
  const cc = Array.from(new Set([...lideres, ...CC_FIJA])).filter((e) => !to.includes(e))
  const nombrePais = { cl: "Chile", pe: "Perú", co: "Colombia", mx: "México" }[ficha.pais] || ficha.pais
  const asunto = `Vincula tu WhatsApp a Vicky (espejo) — equipo comercial ${nombrePais}`
  const filas = pendientes
    .map(
      (p) =>
        `<tr><td style="padding:8px 12px;border-bottom:1px solid #e5e7eb">${esc(p.nombre)}</td>` +
        `<td style="padding:8px 12px;border-bottom:1px solid #e5e7eb">${
          p.link ? `<a href="${p.link}" style="color:#1d4ed8;font-weight:bold">Abrir mi código QR</a>` : "<em>link en preparación</em>"
        }</td></tr>`,
    )
    .join("")
  const html =
    `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#1f2937;max-width:640px">` +
    `<p>Hola equipo 👋</p>` +
    `<p>Les pedimos vincular su WhatsApp corporativo a Vicky. Es como Samu, pero para WhatsApp: ` +
    `sus conversaciones y llamadas con clientes quedan registradas solas como nota en el trato de Zoho, sin copiar nada a mano.</p>` +
    `<p><strong>Por qué importa:</strong></p><ul>` +
    `<li>Tu gestión queda a la vista: una venta en la que participaste cuenta como venta asistida.</li>` +
    `<li>Cuando ya atendiste a un cliente, Vicky lo sabe y deja de escribirle: no se pisan.</li>` +
    `<li>Vicky te presenta al cliente con tu número, y la conversación que sigue queda en el trato.</li></ul>` +
    `<p><strong>Cómo hacerlo (1 minuto):</strong></p><ol>` +
    `<li>Abre <strong>tu</strong> link de la tabla en el computador.</li>` +
    `<li>En el celular con tu WhatsApp corporativo: <em>Configuración → Dispositivos vinculados → Vincular un dispositivo</em>.</li>` +
    `<li>Escanea el código QR que aparece en la página. Listo: la página dirá "conectado".</li></ol>` +
    `<table style="border-collapse:collapse;margin:12px 0;border:1px solid #e5e7eb">` +
    `<tr style="background:#f3f4f6"><th style="padding:8px 12px;text-align:left">Ejecutivo</th><th style="padding:8px 12px;text-align:left">Tu link personal</th></tr>` +
    filas +
    `</table>` +
    `<p style="color:#6b7280;font-size:13px">Usa solo tu propio link: cada uno queda asociado a tu nombre. ` +
    `El link abre únicamente tu código QR; nadie ve tus chats desde ahí. Si el QR expira, recarga la página.</p>` +
    `<p>Cualquier duda, respondan este correo.<br>${esc(firma)}</p></div>`
  return { pais: ficha.pais, nombrePais, asunto, to, cc, pendientes, html }
}

async function enviar(to: string[], cc: string[], asunto: string, html: string, de = FROM_EMAIL, deNombre = ""): Promise<{ ok: boolean; status: number; detalle?: string }> {
  const { getZohoAccessToken } = await import("@/lib/zoho-token")
  const token = await getZohoAccessToken()
  const res = await fetch(`${ZOHO_API_DOMAIN}/crm/v3/${MAIL_ANCHOR}/actions/send_mail`, {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({
      data: [
        {
          from: deNombre ? { user_name: deNombre, email: de } : { email: de },
          reply_to: { email: de },
          to: to.map((email) => ({ email })),
          ...(cc.length ? { cc: cc.map((email) => ({ email })) } : {}),
          subject: asunto,
          content: html,
          mail_format: "html",
        },
      ],
    }),
  })
  const detalle = res.ok ? undefined : (await res.text().catch(() => "")).slice(0, 300)
  return { ok: res.ok, status: res.status, detalle }
}

export async function GET(req: Request): Promise<Response> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  const pais = (new URL(req.url).searchParams.get("pais") || "").toLowerCase()
  if (!pais) return NextResponse.json({ ok: false, error: "falta pais" }, { status: 400 })
  const c = await armar(pais)
  const sinWorker = c.pendientes.filter((p) => p.estado === "sin_sesion_en_worker").map((p) => p.sesion)
  return NextResponse.json({ ok: true, ...c, sinWorker })
}

export async function POST(req: Request): Promise<Response> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  const sp = new URL(req.url).searchParams
  const pais = (sp.get("pais") || "").toLowerCase()
  if (!pais) return NextResponse.json({ ok: false, error: "falta pais" }, { status: 400 })
  if (sp.get("confirmo") !== "1") return NextResponse.json({ ok: false, error: "falta confirmo=1" }, { status: 400 })
  // ?de=<correo>&deNombre=<nombre> (Lalo 26-sep: "¿los puedes mandar a nombre mío?"): remitente,
  // responder-a y firma a nombre de esa persona. Zoho solo acepta remitentes habilitados para el
  // usuario de la API; si lo rechaza, el error vuelve tal cual.
  const de = (sp.get("de") || FROM_EMAIL).trim()
  const deNombre = (sp.get("deNombre") || "").trim()
  const c = await armar(pais, deNombre ? `${deNombre} · GeoVictoria` : undefined)
  if (!c.pendientes.length) return NextResponse.json({ ok: true, nada: "todos los espejos del país están conectados" })
  const soloA = (sp.get("soloA") || "").trim()
  if (soloA) {
    const r = await enviar([soloA], [], `[PRUEBA] ${c.asunto}`, c.html, de, deNombre)
    return NextResponse.json({ prueba: soloA, ...r })
  }
  const sinWorker = c.pendientes.filter((p) => p.estado === "sin_sesion_en_worker").map((p) => p.sesion)
  if (sinWorker.length && sp.get("forzar") !== "1") {
    return NextResponse.json(
      {
        ok: false,
        error: "hay sesiones que el worker aún no conoce: el QR no aparecería",
        sinWorker,
        instruccion: `Agregar a WA_SESSION_IDS del worker en Railway: ${sinWorker.join(",")}`,
      },
      { status: 409 },
    )
  }
  const r = await enviar(c.to, c.cc, c.asunto, c.html, de, deNombre)
  return NextResponse.json({ pais: c.pais, to: c.to, cc: c.cc, ...r })
}
