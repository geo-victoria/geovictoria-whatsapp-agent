/**
 * AUDITORÍA DE MENSAJES CONTRA BOTMAKER (08-ago, caso "Vicky callada").
 *
 * Pregunta de Lalo: ¿cuántos mensajes de clientes llegaron a Botmaker pero
 * NUNCA a nuestro webhook (la acción de código no corrió)? Nuestra base no
 * puede verlos por construcción — la única fuente es la API de Botmaker.
 *
 * GET ?key=<CRON_SECRET>&contact=<fono>            → auditoría de un contacto
 * GET ?key=<CRON_SECRET>&contact=<fono>&raw=1      → respuestas crudas de la
 *     API de Botmaker (para descubrir/ajustar el shape sin redeployar)
 *
 * Compara los mensajes DEL CLIENTE que Botmaker registra contra los user
 * messages de vic_v3_messages y reporta los que nos faltan (= tragados).
 * Solo lectura: jamás escribe ni envía nada.
 */

import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const BM_TOKEN = (process.env.BOTMAKER_ACCESS_TOKEN || "").trim()
const CRON_SECRET = (process.env.CRON_SECRET || "").trim()
const VICKY_SECRET = (process.env.VICKY_COTIZADORA_SECRET || "").trim()
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim().replace(/\/$/, "")
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()

const BM_HEADERS = { "access-token": BM_TOKEN, Accept: "application/json" }

type Intento = { url: string; status: number; body: string }

/** Prueba las variantes conocidas del endpoint de mensajes de Botmaker y
 * devuelve todas las respuestas (la API pública documenta v2.0 pero el shape
 * exacto varía por plan — se descubre en runtime con &raw=1). */
async function consultarBotmaker(contact: string): Promise<Intento[]> {
  const urls = [
    `https://api.botmaker.com/v2.0/messages?chatIdOrContactId=${encodeURIComponent(contact)}&limit=100`,
    `https://api.botmaker.com/v2.0/messages?contactId=${encodeURIComponent(contact)}&limit=100`,
    `https://api.botmaker.com/v2.0/chats/${encodeURIComponent(contact)}/messages`,
    `https://api.botmaker.com/v2.0/customers/${encodeURIComponent(contact)}`,
  ]
  const out: Intento[] = []
  for (const url of urls) {
    try {
      const r = await fetch(url, { headers: BM_HEADERS, cache: "no-store" })
      const body = await r.text().catch(() => "")
      out.push({ url, status: r.status, body: body.slice(0, 4000) })
      // Con un 200 con contenido ya hay material; se sigue igual para comparar shapes.
    } catch (e) {
      out.push({ url, status: 0, body: String(e instanceof Error ? e.message : e).slice(0, 200) })
    }
  }
  return out
}

/** Mensajes de usuario que SÍ registramos, para el cruce. */
async function mensajesRegistrados(contact: string): Promise<Array<{ at: string; content: string }>> {
  const conv = (await fetch(
    `${SUPABASE_URL}/rest/v1/vic_v3_conversations?contact=eq.${encodeURIComponent(contact)}&select=id&limit=1`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, cache: "no-store" },
  ).then((r) => (r.ok ? r.json() : [])).catch(() => [])) as Array<{ id: string }>
  if (!conv[0]?.id) return []
  return ((await fetch(
    `${SUPABASE_URL}/rest/v1/vic_v3_messages?conversation_id=eq.${conv[0].id}&role=eq.user&select=at,content&order=at.desc&limit=200`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, cache: "no-store" },
  ).then((r) => (r.ok ? r.json() : [])).catch(() => [])) as Array<{ at: string; content: string }>)
}

export async function GET(req: Request): Promise<Response> {
  const sp = new URL(req.url).searchParams
  const key = (sp.get("key") || "").trim()
  const headerSecret = (req.headers.get("x-vicky-secret") || "").trim()
  const ok =
    (CRON_SECRET && key === CRON_SECRET) || (VICKY_SECRET && headerSecret === VICKY_SECRET)
  if (!ok) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  if (!BM_TOKEN) return NextResponse.json({ ok: false, error: "BOTMAKER_ACCESS_TOKEN no configurado" }, { status: 500 })

  const contact = (sp.get("contact") || "").trim().replace(/^\+/, "")
  if (!contact) return NextResponse.json({ ok: false, error: "falta ?contact=" }, { status: 400 })

  const intentos = await consultarBotmaker(contact)
  if (sp.get("raw")) {
    return NextResponse.json({ ok: true, contact, intentos })
  }

  // Parseo tolerante: busca un array de mensajes en la primera respuesta 200.
  let bmMsgs: Array<Record<string, unknown>> = []
  for (const it of intentos) {
    if (it.status !== 200) continue
    try {
      const j = JSON.parse(it.body) as unknown
      const arr = Array.isArray(j)
        ? j
        : (j as { messages?: unknown[]; items?: unknown[]; data?: unknown[] })?.messages ||
          (j as { items?: unknown[] })?.items ||
          (j as { data?: unknown[] })?.data
      if (Array.isArray(arr) && arr.length) {
        bmMsgs = arr as Array<Record<string, unknown>>
        break
      }
    } catch { /* siguiente intento */ }
  }

  const registrados = await mensajesRegistrados(contact)
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 80)
  const setReg = new Set(registrados.map((m) => norm(m.content)))

  // Del lado Botmaker: quedarnos con lo que parezca mensaje del CLIENTE.
  const delCliente = bmMsgs.filter((m) => {
    const from = String(m.from || m.sender || m.direction || "").toUpperCase()
    const esUser = from.includes("USER") || from.includes("CUSTOMER") || from.includes("IN")
    const esAgente = from.includes("BOT") || from.includes("AGENT") || from.includes("OUT")
    return esUser && !esAgente
  })
  const faltantes = delCliente.filter((m) => {
    const texto = String(m.message || m.text || m.body || m.content || "")
    return texto && !setReg.has(norm(texto))
  })

  return NextResponse.json({
    ok: true,
    contact,
    botmaker_total: bmMsgs.length,
    botmaker_del_cliente: delCliente.length,
    registrados_nuestros: registrados.length,
    faltantes: faltantes.map((m) => ({
      texto: String(m.message || m.text || m.body || m.content || "").slice(0, 200),
      fecha: m.date || m.creationTime || m.timestamp || null,
    })),
    nota: bmMsgs.length
      ? undefined
      : "Ningún intento devolvió mensajes — revisa &raw=1 para ver los shapes y ajustar.",
  })
}
