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
  getPrefDraft,
  setPrefDraft,
  clearPrefDraft,
  setFormalQuote,
  getFormalQuote,
  getQuotePointer,
  setQuotePointer,
  persistMeeting,
  type PrefParams,
} from "./supabase-persistence-v3"
import { getTimezone, computeMeetingReminderAt } from "./calendar"

// Límite duro para evitar loops infinitos por bugs del modelo.
const MAX_ITERATIONS = 8

// Modelo por default: Sonnet 4.5. Se probó Haiku 4.5 por costo pero falló la
// negociación de descuentos y alucinó cotizaciones (link/PDF inexistentes), así
// que se vuelve a Sonnet. El prompt caching activo ya recorta fuerte el costo.
// Override con env var ANTHROPIC_SALES_AGENT_MODEL_V3.
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
  /**
   * Multi-país: set de tools a exponer al modelo y su despachador. Default:
   * el set chileno (TOOL_SCHEMAS/dispatchTool). Los endurecimientos in-loop
   * que aplican a tools chilenas específicas (generar_link_cotizadora,
   * descuentos, pref_escalon) se activan por NOMBRE de tool, así que un set
   * de otro país con nombres propios no los gatilla.
   */
  tools?: {
    schemas: unknown[]
    dispatch: (name: string, input: unknown) => Promise<unknown>
  }
}): Promise<AgentRunResult> {
  const { systemPrompt, history, userMessage, apiKey, model, contact, tools } = params
  const toolSchemas = (tools?.schemas ?? TOOL_SCHEMAS) as unknown as Anthropic.Messages.Tool[]
  const toolDispatch = (tools?.dispatch ?? dispatchTool) as typeof dispatchTool

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
    // Ambas tools reciben IDs de Zoho del modelo (generar_link para crear la
    // cotización; consultar_descuento para registrar el Borrador). En las dos
    // sanitizamos IDs que no vinieron de un buscar_prospect_en_zoho previo.
    if (
      toolName !== "generar_link_cotizadora" &&
      toolName !== "consultar_descuento_referencial"
    ) {
      return input
    }
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

  // Prompt caching: el system prompt de Vicky es grande y se reenvía en CADA
  // iteración (hasta MAX_ITERATIONS por turno) y en cada turno de la conversación.
  // Marcando el bloque de system con cache_control, el prefijo estable
  // (tools + system, que se renderizan antes que los mensajes) se sirve desde
  // caché a ~0,1× del precio tras la primera llamada. No cambia el modelo ni la
  // calidad; solo recorta el costo de input. Se construye UNA vez para que los
  // bytes sean idénticos entre llamadas (cualquier cambio invalida la caché).
  const systemBlocks: Anthropic.Messages.TextBlockParam[] = [
    {
      type: "text",
      text: systemPrompt,
      cache_control: { type: "ephemeral" },
    },
  ]

  // Segundo breakpoint (11-jul, decisión de costos): también se cachea el
  // HISTORIAL marcando el último bloque del último mensaje de cada request.
  // Sin esto, los hasta 40 mensajes de historia se re-pagaban a precio
  // completo en cada iteración del loop (2-3+ por turno con tools) y en cada
  // turno de una conversación activa (< 5 min entre requests = hit garantizado
  // dentro del TTL). El breakpoint es incremental: el prefijo crece turno a
  // turno y las lecturas caen a ~0,1× del precio de input. Solo 2 breakpoints
  // en total (system + último mensaje), lejos del máximo de 4.
  function conCacheEnUltimoMensaje(
    msgs: Anthropic.Messages.MessageParam[],
  ): Anthropic.Messages.MessageParam[] {
    if (msgs.length === 0) return msgs
    const out = msgs.slice()
    const last = out[out.length - 1]
    const cc = { type: "ephemeral" as const }
    if (typeof last.content === "string") {
      if (!last.content.trim()) return msgs
      out[out.length - 1] = {
        ...last,
        content: [{ type: "text", text: last.content, cache_control: cc }],
      }
    } else if (Array.isArray(last.content) && last.content.length > 0) {
      const blocks = last.content.slice()
      const lastBlock = blocks[blocks.length - 1] as unknown as Record<string, unknown>
      blocks[blocks.length - 1] = { ...lastBlock, cache_control: cc } as never
      out[out.length - 1] = { ...last, content: blocks }
    }
    return out
  }

  // Tope de generación pesada por turno: generar varias cotizaciones formales
  // (generar_link → Zoho + PDF + correo) en un solo turno supera el maxDuration
  // (60s), deja el chat sin respuesta y los reintentos regeneran en loop
  // (correos duplicados). Permitimos UNA cotización formal por turno.
  let generarLinkEnEsteTurno = 0

  while (iteration < MAX_ITERATIONS) {
    iteration++

    const response = await client.messages.create({
      model: effectiveModel,
      max_tokens: MAX_TOKENS,
      system: systemBlocks,
      // Las tools se serializan con su schema completo.
      // El cast es necesario porque TOOL_SCHEMAS es `as const`.
      tools: toolSchemas,
      // Copia con el breakpoint de caché en el último mensaje; `messages`
      // queda limpio (el push de abajo no arrastra marcas viejas).
      messages: conCacheEnUltimoMensaje(messages),
    })

    const stopReason = response.stop_reason

    // Verificación de prompt caching: si cache_read se mantiene en 0 entre
    // llamadas con el mismo prefijo, algún invalidador silencioso está activo.
    const u = response.usage
    console.log(
      `[agent-loop] usage iter=${iteration} model=${effectiveModel} in=${u.input_tokens} cache_write=${u.cache_creation_input_tokens ?? 0} cache_read=${u.cache_read_input_tokens ?? 0} out=${u.output_tokens}`,
    )

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

        // reagendar_reunion necesita el contacto para ubicar el booking vigente;
        // el modelo no lo conoce, así que se lo inyectamos del contexto del turno.
        if (toolName === "reagendar_reunion" && contact) {
          toolInput._contact = contact
        }

        // Capa 3: Borrador de descuento del preform persistido por contacto.
        // La negociación (ofrecer el siguiente escalón) ocurre en un turno y la
        // aceptación en otro, pero entre turnos solo se persiste texto: el
        // `escalonActual` real y los IDs del Borrador en Zoho se perdían, y el
        // modelo terminaba pasando un escalón viejo → la negociación no avanzaba
        // o la cotización nacía con menos descuento del acordado. Acá:
        //   1. Forzamos el escalón al MÁS ALTO entre el del modelo y el último
        //      ofrecido (persistido): la negociación nunca retrocede.
        //   2. Inyectamos los IDs del Borrador (_draft*) para que la negociación
        //      reuse/actualice UN solo Borrador y la aceptación lo finalice, en
        //      vez de crear cotizaciones nuevas.
        const usaBorrador =
          toolName === "consultar_descuento_referencial" ||
          toolName === "generar_link_cotizadora"
        if (contact && usaBorrador) {
          const draft = await getPrefDraft(contact).catch(() => null)
          if (draft) {
            const escalonField =
              toolName === "generar_link_cotizadora" ? "escalonDescuento" : "escalonActual"
            if (draft.escalon > 0) {
              const modelVal = Math.max(0, Number(toolInput[escalonField] || 0))
              const elegido = Math.max(modelVal, draft.escalon)
              if (elegido !== modelVal) {
                console.warn(
                  `[agent-loop] Capa 3: ${toolName}.${escalonField} del modelo=${modelVal} < negociado=${draft.escalon}; se usa ${elegido} (contacto ${contact}).`,
                )
              }
              toolInput[escalonField] = elegido
            }
            // IDs del Borrador (ambas tools leen las mismas claves _draft*).
            if (draft.quoteId) toolInput._draftQuoteId = draft.quoteId
            if (draft.dealId) toolInput._draftDealId = draft.dealId
            if (draft.accountId) toolInput._draftAccountId = draft.accountId
            if (draft.contactId) toolInput._draftContactId = draft.contactId
            // Anclaje de la OPCIÓN negociada: al finalizar, la cotización formal
            // se genera sobre los MISMOS parámetros que se negociaron, no sobre
            // los que el modelo reconstruya en el turno de cierre. Sin esto, en
            // multi-opción el PDF salía con otra opción (app en vez del reloj
            // negociado) y, como el escalón es type-dependiente, con un % errado.
            if (
              toolName === "generar_link_cotizadora" &&
              draft.escalon > 0 &&
              draft.params &&
              typeof draft.params === "object"
            ) {
              const p = draft.params
              const antes = JSON.stringify({
                userCount: toolInput.userCount,
                modulos: toolInput.modulos,
                hardware: toolInput.hardware,
                puntosInstalacion: toolInput.puntosInstalacion,
              })
              if (typeof p.userCount === "number") toolInput.userCount = p.userCount
              if (Array.isArray(p.modulos)) toolInput.modulos = p.modulos
              if (Array.isArray(p.hardware)) toolInput.hardware = p.hardware
              if (Array.isArray(p.puntosInstalacion))
                toolInput.puntosInstalacion = p.puntosInstalacion
              const despues = JSON.stringify({
                userCount: toolInput.userCount,
                modulos: toolInput.modulos,
                hardware: toolInput.hardware,
                puntosInstalacion: toolInput.puntosInstalacion,
              })
              if (antes !== despues) {
                console.warn(
                  `[agent-loop] Capa 3: generar_link usa la opción negociada anclada (contacto ${contact}). modelo=${antes} → anclado=${despues}`,
                )
              }
            }
          }
        }

        // Capa 3b — leadId del formulario web (Vicky proactiva). Regla comercial:
        // al cotizar, el lead original se CONVIERTE en cuenta+contacto+deal —
        // nunca un deal huérfano en paralelo al lead. El modelo a veces omite el
        // leadId aunque el prompt lo exige (pasó en la prueba E2E del 08-jul),
        // así que se inyecta determinístico desde el bloque
        // "[Datos del formulario web: ... zohoLeadId N]" del historial.
        if (
          toolName === "generar_link_cotizadora" &&
          !toolInput.leadId &&
          !toolInput.accountId &&
          !toolInput.contactId
        ) {
          const bloque = [...history]
            .reverse()
            .find(
              (m) =>
                m.role === "assistant" &&
                typeof m.content === "string" &&
                m.content.includes("[Datos del formulario web:"),
            )
          const zohoLeadId =
            typeof bloque?.content === "string"
              ? bloque.content.match(/zohoLeadId (\d+)/)?.[1]
              : undefined
          if (zohoLeadId) {
            toolInput.leadId = zohoLeadId
            console.log(
              `[agent-loop] Capa 3b: leadId ${zohoLeadId} inyectado a generar_link_cotizadora (lead del formulario web).`,
            )
          }
        }

        // Acotamiento: con una cotización FORMAL ya generada en esta
        // conversación, (a) NO se genera otra formal (anti-duplicado) y (b) la
        // negociación preform queda cerrada — todo descuento adicional va
        // post-formal sobre ese MISMO quote_id. Guarda determinista (no depende
        // del prompt). Mata las cotizaciones/correos duplicados y el % que se
        // perdía al negociar sin aterrizar.
        let formalVigente = ""
        if (
          (toolName === "consultar_descuento_referencial" ||
            toolName === "generar_link_cotizadora") &&
          contact
        ) {
          formalVigente = await getFormalQuote(contact).catch(() => "")
        }

        let result: Awaited<ReturnType<typeof dispatchTool>>
        if (toolName === "generar_link_cotizadora" && generarLinkEnEsteTurno >= 1) {
          // Una sola cotización formal por turno (cada PDF es pesado; varias en
          // un turno revientan el timeout de 60s y dejan el chat sin respuesta).
          console.warn(
            `[agent-loop] generar_link bloqueado: ya se generó 1 cotización formal este turno (contacto ${contact}).`,
          )
          result = {
            ok: false,
            error:
              "Límite: solo UNA cotización formal por mensaje (cada PDF es pesado). Ya generaste una en este turno. Entrega esa al cliente y, si quiere otra opción en PDF, ofrécele generarla en el PRÓXIMO mensaje, de a una.",
          } as Awaited<ReturnType<typeof dispatchTool>>
        } else if (toolName === "generar_link_cotizadora" && formalVigente) {
          // Anti-duplicado: ya existe una cotización formal → NO crear otra.
          console.warn(
            `[agent-loop] generar_link bloqueado: ya existe cotización formal ${formalVigente} (contacto ${contact}).`,
          )
          result = {
            ok: false,
            error:
              `Ya existe una cotización formal en esta conversación (quote_id ${formalVigente}). NO generes otra cotización. ` +
              "Si el cliente quiere más descuento, trabájalo sobre ESA con consultar_siguiente_descuento(quote_id) y, al aceptar, aplicar_siguiente_descuento(quote_id): regenera el MISMO documento (nueva versión, mismo número), nunca uno nuevo. " +
              "Si ya está cerrado, entrégale el PDF que ya tiene; si insiste en algo que no puedes resolver, deriva con registrar_solicitud_callback.",
          } as Awaited<ReturnType<typeof dispatchTool>>
        } else if (toolName === "consultar_descuento_referencial" && formalVigente) {
          // Con formal vigente, el preform queda cerrado: redirigir a post-formal.
          console.warn(
            `[agent-loop] consultar_descuento_referencial bloqueado: ya existe cotización formal ${formalVigente} (contacto ${contact}).`,
          )
          result = {
            ok: false,
            error:
              `Ya existe una cotización formal en esta conversación (quote_id ${formalVigente}); la negociación preform quedó cerrada. ` +
              "Para ofrecer descuento usa consultar_siguiente_descuento(quote_id) sobre esa cotización, y cuando acepte, comitea con aplicar_siguiente_descuento(quote_id). " +
              "Esto NO es un error técnico: no se lo menciones al cliente, simplemente continúa la negociación por el camino post-formal.",
          } as Awaited<ReturnType<typeof dispatchTool>>
        } else {
          if (toolName === "generar_link_cotizadora") generarLinkEnEsteTurno++
          result = await toolDispatch(toolName, toolInput)
        }

        // Capa 3 (persistencia): registrar/limpiar el Borrador negociado.
        if (contact && "ok" in result && result.ok) {
          if (
            toolName === "consultar_descuento_referencial" &&
            "escalonActual" in result &&
            typeof result.escalonActual === "number"
          ) {
            // Guardar el escalón ofrecido + los IDs del Borrador (si se creó),
            // para que el siguiente turno reuse el mismo Borrador y, al aceptar,
            // la cotización nazca con ese descuento.
            const draftIds =
              "draft" in result && result.draft && typeof result.draft === "object"
                ? result.draft
                : null
            // Anclar también los parámetros de la opción que se está negociando
            // (los que el modelo pasó a esta consulta), para finalizar sobre la
            // MISMA opción aunque en el turno de cierre el modelo mande otra.
            const params = {
              userCount:
                typeof toolInput.userCount === "number" ? toolInput.userCount : undefined,
              modulos: Array.isArray(toolInput.modulos)
                ? (toolInput.modulos as string[])
                : undefined,
              hardware: Array.isArray(toolInput.hardware)
                ? (toolInput.hardware as PrefParams["hardware"])
                : undefined,
              puntosInstalacion: Array.isArray(toolInput.puntosInstalacion)
                ? (toolInput.puntosInstalacion as PrefParams["puntosInstalacion"])
                : undefined,
            }
            await setPrefDraft(contact, {
              escalon: result.escalonActual,
              quoteId: draftIds?.quoteId,
              dealId: draftIds?.dealId,
              accountId: draftIds?.accountId,
              contactId: draftIds?.contactId,
              params,
            }).catch(() => {})
          } else if (toolName === "cotizar_referencial") {
            // Si ya hay un descuento ACORDADO (escalón negociado) y el cliente
            // re-cotiza por un cambio de configuración (modalidad del reloj, N° de
            // trabajadores, puntos), lo ACORDADO no se pierde:
            //  (1) re-anclamos los params a la nueva config, para que la
            //      finalización use la opción nueva (no revierta a la vieja), y
            //  (2) recalculamos el preview CON el descuento acordado sobre la
            //      config nueva y se lo inyectamos al modelo para que lo presente
            //      con el descuento (no a precio full) y se lo confirme al cliente.
            const draft = await getPrefDraft(contact).catch(() => null)
            if (draft && draft.escalon > 0) {
              const nuevosParams = {
                userCount:
                  typeof toolInput.userCount === "number" ? toolInput.userCount : undefined,
                modulos: Array.isArray(toolInput.modulos)
                  ? (toolInput.modulos as string[])
                  : undefined,
                hardware: Array.isArray(toolInput.hardware)
                  ? (toolInput.hardware as PrefParams["hardware"])
                  : undefined,
                puntosInstalacion: Array.isArray(toolInput.puntosInstalacion)
                  ? (toolInput.puntosInstalacion as PrefParams["puntosInstalacion"])
                  : undefined,
              }
              // Re-anclar la opción nueva (determinista: la formal saldrá con esta
              // config + el escalón ya acordado, no con la opción vieja).
              await setPrefDraft(contact, { params: nuevosParams }).catch(() => {})
              // Re-preview al MISMO nivel acordado (escalon-1 re-muestra el último
              // escalón ofrecido, sin avanzar). dispatchTool directo para NO pasar
              // por el anclaje de escalón (que forzaría el tope y daría error).
              const reArgs = {
                ...toolInput,
                escalonActual: Math.max(0, draft.escalon - 1),
              }
              const reDesc = (await dispatchTool(
                "consultar_descuento_referencial",
                reArgs,
              ).catch(() => null)) as Record<string, any> | null
              if (reDesc && reDesc.ok && reDesc.preview && reDesc.escalon) {
                ;(result as Record<string, unknown>)._descuentoAcordado = {
                  pct: reDesc.escalon.pct,
                  mensualClp: reDesc.preview.mensualClp,
                  pagoInicialClp: reDesc.preview.pagoInicialClp,
                  directiva:
                    "Este cliente YA tiene un descuento ACORDADO sobre el plan de asistencia y " +
                    "acaba de cambiar la configuración. REGLA DE PRESENTACIÓN: NO copies ni muestres " +
                    "el bloque de ítems a precio full ('Resumen mensual recurrente' / 'Pago único' / " +
                    "subtotales) que trae el mensajeParaProspecto de esta tool — esos números NO llevan " +
                    "el descuento y contradicen el total. En su lugar, presenta un resumen BREVE con el " +
                    `descuento ya aplicado: dile que le mantienes su ${reDesc.escalon.pct}% sobre el plan ` +
                    `de asistencia y dale el plan mensual ${reDesc.preview.mensualClp} CLP/mes (con ese ` +
                    `${reDesc.escalon.pct}% los primeros 6 meses) y el pago inicial ${reDesc.preview.pagoInicialClp} CLP. ` +
                    "Nunca muestres dos precios distintos para lo mismo. El descuento acordado no se pierde ante ningún cambio.",
                }
              }
            }
          } else if (toolName === "generar_link_cotizadora") {
            // Cotización finalizada: la negociación del preform se consumió.
            await clearPrefDraft(contact).catch(() => {})
            // Registrar la formal vigente: desde ahora la negociación preform
            // queda bloqueada y todo descuento va post-formal sobre este quote.
            const qid =
              "quoteId" in result && typeof result.quoteId === "string"
                ? result.quoteId
                : ""
            if (qid) await setFormalQuote(contact, qid).catch(() => {})
            // Item B: puntero durable para retomar esta cotización más adelante
            // (anti-amnesia). Sobrevive al borrado de historial y al TTL de 24h.
            if (qid) {
              const str = (k: string): string | undefined =>
                k in result && typeof (result as Record<string, unknown>)[k] === "string"
                  ? ((result as Record<string, unknown>)[k] as string)
                  : undefined
              const num = (k: string): number | undefined =>
                k in result && typeof (result as Record<string, unknown>)[k] === "number"
                  ? ((result as Record<string, unknown>)[k] as number)
                  : undefined
              await setQuotePointer(contact, {
                quoteId: qid,
                dealId: str("dealId"),
                acceptanceUrl: str("acceptanceUrl"),
                pdfUrl: str("pdfUrl"),
                totalClp: num("totalCLP"),
                totalUf: num("totalUF"),
              }).catch(() => {})
            }
          } else if (toolName === "aplicar_siguiente_descuento") {
            // Refrescar la vigencia de la formal sobre la que se negocia.
            const qid =
              typeof toolInput.quote_id === "string" ? toolInput.quote_id : ""
            if (qid) await setFormalQuote(contact, qid).catch(() => {})
            // Y el PUNTERO: el commit regenera PDF + link de aceptación (token
            // nuevo). Sin esto, el guardrail anti-alucinación compara contra el
            // link viejo y bloquea reenvíos legítimos del nuevo (caso Bioval,
            // 15-jul: doble "tuve un problema generando tu cotización").
            const r2 = result as Record<string, unknown>
            if (qid && typeof r2.acceptanceUrl === "string" && r2.acceptanceUrl) {
              // setQuotePointer es upsert completo: merge con lo existente para
              // no pisar totales/dealId con null (la llamada de voz usa total_clp).
              const prev = await getQuotePointer(contact).catch(() => null)
              await setQuotePointer(contact, {
                quoteId: qid,
                dealId: prev?.dealId || undefined,
                acceptanceUrl: r2.acceptanceUrl,
                pdfUrl: typeof r2.linkPdf === "string" ? r2.linkPdf : prev?.pdfUrl || undefined,
                totalClp: prev?.totalClp ?? undefined,
                totalUf: prev?.totalUf ?? undefined,
              }).catch(() => {})
            }
          } else if (toolName === "actualizar_cotizacion") {
            // Puntero al día: mismos quoteId/link, totales nuevos (los usa la
            // llamada de voz y el contexto anti-amnesia).
            const r3 = result as Record<string, unknown>
            const qid3 = typeof toolInput.quote_id === "string" ? toolInput.quote_id : ""
            if (qid3 && r3.ok === true) {
              await setFormalQuote(contact, qid3).catch(() => {})
              const prev = await getQuotePointer(contact).catch(() => null)
              await setQuotePointer(contact, {
                quoteId: qid3,
                dealId: prev?.dealId || undefined,
                acceptanceUrl:
                  (typeof r3.acceptanceUrl === "string" && r3.acceptanceUrl) ||
                  prev?.acceptanceUrl ||
                  undefined,
                pdfUrl: prev?.pdfUrl || undefined,
                totalClp: typeof r3.totalCLP === "number" ? r3.totalCLP : prev?.totalClp ?? undefined,
                totalUf: typeof r3.totalUF === "number" ? r3.totalUF : prev?.totalUf ?? undefined,
              }).catch(() => {})
            }
          } else if (toolName === "agendar_reunion") {
            // Persistir la reunión para el recordatorio por WhatsApp. Usa el
            // `contact` real del canal (no el `telefono` que pasó el modelo).
            const r = result as Record<string, unknown>
            const bookingUid = typeof r.bookingId === "string" ? r.bookingId : ""
            const startIso = typeof r.slotIso === "string" ? r.slotIso : ""
            if (bookingUid && startIso) {
              const country =
                typeof toolInput.country === "string" ? toolInput.country : "Chile"
              // Multi-país: si el dispatch del país devolvió su timezone en el
              // resultado (ej. CO → America/Bogota), esa manda sobre el default
              // por país del input (el modelo CO no envía `country` y caería a
              // Chile, dejando el registro con la zona equivocada).
              const timezone =
                typeof r.timezone === "string" && r.timezone ? r.timezone : getTimezone(country)
              const reminderAt = computeMeetingReminderAt(startIso, timezone)
              await persistMeeting({
                bookingUid,
                contact,
                prospectName:
                  typeof toolInput.prospectName === "string" ? toolInput.prospectName : undefined,
                prospectEmail:
                  typeof toolInput.prospectEmail === "string" ? toolInput.prospectEmail : undefined,
                startIso,
                timezone,
                organizerEmail:
                  typeof r.organizerEmail === "string" ? r.organizerEmail : undefined,
                meetingUrl: typeof r.meetingUrl === "string" ? r.meetingUrl : undefined,
                zohoLeadId: typeof r.leadId === "string" ? r.leadId : undefined,
                zohoEventId: typeof r.eventId === "string" ? r.eventId : undefined,
                reminderAt: reminderAt ? reminderAt.toISOString() : null,
              }).catch(() => {})
            }
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
      "Disculpa, tuve un problema procesando tu mensaje. ¿Puedes repetirlo o decirme con qué te puedo ayudar?"
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
