/**
 * VICKY EN MESSENGER E INSTAGRAM — receptor de la Graph API de Meta (15-sep,
 * orden de Lalo: "usemos la API de Meta Graph para que Vicky responda los
 * chats de la página de GeoVictoria de Facebook (Messenger e Instagram)").
 *
 * PRIMER CORTE, deliberadamente acotado: Vicky conversa, califica y lleva al
 * prospecto a WhatsApp (o le deja el link para escribirle). NO cotiza formal
 * ni cobra por acá: las tools de venta están amarradas al número de WhatsApp
 * (Zoho, cotizador, pago, plantillas), y un PSID de Messenger no es un
 * teléfono. Cuando el prospecto entrega su WhatsApp, la conversación sigue
 * por la línea de Vicky con toda la maquinaria de siempre.
 *
 * Contrato con Meta:
 *   GET  ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…  → devuelve el challenge
 *   POST { object: "page" | "instagram", entry: [{ messaging: [{ sender, recipient, message }] }] }
 *        firma `X-Hub-Signature-256` = sha256 HMAC del cuerpo crudo con el App Secret.
 *        Meta exige 200 en < 20 s: se responde al tiro y se procesa con `after()`.
 * Envío: POST https://graph.facebook.com/<v>/me/messages?access_token=<PAGE_TOKEN>
 *        { recipient: { id }, messaging_type: "RESPONSE", message: { text } }
 *        (Instagram va por el mismo endpoint con el token de la Página vinculada).
 *
 * Envs: META_VERIFY_TOKEN (la que se pega en el panel de webhooks) ·
 *       META_PAGE_ACCESS_TOKEN (token de Página de larga duración, System User) ·
 *       META_APP_SECRET (para verificar la firma; sin él NO se aceptan eventos) ·
 *       META_GRAPH_VERSION (default v21.0).
 * Gate: vic_kv `meta_canal_enabled`="on" — apagado, Vicky recibe y NO contesta
 * (se registra para revisar), así el webhook se puede verificar en Meta sin
 * exponer a Vicky antes de tiempo.
 *
 * Contacto en la base: `FB.<psid>` / `IG.<igsid>` — misma convención que los
 * marcadores de país (`PE.`), fuera del radar de todos los crones (filtran
 * por prefijo 56/57/52/51).
 */

import { NextResponse, after } from "next/server"
import { createHmac, timingSafeEqual } from "node:crypto"
import { runAgentLoop } from "@/lib/agent-loop"
import { getSystemPromptV3 } from "@/app/api/vic-sales-agent-v3/prompt"
import { fetchHistoryV3, appendTurnV3, getKvValue } from "@/lib/supabase-persistence-v3"
import { sanitizarVoseo, quitarSignosApertura } from "@/lib/voseo-v3"
import { avisarEquipoInterno } from "@/lib/alerta-interna"

export const dynamic = "force-dynamic"
export const maxDuration = 120

const VERIFY_TOKEN = (process.env.META_VERIFY_TOKEN || "").trim()
const PAGE_TOKEN = (process.env.META_PAGE_ACCESS_TOKEN || "").trim()
const APP_SECRET = (process.env.META_APP_SECRET || "").trim()
const GRAPH = `https://graph.facebook.com/${(process.env.META_GRAPH_VERSION || "v21.0").trim()}`
const LINEA_VICKY_CL = "56967308227"
const MAX_TEXTO = 1900

const DIRECTIVA_CANAL = (canal: "messenger" | "instagram") => `

CANAL: ${canal === "instagram" ? "INSTAGRAM (mensaje directo)" : "FACEBOOK MESSENGER"} de la página de GeoVictoria — NO es WhatsApp.
Reglas de este canal (mandan sobre cualquier otra):
- Conversa y califica igual que en WhatsApp (nombre, empresa, cuántas personas marcarían, cómo marcan). Puedes dar el precio referencial de palabra si ya tienes dotación y método.
- NO tienes herramientas acá: no puedes emitir cotización formal, ni mandar PDF, ni link de pago, ni agendar, ni derivar. NUNCA digas que hiciste algo de eso.
- Para la cotización formal y el pago, lleva al prospecto a WhatsApp: pídele su número de WhatsApp para escribirle, o entrégale el link https://wa.me/${LINEA_VICKY_CL} para que te escriba él. Explica que por WhatsApp le llega la cotización formal en minutos y puede pagar en línea.
- Respuestas cortas (este canal se lee en el celular): máximo 3 oraciones, sin negritas ni asteriscos, sin emojis de más.
- Si quien escribe ya es cliente y necesita soporte, dale la Mesa de Ayuda: WhatsApp +56 9 4401 3873 · 600 914 3819 · soporte@geovictoria.com.
`

function firmaValida(raw: string, header: string | null): boolean {
  if (!APP_SECRET) return false
  const h = (header || "").trim()
  if (!h.startsWith("sha256=")) return false
  const esperado = createHmac("sha256", APP_SECRET).update(raw, "utf8").digest("hex")
  const a = Buffer.from(h.slice(7), "hex")
  const b = Buffer.from(esperado, "hex")
  return a.length === b.length && timingSafeEqual(a, b)
}

async function enviarMeta(psid: string, texto: string): Promise<{ ok: boolean; detalle?: string }> {
  if (!PAGE_TOKEN) return { ok: false, detalle: "sin META_PAGE_ACCESS_TOKEN" }
  const r = await fetch(`${GRAPH}/me/messages?access_token=${encodeURIComponent(PAGE_TOKEN)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipient: { id: psid }, messaging_type: "RESPONSE", message: { text: texto.slice(0, MAX_TEXTO) } }),
    cache: "no-store",
  }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }) as unknown as Response)
  if (!r.ok) return { ok: false, detalle: `graph ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}` }
  return { ok: true }
}

type Evento = { canal: "messenger" | "instagram"; psid: string; texto: string; mid: string; adjuntos: number }

function extraerEventos(body: unknown): Evento[] {
  const out: Evento[] = []
  const b = body as { object?: string; entry?: Array<{ messaging?: Array<Record<string, unknown>> }> }
  const canal: "messenger" | "instagram" = b?.object === "instagram" ? "instagram" : "messenger"
  for (const e of b?.entry || []) {
    for (const m of e.messaging || []) {
      const msg = m.message as { mid?: string; text?: string; is_echo?: boolean; attachments?: unknown[] } | undefined
      const sender = (m.sender as { id?: string } | undefined)?.id
      if (!msg || msg.is_echo || !sender) continue
      out.push({ canal, psid: String(sender), texto: String(msg.text || "").trim(), mid: String(msg.mid || ""), adjuntos: Array.isArray(msg.attachments) ? msg.attachments.length : 0 })
    }
  }
  return out
}

async function atender(ev: Evento): Promise<void> {
  const contact = `${ev.canal === "instagram" ? "IG" : "FB"}.${ev.psid}`
  const texto = ev.texto || (ev.adjuntos ? "(el cliente envió un adjunto — por este canal no puedo verlo; pídele que lo escriba en texto)" : "")
  if (!texto) return
  const apiKey = (process.env.ANTHROPIC_API_KEY || "").trim()
  if (!apiKey) return
  const history = await fetchHistoryV3(contact).catch(() => [])
  const systemPrompt = getSystemPromptV3(contact) + DIRECTIVA_CANAL(ev.canal)
  const result = await runAgentLoop({ systemPrompt, history, userMessage: texto, apiKey, contact })
  const reply = quitarSignosApertura(sanitizarVoseo((result.reply || "").trim())).replace(/\*/g, "")
  if (!reply) return
  const env = await enviarMeta(ev.psid, reply)
  await appendTurnV3(contact, texto, env.ok ? reply : `${reply}\n[NO ENVIADO: ${env.detalle}]`, "cl").catch(() => {})
  if (!env.ok) await avisarEquipoInterno(`⚠️ Vicky ${ev.canal}: no pude responder a ${contact} — ${env.detalle}`).catch(() => false)
}

export async function GET(req: Request): Promise<Response> {
  const sp = new URL(req.url).searchParams
  if (sp.get("hub.mode") === "subscribe" && VERIFY_TOKEN && sp.get("hub.verify_token") === VERIFY_TOKEN) {
    return new Response(sp.get("hub.challenge") || "", { status: 200, headers: { "Content-Type": "text/plain" } })
  }
  return NextResponse.json({ ok: false, error: "verificación inválida" }, { status: 403 })
}

export async function POST(req: Request): Promise<Response> {
  const raw = await req.text()
  if (!firmaValida(raw, req.headers.get("x-hub-signature-256"))) {
    return NextResponse.json({ ok: false, error: "firma inválida" }, { status: 401 })
  }
  let body: unknown = null
  try { body = JSON.parse(raw) } catch { return NextResponse.json({ ok: false, error: "json" }, { status: 400 }) }
  const eventos = extraerEventos(body)
  const encendido = ((await getKvValue("meta_canal_enabled").catch(() => null)) || "").trim().toLowerCase() === "on"
  if (!encendido) {
    // Apagado: Meta recibe su 200 (si no, reintenta y termina desactivando el
    // webhook) y queda rastro de lo que llegó para revisar antes de prender.
    for (const ev of eventos) console.log(`[vic-meta] (apagado) ${ev.canal} ${ev.psid}: ${ev.texto.slice(0, 120)}`)
    return NextResponse.json({ ok: true, recibidos: eventos.length, apagado: true })
  }
  after(async () => {
    for (const ev of eventos) await atender(ev).catch((e) => console.error("[vic-meta]", e instanceof Error ? e.message : e))
  })
  return NextResponse.json({ ok: true, recibidos: eventos.length })
}
