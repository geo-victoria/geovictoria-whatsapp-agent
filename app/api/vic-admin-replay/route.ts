/**
 * Endpoint ADMIN: POST /api/vic-admin-replay
 *
 * Corre el agente V3 con un historial + mensaje dados y devuelve el reply y los
 * tool-calls que hizo, SIN enviar nada al cliente (no hace push). Sirve para
 * auditar/diagnosticar qué tools invoca Vicky ante un input (ej. confirmar si
 * una consulta de soporte pasa por consultar_agente_soporte o la responde sola).
 *
 * Auth: header x-cron-secret == vic_kv.followup_cron_secret, o ?key=/Bearer ==
 * CRON_SECRET.
 *
 * Body:
 *   { "message": "<texto del cliente>",
 *     "history": [ { "role":"user"|"assistant", "content":"..." } ],  // opcional
 *     "contact": "<fono>",            // opcional (solo para el prompt; NO persiste)
 *     "useStoredHistory": true }      // opcional: usa el historial real del contacto
 *
 * NO pasa `contact` a runAgentLoop a propósito, para no mutar pref_escalon.
 */

import { NextResponse } from "next/server"
import { runAgentLoop, type ConversationMessage } from "@/lib/agent-loop"
import { fetchHistoryV3, getFollowupCronSecret } from "@/lib/supabase-persistence-v3"
import { getSystemPromptV3 } from "@/app/api/vic-sales-agent-v3/prompt"
import { umbralPrecios, formatUmbralParaPrompt, dotacionSobreUmbral, formatDirectivaSobreUmbral } from "@/lib/umbral-autonomia"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const CRON_SECRET = (process.env.CRON_SECRET || "").trim()

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

export async function POST(req: Request): Promise<Response> {
  if (!(await authorized(req))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }
  const apiKey = (process.env.ANTHROPIC_API_KEY || "").trim()
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: "ANTHROPIC_API_KEY no configurada" }, { status: 500 })
  }
  let body: {
    message?: string
    history?: ConversationMessage[]
    contact?: string
    useStoredHistory?: boolean
  } = {}
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: "body JSON inválido" }, { status: 400 })
  }
  const message = (body.message || "").toString()
  const contact = (body.contact || "").trim()
  if (!message) {
    return NextResponse.json({ ok: false, error: "message requerido" }, { status: 400 })
  }
  let history: ConversationMessage[] = []
  if (Array.isArray(body.history)) {
    history = body.history
  } else if (body.useStoredHistory && contact) {
    history = await fetchHistoryV3(contact, 40)
  }
  // Espejo del prompt productivo (umbral 08-ago): el replay audita lo que el
  // cliente vería, así que lleva el mismo bloque de umbral que vic-botmaker-v3.
  const umbralInfo = contact.replace(/\D/g, "").startsWith("56")
    ? await umbralPrecios(contact).catch(() => null)
    : null
  const contextoUmbral = umbralInfo
    ? formatUmbralParaPrompt(umbralInfo.umbral, umbralInfo.origen)
    : ""
  const textoCliente = [message, ...history.filter((m) => m.role === "user").map((m) => String(m.content || ""))].join("\n")
  const dotacionDetectada = umbralInfo ? dotacionSobreUmbral(textoCliente, umbralInfo.umbral) : null
  const directivaUmbral =
    dotacionDetectada && umbralInfo
      ? formatDirectivaSobreUmbral(dotacionDetectada, umbralInfo.umbral)
      : ""
  const result = await runAgentLoop({
    systemPrompt:
      contextoUmbral +
      getSystemPromptV3(contact || undefined, umbralInfo?.umbral) +
      contextoUmbral +
      directivaUmbral,
    history,
    userMessage: message,
    apiKey,
    // contact omitido a propósito: no mutar persistencia en un replay.
  })
  return NextResponse.json({
    ok: true,
    replay: true,
    reply: result.reply,
    toolCalls: (result.toolCalls || []).map((t) => ({ name: t.name, ok: t.ok })),
  })
}
