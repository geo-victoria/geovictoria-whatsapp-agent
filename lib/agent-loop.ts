/**
 * Agent loop para Vicky V3 — patrón ReAct con tool use de Claude.
 *
 * Flujo:
 *   1. Recibe historial conversacional + system prompt + mensaje nuevo del usuario.
 *   2. Llama a Claude API con las tools registradas en TOOL_SCHEMAS.
 *   3. Si la respuesta es solo texto (stop_reason: "end_turn"), retorna ese texto al usuario.
 *   4. Si la respuesta incluye tool_use blocks (stop_reason: "tool_use"):
 *      - Ejecuta cada tool localmente con dispatchTool().
 *      - Agrega los tool_result al historial.
 *      - Vuelve a llamar a Claude con el historial actualizado.
 *      - Repite hasta que la respuesta sea text-only o se alcance MAX_ITERATIONS.
 *
 * El loop garantiza:
 *   - El modelo siempre recibe el resultado de cada tool (no fail-silently).
 *   - Si una tool falla, el modelo lo sabe y puede reaccionar (típicamente
 *     derivar a soporte).
 *   - Cada iteración queda registrada en el log de la conversación.
 */

import Anthropic from "@anthropic-ai/sdk"
import { TOOL_SCHEMAS, dispatchTool } from "./tools"
import {
  getPrefEscalon,
  setPrefEscalon,
  clearPrefEscalon,
} from "./supabase-persistence-v3"

// Límite duro para evitar loops infinitos por bugs del modelo.
const MAX_ITERATIONS = 8

// Modelo por default. Override con env var ANTHROPIC_SALES_AGENT_MODEL_V3.
const DEFAULT_MODEL = "claude-sonnet-4-5-20250929"

// Límite de tokens por respuesta. Generoso para que el modelo pueda razonar.
const MAX_TOKENS = 1024

export type ConversationMessage = {
  role: "user" | "assistant"
  content: string
}

export type AgentRunResult = {
  reply: string
  handoff: boolean
  iterations: number
  toolCalls: Array<{ name: string; input: unknown; ok: boolean; output?: unknown }>
  rawTrace: Anthropic.Messages.MessageParam[]
}

export async function runAgentLoop(params: {
  systemPrompt: string
  history: ConversationMessage[]
  userMessage: string
  apiKey: string
  model?: string
  /**
   * Teléfono del contacto. Necesario para persistir el escalón de descuento
   * negociado en el preform entre turnos (ver pref_escalon en
   * supabase-persistence-v3). Si no se entrega, la persistencia se omite.
   */
  contact?: string
}): Promise<AgentRunResult> {
  const { systemPrompt, history, userMessage, apiKey, model, contact } = params

  const client = new Anthropic({ apiKey })
  const effectiveModel = model || process.env.ANTHROPIC_SALES_AGENT_MODEL_V3 || DEFAULT_MODEL

  // Construir el historial inicial para Claude.
  // tipo `Anthropic.Messages.MessageParam[]`
  const messages: Anthropic.Messages.MessageParam[] = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user" as const, content: userMessage },
  ]

  const toolCalls: AgentRunResult["toolCalls"] = []
  let handoff = false
  let finalText = ""
  let iteration = 0

  // ── Capa 2: registro de IDs válidos ──
  //
  // Los LLMs cometen errores de transcripción cuando tienen que copiar IDs
  // numéricos de 19 dígitos (los Zoho IDs). Para evitar pasar IDs alucinados
  // o mal transcritos a generar_link_cotizadora, mantenemos un registro de
  // los IDs que efectivamente retornó buscar_prospect_en_zoho en esta
  // conversación. Si el LLM pasa un ID que no está en el registro, lo
  // sanitizamos (removemos del input) antes de despachar la tool.
  const knownIds = {
    accounts: new Set<string>(),
    contacts: new Set<string>(),
    leads: new Set<string>(),
  }

  type ProspectMatchLite = { modulo: string; id: string }

  function registerKnownIdsFromSearchResult(result: unknown): void {
    if (!result || typeof result !== "object") return
    const r = result as { ok?: boolean; matches?: ProspectMatchLite[] }
    if (!r.ok || !Array.isArray(r.matches)) return
    for (const match of r.matches) {
      if (!match?.id) continue
      const id = String(match.id)
      if (match.modulo === "Account") knownIds.accounts.add(id)
      else if (match.modulo === "Contact") knownIds.contacts.add(id)
      else if (match.modulo === "Lead") knownIds.leads.add(id)
    }
  }

  function sanitizeIdsInToolInput(
    toolName: string,
    input: Record<string, unknown>,
  ): Record<string, unknown> {
    if (toolName !== "generar_link_cotizadora") return input
    const sanitized: Record<string, unknown> = { ...input }
    const checks: Array<{ field: "accountId" | "contactId" | "leadId"; set: Set<string> }> = [
      { field: "accountId", set: knownIds.accounts },
      { field: "contactId", set: knownIds.contacts },
      { field: "leadId", set: knownIds.leads },
    ]
    for (const { field, set } of checks) {
      const value = sanitized[field]
      if (typeof value !== "string" || !value.trim()) continue
      if (!set.has(value.trim())) {
        console.warn(
          `[agent-loop] Capa 2: ID "${value}" en ${field} no coincide con ningún match previo de buscar_prospect_en_zoho. Removido del tool_use.`,
        )
        delete sanitized[field]
      }
    }
    return sanitized
  }

  while (iteration < MAX_ITERATIONS) {
    iteration++

    const response = await client.messages.create({
      model: effectiveModel,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      // Las tools se serializan con su schema completo.
      // El cast es necesario porque TOOL_SCHEMAS es `as const`.
      tools: TOOL_SCHEMAS as unknown as Anthropic.Messages.Tool[],
      messages,
    })

    const stopReason = response.stop_reason

    // Agregar la respuesta del assistant al historial.
    messages.push({
      role: "assistant",
      content: response.content,
    })

    if (stopReason === "tool_use") {
      // El modelo quiere usar una o más tools. Ejecutarlas todas.
      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = []

      for (const block of response.content) {
        if (block.type !== "tool_use") continue

        const toolName = block.name
        const rawInput = (block.input as Record<string, unknown>) || {}

        // Capa 2: sanitizar IDs en el tool_use antes de despachar.
        // Si el LLM puso un accountId/contactId/leadId que no vino de un
        // buscar_prospect_en_zoho previo, lo removemos para forzar fallback
        // a creación nueva en lugar de update sobre un ID alucinado.
        const toolInput = sanitizeIdsInToolInput(toolName, rawInput)

        // Capa 3: escalón de descuento del preform persistido por contacto.
        // La negociación (ofrecer el siguiente escalón) ocurre en un turno y la
        // aceptación en otro, pero entre turnos solo se persiste texto: el
        // `escalonActual` real se perdía y el modelo terminaba pasando un
        // escalón viejo → la negociación no avanzaba o la cotización nacía con
        // menos descuento del acordado. Acá forzamos el escalón al MÁS ALTO
        // entre el que pasó el modelo y el último ofrecido (persistido), tanto
        // al seguir negociando como al crear la cotización.
        if (contact) {
          const escalonField =
            toolName === "generar_link_cotizadora"
              ? "escalonDescuento"
              : toolName === "consultar_descuento_referencial"
                ? "escalonActual"
                : null
          if (escalonField) {
            const persisted = await getPrefEscalon(contact).catch(() => 0)
            if (persisted > 0) {
              const modelVal = Math.max(0, Number(toolInput[escalonField] || 0))
              const elegido = Math.max(modelVal, persisted)
              if (elegido !== modelVal) {
                console.warn(
                  `[agent-loop] Capa 3: ${toolName}.${escalonField} del modelo=${modelVal} < negociado=${persisted}; se usa ${elegido} (contacto ${contact}).`,
                )
              }
              toolInput[escalonField] = elegido
            }
          }
        }

        const result = await dispatchTool(toolName, toolInput)

        // Capa 3 (persistencia): registrar/limpiar el escalón negociado.
        if (contact && "ok" in result && result.ok) {
          if (
            toolName === "consultar_descuento_referencial" &&
            "escalonActual" in result &&
            typeof result.escalonActual === "number"
          ) {
            // Guardar el escalón ofrecido para que, si el cliente acepta en un
            // turno posterior, la cotización nazca con ese descuento.
            await setPrefEscalon(contact, result.escalonActual).catch(() => {})
          } else if (toolName === "generar_link_cotizadora") {
            // Cotización creada: la negociación del preform se consumió.
            await clearPrefEscalon(contact).catch(() => {})
          }
        }

        // Si la tool fue buscar_prospect_en_zoho, registrar los IDs que
        // devolvió como "válidos" para futuras validaciones de Capa 2.
        if (toolName === "buscar_prospect_en_zoho") {
          registerKnownIdsFromSearchResult(result)
        }

        toolCalls.push({
          name: toolName,
          input: toolInput,
          ok: "ok" in result ? result.ok : false,
          output: result,
        })

        if ("ok" in result && result.ok && "handoff" in result && result.handoff) {
          handoff = true
        }

        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result),
          is_error: "ok" in result && !result.ok,
        })
      }

      // Insertar los tool_results y continuar el loop.
      messages.push({
        role: "user",
        content: toolResults,
      })

      continue
    }

    if (stopReason === "end_turn" || stopReason === "stop_sequence" || stopReason === "max_tokens") {
      // Respuesta final. Extraer texto.
      const textBlocks = response.content.filter(
        (b): b is Anthropic.Messages.TextBlock => b.type === "text"
      )
      finalText = textBlocks.map((b) => b.text).join("\n").trim()
      break
    }

    // Caso defensivo: stop_reason inesperado. Salir del loop.
    console.warn(`[vicky-v3] stop_reason inesperado: ${stopReason}. Terminando loop.`)
    break
  }

  if (!finalText) {
    finalText =
      "Disculpá, tuve un problema procesando tu mensaje. ¿Podés repetirlo o decirme con qué te puedo ayudar?"
  }

  if (iteration >= MAX_ITERATIONS) {
    console.warn(`[vicky-v3] Loop alcanzó MAX_ITERATIONS=${MAX_ITERATIONS}.`)
  }

  return {
    reply: finalText,
    handoff,
    iterations: iteration,
    toolCalls,
    rawTrace: messages,
  }
}
