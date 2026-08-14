/**
 * AUDITORÍA DE MENSAJES CONTRA BOTMAKER (08-ago, caso "Vicky callada").
 *
 * Pregunta de Lalo: ¿cuántos mensajes de clientes llegaron a Botmaker pero
 * NUNCA a nuestro webhook (la acción de código no corrió)? Nuestra base no
 * puede verlos por construcción — la única fuente es la API de Botmaker.
 *
 * Descubrimiento 08-ago (&raw=1): GET /v2.0/messages devuelve el FEED
 * COMPLETO paginado (ignora contactId), con from/to y nextPage. Eso permite
 * barrer todo el tráfico desde una fecha y cruzarlo contra vic_v3_messages.
 *
 * GET ?key=<secret>&sweep=1&from=2026-08-04T00:00:00Z[&pages=6][&cursor=URL]
 *   → { mensajes_user, faltantes_total, por_contacto, cursor }
 * GET ?key=<secret>&contact=<fono>&raw=1  → respuestas crudas (diagnóstico)
 *
 * El match es por INCLUSIÓN: el webhook v3 combina ráfagas en un solo turno,
 * así que el texto Botmaker debe aparecer DENTRO de algún user message
 * nuestro del mismo contacto. Solo lectura: jamás escribe ni envía nada.
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const BM_TOKEN = (process.env.BOTMAKER_ACCESS_TOKEN || "").trim()
const CRON_SECRET = (process.env.CRON_SECRET || "").trim()
const VICKY_SECRET = (process.env.VICKY_COTIZADORA_SECRET || "").trim()
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim().replace(/\/$/, "")
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()

const BM_HEADERS = { "access-token": BM_TOKEN, Accept: "application/json" }
const SB_HEADERS = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }

type BmItem = {
  id?: string
  creationTime?: string
  from?: string
  content?: { type?: string; text?: string }
  chat?: { chatId?: string; channelId?: string; contactId?: string }
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase()

async function autorizado(req: Request, key: string): Promise<boolean> {
  const headerSecret = (req.headers.get("x-vicky-secret") || "").trim()
  if (CRON_SECRET && key === CRON_SECRET) return true
  if (VICKY_SECRET && headerSecret === VICKY_SECRET) return true
  if (key) {
    const kvSecret = await getFollowupCronSecret().catch(() => "")
    if (kvSecret && key === kvSecret) return true
  }
  return false
}

/** User messages nuestros desde una fecha, agrupados por contacto.
 * OJO PostgREST: el servidor CAPA cada respuesta a 1000 filas aunque el limit
 * pida más (bug del primer barrido 08-ago: solo entraban los primeros 1000
 * mensajes y todo lo posterior aparecía como "faltante"). Se pagina de a 1000
 * hasta página corta. */
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
  for (let page = 0; page < 40; page++) {
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

export async function GET(req: Request): Promise<Response> {
  const sp = new URL(req.url).searchParams
  const key = (sp.get("key") || "").trim()
  if (!(await autorizado(req, key))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }
  if (!BM_TOKEN) {
    return NextResponse.json({ ok: false, error: "BOTMAKER_ACCESS_TOKEN no configurado" }, { status: 500 })
  }

  // ── Proxy de SOLO LECTURA a la API de Botmaker (exploración de endpoints:
  // bots/intents/agentes/colas). GET únicamente, host fijo — jamás muta nada.
  const bmpath = (sp.get("bmpath") || "").trim()
  if (bmpath) {
    if (!/^\/v[0-9.]+\/[a-zA-Z0-9/_?&=%.:+-]*$/.test(bmpath)) {
      return NextResponse.json({ ok: false, error: "bmpath inválido" }, { status: 400 })
    }
    const r = await fetch(`https://api.botmaker.com${bmpath}`, { headers: BM_HEADERS, cache: "no-store" })
    // 8000 se quedaba corto: el listado de agentes del workspace se cortaba en
    // la letra L y el cruce con los dueños de Zoho salía incompleto.
    return NextResponse.json({ ok: true, bmpath, status: r.status, body: (await r.text()).slice(0, 500000) })
  }

  // ── Modo diagnóstico crudo (se mantiene para futuros ajustes de shape) ──
  const contact = (sp.get("contact") || "").trim().replace(/^\+/, "")
  if (contact && sp.get("raw")) {
    const url = `https://api.botmaker.com/v2.0/messages?contactId=${encodeURIComponent(contact)}&limit=100`
    const r = await fetch(url, { headers: BM_HEADERS, cache: "no-store" })
    return NextResponse.json({ ok: true, contact, status: r.status, body: (await r.text()).slice(0, 6000) })
  }

  if (!sp.get("sweep")) {
    return NextResponse.json({ ok: false, error: "usa ?sweep=1&from=ISO (o &contact=X&raw=1)" }, { status: 400 })
  }

  const fromIso = (sp.get("from") || "2026-08-04T00:00:00.000Z").trim()
  const toIso = (sp.get("to") || new Date().toISOString()).trim()
  const maxPages = Math.min(10, Math.max(1, Number(sp.get("pages") || 6)))
  let cursor = (sp.get("cursor") || "").trim()

  const nuestros = await nuestrosPorContacto(fromIso)

  let totalItems = 0
  let userTexto = 0
  let userOtroTipo = 0
  const faltantes: Array<{ contact: string; canal: string; fecha: string; texto: string }> = []
  let paginas = 0

  for (; paginas < maxPages; paginas++) {
    const url =
      cursor ||
      `https://api.botmaker.com/v2.0/messages?limit=250&from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`
    const r = await fetch(url, { headers: BM_HEADERS, cache: "no-store" })
    if (!r.ok) {
      return NextResponse.json({ ok: false, error: `Botmaker ${r.status} en página ${paginas + 1}`, paginas }, { status: 502 })
    }
    const j = (await r.json().catch(() => null)) as { items?: BmItem[]; nextPage?: string } | null
    const items = Array.isArray(j?.items) ? j.items : []
    totalItems += items.length

    for (const it of items) {
      if (String(it.from || "").toLowerCase() !== "user") continue
      const cid = String(it.chat?.contactId || "").trim()
      if (!cid || /[^\d]/.test(cid)) continue // anónimos/CO.xxx quedan fuera del cruce por fono
      const tipo = String(it.content?.type || "")
      if (tipo !== "text") {
        userOtroTipo++
        continue
      }
      const texto = String(it.content?.text || "").trim()
      if (!texto) continue
      userTexto++
      const registrados = nuestros.get(cid) || []
      const n = norm(texto)
      const visto = registrados.some((rg) => rg.includes(n))
      if (!visto) {
        faltantes.push({
          contact: cid,
          canal: String(it.chat?.channelId || ""),
          fecha: String(it.creationTime || ""),
          texto: texto.slice(0, 160),
        })
      }
    }

    cursor = String(j?.nextPage || "")
    if (!cursor || items.length === 0) {
      cursor = ""
      break
    }
  }

  // Agregado por contacto para lectura rápida.
  const porContacto = new Map<string, number>()
  for (const f of faltantes) porContacto.set(f.contact, (porContacto.get(f.contact) || 0) + 1)

  return NextResponse.json({
    ok: true,
    ventana: { from: fromIso, to: toIso },
    paginas,
    mensajes_feed: totalItems,
    user_texto: userTexto,
    user_no_texto: userOtroTipo,
    faltantes_total: faltantes.length,
    contactos_afectados: porContacto.size,
    por_contacto: Array.from(porContacto.entries()).map(([c, n]) => ({ contact: c, faltantes: n })),
    detalle: faltantes.slice(0, 120),
    cursor: cursor || undefined,
  })
}
