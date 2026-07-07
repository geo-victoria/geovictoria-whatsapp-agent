/**
 * Cron de REACTIVACIÓN de leads tibios (fuera de la ventana de 24h).
 *
 * Distinto del seguimiento normal (vic-followup-cron, que corre DENTRO de 24h con
 * texto libre): este reactiva a quienes se enfriaron y reabre la conversación con
 * una PLANTILLA HSM aprobada por Meta (única vía permitida fuera de 24h). Dos
 * segmentos:
 *   - "preform": vio un estimado referencial pero NO llegó a cotización formal.
 *   - "cotizacion": recibió el link + PDF (cotización formal) y NO la aceptó/pagó.
 *
 * Salvaguardas: respeta opt-out, no toca ciclos activos, excluye cotizaciones ya
 * aceptadas/pagadas (consulta Zoho), y tope de frecuencia por conversación.
 *
 * SEGURO POR DEFECTO: si no hay nombre de plantilla configurado (REACTIVATION_
 * TEMPLATE_*), ese segmento NO envía nada. Así se puede desplegar ANTES de tener
 * las plantillas aprobadas.
 *
 * Auth: Authorization: Bearer ${CRON_SECRET} (o ?key=${CRON_SECRET}).
 */

import { NextResponse } from "next/server"
import { sendBotmakerTemplate } from "@/lib/botmaker-push-v3"
import { appendAssistantV3, fetchHistoryV3, getFollowupCronSecret } from "@/lib/supabase-persistence-v3"
import { testContactSet, isTestContact } from "@/lib/funnel-analysis"
import { getZohoAccessToken } from "@/lib/zoho-token"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const CRON_SECRET = (process.env.CRON_SECRET || "").trim()

// Plantillas HSM aprobadas (nombre/ruleNameOrId en Botmaker). Vacío = segmento off.
const TPL_PREFORM = (process.env.REACTIVATION_TEMPLATE_PREFORM || "").trim()
const TPL_QUOTE = (process.env.REACTIVATION_TEMPLATE_QUOTE || "").trim()
// Cadencia de los toques largos (HSM), en HORAS desde el último mensaje del
// cliente (silence anchor): 47h, 7 días (168h), 15 días (360h). El toque N se
// envía cuando reactivation_count == N-1 y ya transcurrió OFFSETS_H[N-1].
// Configurable por env (REACTIVATION_OFFSETS_H="47,168,360").
const OFFSETS_H = (process.env.REACTIVATION_OFFSETS_H || "47,168,360")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0)
// Primer toque = primer offset; tope de toques = cantidad de offsets.
const COLD_AFTER_H = OFFSETS_H[0] ?? 47
const MAX_REACT = OFFSETS_H.length || 3
// Ventana máxima: el último offset (en días) + 1 día de margen.
const MAX_AGE_D = Number(
  process.env.REACTIVATION_MAX_AGE_DAYS || Math.ceil((OFFSETS_H[OFFSETS_H.length - 1] || 360) / 24) + 1,
)
// Safety anti doble-envío (la cadencia real la marcan los offsets).
const MIN_GAP_H = Number(process.env.REACTIVATION_MIN_GAP_HOURS || 24)
const BATCH = Number(process.env.REACTIVATION_BATCH || 25)
const QUOTE_MODULE = (process.env.ZOHO_QUOTE_MODULE || "Cotizaciones_GeoVictoria").trim()

// Correo de reactivación (segmento "cotizacion"): se dispara en paralelo al HSM.
// La cotizadora decide a quién enviar (filtra internos/prueba) y arma el correo
// con CTA de aceptación online + PDF adjunto. Seguro por defecto: solo se llama
// si REACTIVATION_EMAIL_ENABLED=true; la cotizadora además se auto-gatea.
const COTIZADORA_API_BASE = (process.env.COTIZADORA_API_BASE || "https://cotizacion.geovictoria.com").trim()
const VICKY_COTIZADORA_SECRET = (process.env.VICKY_COTIZADORA_SECRET || "").trim()
const EMAIL_ENABLED = (process.env.REACTIVATION_EMAIL_ENABLED || "").trim().toLowerCase() === "true"

// Texto que se guarda en el historial como turno de Vicky cuando se envía el HSM,
// para que al responder el cliente, Vicky sepa que ELLA reabrió con la oferta
// flash y le dé continuidad. NO se reenvía al cliente: es contexto interno.
const REACT_CONTEXT_MSG: Record<string, string> = {
  cotizacion:
    "Hola, soy Vicky 👋 Te escribí para retomar tu cotización, que quedó pendiente. Tengo un precio especial vigente por tiempo limitado para que puedas cerrar. ¿La revisamos antes de que caduque?",
  preform:
    "Hola, soy Vicky 👋 Te escribí para retomar tu cotización pendiente. Tengo un precio especial por tiempo limitado para ti. ¿Lo vemos antes de que caduque?",
}

type Row = {
  id: string
  contact: string
  formal_quote_id: string | null
  reactivation_count: number | null
  reactivation_at: string | null
  last_user_at: string | null
  followup_closed_reason: string | null
  followup_status: string | null
}

async function supa(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
    cache: "no-store",
  })
}

async function authorized(req: Request): Promise<boolean> {
  // (a) Secreto compartido en vic_kv (mismo que followup/meeting crons): permite
  // que el pg_cron de Supabase gatille este endpoint con el header x-cron-secret.
  const xcron = (req.headers.get("x-cron-secret") || "").trim()
  if (xcron) {
    const expected = await getFollowupCronSecret().catch(() => "")
    if (expected && xcron === expected) return true
  }
  // (b) CRON_SECRET por env (Bearer o ?key=): para invocación manual/externa.
  if (!CRON_SECRET) return false
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim()
  if (bearer === CRON_SECRET) return true
  const key = (new URL(req.url).searchParams.get("key") || "").trim()
  return key === CRON_SECRET
}

// Devuelve el set de quoteIds que NO se deben reactivar (ya aceptadas/pagadas/
// cerradas/rechazadas). Conservador: si la consulta a Zoho falla, marca el chunk
// completo como "no reactivar" para no escribirle a un cliente que ya cerró.
async function quoteIdsNoAccionables(
  quoteIds: string[],
): Promise<{ skip: Set<string>; nombres: Map<string, string> }> {
  const skip = new Set<string>()
  const nombres = new Map<string, string>()
  if (!quoteIds.length) return { skip, nombres }
  const apiDomain = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
  let token = ""
  try {
    token = await getZohoAccessToken()
  } catch {
    for (const id of quoteIds) skip.add(id)
    return { skip, nombres }
  }
  for (let i = 0; i < quoteIds.length; i += 50) {
    const chunk = quoteIds.slice(i, i + 50)
    try {
      const ids = chunk.map((id) => `'${id}'`).join(",")
      const res = await fetch(`${apiDomain}/crm/v3/coql`, {
        method: "POST",
        headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          select_query: `select id, Estado_Cotizacion, Contacto_Asociado from ${QUOTE_MODULE} where id in (${ids}) limit 200`,
        }),
        cache: "no-store",
      })
      if (!res.ok) {
        for (const id of chunk) skip.add(id)
        continue
      }
      const data = await res.json()
      for (const r of data?.data || []) {
        const e = String(r?.Estado_Cotizacion || "").toLowerCase()
        if (e.includes("acept") || e.includes("pagad") || e.includes("ganad") || e.includes("cerrad") || e.includes("rechaz")) {
          skip.add(String(r.id))
        }
        // Primer nombre del contacto de la cotización (para el \${nombre} del HSM).
        const full = String(r?.Contacto_Asociado?.name || "").trim()
        if (full) nombres.set(String(r.id), full.split(/\s+/)[0])
      }
    } catch {
      for (const id of chunk) skip.add(id)
    }
  }
  return { skip, nombres }
}


// Primer nombre del cliente extraído del historial (para el ${nombre} del HSM
// cuando no hay cotización formal de la cual sacarlo). Best-effort con el
// modelo chico; si no hay nombre claro devuelve null y el toque se OMITE (mejor
// no enviar que enviar "Hola , cómo estás?").
async function nombreDesdeHistorial(contact: string): Promise<string | null> {
  const apiKey = (process.env.ANTHROPIC_API_KEY || "").trim()
  if (!apiKey) return null
  try {
    const history = await fetchHistoryV3(contact, 30)
    const transcript = history
      .map((m) => `${m.role === "user" ? "Cliente" : "Vicky"}: ${m.content}`)
      .join("\n")
      .slice(-3500)
    if (!transcript) return null
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 20,
        system:
          "Extrae el PRIMER NOMBRE de pila del CLIENTE desde la conversación (el nombre con que se presentó o con que Vicky lo llama). Responde SOLO el nombre (una palabra, capitalizada). Si no hay un nombre claro del cliente, responde exactamente NO.",
        messages: [{ role: "user", content: transcript }],
      }),
      cache: "no-store",
    })
    if (!res.ok) return null
    const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> }
    const out = (data.content?.find((b) => b.type === "text")?.text || "").trim()
    if (!out || out.toUpperCase() === "NO" || out.split(/\s+/).length > 2 || out.length > 25) return null
    return out.split(/\s+/)[0]
  } catch {
    return null
  }
}

export async function GET(req: Request): Promise<Response> {
  if (!(await authorized(req))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }

  // Hook de PRUEBA: ?to=<fono>[&seg=preform|quote] → envía la plantilla a ese
  // número saltando candidatos/filtros (incluido el de prueba), para validar el
  // flujo del botón end-to-end. Mismo auth. Marca reactivation_at para que el
  // reenganche se active al responder.
  const _u = new URL(req.url)
  const testTo = (_u.searchParams.get("to") || "").replace(/\D/g, "")
  if (testTo) {
    const seg = _u.searchParams.get("seg") === "quote" ? "cotizacion" : "preform"
    const tpl = seg === "cotizacion" ? TPL_QUOTE : TPL_PREFORM
    if (!tpl) {
      return NextResponse.json({ ok: false, error: `plantilla ${seg} no configurada` }, { status: 400 })
    }
    const testNombre = (_u.searchParams.get("nombre") || "Cliente").trim()
    const ok = await sendBotmakerTemplate(testTo, tpl, { nombre: testNombre }).catch(() => false)
    if (ok) {
      await appendAssistantV3(testTo, REACT_CONTEXT_MSG[seg] ?? REACT_CONTEXT_MSG.preform).catch(() => {})
      await supa(`vic_v3_conversations?contact=eq.${testTo}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ reactivation_at: new Date().toISOString() }),
      }).catch(() => {})
    }
    return NextResponse.json({ ok, test: true, to: testTo, seg, tpl })
  }

  if (!TPL_PREFORM && !TPL_QUOTE) {
    return NextResponse.json({ ok: true, skipped: "sin plantillas configuradas (REACTIVATION_TEMPLATE_*)" })
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return NextResponse.json({ ok: false, error: "Supabase no configurado" }, { status: 503 })
  }

  const now = Date.now()
  const coldBefore = new Date(now - COLD_AFTER_H * 3600e3).toISOString()
  const maxAgeAfter = new Date(now - MAX_AGE_D * 86400e3).toISOString()
  const gapBefore = new Date(now - MIN_GAP_H * 3600e3).toISOString()

  // Candidatos: enfriados (last_user_at en la ventana), bajo el tope, con datos
  // para clasificar. Los filtros finos (opt-out, ciclo activo, gap) se aplican en JS.
  const res = await supa(
    `vic_v3_conversations?last_user_at=lte.${coldBefore}&last_user_at=gte.${maxAgeAfter}` +
    `&reactivation_count=lt.${MAX_REACT}` +
    `&select=id,contact,formal_quote_id,reactivation_count,reactivation_at,last_user_at,followup_closed_reason,followup_status` +
    `&order=last_user_at.asc&limit=400`,
  )
  const rows = (res.ok ? await res.json() : []) as Row[]
  // Números internos de prueba (mismos que excluye el embudo: VIC_FUNNEL_TEST_CONTACTS).
  const testSet = testContactSet()
  // ¿Le toca un toque AHORA? El toque N (reactivation_count = N-1) recién aplica
  // cuando ya pasaron OFFSETS_H[N-1] horas desde el último mensaje del cliente
  // (47h → 7d → 15d). Así la cadencia se mide desde el silencio, no por gap plano.
  const tocaAhora = (r: Row): boolean => {
    const c = r.reactivation_count || 0
    if (c >= OFFSETS_H.length || !r.last_user_at) return false
    const hrs = (now - new Date(r.last_user_at).getTime()) / 3600e3
    if (hrs < OFFSETS_H[c]) return false
    // Espaciado real ENTRE toques: además del silencio, el toque N espera el
    // delta de la cadencia desde el toque anterior (47h→7d→15d ⇒ ~5d y ~8d).
    // Sin esto, un contacto de silencio antiguo recibiría los 3 toques en días
    // consecutivos (solo limitado por el gap de 24h) — quema al lead.
    if (c > 0 && r.reactivation_at) {
      const desdeToque = (now - new Date(r.reactivation_at).getTime()) / 3600e3
      if (desdeToque < OFFSETS_H[c] - OFFSETS_H[c - 1]) return false
    }
    return true
  }
  let cand = rows.filter(
    (r) =>
      r.contact &&
      !isTestContact(r.contact, testSet) &&
      !["opt_out", "perdido"].includes(r.followup_closed_reason || "") &&
      r.followup_status !== "activo" &&
      r.followup_status !== "consensuado" && // tiene su propio toque programado
      (!r.reactivation_at || r.reactivation_at <= gapBefore) &&
      tocaAhora(r),
  )

  // Gate de horario hábil en la ZONA DEL CONTACTO (mismo helper que el follow-up,
  // vic_is_business_now: Lun-Sáb 9-19 local, sin feriado del país). Una sola
  // llamada al RPC con todos los candidatos; deja solo los que están en horario.
  if (cand.length) {
    const elegibles = await supa(`rpc/vic_filter_business_now`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ p_contacts: cand.map((r) => r.contact) }),
    })
      .then((r) => (r.ok ? (r.json() as Promise<string[]>) : Promise.resolve([] as string[])))
      .catch(() => [] as string[])
    const okSet = new Set(elegibles)
    cand = cand.filter((r) => okSet.has(r.contact))
  }

  // ── Seguimiento CONSENSUADO ────────────────────────────────────────────────
  // Toques ÚNICOS programados a una fecha acordada con el cliente (tool
  // programar_seguimiento). Se disparan por followup_next_at —no por la cadencia
  // 47h/7d/15d— y, tras enviarse, cierran el ciclo (un solo toque). Mismo gate de
  // horario hábil por zona.
  let consensuado: Row[] = []
  {
    const cr = await supa(
      `vic_v3_conversations?followup_status=eq.consensuado&followup_next_at=lte.${new Date(now).toISOString()}` +
      `&select=id,contact,formal_quote_id,reactivation_count,reactivation_at,last_user_at,followup_closed_reason,followup_status` +
      `&order=followup_next_at.asc&limit=100`,
    )
    const crows = (cr.ok ? ((await cr.json()) as Row[]) : []).filter(
      (r) => r.contact && !isTestContact(r.contact, testSet),
    )
    if (crows.length) {
      const elegibles = await supa(`rpc/vic_filter_business_now`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ p_contacts: crows.map((r) => r.contact) }),
      })
        .then((r) => (r.ok ? (r.json() as Promise<string[]>) : Promise.resolve([] as string[])))
        .catch(() => [] as string[])
      const okSet = new Set(elegibles)
      consensuado = crows.filter((r) => okSet.has(r.contact))
    }
  }

  // Segmento "cotizacion": tiene formal_quote_id y NO está aceptada/pagada.
  let segCot: Row[] = []
  let nombresPorQuote = new Map<string, string>()
  if (TPL_QUOTE) {
    const conQuote = cand.filter((r) => !!r.formal_quote_id)
    const zoho = await quoteIdsNoAccionables(conQuote.map((r) => r.formal_quote_id as string))
    nombresPorQuote = zoho.nombres
    segCot = conQuote.filter((r) => !zoho.skip.has(String(r.formal_quote_id)))
  }

  // Segmento "preform": SIN cotización formal pero con un estimado mostrado
  // (marcador "recurrente" en un mensaje del asistente — el preform de precios).
  let segPre: Row[] = []
  if (TPL_PREFORM) {
    const sinQuote = cand.filter((r) => !r.formal_quote_id)
    if (sinQuote.length) {
      const ids = sinQuote.map((r) => r.id).join(",")
      const mr = await supa(
        `vic_v3_messages?conversation_id=in.(${ids})&role=eq.assistant&content=ilike.*recurrente*&select=conversation_id`,
      )
      const conPreform = new Set(
        (mr.ok ? ((await mr.json()) as Array<{ conversation_id: string }>) : []).map((x) => x.conversation_id),
      )
      segPre = sinQuote.filter((r) => conPreform.has(r.id))
    }
  }

  // Correo de reactivación: best-effort, no bloquea ni afecta el conteo del HSM.
  // La cotizadora self-gatea y filtra internos/prueba; aquí solo evitamos la
  // llamada si el flag está apagado.
  let correos = 0
  async function dispararCorreo(quoteId: string | null): Promise<void> {
    if (!EMAIL_ENABLED || !quoteId) return
    try {
      const r = await fetch(`${COTIZADORA_API_BASE}/api/quote-acceptance/send-reactivation-email`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(VICKY_COTIZADORA_SECRET ? { "x-vicky-secret": VICKY_COTIZADORA_SECRET } : {}),
        },
        body: JSON.stringify({ quoteId }),
        cache: "no-store",
      })
      const data = await r.json().catch(() => null)
      if (data?.sent) correos++
    } catch (e) {
      console.warn(`[reactivation] correo falló quote=${quoteId}:`, e)
    }
  }

  let enviados = 0
  let omitidosSinNombre = 0
  async function enviar(list: Row[], template: string, segmento: string) {
    for (const r of list) {
      if (enviados >= BATCH) break
      // Las plantillas v2 llevan \${nombre}: resolverlo (Zoho para cotización;
      // historial como fallback). Sin nombre NO se envía (quedaría "Hola ,").
      let nombre =
        (segmento === "cotizacion" && r.formal_quote_id
          ? nombresPorQuote.get(String(r.formal_quote_id))
          : undefined) || null
      if (!nombre) nombre = await nombreDesdeHistorial(r.contact)
      if (!nombre) {
        omitidosSinNombre++
        console.warn(`[reactivation] sin nombre resoluble, omitido: ${r.contact} (${segmento})`)
        continue
      }
      const ok = await sendBotmakerTemplate(r.contact, template, { nombre }).catch(() => false)
      if (!ok) continue
      await supa(`vic_v3_conversations?id=eq.${r.id}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          reactivation_at: new Date().toISOString(),
          reactivation_count: (r.reactivation_count || 0) + 1,
        }),
      }).catch(() => {})
      enviados++
      console.log(`[reactivation] ${segmento} → ${r.contact}`)
      // Deja el toque como turno de Vicky en el historial: así, cuando el cliente
      // responda, Vicky retoma con continuidad (excepción de reenganche del prompt).
      await appendAssistantV3(
        r.contact,
        REACT_CONTEXT_MSG[segmento] ?? REACT_CONTEXT_MSG.preform,
      ).catch(() => {})
      // En "cotizacion" sumamos el correo (CTA aceptación online + PDF) al HSM.
      if (segmento === "cotizacion") await dispararCorreo(r.formal_quote_id)
    }
  }

  // Toque consensuado: UN solo envío a la fecha acordada. Elige la plantilla por
  // segmento (tiene cotización formal → quote; si no → preform) y, tras enviar,
  // CIERRA el ciclo (no se repite). El cliente ya engagueó, así que no exige el
  // marcador de preform.
  let enviadosConsensuado = 0
  async function enviarConsensuadoLista(list: Row[]) {
    for (const r of list) {
      if (enviados >= BATCH) break
      const segmento = r.formal_quote_id ? "cotizacion" : "preform"
      const template = segmento === "cotizacion" ? TPL_QUOTE : TPL_PREFORM
      if (!template) continue
      const nombre = await nombreDesdeHistorial(r.contact)
      if (!nombre) {
        omitidosSinNombre++
        console.warn(`[reactivation] consensuado sin nombre resoluble, omitido: ${r.contact}`)
        continue
      }
      const ok = await sendBotmakerTemplate(r.contact, template, { nombre }).catch(() => false)
      if (!ok) continue
      await supa(`vic_v3_conversations?id=eq.${r.id}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          followup_status: "cerrado",
          followup_next_at: null,
          followup_closed_reason: "consensuado_enviado",
        }),
      }).catch(() => {})
      enviados++
      enviadosConsensuado++
      console.log(`[reactivation] consensuado(${segmento}) → ${r.contact}`)
      await appendAssistantV3(
        r.contact,
        REACT_CONTEXT_MSG[segmento] ?? REACT_CONTEXT_MSG.preform,
      ).catch(() => {})
      if (segmento === "cotizacion") await dispararCorreo(r.formal_quote_id)
    }
  }

  // Primero los consensuados (cita acordada), luego la cadencia: cotización y preform.
  await enviarConsensuadoLista(consensuado)
  if (TPL_QUOTE) await enviar(segCot, TPL_QUOTE, "cotizacion")
  if (TPL_PREFORM) await enviar(segPre, TPL_PREFORM, "preform")

  return NextResponse.json({
    ok: true,
    candidatos: cand.length,
    segmento_cotizacion: segCot.length,
    segmento_preform: segPre.length,
    consensuado: consensuado.length,
    enviados,
    enviados_consensuado: enviadosConsensuado,
    omitidos_sin_nombre: omitidosSinNombre,
    correos,
  })
}

// pg_cron invoca con net.http_post → aceptar POST además de GET (mismo handler).
export async function POST(req: Request): Promise<Response> {
  return GET(req)
}
