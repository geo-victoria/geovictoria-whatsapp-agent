/**
 * Endpoint POST /api/vic-sales-agent-v3
 *
 * Endpoint NUEVO para V3 con tool use. NO toca el flujo productivo
 * (`/api/vic-sales-agent` y `/api/vic-botmaker` siguen funcionando como V2).
 *
 * Diseñado para ser consumido por la página web de prueba en /vic-v3.
 * Cuando V3 esté validado, se puede:
 *   1. Reescribir `/api/vic-botmaker` para que llame a este endpoint en
 *      lugar de a `/api/vic-sales-agent`.
 *   2. Apagar el endpoint viejo.
 *   3. Mover este archivo a `/api/vic-sales-agent` reemplazando el de V2.
 *
 * Request body:
 *   {
 *     history: [{ role: "user" | "assistant", content: string }, ...],
 *     message: string
 *   }
 *
 * Response:
 *   {
 *     reply: string,
 *     handoff: boolean,
 *     iterations: number,
 *     toolCalls: [{ name, input, ok }, ...]
 *   }
 *
 * NOTA: este endpoint NO persiste en Supabase. El historial se mantiene
 * en el cliente (React state). Esto es intencional para el chat de prueba:
 * cada refresh es una conversación nueva, sin contaminar BD de producción.
 */

import { NextResponse } from "next/server"
import { runAgentLoop, type ConversationMessage } from "@/lib/agent-loop"
import { SYSTEM_PROMPT_V3 } from "./prompt"

export const dynamic = "force-dynamic"
export const maxDuration = 60

type RequestBody = {
  history?: unknown
  message?: unknown
}

function isValidMessage(m: unknown): m is ConversationMessage {
  if (!m || typeof m !== "object") return false
  const obj = m as Record<string, unknown>
  return (
    (obj.role === "user" || obj.role === "assistant") &&
    typeof obj.content === "string" &&
    obj.content.length > 0
  )
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as RequestBody

    // Validar input
    const userMessage = typeof body.message === "string" ? body.message.trim() : ""
    if (!userMessage) {
      return NextResponse.json({ error: "Falta 'message' en el body." }, { status: 400 })
    }
    if (userMessage.length > 2000) {
      return NextResponse.json({ error: "Mensaje demasiado largo (máx 2000 caracteres)." }, { status: 400 })
    }

    const history: ConversationMessage[] = Array.isArray(body.history)
      ? body.history.filter(isValidMessage)
      : []

    // Limitar historial a los últimos 40 mensajes para controlar costos.
    const trimmedHistory = history.slice(-40)

    // API key
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) {
      console.error("[vicky-v3] ANTHROPIC_API_KEY no configurada")
      return NextResponse.json(
        { error: "Servicio no disponible temporalmente. Intentá de nuevo en unos minutos." },
        { status: 503 }
      )
    }

    // Ejecutar el agent loop
    const result = await runAgentLoop({
      systemPrompt: SYSTEM_PROMPT_V3,
      history: trimmedHistory,
      userMessage,
      apiKey,
    })

    return NextResponse.json({
      reply: result.reply,
      handoff: result.handoff,
      iterations: result.iterations,
      toolCalls: result.toolCalls,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error("[vicky-v3] Error procesando request:", err)
    return NextResponse.json(
      {
        error: "Error procesando tu mensaje.",
        detail: process.env.NODE_ENV === "development" ? message : undefined,
      },
      { status: 500 }
    )
  }
}
