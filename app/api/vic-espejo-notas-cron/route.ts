/**
 * Cron: GET /api/vic-espejo-notas-cron — cada 15 minutos (vercel.json)
 *
 * Sincroniza las conversaciones del ESPEJO de WhatsApp de los ejecutivos
 * (vic_wa_espejo_mensajes, capturadas por workers/wa-espejo) hacia las NOTAS
 * del DEAL en Zoho (pedido Lalo 06-ago):
 *
 *  - El cruce es por TELÉFONO: el teléfono del chat espejado contra el
 *    Contact_Phone del deal. Muchos chats llegan con ID anónimo (@lid); el
 *    teléfono real viene en key.senderPn de los mensajes ENTRANTES, así que
 *    un chat se vuelve cruzable apenas el cliente escribió una vez.
 *  - UNA nota por (deal, ejecutivo), SIEMPRE la misma: cada corrida
 *    reconstruye el historial completo del chat y ACTUALIZA la nota en el
 *    lugar (no crea notas nuevas). El id de la nota vive en vic_kv.
 *  - Best-effort de punta a punta: un chat que falla no detiene al resto.
 *
 * Auth: Bearer CRON_SECRET (Vercel Cron lo manda solo), ?key= o x-cron-secret.
 */

import { NextResponse } from "next/server"
import { getZohoAccessToken } from "@/lib/zoho-token"
import { getFollowupCronSecret } from "@/lib/supabase-persistence-v3"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const CRON_SECRET = (process.env.CRON_SECRET || "").trim()
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const ZOHO_API_DOMAIN = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()

// Nombre visible del ejecutivo por sesión del espejo (los ids son los handles
// de email; los numéricos son líneas internas de prueba/piloto).
const NOMBRE_SESION: Record<string, string> = {
  emujica: "Eddyluz Mujica",
  tmartinezq: "Tamara Martínez",
  alopez: "Ana Paula López",
  gmelendez: "Grey Meléndez",
  dgalvez: "Daniela Gálvez",
  pdiaz: "Paola Díaz",
  adiazg: "Anderson Díaz",
}

// Tamaño máximo del cuerpo de la nota (el límite duro de Zoho es ~65k).
const MAX_NOTA = 58_000

const hSb = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }

async function kvGet(key: string): Promise<string> {
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/vic_kv?key=eq.${encodeURIComponent(key)}&select=value,expires_at&limit=1`,
      { headers: hSb, cache: "no-store" },
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

async function kvSet(key: string, value: string): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/vic_kv?on_conflict=key`, {
    method: "POST",
    headers: { ...hSb, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ key, value }),
    cache: "no-store",
  }).catch(() => {})
}

type FilaEspejo = {
  session_id: string
  chat_jid: string
  from_me: boolean
  autor: string | null
  telefono_chat: string | null
  texto: string | null
  tipo: string | null
  enviado_at: string
  raw?: { key?: { senderPn?: string; participantPn?: string } } | null
}

async function filasEspejo(query: string): Promise<FilaEspejo[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/vic_wa_espejo_mensajes?${query}`, {
    headers: hSb,
    cache: "no-store",
  })
  return r.ok ? (((await r.json().catch(() => [])) as FilaEspejo[]) || []) : []
}

function fonoDe(filas: FilaEspejo[]): string {
  for (const f of filas) {
    if (f.telefono_chat && /^\d{8,15}$/.test(f.telefono_chat) && !f.chat_jid.endsWith("@lid")) return f.telefono_chat
  }
  for (const f of filas) {
    const pn = (f.raw?.key?.senderPn || f.raw?.key?.participantPn || "").replace(/@.*$/, "").replace(/\D/g, "")
    if (pn) return pn
  }
  // telefono_chat de chats @lid antiguos era el LID (no sirve para cruzar).
  return ""
}

const fmtCL = (iso: string) =>
  new Date(iso).toLocaleString("es-CL", {
    timeZone: "America/Santiago",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })

function transcript(filas: FilaEspejo[], ejecutivo: string): string {
  const lineas = filas.map((f) => {
    const quien = f.from_me ? ejecutivo : (f.autor || "Cliente")
    const cuerpo = f.texto?.trim() || `[${f.tipo || "mensaje"}]`
    return `[${fmtCL(f.enviado_at)}] ${quien}: ${cuerpo}`
  })
  let cuerpo = lineas.join("\n")
  if (cuerpo.length > MAX_NOTA) {
    cuerpo = "(…historial anterior truncado por tamaño…)\n" + cuerpo.slice(cuerpo.length - MAX_NOTA)
  }
  return cuerpo
}

/** Deal de Zoho por teléfono del contacto (últimos 8 dígitos, cache 1 día). */
async function dealPorFono(fono: string, token: string): Promise<{ id: string; nombre: string } | null> {
  const cacheKey = `espejo_deal_${fono}`
  const cacheado = await kvGet(cacheKey)
  if (cacheado === "no") return null
  if (cacheado) {
    try {
      return JSON.parse(cacheado) as { id: string; nombre: string }
    } catch {
      /* re-resuelve */
    }
  }
  const cola = fono.slice(-8)
  const r = await fetch(`${ZOHO_API_DOMAIN}/crm/v3/coql`, {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      select_query: `select id, Deal_Name from Deals where Contact_Phone like '%${cola}' order by Created_Time desc limit 1`,
    }),
    cache: "no-store",
  })
  const data = ((await r.json().catch(() => null))?.data || []) as Array<{ id: string; Deal_Name?: string }>
  if (!data.length) {
    await kvSet(cacheKey, "no")
    return null
  }
  const deal = { id: String(data[0].id), nombre: String(data[0].Deal_Name || "") }
  await kvSet(cacheKey, JSON.stringify(deal))
  return deal
}

async function upsertNota(
  dealId: string,
  session: string,
  titulo: string,
  contenido: string,
  token: string,
): Promise<{ noteId: string; creada: boolean } | null> {
  const kvKey = `espejo_nota_${dealId}_${session}`
  const existente = await kvGet(kvKey)
  const H = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }
  if (existente) {
    const upd = await fetch(`${ZOHO_API_DOMAIN}/crm/v3/Notes/${existente}`, {
      method: "PUT",
      headers: H,
      body: JSON.stringify({ data: [{ Note_Title: titulo, Note_Content: contenido }] }),
      cache: "no-store",
    })
    if (upd.ok) return { noteId: existente, creada: false }
    // La nota pudo haber sido borrada a mano: se crea de nuevo.
  }
  const crea = await fetch(`${ZOHO_API_DOMAIN}/crm/v3/Deals/${dealId}/Notes`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ data: [{ Note_Title: titulo, Note_Content: contenido }] }),
    cache: "no-store",
  })
  const cuerpo = (await crea.json().catch(() => null)) as {
    data?: Array<{ details?: { id?: string } }>
  } | null
  const noteId = cuerpo?.data?.[0]?.details?.id
  if (!crea.ok || !noteId) return null
  await kvSet(kvKey, String(noteId))
  return { noteId: String(noteId), creada: true }
}

async function authorized(req: Request): Promise<boolean> {
  const url = new URL(req.url)
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim()
  if (CRON_SECRET && (bearer === CRON_SECRET || (url.searchParams.get("key") || "").trim() === CRON_SECRET)) return true
  const xcron = (req.headers.get("x-cron-secret") || "").trim()
  const key = (url.searchParams.get("key") || "").trim()
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

  // Chats con actividad desde el último cursor (48h de gracia en el arranque
  // para no perder lo capturado antes de que existiera este cron).
  const cursor = (await kvGet("espejo_notas_cursor")) || new Date(Date.now() - 48 * 3600_000).toISOString()
  const ahora = new Date().toISOString()
  const recientes = await filasEspejo(
    `recibido_at=gt.${encodeURIComponent(cursor)}&es_grupo=eq.false&select=session_id,chat_jid&limit=3000`,
  )
  const chats = new Map<string, { session: string; jid: string }>()
  for (const f of recientes) {
    chats.set(`${f.session_id}|${f.chat_jid}`, { session: f.session_id, jid: f.chat_jid })
  }

  const resumen = { chatsRevisados: 0, notasCreadas: 0, notasActualizadas: 0, sinDeal: 0, sinFono: 0, errores: [] as string[] }
  if (!chats.size) {
    await kvSet("espejo_notas_cursor", ahora)
    return NextResponse.json({ ok: true, ...resumen, detalle: "sin actividad nueva" })
  }

  const token = await getZohoAccessToken()

  for (const { session, jid } of chats.values()) {
    try {
      resumen.chatsRevisados += 1
      const filas = await filasEspejo(
        `session_id=eq.${encodeURIComponent(session)}&chat_jid=eq.${encodeURIComponent(jid)}&order=enviado_at.asc&limit=1000&select=session_id,chat_jid,from_me,autor,telefono_chat,texto,tipo,enviado_at,raw`,
      )
      if (!filas.length) continue
      const fono = fonoDe(filas)
      if (!fono) {
        resumen.sinFono += 1
        continue
      }
      const deal = await dealPorFono(fono, token)
      if (!deal) {
        resumen.sinDeal += 1
        continue
      }
      const ejecutivo = NOMBRE_SESION[session] || session
      const titulo = `WhatsApp ${ejecutivo} ↔ cliente (espejo, se actualiza cada 15 min)`
      const cuerpo =
        `Conversación de WhatsApp entre ${ejecutivo} (línea corporativa espejada) y el cliente (+${fono}).\n` +
        `Última sincronización: ${fmtCL(ahora)} (hora Chile). Mensajes: ${filas.length}.\n` +
        `----------------------------------------\n` +
        transcript(filas, ejecutivo)
      const nota = await upsertNota(deal.id, session, titulo, cuerpo, token)
      if (!nota) {
        resumen.errores.push(`${session}/${fono}: Zoho rechazó la nota`)
        continue
      }
      if (nota.creada) resumen.notasCreadas += 1
      else resumen.notasActualizadas += 1
    } catch (e) {
      resumen.errores.push(`${session}/${jid}: ${String((e as Error)?.message || e).slice(0, 120)}`)
    }
  }

  await kvSet("espejo_notas_cursor", ahora)
  return NextResponse.json({ ok: true, ...resumen })
}
