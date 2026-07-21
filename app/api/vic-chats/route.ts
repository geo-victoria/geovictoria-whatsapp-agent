/**
 * Visor de conversaciones en TIEMPO REAL — pedido del equipo Colombia (21-jul).
 *
 * GET /api/vic-chats?key=<VIC_FUNNEL_KEY>[&pais=co|cl|all][&contact=<fono>]
 *
 *  - Sin `contact`: lista de conversaciones (default: Colombia) ordenadas por
 *    última actividad, con preview del último mensaje y estado del ciclo.
 *  - Con `contact`: transcripción completa del chat, con los registros
 *    internos atenuados (son notas operativas del sistema, útiles para el
 *    equipo pero no son mensajes que vio el cliente).
 *  - Auto-refresh cada 20s (meta refresh) — "tiempo real" operativo sin
 *    websockets. Datos directo de Supabase (fuente de verdad del agente).
 *
 * Misma llave del dash del embudo (VIC_FUNNEL_KEY): una sola credencial que
 * ya circula en el equipo. Solo lectura.
 */

import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"
export const maxDuration = 30

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const FUNNEL_KEY = (process.env.VIC_FUNNEL_KEY || "").trim()

const HEADERS = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function fmt(ts: string | null | undefined, tz: string): string {
  if (!ts) return "—"
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return "—"
  return new Intl.DateTimeFormat("es-CL", {
    timeZone: tz,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d)
}

type Conv = {
  id: string
  contact: string
  country: string | null
  started_at: string
  updated_at: string | null
  last_user_at: string | null
  followup_status: string | null
  formal_quote_id: string | null
}

type Msg = { role: string; content: string; at: string }
type Pointer = { quote_id: string; deal_id: string | null; acceptance_url: string | null }

// Links útiles de la cotización asociada (pedido equipo CO, 21-jul): la página
// de aceptación (lo que ve el cliente, con precio vivo) y el Deal en Zoho.
async function punteroDe(contact: string, quoteId: string | null): Promise<Pointer | null> {
  if (!quoteId) return null
  const rows = await sb<Pointer[]>(
    `vic_v3_quote_pointers?contact=eq.${contact}&quote_id=eq.${quoteId}&select=quote_id,deal_id,acceptance_url&limit=1`,
  ).catch(() => [] as Pointer[])
  return rows[0] || null
}

function linksCotizacion(p: Pointer | null): string {
  if (!p) return ""
  const partes: string[] = []
  if (p.acceptance_url) partes.push(`<a href="${esc(p.acceptance_url)}" target="_blank">ver cotización</a>`)
  if (p.deal_id) partes.push(`<a href="https://crm.zoho.com/crm/tab/Potentials/${esc(p.deal_id)}" target="_blank">deal en Zoho</a>`)
  return partes.join(" · ")
}

async function sb<T>(path: string): Promise<T> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: HEADERS, cache: "no-store" })
  if (!r.ok) throw new Error(`Supabase ${r.status}`)
  return (await r.json()) as T
}

const ESTILO = `<style>
  body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:0;background:#f5f6f8;color:#1f2733}
  .wrap{max-width:860px;margin:0 auto;padding:18px 14px}
  h1{font-size:19px;margin:0 0 4px} .sub{color:#6b7280;font-size:13px;margin-bottom:14px}
  a{color:#1a73e8;text-decoration:none}
  table{width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.07);font-size:13px}
  th{background:#f7fafc;text-align:left;padding:8px 10px;color:#4a5568} td{padding:8px 10px;border-top:1px solid #edf2f7;vertical-align:top}
  .prev{color:#6b7280;max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block}
  .tag{background:#eef2ff;border-radius:6px;padding:1px 7px;font-size:11px;color:#4338ca}
  .msg{max-width:78%;margin:6px 0;padding:8px 12px;border-radius:12px;font-size:13.5px;white-space:pre-wrap;word-break:break-word}
  .u{background:#fff;border:1px solid #e2e8f0;margin-right:auto}
  .a{background:#d9fdd3;margin-left:auto}
  .int{background:#f1f5f9;color:#94a3b8;font-size:11.5px;max-width:100%;border:1px dashed #cbd5e1}
  .who{font-size:10.5px;color:#94a3b8;margin-bottom:2px}
  .hora{font-size:10px;color:#a0aec0;text-align:right;margin-top:2px}
</style>`

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const key = (url.searchParams.get("key") || "").trim()
  if (!FUNNEL_KEY || key !== FUNNEL_KEY) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }
  const pais = (url.searchParams.get("pais") || "co").toLowerCase()
  const contact = (url.searchParams.get("contact") || "").replace(/\D/g, "")
  const tz = pais === "cl" ? "America/Santiago" : "America/Bogota"
  const qs = (extra: string) => `?key=${encodeURIComponent(key)}${extra}`

  try {
    if (contact) {
      // ── Detalle: transcripción completa ──
      const convs = await sb<Conv[]>(
        `vic_v3_conversations?contact=eq.${contact}&select=id,contact,country,started_at,last_user_at,followup_status,formal_quote_id&limit=1`,
      )
      const conv = convs[0]
      const msgs = conv
        ? await sb<Msg[]>(
            `vic_v3_messages?conversation_id=eq.${conv.id}&select=role,content,at&order=at.asc&limit=500`,
          )
        : []
      const burbujas = msgs
        .map((m) => {
          const interno = m.role === "assistant" && m.content.startsWith("[REGISTRO INTERNO")
          const clase = interno ? "msg int" : m.role === "user" ? "msg u" : "msg a"
          const quien = interno ? "sistema (no visible para el cliente)" : m.role === "user" ? "Cliente" : "Vicky"
          return `<div class="${clase}"><div class="who">${quien}</div>${esc(m.content)}<div class="hora">${fmt(m.at, tz)}</div></div>`
        })
        .join("")
      const puntero = conv ? await punteroDe(contact, conv.formal_quote_id) : null
      const links = linksCotizacion(puntero)
      const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="20"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Chat +${esc(contact)}</title>${ESTILO}</head><body><div class="wrap">
        <div class="sub"><a href="${qs(`&pais=${pais}`)}">← Volver a la lista</a></div>
        <h1>+${esc(contact)} ${conv?.country === "co" ? "🇨🇴" : "🇨🇱"}</h1>
        <div class="sub">${msgs.length} mensajes · ciclo: ${esc(conv?.followup_status || "—")} · ${conv?.formal_quote_id ? `cotización formal${links ? " (" + links + ")" : ""}` : "sin cotización formal"} · hora local ${pais.toUpperCase()} · se actualiza solo cada 20s</div>
        ${burbujas || "<p class='sub'>Sin mensajes.</p>"}
      </div></body></html>`
      return new NextResponse(html, { headers: { "Content-Type": "text/html; charset=utf-8" } })
    }

    // ── Lista de conversaciones ──
    const filtro = pais === "all" ? "" : `&country=eq.${pais === "cl" ? "cl" : "co"}`
    const convs = await sb<Conv[]>(
      `vic_v3_conversations?select=id,contact,country,started_at,updated_at,last_user_at,followup_status,formal_quote_id${filtro}&order=updated_at.desc.nullslast&limit=60`,
    )
    // Preview del último mensaje de cada conversación (consultas chicas en lote).
    const previews = await Promise.all(
      convs.slice(0, 60).map(async (c) => {
        const [m, p] = await Promise.all([
          sb<Msg[]>(
            `vic_v3_messages?conversation_id=eq.${c.id}&select=role,content,at&order=at.desc&limit=1`,
          ).catch(() => [] as Msg[]),
          punteroDe(c.contact, c.formal_quote_id),
        ])
        return { m: m[0], p }
      }),
    )
    const filas = convs
      .map((c, i) => {
        const { m, p } = previews[i]
        const prev = m ? `${m.role === "user" ? "Cliente" : "Vicky"}: ${m.content.slice(0, 90)}` : "—"
        const tagCotizacion = c.formal_quote_id
          ? p?.acceptance_url
            ? `<a class="tag" href="${esc(p.acceptance_url)}" target="_blank">cotización ↗</a>`
            : '<span class="tag">cotización</span>'
          : ""
        return `<tr>
          <td><a href="${qs(`&pais=${pais}&contact=${c.contact}`)}"><b>+${esc(c.contact)}</b></a> ${c.country === "co" ? "🇨🇴" : "🇨🇱"}</td>
          <td><span class="prev">${esc(prev)}</span></td>
          <td>${fmt(m?.at || c.updated_at, tz)}</td>
          <td>${tagCotizacion} ${esc(c.followup_status || "")}</td>
        </tr>`
      })
      .join("")
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="20"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Conversaciones Vicky</title>${ESTILO}</head><body><div class="wrap">
      <h1>Conversaciones Vicky — ${pais === "all" ? "todas" : pais === "cl" ? "Chile 🇨🇱" : "Colombia 🇨🇴"}</h1>
      <div class="sub">${convs.length} conversaciones · hora local ${pais === "cl" ? "Santiago" : "Bogotá"} · se actualiza sola cada 20s ·
        <a href="${qs("&pais=co")}" style="font-weight:${pais === "co" ? 700 : 400}">Colombia</a> |
        <a href="${qs("&pais=cl")}" style="font-weight:${pais === "cl" ? 700 : 400}">Chile</a> |
        <a href="${qs("&pais=all")}" style="font-weight:${pais === "all" ? 700 : 400}">Todas</a></div>
      <table><thead><tr><th>Contacto</th><th>Último mensaje</th><th>Hora</th><th>Estado</th></tr></thead><tbody>${filas}</tbody></table>
    </div></body></html>`
    return new NextResponse(html, { headers: { "Content-Type": "text/html; charset=utf-8" } })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error)?.message || e) }, { status: 500 })
  }
}
