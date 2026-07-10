/**
 * Webhook de la línea de WhatsApp de COLOMBIA (+57 318 107 0737).
 *
 * Ruta delgada por país (decisión de arquitectura jul-2026): la URL declara el
 * país — la acción de código de la línea CO en Botmaker apunta ACÁ, la chilena
 * sigue en /api/vic-botmaker-v3. Imposible cruzar países por configuración.
 *
 * v1 SÍNCRONO: procesa el turno y devuelve { reply } en la respuesta HTTP; la
 * acción de código de Botmaker envía ese texto (result.text). Sin push, sin
 * lock (tráfico inicial bajo; el asíncrono chileno se adopta si el volumen lo
 * pide). El país queda persistido en la conversación (country='co').
 *
 * Modos:
 *   - VICKY_CO_ENABLED != "on": OBSERVACIÓN — registra y no responde.
 *   - body.simular === true (+ secreto válido): ejecuta el cerebro completo y
 *     devuelve el reply SIN persistir — para pruebas E2E vía curl aunque el
 *     flag esté apagado. Botmaker nunca manda este campo.
 *
 * Auth: header x-secret == BOTMAKER_SECRET_CO (secreto propio de la línea CO).
 */

import { NextResponse } from "next/server"
import { runAgentLoop } from "@/lib/agent-loop"
import { PERFIL_CO } from "@/lib/paises/co"
import { SYSTEM_PROMPT_CO } from "@/lib/paises/co/prompt"
import { TOOL_SCHEMAS_CO, buildDispatchCO } from "@/lib/paises/co/tools"
import { fetchHistoryV3, appendTurnV3 } from "@/lib/supabase-persistence-v3"
import { sendTypingIndicator } from "@/lib/botmaker-push-v3"
import { sanitizarVoseo, normalizarFormatoWhatsApp, quitarSignosApertura } from "@/lib/voseo-v3"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const SECRET_CO = (process.env.BOTMAKER_SECRET_CO || "").trim()
const ENABLED = (process.env.VICKY_CO_ENABLED || "off").trim().toLowerCase() === "on"

type BotmakerBody = {
  contact?: string
  message?: string
  audioUrl?: string
  audioURL?: string
  simular?: boolean
}

const PIDE_TEXTO_CO =
  "Le pido disculpas: por ahora no puedo escuchar notas de voz. ¿Me lo puede escribir por texto, por favor?"

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const secret = request.headers.get("x-secret") || ""
    if (!SECRET_CO) {
      return NextResponse.json(
        { ok: false, error: "BOTMAKER_SECRET_CO no configurado" },
        { status: 503 },
      )
    }
    if (secret !== SECRET_CO) {
      return NextResponse.json({ reply: "Unauthorized" }, { status: 401 })
    }

    const body = (await request.json().catch(() => ({}))) as BotmakerBody
    const contact = (body.contact || "").replace(/\D/g, "")
    let message = (body.message || "").trim()
    const audioUrl = (body.audioUrl || body.audioURL || "").trim()
    const simulacion = body.simular === true

    if (!ENABLED && !simulacion) {
      console.log(
        `[vic-co][observacion] contact=${contact} msgLen=${message.length} audio=${audioUrl ? "sí" : "no"} texto="${message.slice(0, 120)}"`,
      )
      return NextResponse.json({ ok: true, modo: "observacion", pais: "co" })
    }

    if (!contact) return NextResponse.json({ ok: false, error: "contact requerido" }, { status: 400 })

    // v1 sin transcripción de audio: pedir el mensaje por texto (en usted).
    if (!message || message === "__audio__") {
      if (audioUrl) return NextResponse.json({ reply: PIDE_TEXTO_CO, pais: "co" })
      return NextResponse.json({ ok: false, error: "message requerido" }, { status: 400 })
    }

    const apiKey = (process.env.ANTHROPIC_API_KEY || "").trim()
    if (!apiKey) {
      return NextResponse.json({ ok: false, error: "ANTHROPIC_API_KEY no configurada" }, { status: 503 })
    }

    // Cadencia humana: "escribiendo…" mientras se procesa (el propio tiempo
    // del loop hace de latencia natural; el envío del reply lo apaga solo).
    if (!simulacion) {
      sendTypingIndicator(contact, true, PERFIL_CO.canal.channelId).catch(() => {})
    }

    const history = simulacion ? [] : await fetchHistoryV3(contact)
    const result = await runAgentLoop({
      systemPrompt: SYSTEM_PROMPT_CO,
      history,
      userMessage: message,
      apiKey,
      contact,
      tools: {
        schemas: TOOL_SCHEMAS_CO as unknown as unknown[],
        dispatch: buildDispatchCO(contact),
      },
    })

    let reply = quitarSignosApertura(normalizarFormatoWhatsApp(sanitizarVoseo(result.reply || "")))
    if (!reply.trim()) {
      reply =
        "Disculpe, tuve un inconveniente para procesar su mensaje. ¿Me lo puede repetir, por favor?"
    }

    if (!simulacion) {
      await appendTurnV3(contact, message, reply, "co").catch((e) =>
        console.error(`[vic-co] error persistiendo turno contact=${contact}:`, e),
      )
    }

    console.log(
      `[vic-co] turno contact=${contact} iter=${result.iterations} tools=${result.toolCalls.map((t) => t.name).join(",") || "-"} handoff=${result.handoff}${simulacion ? " (simulación)" : ""}`,
    )
    return NextResponse.json({ reply, handoff: result.handoff, pais: "co" })
  } catch (err) {
    console.error("[vic-co] error en webhook:", err)
    return NextResponse.json(
      {
        reply:
          "Estamos presentando un inconveniente técnico. Un asesor lo contactará muy pronto.",
        pais: "co",
      },
      { status: 200 },
    )
  }
}
