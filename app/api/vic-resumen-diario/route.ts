/**
 * Resumen diario de la cola de gestión por CORREO (pedido Lalo 04-ago).
 *
 * Corre por Vercel Cron (L-V 8:00 Chile) y envía a los ejecutivos el estado
 * de la cola "Para gestionar hoy" de cada país: cuántas oportunidades hay por
 * tipo de accionable, el top priorizado con monto/urgencia/ejecutivo, y el
 * link directo a la cola. Los datos salen del modo JSON del propio dashboard
 * (/api/vic-funnel?formato=json), así que es SIEMPRE la misma lógica que la
 * página — sin duplicación.
 *
 * Envío vía Zoho send_mail anclado en la cotización más reciente de Vicky
 * (mismo patrón que el correo de cobranza); destinatarios en
 * VIC_RESUMEN_EMAILS (coma-separados) con default de los 3 pedidos por Lalo.
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}` (Vercel Cron) o ?key=<VIC_FUNNEL_KEY>.
 */

import { getZohoAccessToken } from "@/lib/zoho-token"

export const dynamic = "force-dynamic"
export const maxDuration = 120

const FUNNEL_KEY = (process.env.VIC_FUNNEL_KEY || "").trim()
const CRON_SECRET = (process.env.CRON_SECRET || "").trim()
const QUOTE_MODULE = (process.env.ZOHO_QUOTE_MODULE || "Cotizaciones_GeoVictoria").trim()
const ZOHO_API_DOMAIN = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
const VICKY_CREATOR_ID = (process.env.VICKY_ZOHO_CREATOR_ID || "3525045000484500876").trim()
const FROM_EMAIL = (process.env.VICKY_FROM_EMAIL || "vicky@geovictoria.com").trim()
const DESTINATARIOS = (process.env.VIC_RESUMEN_EMAILS || "vluna@geovictoria.com,egomez@geovictoria.com,rlewit@geovictoria.com")
  .split(",")
  .map((e) => e.trim())
  .filter(Boolean)
// Base del dashboard: por defecto, este mismo deployment.
const DASH_BASE = (process.env.VIC_DASH_BASE_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "")).trim()

const PAISES_RESUMEN = ["cl", "co", "mx", "pe"] as const
const PAIS_LABEL: Record<string, string> = { cl: "Chile 🇨🇱", co: "Colombia 🇨🇴", mx: "México 🇲🇽", pe: "Perú 🇵🇪" }

type CasoJson = {
  empresa: string
  contacto: string
  propietario: string
  tipoLabel: string
  tipoEmoji: string
  urgencia: string
  urgenciaColor: string
  monto: string
  diasSinContacto: number
  accionable: string
}

type ResumenPais = {
  pais: string
  totales: { colaPendiente: number; gestionados24h: number }
  cierre: { aceptadas: number; cotizaciones: number; tasaEndToEnd: number; objetivo: number } | null
  casos: CasoJson[]
}

function esc(s: string): string {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function autorizado(req: Request): boolean {
  const { searchParams } = new URL(req.url)
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim()
  if (CRON_SECRET && bearer === CRON_SECRET) return true
  if (FUNNEL_KEY && (searchParams.get("key") || "").trim() === FUNNEL_KEY) return true
  return false
}

function seccionPais(r: ResumenPais): string {
  if (!r.totales.colaPendiente) return ""
  const linkCola = `${DASH_BASE}/api/vic-funnel?key=${encodeURIComponent(FUNNEL_KEY)}&pais=${r.pais}`
  // Conteo por tipo, en el orden de prioridad que ya trae la cola.
  const porTipo = new Map<string, { emoji: string; n: number }>()
  for (const c of r.casos) {
    const cur = porTipo.get(c.tipoLabel) || { emoji: c.tipoEmoji, n: 0 }
    cur.n++
    porTipo.set(c.tipoLabel, cur)
  }
  const chips = [...porTipo.entries()]
    .map(([label, v]) => `${v.emoji} ${esc(label)}: <b>${v.n}</b>`)
    .join(" &nbsp;·&nbsp; ")
  const top = r.casos.slice(0, 12)
  const filas = top
    .map(
      (c) => `<tr>
      <td style="padding:6px 10px 6px 0;white-space:nowrap">${c.tipoEmoji}</td>
      <td style="padding:6px 10px 6px 0"><b>${esc(c.empresa)}</b><br><span style="color:#718096;font-size:13px">+${esc(c.contacto)} · ${esc(c.propietario)}</span></td>
      <td style="padding:6px 10px;white-space:nowrap;color:${c.urgenciaColor};font-weight:600">${esc(c.urgencia)}<br><span style="color:#718096;font-weight:400;font-size:12px">${c.diasSinContacto < 1 ? `${Math.round(c.diasSinContacto * 24)}h` : `${Math.round(c.diasSinContacto)}d`} sin contacto</span></td>
      <td style="padding:6px 10px;white-space:nowrap;text-align:right">${esc(c.monto)}</td>
      <td style="padding:6px 0 6px 10px;font-size:13px;color:#2d3748">${esc(c.accionable)}</td>
    </tr>`,
    )
    .join("")
  const cierreLinea = r.cierre
    ? `Tasa de cierre: <b>${r.cierre.tasaEndToEnd}%</b> (objetivo ${r.cierre.objetivo}%) · ${r.cierre.aceptadas} aceptadas de ${r.cierre.cotizaciones} cotizaciones`
    : ""
  return `<h3 style="margin:26px 0 4px;color:#1a202c">${PAIS_LABEL[r.pais] || r.pais.toUpperCase()} — ${r.totales.colaPendiente} por gestionar${r.totales.gestionados24h ? ` · ${r.totales.gestionados24h} gestionadas ayer` : ""}</h3>
  ${cierreLinea ? `<p style="margin:0 0 6px;color:#4a5568;font-size:14px">${cierreLinea}</p>` : ""}
  <p style="margin:0 0 10px;font-size:14px;color:#4a5568">${chips}</p>
  <table style="border-collapse:collapse;width:100%;font-size:14px">${filas}</table>
  ${r.casos.length > top.length ? `<p style="margin:6px 0 0;color:#718096;font-size:13px">…y ${r.casos.length - top.length} más en la cola.</p>` : ""}
  <p style="margin:10px 0 0"><a href="${esc(linkCola)}" style="color:#1a73e8;font-weight:600">Abrir la cola de ${PAIS_LABEL[r.pais]?.split(" ")[0] || r.pais} →</a></p>`
}

async function anchorQuoteId(): Promise<string> {
  const fijo = (process.env.VIC_RESUMEN_ANCHOR_QUOTE_ID || "").trim()
  if (fijo) return fijo
  try {
    const token = await getZohoAccessToken()
    const res = await fetch(`${ZOHO_API_DOMAIN}/crm/v3/coql`, {
      method: "POST",
      headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        select_query: `select id from ${QUOTE_MODULE} where Created_By = ${VICKY_CREATOR_ID} limit 1`,
      }),
    })
    const data = (await res.json().catch(() => null)) as { data?: Array<{ id?: string }> } | null
    return String(data?.data?.[0]?.id || "")
  } catch {
    return ""
  }
}

export async function GET(req: Request): Promise<Response> {
  if (!autorizado(req)) {
    return Response.json({ ok: false, error: "no autorizado" }, { status: 401 })
  }
  if (!FUNNEL_KEY || !DASH_BASE) {
    return Response.json({ ok: false, error: "faltan VIC_FUNNEL_KEY o base del dashboard" }, { status: 503 })
  }

  // Cola de cada país desde el modo JSON del dashboard (misma lógica que la página).
  const resumenes = (
    await Promise.all(
      PAISES_RESUMEN.map(async (p): Promise<ResumenPais | null> => {
        try {
          const r = await fetch(`${DASH_BASE}/api/vic-funnel?key=${encodeURIComponent(FUNNEL_KEY)}&formato=json&pais=${p}`, {
            cache: "no-store",
          })
          if (!r.ok) return null
          return (await r.json()) as ResumenPais
        } catch {
          return null
        }
      }),
    )
  ).filter((r): r is ResumenPais => r !== null && r.totales?.colaPendiente > 0)

  const totalCasos = resumenes.reduce((a, r) => a + r.totales.colaPendiente, 0)
  const fecha = new Date().toLocaleDateString("es-CL", { timeZone: "America/Santiago", weekday: "long", day: "numeric", month: "long" })

  if (!totalCasos) {
    return Response.json({ ok: true, enviado: false, motivo: "cola vacía en todos los países" })
  }

  const html = `<!DOCTYPE html><html lang="es"><body style="font-family:Segoe UI,Arial,sans-serif;color:#2d3748;font-size:15px;line-height:1.5;max-width:760px">
<p style="font-size:17px;margin:0 0 2px"><b>📞 Vicky — resumen diario de gestión</b></p>
<p style="color:#718096;margin:0 0 8px;text-transform:capitalize">${esc(fecha)}</p>
<p style="margin:0"><b>${totalCasos}</b> oportunidades esperan gestión hoy. Las más importantes arriba (prioridad = cercanía al cierre × monto ÷ días sin contacto):</p>
${resumenes.map(seccionPais).join("")}
<p style="margin:26px 0 0;color:#718096;font-size:13px">Correo automático de lunes a viernes a las 8:00 (hora de Chile). El botón ✔ del dashboard marca un caso como gestionado y lo saca de la cola por 24 horas.</p>
<p style="margin:6px 0 0;color:#4a5568">Vicky · GeoVictoria</p>
</body></html>`
  const subject = `📞 Vicky — ${totalCasos} oportunidades por gestionar hoy`

  const anchor = await anchorQuoteId()
  if (!anchor) {
    return Response.json({ ok: false, error: "sin registro ancla en Zoho para send_mail" }, { status: 502 })
  }
  try {
    const token = await getZohoAccessToken()
    const res = await fetch(`${ZOHO_API_DOMAIN}/crm/v3/${QUOTE_MODULE}/${encodeURIComponent(anchor)}/actions/send_mail`, {
      method: "POST",
      headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        data: [
          {
            from: { email: FROM_EMAIL },
            to: DESTINATARIOS.map((email) => ({ email })),
            subject,
            content: html,
            mail_format: "html",
          },
        ],
      }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      console.error(`[resumen-diario] send_mail ${res.status}:`, body.slice(0, 300))
      return Response.json({ ok: false, error: `send_mail ${res.status}: ${body.slice(0, 200)}` }, { status: 502 })
    }
    console.log(`[resumen-diario] enviado a ${DESTINATARIOS.join(", ")} · ${totalCasos} casos · países: ${resumenes.map((r) => r.pais).join(",")}`)
    return Response.json({
      ok: true,
      enviado: true,
      destinatarios: DESTINATARIOS,
      casos: totalCasos,
      paises: resumenes.map((r) => ({ pais: r.pais, cola: r.totales.colaPendiente })),
    })
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : "excepción" }, { status: 502 })
  }
}
