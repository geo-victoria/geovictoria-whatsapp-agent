/**
 * Endpoint POST /api/vic-followup-cron
 *
 * Re-engagement (item 5): reengancha a prospectos con intención comercial que
 * dejaron de responder. Lo invoca pg_cron (Supabase) cada minuto vía pg_net.
 *
 * Flujo por tick:
 *   1. Autenticación contra el secret compartido en vic_kv (lo siembra la
 *      migración; ni el código ni el cron job conocen el valor hardcodeado).
 *   2. vic_v3_claim_followups(batch): claim ATÓMICO server-side (FOR UPDATE
 *      SKIP LOCKED). Solo el ganador de cada fila envía — dos ticks solapados
 *      jamás duplican un toque. El claim ya avanzó stage/next_at/status.
 *   3. Por cada conversación reclamada: genera UN nudge corto y contextual
 *      (LLM acotado, SIN tools, SIN precios, SIN pedir datos), lo sanea
 *      (anti-voseo + guardrail determinista) y lo envía vía push de Botmaker.
 *   4. Persiste el toque como mensaje del asistente (contexto para el próximo
 *      turno) sin mover silence_anchor_at, y lo registra en el log.
 *
 * Cadencia (definida en la migración): 2m, 5m, 15m, 1h, 3h, 6h, 23h — todos
 * dentro de la ventana de 24h de WhatsApp, así que va texto libre (sin HSM).
 * La cancelación vive en el webhook: si el cliente responde, el ciclo se pausa.
 */

import { NextResponse } from "next/server"
import Anthropic from "@anthropic-ai/sdk"
import {
  claimFollowups,
  fetchHistoryV3,
  appendAssistantV3,
  logFollowup,
  getFollowupCronSecret,
} from "@/lib/supabase-persistence-v3"
import { sendBotmakerMessage } from "@/lib/botmaker-push-v3"
import { sanitizarVoseo } from "@/lib/voseo-v3"

export const dynamic = "force-dynamic"
export const maxDuration = 60

// Lote por tick: 8 nudges × ~2-3s de generación cabe holgado en maxDuration.
// Al tráfico actual (~10-15 toques/hora peak) un tick rara vez trae más de 1-2.
const CLAIM_BATCH = 8

// Modelo chico y rápido: el nudge es UNA frase corta, no necesita el modelo
// del agente principal.
const NUDGE_MODEL = "claude-haiku-4-5-20251001"

// Tono según el tramo de la cadencia (1-7).
function instruccionDeTono(stage: number): string {
  if (stage <= 2)
    return "Tono liviano y natural, como quien retoma una conversación que quedó al aire hace minutos. NO suenes a recordatorio formal."
  if (stage <= 5)
    return "Tono cálido y servicial: retoma el punto exacto donde quedaron y ofrece continuar, sin presionar."
  if (stage === 6)
    return "Tono directo pero amable: pregunta si sigue interesado en avanzar o prefiere retomarlo en otro momento."
  return "Último toque: cierre cordial. Pregunta si sigue interesado en cotizar con nosotros o lo dejamos para más adelante, dejando la puerta abierta."
}

// Fallbacks deterministas si el LLM falla o el output viola el guardrail.
// Neutros a propósito: sirven igual para una cotización a medias que para una
// conversación que recién partía (un "hola" sin intención identificada aún).
function fallbackPorStage(stage: number): string {
  if (stage <= 2) return "¿Todo bien? Te perdí 😅 Aquí sigo si quieres continuar."
  if (stage <= 5) return "Hola! ¿Retomamos donde quedamos? Quedé atenta 😊"
  if (stage === 6)
    return "Hola! ¿Sigues interesado en avanzar, o prefieres que lo retomemos en otro momento?"
  return "Hola! ¿Sigues interesado en cotizar con nosotros o lo dejamos para más adelante? Cualquier cosa, aquí estoy 😊"
}

// Guardrail determinista del nudge: el toque NUNCA lleva precios, porcentajes
// ni links (eso vive en las tools del agente, no en un push). Si el modelo se
// escapó, usamos el fallback del tramo.
function nudgeEsSeguro(texto: string): boolean {
  if (!texto) return false
  if (texto.length > 400) return false
  if (/\d+\s*%|\$\s?\d|\bUF\b|https?:\/\//i.test(texto)) return false
  return true
}

async function generarNudge(
  apiKey: string,
  contact: string,
  stage: number,
): Promise<string> {
  const history = await fetchHistoryV3(contact, 14).catch(() => [])
  const transcript = history
    .map((m) => `${m.role === "user" ? "Cliente" : "Vicky"}: ${m.content}`)
    .join("\n")
    .slice(-4000)

  const client = new Anthropic({ apiKey })
  const system =
    "Eres Vicky, vendedora chilena de GeoVictoria (control de asistencia B2B). " +
    "El cliente dejó de responder. Escribe UN solo mensaje corto de WhatsApp (máximo 2 frases) para reengancharlo, retomando el punto EXACTO donde quedó la conversación. " +
    "Si la conversación recién partía y casi no hay contexto (solo un saludo o una pregunta suelta), usa un toque breve y humano tipo '¿Todo bien? Te perdí 😅' o '¿Sigues ahí?' — NO inventes un tema que no existió. " +
    instruccionDeTono(stage) +
    " REGLAS DURAS: español chileno con tuteo (tú/tienes/puedes; JAMÁS vos/tenés/podés). " +
    "PROHIBIDO: mencionar precios, montos, porcentajes, descuentos, UF o links; pedir datos (nombre, RUT, email); inventar información nueva; usar más de un emoji. " +
    "Devuelve SOLO el texto del mensaje, sin comillas ni explicación."

  const response = await client.messages.create({
    model: NUDGE_MODEL,
    max_tokens: 150,
    system,
    messages: [
      {
        role: "user",
        content: `Conversación hasta ahora:\n${transcript}\n\nEscribe el mensaje de reenganche (toque ${stage} de 7).`,
      },
    ],
  })
  const block = response.content.find((b) => b.type === "text")
  return block && block.type === "text" ? block.text.trim() : ""
}

export async function POST(req: Request) {
  // 1. Autenticación contra el secret compartido (fuente de verdad: vic_kv).
  const provided = (req.headers.get("x-cron-secret") || "").trim()
  const expected = await getFollowupCronSecret()
  if (!expected || provided !== expected) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }

  const apiKey = (process.env.ANTHROPIC_API_KEY || "").trim()
  if (!apiKey) {
    console.error("[followup-cron] ANTHROPIC_API_KEY no configurada")
    return NextResponse.json({ ok: false, error: "config" }, { status: 500 })
  }

  // 2. Claim atómico de los seguimientos vencidos.
  const claims = await claimFollowups(CLAIM_BATCH)
  if (claims.length === 0) {
    return NextResponse.json({ ok: true, sent: 0 })
  }

  // 3. Generar + enviar cada toque (secuencial: el lote es chico).
  let sent = 0
  for (const claim of claims) {
    let nudge = ""
    let errorMsg = ""
    try {
      nudge = await generarNudge(apiKey, claim.contact, claim.stage)
    } catch (err) {
      errorMsg = `generación falló: ${err instanceof Error ? err.message : String(err)}`
      console.error(`[followup-cron] ${errorMsg} (contact=${claim.contact})`)
    }
    if (!nudgeEsSeguro(nudge)) {
      if (nudge) {
        console.warn(
          `[followup-cron] Nudge violó guardrail, usando fallback. contact=${claim.contact} nudge=${JSON.stringify(nudge.slice(0, 200))}`,
        )
      }
      nudge = fallbackPorStage(claim.stage)
    }
    nudge = sanitizarVoseo(nudge)

    const ok = await sendBotmakerMessage(claim.contact, nudge).catch(() => false)
    if (ok) {
      sent++
      // Persistir como mensaje del asistente (NO mueve silence_anchor_at).
      await appendAssistantV3(claim.contact, nudge).catch(() => {})
    }
    await logFollowup({
      conversationId: claim.conversation_id,
      contact: claim.contact,
      stage: claim.stage,
      content: nudge,
      ok,
      error: errorMsg || (ok ? undefined : "envío Botmaker falló"),
    }).catch(() => {})

    console.log(
      `[followup-cron] toque=${claim.stage}/7 contact=${claim.contact} ok=${ok}`,
    )
  }

  return NextResponse.json({ ok: true, claimed: claims.length, sent })
}
