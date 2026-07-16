/**
 * Notificación interna por WhatsApp de cotización ACEPTADA / PAGADA.
 *
 * Lo llama el cotizador (quote-internal-notify) cuando una cotización se acepta o
 * se paga, además del correo. Envía por la línea de Meta (Cloud API) al equipo
 * (VICKY_REPORT_PHONE / QUOTE_NOTIFY_TO).
 *
 * Entrega:
 *  - Si hay plantilla configurada (QUOTE_NOTIFY_TEMPLATE) → la usa (única vía
 *    confiable fuera de la ventana de 24h: las aceptaciones/pagos pasan en
 *    cualquier momento). Variables del body, en orden: {{1}}=N° cotización,
 *    {{2}}=estado (ACEPTADA/PAGADA), {{3}}=empresa, {{4}}=monto.
 *  - Si NO hay plantilla → fallback a TEXTO LIBRE (solo llega si la ventana de
 *    24h del receptor está abierta).
 *
 * Auth: x-cron-secret == vic_kv.followup_cron_secret, o Bearer/?key=CRON_SECRET.
 */

import { NextResponse } from "next/server"
import {
  closeFollowup,
  findContactByQuoteId,
  getFollowupCronSecret,
} from "@/lib/supabase-persistence-v3"
import { cancelPendingCallbacks } from "@/lib/dapta-voice"

export const dynamic = "force-dynamic"
export const maxDuration = 20

const CRON_SECRET = (process.env.CRON_SECRET || "").trim()
const NOTIFY_TO = (process.env.QUOTE_NOTIFY_TO || process.env.VICKY_REPORT_PHONE || "56944668823").trim()
const TEMPLATE = (process.env.QUOTE_NOTIFY_TEMPLATE || "").trim()
const TEMPLATE_LANG = (process.env.QUOTE_NOTIFY_TEMPLATE_LANG || "es").trim()

async function authorized(req: Request): Promise<boolean> {
  const xcron = (req.headers.get("x-cron-secret") || "").trim()
  if (xcron) {
    const expected = await getFollowupCronSecret().catch(() => "")
    if (expected && xcron === expected) return true
  }
  if (CRON_SECRET) {
    const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim()
    if (bearer === CRON_SECRET) return true
    const key = (new URL(req.url).searchParams.get("key") || "").trim()
    if (key === CRON_SECRET) return true
  }
  return false
}

function graphUrl(): { url: string; token: string } | null {
  const accessToken = (process.env.WHATSAPP_ACCESS_TOKEN || "").trim()
  const phoneNumberId = (process.env.WHATSAPP_PHONE_NUMBER_ID || "").trim()
  if (!accessToken || !phoneNumberId) return null
  return { url: `https://graph.facebook.com/v22.0/${phoneNumberId}/messages`, token: accessToken }
}

async function send(body: Record<string, unknown>) {
  const g = graphUrl()
  if (!g) return { ok: false, error: "WhatsApp Cloud API no configurado" }
  const res = await fetch(g.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${g.token}` },
    body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
    cache: "no-store",
  })
  const response = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, response }
}

async function handle(req: Request): Promise<Response> {
  if (!(await authorized(req))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }
  const url = new URL(req.url)
  let p: {
    evento?: string
    empresa?: string
    numero?: string
    monto?: string
    to?: string
    quoteId?: string
  } = {}
  if (req.method === "POST") p = (await req.json().catch(() => ({}))) as typeof p

  // Cierre de cadencia: una cotización aceptada/pagada apaga TODO el
  // seguimiento automático del contacto (nudges, anuncio de llamada y
  // llamadas agendadas). Antes esto no existía y el ciclo seguía corriendo —
  // con el canal de voz activo eso significaba LLAMAR a un cliente que ya
  // pagó (visto con Transportes Viig, 15-jul). Best-effort: no bloquea la
  // notificación al equipo.
  const eventoRaw = (p.evento || new URL(req.url).searchParams.get("evento") || "aceptada").toLowerCase()
  const quoteId = (p.quoteId || new URL(req.url).searchParams.get("quoteId") || "").trim()
  // Solo una venta cerrada (aceptada/pagada) apaga la cadencia — un aviso
  // operativo (ej. crm_incompleto) NO debe silenciar el seguimiento comercial.
  if (quoteId && (eventoRaw === "aceptada" || eventoRaw === "pagada")) {
    const contact = await findContactByQuoteId(quoteId).catch(() => null)
    if (contact) {
      await closeFollowup(contact, "cotizacion_aceptada").catch(() => {})
      await cancelPendingCallbacks(contact).catch(() => {})
      console.log(`[quote-notify] cadencia cerrada contact=${contact} quote=${quoteId}`)
    }
  }
  const evento = (p.evento || url.searchParams.get("evento") || "aceptada").toLowerCase()
  const empresa = (p.empresa || url.searchParams.get("empresa") || "").trim() || "—"
  const numero = (p.numero || url.searchParams.get("numero") || "").trim() || "—"
  const monto = (p.monto || url.searchParams.get("monto") || "").trim() || "—"
  const to = (p.to || url.searchParams.get("to") || NOTIFY_TO).replace(/\D/g, "")
  const estado =
    evento === "pagada" ? "PAGADA" : evento === "crm_incompleto" ? "⚠️ ENTREGADA SIN CRM COMPLETO (reconciliador en camino)" : "ACEPTADA"

  let result
  let via: string
  if (TEMPLATE) {
    via = "template"
    result = await send({
      to,
      type: "template",
      template: {
        name: TEMPLATE,
        language: { code: TEMPLATE_LANG },
        components: [
          {
            type: "body",
            parameters: [numero, estado, empresa, monto].map((t) => ({ type: "text", text: String(t) })),
          },
        ],
      },
    })
  } else {
    via = "texto_libre"
    const emoji = evento === "pagada" ? "💰" : "✅"
    const texto = `${emoji} Cotización ${numero} ${estado} — ${empresa}. Monto: ${monto}.`
    result = await send({ to, type: "text", text: { body: texto } })
  }

  return NextResponse.json({ via, to, evento: estado, ...result }, { status: result.ok ? 200 : 502 })
}

export async function GET(req: Request): Promise<Response> {
  return handle(req)
}
export async function POST(req: Request): Promise<Response> {
  return handle(req)
}
