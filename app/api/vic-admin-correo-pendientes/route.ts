/**
 * Endpoint ADMIN: correo por país con lo que le falta configurar a cada persona
 * del equipo (espejo de WhatsApp, calendario de Cal.com, teléfono corporativo).
 * Lalo 26-sep. La revisión vive en lib/pendientes-configuracion-pais.ts y sale
 * de la ficha operativa: sirve igual para cualquier país.
 *
 *   GET  ?key=&pais=co            → vista previa (personas, destinatarios, HTML), no envía
 *   POST ?key=&pais=co&confirmo=1 → envía (desde vicky@; Zoho no deja otra casilla)
 *        &deNombre=<nombre>&responderA=<correo> → nombre visible, firma y respuestas de esa persona
 *        &soloA=<correo>          → prueba a una sola casilla
 *        &forzar=1                → envía aunque el worker no conozca alguna sesión
 */
import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"
import { pendientesDelPais, correoPendientes } from "@/lib/pendientes-configuracion-pais"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const CRON_SECRET = (process.env.CRON_SECRET || "").trim()
const MAIL_ANCHOR = (process.env.VIC_DASH_MAIL_ANCHOR || "Contacts/3525045000645054553").trim()
const FROM_EMAIL = (process.env.VICKY_FROM_EMAIL || "vicky@geovictoria.com").trim()
const ZOHO_API_DOMAIN = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
const PAISES = ["cl", "pe", "co", "mx"]

async function autorizado(req: Request): Promise<boolean> {
  const url = new URL(req.url)
  const entregado = req.headers.get("x-cron-secret") || url.searchParams.get("key") || ""
  if (!entregado) return false
  const kv = await getFollowupCronSecret().catch(() => "")
  return entregado === CRON_SECRET || (Boolean(kv) && entregado === kv)
}

async function enviar(to: string[], cc: string[], asunto: string, html: string, deNombre: string, responderA: string) {
  const { getZohoAccessToken } = await import("@/lib/zoho-token")
  const token = await getZohoAccessToken()
  const res = await fetch(`${ZOHO_API_DOMAIN}/crm/v3/${MAIL_ANCHOR}/actions/send_mail`, {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({
      data: [
        {
          from: deNombre ? { user_name: deNombre, email: FROM_EMAIL } : { email: FROM_EMAIL },
          reply_to: { email: responderA || FROM_EMAIL },
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
  if (!PAISES.includes(pais)) return NextResponse.json({ ok: false, error: "pais debe ser cl, pe, co o mx" }, { status: 400 })
  const d = await pendientesDelPais(pais)
  const { asunto, html } = correoPendientes(d, "Vicky · GeoVictoria")
  return NextResponse.json({ ok: true, ...d, asunto, html })
}

export async function POST(req: Request): Promise<Response> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  const sp = new URL(req.url).searchParams
  const pais = (sp.get("pais") || "").toLowerCase()
  if (!PAISES.includes(pais)) return NextResponse.json({ ok: false, error: "pais debe ser cl, pe, co o mx" }, { status: 400 })
  if (sp.get("confirmo") !== "1") return NextResponse.json({ ok: false, error: "falta confirmo=1" }, { status: 400 })
  const deNombre = (sp.get("deNombre") || "").trim()
  const responderA = (sp.get("responderA") || "").trim()
  const d = await pendientesDelPais(pais)
  if (!d.personas.length) return NextResponse.json({ ok: true, nada: "nadie tiene pendientes en este país" })
  const { asunto, html } = correoPendientes(d, deNombre ? `${deNombre} · GeoVictoria` : "Vicky · GeoVictoria")
  const soloA = (sp.get("soloA") || "").trim()
  if (soloA) return NextResponse.json({ prueba: soloA, ...(await enviar([soloA], [], `[PRUEBA] ${asunto}`, html, deNombre, responderA)) })
  if (d.sinWorker.length && sp.get("forzar") !== "1") {
    return NextResponse.json(
      { ok: false, error: "hay sesiones que el worker aún no conoce: el QR no aparecería", sinWorker: d.sinWorker },
      { status: 409 },
    )
  }
  if ((!d.calLeido || !d.botmakerLeido) && sp.get("forzar") !== "1") {
    return NextResponse.json({ ok: false, error: "no se pudo leer Cal.com o Botmaker: las columnas no serían confiables" }, { status: 409 })
  }
  return NextResponse.json({ pais: d.pais, to: d.to, cc: d.cc, ...(await enviar(d.to, d.cc, asunto, html, deNombre, responderA)) })
}
