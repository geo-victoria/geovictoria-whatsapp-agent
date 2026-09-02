/**
 * ADMIN — Disparo MANUAL de llamadas de voz por campaña (Lalo 01-sep).
 *
 * "Las campañas no son automáticas: nosotros las gatillamos manualmente por
 * cada campaña; lo que sí se tiene que poder visualizar en el dash es cuándo
 * la llamada tocó al usuario y si esto luego generó una venta."
 *
 * POST auth cron: { contact, campana, quoteId?, variables? }
 *   - contact: teléfono destino (solo dígitos).
 *   - campana: etiqueta de la campaña (ej. "reencantamiento_sep26").
 *   - quoteId: cotización de referencia; si viene, las variables de la
 *     llamada se COMPONEN determinísticamente desde el subform real de Zoho
 *     (monto vigente + oferta = dcto actual + 10, tope 20 — la escalera de
 *     cliente; sin tocar el puntero de negociación).
 *   - variables: overrides directos (pruebas internas).
 *
 * La llamada se dispara contra el puente phonecall de Dapta (mismo endpoint
 * que usa el nodo "Dapta Phone Call Input Agent" de sus flows — sin capa de
 * flow: las "llamadas fantasma" de julio nacieron ahí). El agente sale de
 * vic_kv `dapta_agente_reencantamiento` (override por body.agentId).
 *
 * REGISTRO: cada disparo deja fila en vic_llamadas (campana, variables) —
 * el postcall (vic-dapta-postcall) le estampa el resultado, y el dash cruza
 * contra pagos para la atribución llamada→venta.
 *
 * Guardas: opt-out de voz (vic_kv voz_no_llamar_<fono>) bloquea SIEMPRE;
 * fuera de 9-21 hora CL bloquea salvo forzar=true (prueba interna).
 */

import { NextResponse } from "next/server"
import { getFollowupCronSecret, getKvValue } from "@/lib/supabase-persistence-v3"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const FROM_NUMBER = (process.env.VICKY_VOZ_FROM || "+56967308227").trim()
// Puente de llamadas de Dapta (extraído del template público del nodo
// "Dapta Phone Call Input Agent"; si Dapta lo rota, override por env).
const PHONECALL_URL = (
  process.env.DAPTA_PHONECALL_URL ||
  "https://api.dapta.ai/api/devops-dapta-tech-169-938-7/phonecallb?x-api-key=wlXDS-8f5211b7-ea23-4f31-b0ab-29710a46e83b-a"
).trim()

async function autorizado(req: Request): Promise<boolean> {
  const url = new URL(req.url)
  const entregado =
    req.headers.get("x-cron-secret") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") ||
    url.searchParams.get("key") ||
    ""
  if (!entregado) return false
  const kv = await getFollowupCronSecret().catch(() => "")
  const env = (process.env.CRON_SECRET || "").trim()
  return entregado === env || (Boolean(kv) && entregado === kv)
}

const HS = () => ({ apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" })

function horaCL(): number {
  const f = new Intl.DateTimeFormat("es-CL", { timeZone: "America/Santiago", hour: "numeric", hour12: false })
  return parseInt(f.format(new Date()), 10)
}

/** Compone las variables de la llamada desde la cotización REAL en Zoho.
 * Oferta = dcto vigente + 10 (tope 20, escalera de cliente); si ya está en
 * 20 o más, no hay oferta (el agente no ofrece nada). Determinista y SIN
 * tocar el puntero de negociación del cotizador. */
async function variablesDesdeQuote(quoteId: string): Promise<Record<string, string>> {
  const { getZohoAccessToken } = await import("@/lib/zoho-token")
  const token = await getZohoAccessToken()
  const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
  const r = await fetch(`${api}/crm/v3/Cotizaciones_GeoVictoria/${quoteId}`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
    cache: "no-store",
  })
  if (r.status !== 200) throw new Error(`cotización ${quoteId} no encontrada`)
  const q = ((await r.json().catch(() => ({}))) as { data?: Array<Record<string, unknown>> }).data?.[0]
  if (!q) throw new Error(`cotización ${quoteId} vacía`)
  const filas = (Array.isArray(q.Detalle_Items_Cotizacion) ? q.Detalle_Items_Cotizacion : []) as Array<Record<string, unknown>>
  // Las cotizaciones viejas (pre-ago) no guardan UF_Valor → los montos salían
  // en 0 y el guion quedaba sin cifras (visto en la tanda del 01-sep, casos
  // Carolina/Johana/David). Fallback: UF del día vía mindicador (best-effort).
  let uf = Number(q.UF_Valor || 0)
  if (!(uf > 0)) {
    uf = await fetch("https://mindicador.cl/api/uf", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { serie?: Array<{ valor?: number }> }) => Number(d?.serie?.[0]?.valor || 0))
      .catch(() => 0)
  }
  if (!(uf > 0)) throw new Error(`cotización ${quoteId} sin UF (ni Zoho ni mindicador)`)

  const pct = Number(q.Descuento_Recurrente_Pct || 0)
  let recNetoUF = 0
  let planUF = 0
  for (const f of filas) {
    if (f.Es_Recurrente !== true) continue
    const sub = Number(f.Subtotal_UF || 0)
    recNetoUF += sub
    if (String(f.Modalidad || "") !== "Arriendo") planUF += sub
  }
  // Mensual vigente con IVA (el descuento comiteado aplica solo al plan).
  const mensualVigenteUF = (planUF * (1 - pct / 100) + (recNetoUF - planUF)) * 1.19
  const mensualVigenteClp = Math.round(mensualVigenteUF * uf)
  // CINTURÓN (01-sep, tanda 1): jamás marcar con monto 0 — el guion ofrecía
  // "10% de descuento sobre $0" en 19/22 llamadas (cotizaciones viejas sin
  // UF_Valor, antes del fallback). Toda cotización FORMAL tiene recurrente > 0;
  // si aquí queda 0 es cotización rota o UF caída → se salta el disparo (502),
  // no se llama al cliente con una cifra vacía.
  if (!(mensualVigenteClp > 0)) {
    throw new Error(`cotización ${quoteId} con mensualidad vigente 0 (recurrente=${recNetoUF} UF, uf=${uf}) — no se llama`)
  }
  const pctOferta = pct >= 20 ? 0 : Math.min(20, pct + 10)
  const mensualOfertaClp =
    pctOferta > 0 ? Math.round((planUF * (1 - pctOferta / 100) + (recNetoUF - planUF)) * 1.19 * uf) : 0
  const nombreCliente = String(q.Contacto_Asociado && (q.Contacto_Asociado as { name?: string }).name || "").split(" ")[0]
  const empresa = String(q.Name || "").replace(/^Cotización\s+/i, "").replace(/\s+-\s+\d{4}-\d{2}-\d{2}$/, "")
  return {
    customer_name: nombreCliente,
    company: empresa,
    // El postcall usa quote_id para aplicar el precio acordado a la
    // cotización REAL y para agendar la llamada devuelta con contexto.
    quote_id: quoteId,
    monto_mensual: String(mensualVigenteClp),
    oferta_pct: pctOferta > 0 ? String(pctOferta) : "",
    monto_oferta: pctOferta > 0 ? String(mensualOfertaClp) : "",
    plazo_oferta: pctOferta > 0 ? "si lo tomas dentro de las próximas 48 horas" : "",
    contexto: `Cotización ${String(q.Numero_Cotizacion || "")} de ${empresa}, emitida el ${String(q.Fecha_Cotizacion || "")}. Mensualidad vigente $${mensualVigenteClp.toLocaleString("es-CL")} IVA incluido${pct > 0 ? ` (ya tiene ${pct}% de descuento)` : ""}.`,
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 })
  const body = (await req.json().catch(() => ({}))) as {
    contact?: string
    campana?: string
    quoteId?: string
    agentId?: string
    forzar?: boolean
    variables?: Record<string, string>
  }
  const contact = String(body.contact || "").replace(/\D/g, "")
  const campana = String(body.campana || "").trim()
  if (!contact || !campana) {
    return NextResponse.json({ ok: false, error: "faltan contact y campana" }, { status: 400 })
  }

  // Opt-out de voz: sagrado, sin override.
  const noLlamar = await getKvValue(`voz_no_llamar_${contact}`).catch(() => null)
  if (noLlamar) {
    return NextResponse.json({ ok: false, error: `contacto pidió NO ser llamado (${noLlamar})` }, { status: 403 })
  }
  // Caso de SOPORTE = jamás campaña comercial (Lalo 01-sep, caso LA FLORERA:
  // clienta esperando instalación recibió la llamada de re-encantamiento —
  // la marca 'soporte' de la conversación ahora bloquea el disparo, sin
  // override por forzar). Fail-open si Supabase no responde.
  try {
    const conv = await fetch(
      `${SUPABASE_URL}/rest/v1/vic_v3_conversations?contact=eq.${contact}&select=followup_closed_reason&limit=1`,
      { headers: HS(), cache: "no-store" },
    ).then((r) => (r.ok ? r.json() : []))
    if (Array.isArray(conv) && conv[0]?.followup_closed_reason === "soporte") {
      return NextResponse.json(
        { ok: false, error: "conversación marcada SOPORTE (cliente existente/reclamo) — sin campañas comerciales" },
        { status: 403 },
      )
    }
  } catch { /* fail-open */ }
  const h = horaCL()
  if ((h < 9 || h >= 21) && body.forzar !== true) {
    return NextResponse.json({ ok: false, error: `fuera de ventana 9-21 CL (hora actual ${h}); forzar=true solo para pruebas internas` }, { status: 403 })
  }

  const agentId = String(body.agentId || (await getKvValue("dapta_agente_reencantamiento").catch(() => "")) || "").trim()
  if (!agentId) {
    return NextResponse.json({ ok: false, error: "sin agente: setea vic_kv dapta_agente_reencantamiento o pasa agentId" }, { status: 400 })
  }

  let variables: Record<string, string> = {}
  const overrides = { ...(body.variables || {}) }
  if (body.quoteId) {
    try {
      variables = await variablesDesdeQuote(String(body.quoteId))
    } catch (e) {
      return NextResponse.json({ ok: false, error: `componiendo variables: ${e instanceof Error ? e.message : "error"}` }, { status: 502 })
    }
    // Con quoteId, el precio lo manda SIEMPRE el cálculo determinista desde la
    // cotización real — el body no puede pisar los campos de precio (así un
    // ensamble que pre-calcule mal jamás mete un monto falso, cicatriz $0 del
    // 01-sep). Los demás overrides (p.ej. contexto extra) sí se respetan.
    for (const k of ["monto_mensual", "monto_oferta", "oferta_pct", "contexto"]) delete overrides[k]
  }
  variables = { ...variables, ...overrides }

  // Registro ANTES de marcar (si el puente falla, la fila queda con resultado
  // null y el reintento es visible).
  let filaId = 0
  try {
    const ins = await fetch(`${SUPABASE_URL}/rest/v1/vic_llamadas`, {
      method: "POST",
      headers: { ...HS(), Prefer: "return=representation" },
      body: JSON.stringify({
        contact,
        campana,
        quote_id: body.quoteId || null,
        agent_id: agentId,
        variables,
      }),
      cache: "no-store",
    })
    filaId = Number(((await ins.json().catch(() => [])) as Array<{ id?: number }>)[0]?.id || 0)
  } catch { /* best-effort */ }

  // FORMATO DEL PUENTE (descubierto en la prueba del 01-sep): el agent_id va
  // con prefijo "agent_" — SIN el prefijo el puente responde 200 {"error":null}
  // y bota la llamada en silencio (la "llamada fantasma" del caso Alejandro).
  // Las variables van como diccionario plano.
  const r = await fetch(PHONECALL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      from_number: FROM_NUMBER,
      to_number: `+${contact}`,
      agent_id: agentId.startsWith("agent_") ? agentId : `agent_${agentId}`,
      variables,
    }),
    cache: "no-store",
  }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }) as unknown as Response)

  const respuesta = await r.text().catch(() => "")
  // ÉXITO REAL = call_id en la respuesta. El puente responde 200 hasta con
  // payloads que bota (cicatriz Alejandro + prueba de hoy): el 200 no vale.
  const callId = (respuesta.match(/"call_id"\s*:\s*"([^"]+)"/) || [])[1] || ""
  console.log(`[vic-admin-llamada] ${campana} → +${contact} (agente ${agentId.slice(0, 8)}): ${r.status} call_id=${callId || "NINGUNO"} ${respuesta.slice(0, 150)}`)
  return NextResponse.json({
    ok: r.ok && Boolean(callId),
    filaId,
    callId,
    status: r.status,
    respuesta: respuesta.slice(0, 400),
    variables,
  })
}
