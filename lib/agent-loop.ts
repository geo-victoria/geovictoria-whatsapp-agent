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
  getQuotePointers,
  setQuotePointer,
  persistMeeting,
  marcarConversacionSoporte,
  type PrefParams,
} from "./supabase-persistence-v3"
import { avisarEquipoInterno } from "./alerta-interna"
import { getTimezone, computeMeetingReminderAt } from "./calendar"
import { duenoCotizacionVigente, duenoDealVigente, type DuenoReunion } from "./tools/agendar-reunion"
import { eventoSeguimientoDe } from "./eventos-seguimiento"
import { tagearChatComercial, TOOLS_SENAL_COMERCIAL } from "./botmaker-tags"
import { sincronizarHitoCrm, datosDeToolInput, HITO_POR_TOOL, TOOLS_QUE_CREAN_SU_LEAD, actualizarNotaTranscripcion, parseEmpleados } from "./crm-hitos"
import { umbralPrecios, SCOPE_MAX_SISTEMA, paisConUmbral, derivacionDePais } from "./umbral-autonomia"
import { mas50CierraLoop } from "./loop-v2"

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
  let toolSchemas = (tools?.schemas ?? TOOL_SCHEMAS) as unknown as Anthropic.Messages.Tool[]
  const toolDispatch = (tools?.dispatch ?? dispatchTool) as typeof dispatchTool

  // POLÍTICA 24-jul (Lalo): si el cliente quiere cotizar, se le cotiza — SIN
  // barreras, aunque exista un lead o deal de otro ejecutivo en Zoho. El
  // antiguo candado de "proceso humano" retiraba acá las tools comerciales;
  // hoy la detección solo genera avisos de coordinación (nota al ejecutivo y
  // alerta interna), nunca un bloqueo al cliente.

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
  let mensajeHandoffRespaldo = ""
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
        if (
          (toolName === "reagendar_reunion" ||
            toolName === "registrar_comprobante_transferencia" ||
            // enviar_cotizacion_whatsapp manda el PDF al contacto del turno.
            toolName === "enviar_cotizacion_whatsapp") &&
          contact
        ) {
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

        // Capa 3c — contacto ya TRASPASADO a un ejecutivo (vic_ptv activo): la
        // formal nace con ESE dueño, sin re-sorteo de tómbola, para que el
        // correo con el PDF salga sí o sí con el ejecutivo asignado en copia y
        // presentándolo (Lalo 03-ago). Determinístico y best-effort: si la
        // consulta falla, la emisión sigue con el sorteo normal.
        if (contact && toolName === "generar_link_cotizadora") {
          // El campo es EXCLUSIVO de flujos admin/deterministas: si el modelo
          // lo trajo (hallucinación), se descarta siempre.
          delete toolInput._ownerOverrideId
          const { vendedorTraspasado } = await import("./loop-v2")
          const vendedor = await vendedorTraspasado(contact).catch(() => null)
          if (vendedor?.zohoId) {
            toolInput._ownerOverrideId = vendedor.zohoId
            console.log(
              `[agent-loop] Capa 3c: formal hereda al ejecutivo traspasado ${vendedor.email || vendedor.zohoId} (contacto ${contact}).`,
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
        // Multi-RUT (caso Génesis, 16-jul): el candado de "no crear otra formal"
        // es POR RAZÓN SOCIAL, no por conversación. Si el cliente cotiza para un
        // RUT distinto (otra empresa suya), generar_link se permite; solo se
        // bloquea repetir la formal del MISMO RUT (para eso está
        // actualizar_cotizacion / la escalera de descuento).
        let formalMismoRut = ""
        if (
          (toolName === "consultar_descuento_referencial" ||
            toolName === "generar_link_cotizadora") &&
          contact
        ) {
          formalVigente = await getFormalQuote(contact).catch(() => "")
          if (toolName === "generar_link_cotizadora") {
            const punteros = await getQuotePointers(contact).catch(() => [])
            const compactar = (v: unknown) =>
              String(v || "").replace(/[.\s-]/g, "").toUpperCase()
            const rutNuevo = compactar((toolInput as Record<string, unknown>).rutEmpresa)
            const choque = punteros.find(
              // Punteros antiguos sin rut registrado bloquean igual (conservador):
              // no podemos garantizar que sea otra razón social.
              (pt) => !pt.rut || (rutNuevo && compactar(pt.rut) === rutNuevo),
            )
            formalMismoRut = choque?.quoteId || ""
            if (formalVigente && !formalMismoRut) {
              console.log(
                `[agent-loop] multi-RUT: se permite formal adicional para RUT nuevo (contacto ${contact}, ruts existentes: ${punteros.map((pt) => pt.rut || "?").join(",")}).`,
              )
            }
          }
        }

        // UMBRAL DE VENTA AUTÓNOMA (Lalo 08-ago): inbound 20 / outbound 10 —
        // sobre el umbral (y hasta 50) Vicky NO da precios: deriva (deal +
        // tómbola en el acto) y ACOMPAÑA sin precio. Guarda DETERMINISTA:
        // el prompt lleva la misma regla, pero si el modelo intenta cotizar
        // igual, la tool se bloquea con guía. Solo CL; rollback por env
        // VICKY_UMBRAL_CLASICO=1 (umbralPrecios devuelve 50 y nada se activa).
        let bloqueoUmbral = ""
        if (
          contact &&
          paisConUmbral(contact) &&
          (toolName === "cotizar_referencial" ||
            toolName === "consultar_descuento_referencial" ||
            toolName === "generar_link_cotizadora") &&
          typeof (toolInput as Record<string, unknown>).userCount === "number"
        ) {
          const uc = (toolInput as { userCount: number }).userCount
          const { umbral, origen } = await umbralPrecios(contact).catch(() => ({
            umbral: SCOPE_MAX_SISTEMA,
            origen: "inbound" as const,
          }))
          if (uc > umbral) {
            const dp = derivacionDePais(contact)
            bloqueoUmbral =
              `REGLA DE PROCESO (no es un error técnico — no se lo menciones al cliente): esta conversación es ${origen} y tu umbral para DAR PRECIOS es ${umbral} trabajadores; con ${uc} el precio lo entrega un ejecutivo. ` +
              `NO des precios ni estimados (tampoco de memoria del catálogo). Haz esto AHORA: (1) si te falta nombre, email o empresa, captúralos primero; ` +
              `(2) deriva con ${dp.tool} motivo "${dp.motivo}" pasando nombre, email, empresa y trabajadores — el registro pasa AL ACTO al equipo comercial y un ejecutivo lo toma con el precio; ` +
              `(3) NO te despidas: responde todas las dudas que el cliente traiga (producto, implementación, hardware, prueba) y ${dp.agenda} — pero la VENTA es del ejecutivo: no prometas seguimientos tuyos ni retomes el precio después.`
            console.warn(
              `[agent-loop] umbral autonomía: ${toolName} bloqueado (${uc} > ${umbral} ${origen}) contacto ${contact}.`,
            )
          }
        }

        // CANDADOS DE EVIDENCIA POR CITA (Lalo 13-ago v2 — "¿por qué 'ambas'
        // tiene que estar en un listado?"): el MODELO interpreta el lenguaje y
        // CITA la frase textual del cliente; el CÓDIGO solo verifica que esa
        // cita exista palabra por palabra en la conversación. Así ninguna
        // lista de palabras decide por el cliente (el regex anterior bloqueó
        // en círculo el caso real "me interesa con ambos"), y el modelo no
        // puede inventar una elección que nadie escribió — sin cita no cotiza.
        const normEv = (s: string) =>
          s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim()
        const textosClienteEv = normEv(
          [
            ...history.filter((m) => m.role === "user").map((m) => String(m.content || "")),
            userMessage || "",
          ].join("\n"),
        )
        const citaDelCliente = (cita: unknown): boolean => {
          const c = normEv(String(cita || ""))
          return c.length >= 2 && textosClienteEv.includes(c)
        }

        // CANDADO 1 — RELOJ SIN PEDIRLO: cotizar con hardware exige la cita
        // de la elección (`evidenciaEleccionReloj`). Heurística de palabras
        // solo como fallback de transición mientras el modelo aprende a citar.
        if (
          !bloqueoUmbral &&
          (toolName === "cotizar_referencial" || toolName === "generar_link_cotizadora") &&
          Array.isArray((toolInput as Record<string, unknown>).hardware) &&
          ((toolInput as { hardware: unknown[] }).hardware || []).length > 0
        ) {
          let eleccionRespaldada = citaDelCliente(
            (toolInput as Record<string, unknown>).evidenciaEleccionReloj,
          )
          if (!eleccionRespaldada) {
            const RE_RELOJ =
              /reloj|mixt|combinad|combinaci|ambos|ambas|los dos|las dos|biometr|huellero|checador|marcador|t[oó]tem|dispositivo|aparato|m[aá]quina|terminal|equipo f[ií]sico/i
            const ultimoAsistente = [...history].reverse().find((m) => m.role === "assistant")
            const afirmoRelojPreguntado =
              /^\s*(s[ií]|claro|dale|ok(?:ay)?|perfecto|correcto|exacto|as[ií] es)\b/i.test(userMessage || "") &&
              /reloj|mixt/i.test(String(ultimoAsistente?.content || ""))
            eleccionRespaldada = RE_RELOJ.test(textosClienteEv) || afirmoRelojPreguntado
          }
          if (!eleccionRespaldada) {
            bloqueoUmbral =
              "REGLA DE PROCESO (no es un error técnico — no se lo menciones al cliente): para cotizar CON reloj debes pasar `evidenciaEleccionReloj` = la frase TEXTUAL del cliente (copiada literal de su mensaje) donde eligió el reloj o el mixto — y esa frase debe existir en la conversación. " +
              "Si el cliente YA eligió, vuelve a llamar la tool citando su frase exacta. Si aún NO ha elegido o su respuesta fue ambigua, NO asumas: re-pregunta corto ('¿Y cómo prefieren marcar: app (sin costo adicional), reloj físico, o mixto?') y cotiza cuando responda. Si eligió app/web/telefónico, cotiza SIN hardware."
            console.warn(
              `[agent-loop] candado reloj-sin-cita: ${toolName} con hardware bloqueado (contacto ${contact}) — sin evidencia textual de la elección.`,
            )
          }
        }

        // CANDADO COMUNA ASUMIDA (Lalo 13-ago, caso Rodrigo AM: el modelo
        // cotizó asumiendo Región Metropolitana sin preguntar). Regla dura:
        // la ubicación de CADA punto debe haber sido dicha por el CLIENTE en
        // algún mensaje (acepta abreviaciones tipo "provi" → Providencia).
        // Si no hay respaldo, la tool se niega y guía a PREGUNTAR la comuna.
        // Peor caso de un falso positivo: una pregunta de confirmación de
        // comuna — exactamente el comportamiento que pide la regla.
        if (
          !bloqueoUmbral &&
          (toolName === "cotizar_referencial" || toolName === "generar_link_cotizadora")
        ) {
          const puntos = (toolInput as { puntosInstalacion?: Array<{ ubicacion?: string }> })
            .puntosInstalacion
          if (Array.isArray(puntos) && puntos.length > 0) {
            // Camino primario: cita textual (`evidenciaUbicacion`) — el modelo
            // copia la frase del cliente donde dijo dónde ("no disculpa es
            // para olmué") y el código verifica que exista literal. La
            // interpretación (frase → comuna) es trabajo del modelo.
            let ubicacionRespaldada = citaDelCliente(
              (toolInput as Record<string, unknown>).evidenciaUbicacion,
            )
            if (!ubicacionRespaldada) {
              // Fallback de transición: tokens de la ubicación en el texto del
              // cliente (acepta abreviaciones tipo "provi" → Providencia).
              const tokensCliente = textosClienteEv.split(/[^a-z]+/).filter((t) => t.length >= 4)
              ubicacionRespaldada = !puntos.some((p) => {
                const tokensUb = normEv(String(p?.ubicacion || ""))
                  .split(/[^a-z]+/)
                  .filter((t) => t.length >= 3)
                if (tokensUb.length === 0) return true // "RM" pelado u ubicación vacía
                return !tokensUb.some(
                  (tu) =>
                    textosClienteEv.includes(tu) || tokensCliente.some((tc) => tu.startsWith(tc)),
                )
              })
            }
            if (!ubicacionRespaldada) {
              bloqueoUmbral =
                "REGLA DE PROCESO (no es un error técnico — no se lo menciones al cliente): la ubicación del punto necesita respaldo del cliente — la comuna JAMÁS se asume (ni la Región Metropolitana por defecto). " +
                "Si el cliente YA dijo dónde, vuelve a llamar la tool pasando `evidenciaUbicacion` = su frase TEXTUAL (copiada literal). Si no lo ha dicho, pregúntale en qué comuna estará el reloj y cotiza recién cuando te la dé."
              console.warn(
                `[agent-loop] candado comuna-sin-cita: ${toolName} bloqueado (contacto ${contact}) — ubicación sin respaldo del cliente.`,
              )
            }
          }
        }

        let result: Awaited<ReturnType<typeof dispatchTool>>
        // REUNIÓN POST-FORMAL = del dueño del deal, no del Round Robin (Lalo,
        // 21-jul, caso notaría). Desde el 28-jul existe la forma de AGENDARLA
        // de verdad: los eventos "Seguimiento cotización" (uno por ejecutivo,
        // host único). Si el dueño de la cotización tiene su evento, se
        // inyecta ese eventTypeId — disponibilidad Y booking corren contra SU
        // agenda, y la reunión nace asignada a él. Solo los dueños legacy sin
        // evento (Anderson) conservan el camino determinista: aviso al equipo
        // y el dueño envía la invitación.
        let reunionPostFormal = false
        // FLUJO 21+ (Lalo 13-ago — SUPERSEDE la excepción SDR-inbound del
        // 11-ago): la reunión del sobre-umbral agenda con el DUEÑO DEL DEAL
        // sorteado por la tómbola, igual que cualquier reunión — el camino de
        // abajo ya lo hace (sin deal → hito síncrono con sorteoInmediato →
        // disponibilidad sobre el evento de host único del dueño; sin evento
        // configurado cae al round-robin por defecto, jamás se bloquea).
        if (
          (toolName === "agendar_reunion" || toolName === "consultar_disponibilidad_horario") &&
          contact
        ) {
          // REGLA NUEVA (Lalo 10-ago): "si se traspasa una conversación a un
          // ejecutivo, la reunión se queda a nombre de él". Manda el dueño
          // del DEAL (el que sorteó la tómbola al traspasar) y la cotización
          // formal queda de respaldo — antes (31-jul) solo la formal
          // redirigía la agenda y el dueño del deal entraba como invitado.
          //
          // Cal.com NO permite dirigir un evento multi-host a una persona
          // (re-verificado 10-ago: teamMemberEmail/username → 400), así que
          // esto SOLO funciona con el evento de host único del ejecutivo. Sin
          // ese evento configurado, el comportamiento es el de siempre: se
          // agenda por el round-robin y el dueño entra como asistente — un
          // ejecutivo sin calendario jamás rompe la reunión del cliente.
          let duenoDeal: DuenoReunion | null = await duenoDealVigente(contact).catch(() => null)
          // Deal en un INTERINO = deal sin dueño real para efectos de agenda
          // (Lalo 10-ago: "si hay deal pero es de Vicky aún, se pasa a
          // tómbola"). duenoDealVigente ya descarta a Vicky; acá se agrega el
          // Admin (info@), dueño fantasma de los leads del formulario web que
          // nadie atiende. Eddyluz/Gordillo/Yahel NO entran: hoy son dueños
          // reales con agenda propia.
          if (duenoDeal && /^info@geovictoria\.com$/i.test(duenoDeal.email)) duenoDeal = null
          // TÓMBOLA ÚNICA (Lalo 10-ago): "la tómbola es la de deals de Zoho",
          // Cal no debe sortear a nadie. Si el cliente pide reunión y todavía
          // no hay deal (77% de los casos, medido el 10-ago), se dispara el
          // hito AHORA y de forma SÍNCRONA: nace el deal por la vía de
          // siempre —lead convertido, candado deal_fono_<fono> anti-duplicado
          // y candado de lead por teléfono— y la tómbola de Zoho sortea al
          // ejecutivo con sorteoInmediato. Recién con ese dueño se busca
          // agenda, así el cliente ve las horas de quien lo va a atender.
          //
          // Sin número de trabajadores el deal NO nace (regla CL del 06-ago:
          // esa oportunidad no está calificada) — ahí se cae al camino de
          // siempre, que sigue ofreciendo agenda. Timeout de 8 s: si Zoho se
          // demora, el cliente NO se queda esperando su reunión.
          if (!duenoDeal) {
            await Promise.race([
              sincronizarHitoCrm(contact, "intencion", datosDeToolInput(toolName, toolInput), {
                sorteoInmediato: true,
              }),
              new Promise((r) => setTimeout(r, 8000)),
            ]).catch(() => undefined)
            duenoDeal = await duenoDealVigente(contact).catch(() => null)
          }
          const eventoDeal = duenoDeal ? eventoSeguimientoDe(duenoDeal.email) : undefined
          if (eventoDeal) {
            ;(toolInput as Record<string, unknown>).eventTypeId = eventoDeal
          } else {
            const formalReunion = await getFormalQuote(contact).catch(() => "")
            if (formalReunion) {
              const dueno: DuenoReunion | null = await duenoCotizacionVigente(contact).catch(() => null)
              const eventoDelDueno = dueno ? eventoSeguimientoDe(dueno.email) : undefined
              if (eventoDelDueno) {
                ;(toolInput as Record<string, unknown>).eventTypeId = eventoDelDueno
              } else if (dueno && toolName === "agendar_reunion") {
                reunionPostFormal = true
              }
            }
          }
        }
        if (reunionPostFormal) {
          const slot = String((toolInput as Record<string, unknown>).slotIso || "")
          const nombreCli = String((toolInput as Record<string, unknown>).prospectName || "")
          await avisarEquipoInterno(
            `📅 Reunión pedida POST-cotización — contacto +${contact} (${nombreCli}). Horario pedido: ${slot || "sin hora exacta"}. La invitación la envía el DUEÑO del deal (revisar Owner de la cotización en Zoho — asignado por la tómbola de deals; Eddyluz/Anderson solo en deals anteriores); no se agendó por Cal.com para no asignar otro KAM.`,
          ).catch(() => {})
          result = {
            ok: true,
            mensajeParaProspecto:
              "Listo! Le pasé tu horario al ejecutivo a cargo de tu cotización — te va a enviar la invitación de la reunión para confirmarla 😊",
          } as unknown as Awaited<ReturnType<typeof dispatchTool>>
        } else if (bloqueoUmbral) {
          result = {
            ok: false,
            error: bloqueoUmbral,
          } as Awaited<ReturnType<typeof dispatchTool>>
        } else if (toolName === "generar_link_cotizadora" && generarLinkEnEsteTurno >= 1) {
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
        } else if (toolName === "generar_link_cotizadora" && formalMismoRut) {
          // Anti-duplicado POR RUT: ya existe formal para ESA razón social.
          console.warn(
            `[agent-loop] generar_link bloqueado: ya existe cotización formal ${formalMismoRut} para ese RUT (contacto ${contact}).`,
          )
          result = {
            ok: false,
            error:
              `Ya existe una cotización formal para ESA razón social (quote_id ${formalMismoRut}). NO generes otra para el mismo RUT. ` +
              "Si el cliente quiere CAMBIAR la configuración de esa cotización, usa actualizar_cotizacion. " +
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

        // Tag comercial por país en Botmaker (Lalo 28-jul): el ÉXITO de una
        // tool de venta marca el chat (comercial_cl/co/mx) para que cada
        // ejecutivo filtre su bandeja por tag. Determinista: soporte no pasa
        // por estas tools, así que jamás se taguea. Best-effort, nunca
        // bloquea el turno.
        if (
          contact &&
          TOOLS_SENAL_COMERCIAL.has(toolName) &&
          (result as { ok?: boolean } | null)?.ok !== false
        ) {
          void tagearChatComercial(contact).catch(() => false)
        }

        // Sincronización CRM por hitos (Lalo 30-jul): el ÉXITO de una tool
        // implica un hito del diccionario (preform, intención, aceptada) y el
        // CRM se actualiza solo — lead creado/convertido según origen del
        // dato (entrante vs asignado en el CRM) y deal subiendo de etapa como
        // PISO, nunca hacia atrás. Detrás de flag; best-effort siempre.
        if (
          contact &&
          HITO_POR_TOOL[toolName] &&
          (result as { ok?: boolean } | null)?.ok !== false
        ) {
          // Con reunión agendada, el owner del deal/lead se FUERZA al host
          // que sorteó Cal (Lalo 06-ago) — el hito lo recibe explícito para
          // matar la carrera con la reasignación del lead (caso VDZ: cliente
          // conoció a Aleydis y el deal se sorteó a Tamara).
          const hostReunion =
            (toolName === "agendar_reunion" || toolName === "reagendar_reunion") &&
            result &&
            typeof result === "object" &&
            "organizerEmail" in result
              ? String((result as { organizerEmail?: unknown }).organizerEmail || "").trim()
              : ""
          void sincronizarHitoCrm(
            contact,
            HITO_POR_TOOL[toolName],
            datosDeToolInput(toolName, toolInput),
            {
              noCrear: TOOLS_QUE_CREAN_SU_LEAD.has(toolName),
              ...(hostReunion ? { ownerForzadoEmail: hostReunion } : {}),
            },
          ).catch(() => undefined)
        }

        // Transcripción INMEDIATA al deal de la cotización formal (Lalo,
        // 31-jul): el cotizador devuelve el dealId del deal que creó/reusó —
        // pegarla directo evita el lag del buscador de Zoho, que hoy dejó
        // tres deals sin historial y a los vendedores sorteados reclamando a
        // ciegas (Tamara, Grey, Paola). Best-effort, jamás bloquea el turno.
        if (contact && toolName === "generar_link_cotizadora") {
          const dealDeCotizacion =
            "dealId" in result && typeof (result as { dealId?: unknown }).dealId === "string"
              ? (result as { dealId: string }).dealId
              : ""
          if (dealDeCotizacion) {
            void actualizarNotaTranscripcion(dealDeCotizacion, contact).catch(() => undefined)
          }
        }

        // Marca SOPORTE determinística (Lalo 20-jul): si la conversación se
        // redirige al agente de soporte de Foundry (consultar_agente_soporte) o
        // se deriva a soporte operativo, queda marcada como soporte SÍ O SÍ —
        // cierra la cadencia de seguimiento y candadea el re-armado de esta
        // conversación (armFollowup lo respeta). Se marca por la INVOCACIÓN,
        // no por el éxito de la tool: aunque Foundry falle, la conversación es
        // de soporte. No depende del análisis LLM por hora ni del sweep de 15m.
        // Brecha 2 del doc "Vicky paso a paso" (30-jul): el prospecto de MÁS
        // de 50 trabajadores sale del Loop — el ejecutivo lo llama al toque en
        // hábil y Vicky no le manda más toques (sí responde si él escribe).
        // Se marca por la INVOCACIÓN, igual que soporte: aunque la derivación
        // falle, el prospecto sigue siendo >50. Best-effort, nunca bloquea.
        const esDerivacionMas50 =
          (toolName === "derivar_a_soporte" &&
            String(toolInput.motivo || "") === "fuera_de_rango_trabajadores") ||
          (toolName === "derivar_a_ejecutivo" && String(toolInput.motivo || "") === "mas_de_50")
        if (contact && esDerivacionMas50) {
          // ORDEN LALO 10-ago PM (supersede el "acompañamiento" del 08-ago):
          // "Vicky solo vende hasta 20; si es más, crea el lead en Zoho y YA
          // NO hace comunicación proactiva — esos leads no se le asignan a
          // ella". Toda derivación sobre el umbral cierra el loop: el lead y
          // el deal quedan creados (sorteoInmediato abajo sigue intacto), el
          // equipo humano es el dueño, y Vicky solo responde REACTIVAMENTE
          // si el cliente escribe. Motivo diferenciado para el reporting:
          // 'sobre_umbral' (21-50 con N legible) vs 'mas_de_50' (>50 o sin
          // N). La válvula de precio muere con esto: sin marca sobre_umbral_
          // no hay válvula que armar — Vicky no retoma ventas que no son
          // suyas.
          const nDerivado = parseEmpleados((toolInput as Record<string, unknown>).trabajadores)
          const esBandaMedia =
            typeof nDerivado === "number" &&
            nDerivado >= 1 &&
            nDerivado <= SCOPE_MAX_SISTEMA
          void mas50CierraLoop(contact, esBandaMedia ? "sobre_umbral" : "mas_de_50").catch(
            () => undefined,
          )
        }
        // ORDEN LALO 06-ago: el >50 que Vicky no puede cotizar pasa SÍ O SÍ a
        // la tómbola de deals con sus datos (N° empleados incluido, para caer
        // en el tramo correcto de la regla). Antes derivar_a_soporte era un
        // no-op de CRM: "un ejecutivo te contactará" sin lead ni deal (casos
        // Grupo Euskadi/Veltis/Safran — nadie los recibió). El hito
        // "intencion" crea el lead si falta, lo convierte con deal y aplica
        // la tómbola. Solo CL (CO/MX/PE derivan con derivar_a_ejecutivo y
        // dueños fijos de país). Best-effort: jamás toca la conversación.
        if (
          contact &&
          contact.replace(/\D/g, "").startsWith("56") &&
          toolName === "derivar_a_soporte" &&
          String(toolInput.motivo || "") === "fuera_de_rango_trabajadores"
        ) {
          // sorteoInmediato (umbral 08-ago): al cliente se le acaba de decir
          // "un ejecutivo te entrega el precio" — el deal NO puede quedar
          // esperando en Vicky hasta el reloj de 120': la tómbola sortea y
          // notifica al nacer, para cualquier N (los >50 ya funcionaban así).
          // SÍNCRONO (Eduardo 14-ago): el hito entrega el lead a la tómbola
          // de LEADS y necesitamos saber QUIÉN quedó asignado para
          // presentarlo en esta misma respuesta y ofrecer reunión con él.
          // Timeout de 8s: si Zoho se demora, el cliente igual recibe su
          // mensaje (sin nombre) y el registro se completa por detrás.
          await Promise.race([
            sincronizarHitoCrm(contact, "intencion", datosDeToolInput(toolName, toolInput), {
              sorteoInmediato: true,
              // entregarComoLead (Eduardo 14-ago): la rama "que me llamen" NO
              // crea trato — el caso se entrega como LEAD a la tómbola de
              // leads de ejecutivos comerciales. La rama REUNIÓN sí crea el
              // deal (más arriba, sin este flag): ahí hay compromiso agendado
              // y la reunión tiene que nacer con el dueño del deal.
              entregarComoLead: true,
            }).catch(() => undefined),
            new Promise((r) => setTimeout(r, 8000)),
          ])
          // Datos del ejecutivo que sorteó la tómbola de leads: se los pasamos
          // al modelo dentro del resultado de la tool para que lo presente y
          // ofrezca agendar una reunión con él.
          const { leerEjecutivoAsignado } = await import("./crm-hitos")
          const ejec = await leerEjecutivoAsignado(contact).catch(() => null)
          if (ejec && (ejec.nombre || ejec.email) && result && typeof result === "object") {
            ;(result as Record<string, unknown>).ejecutivoAsignado = {
              nombre: ejec.nombre,
              email: ejec.email,
              telefono: ejec.telefono || "",
            }
            ;(result as Record<string, unknown>).instruccionPresentacion =
              `PRESENTA a ${ejec.nombre || "tu ejecutivo"} al cliente EN ESTE MENSAJE: su nombre` +
              (ejec.telefono ? `, su teléfono ${ejec.telefono}` : "") +
              (ejec.email ? ` y su correo ${ejec.email}` : "") +
              `. Y pregúntale si quiere que le dejes AGENDADA una reunión con ${ejec.nombre || "él"} (si acepta, pide su correo y usa consultar_disponibilidad_horario + agendar_reunion).`
          }
        }

        const esRedireccionSoporte =
          toolName === "consultar_agente_soporte" ||
          (toolName === "derivar_a_soporte" &&
            ["cliente_existente_problema", "transferir_soporte_operativo"].includes(
              String(toolInput.motivo || ""),
            ))
        if (contact && esRedireccionSoporte) {
          const paisContacto = contact.startsWith("57")
            ? "co"
            : contact.startsWith("52")
              ? "mx"
              : contact.startsWith("51")
                ? "pe"
                : "cl"
          await marcarConversacionSoporte(contact, paisContacto).catch((e) =>
            console.error(`[agent-loop] marcarConversacionSoporte falló (${contact}):`, e),
          )
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
            // Reloj v2 de 15' — "precio dado" ES el referencial exitoso.
            // CO/MX/PE desde el 05/08-ago (sin tools de negociación, estampan
            // siempre). CL desde el 10-ago (caso Rodrigo 11:15: vio precio,
            // nunca negoció, y quedó como "sin_precio" — invisible para el
            // reloj de silencio y el toque temprano). En CL solo se estampa si
            // NO hay draft: una negociación previa ya estampó y trae un
            // escalón acordado que no se puede pisar.
            {
              const digits = contact.replace(/\D/g, "")
              const okRef = (result as { ok?: boolean }).ok === true
              if (/^(57|52|51)\d{8,12}$/.test(digits) && okRef) {
                await setPrefDraft(contact, {}).catch(() => {})
              } else if (/^56\d{8,12}$/.test(digits) && okRef) {
                // BUG 26-ago (caso José Ormeño): getPrefDraft NUNCA devuelve
                // null — entrega EMPTY_PREF_DRAFT — así que `if (!draftCL)`
                // jamás corría y el estampado CL del 10-ago nació muerto
                // (34 de 37 precios de agosto sin estampa → reloj de 120' en
                // vez del de 15' de silencio). Lo que no se puede pisar es un
                // ESCALÓN negociado, no el draft vacío.
                const draftCL = await getPrefDraft(contact).catch(() => null)
                if (!draftCL || !(draftCL.escalon > 0)) await setPrefDraft(contact, {}).catch(() => {})
              }
            }
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
            // Punto 4 (Lalo 08-ago): el primer toque post-formal sale a los
            // 35 minutos, dentro de la ventana real de compra (mediana de
            // pago histórica: 36 min). Best-effort.
            void (async () => {
              const { adelantarPrimerToqueFormal } = await import("./loop-v2")
              await adelantarPrimerToqueFormal(contact)
            })().catch(() => undefined)
            // ARREPENTIMIENTO POST-ACEPTACIÓN (Rodrigo 10-ago): si el contacto
            // tenía OTRA cotización y esa quedó Aceptada sin pagar, esta
            // emisión nueva la reemplaza — la anterior pasa a Rechazada
            // (perdida) por detrás, sin tocar la conversación. Emitidas en
            // comparación o pagadas no se tocan (el helper lo verifica).
            if (qid) {
              const rutNuevo =
                typeof toolInput.rutEmpresa === "string"
                  ? toolInput.rutEmpresa.replace(/[^0-9kK]/g, "").toLowerCase()
                  : ""
              void (async () => {
                const anteriores = await getQuotePointers(contact).catch(() => [])
                // Multi-RUT: solo se supera la cotización de la MISMA empresa
                // (o sin RUT etiquetado) — la aceptada de otra razón social
                // del mismo contacto no se toca.
                const superada = anteriores.find((p) => {
                  if (!p.quoteId || p.quoteId === qid) return false
                  const rutPrev = (p.rut || "").replace(/[^0-9kK]/g, "").toLowerCase()
                  return !rutPrev || !rutNuevo || rutPrev === rutNuevo
                })
                if (superada?.quoteId) {
                  // Guarda de pago REAL (10-ago): un contacto que ya pagó por
                  // MP puede tener la cotización aún "Aceptada" en Zoho — esa
                  // jamás se marca perdida.
                  const { loopCerradoPorPagoReal } = await import("./loop-v2")
                  const yaPago = await loopCerradoPorPagoReal(contact).catch(() => false)
                  if (!yaPago) {
                    const { rechazarAceptadaSuperada } = await import("./zoho-quote-status")
                    await rechazarAceptadaSuperada(superada.quoteId)
                  }
                }
              })().catch(() => undefined)
            }
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
                // Multi-RUT: etiquetar el puntero con la razón social.
                rut: typeof toolInput.rutEmpresa === "string" ? toolInput.rutEmpresa : undefined,
                empresa: typeof toolInput.empresa === "string" ? toolInput.empresa : undefined,
              }).catch(() => {})
              // CAMPAÑA 10% (26-ago): si el contacto aceptó la oferta de la
              // campaña ANTES de tener formal (segmento vio-precio), la
              // emisión recién creada recibe su % exacto por fuera del chat
              // (descuento-ejecutivo). Best-effort: no toca la conversación.
              import("./campana-descuento")
                .then((m) => m.aplicarCampanaAQuoteNueva(contact, qid))
                .catch(() => {})
              // TODO lo que la emisión creó en Zoho queda registrado (Lalo
              // 15-ago). La cotización trae además cuenta y contacto, que
              // hasta hoy no quedaban anotados en ninguna parte — y el
              // deal_id solo se guardaba en las emisiones chilenas, por eso
              // 15 cotizaciones de CO/MX figuraban "sin trato" teniéndolo.
              const { registrarEnZoho } = await import("./registro-zoho")
              await registrarEnZoho(
                contact,
                [
                  { modulo: "Cotizaciones_GeoVictoria", id: qid },
                  { modulo: "Deals", id: str("dealId") },
                  { modulo: "Accounts", id: str("accountId") },
                  { modulo: "Contacts", id: str("contactId") },
                ],
                { origen: "cotizador" },
              ).catch(() => 0)
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
              const prevs = await getQuotePointers(contact).catch(() => [])
              const prev = prevs.find((pt) => pt.quoteId === qid) || prevs[0] || null
              await setQuotePointer(contact, {
                quoteId: qid,
                dealId: prev?.dealId || undefined,
                acceptanceUrl: r2.acceptanceUrl,
                pdfUrl: typeof r2.linkPdf === "string" ? r2.linkPdf : prev?.pdfUrl || undefined,
                totalClp: prev?.totalClp ?? undefined,
                totalUf: prev?.totalUf ?? undefined,
                rut: prev?.rut || undefined,
                empresa: prev?.empresa || undefined,
              }).catch(() => {})
            }
          } else if (toolName === "actualizar_cotizacion") {
            // Puntero al día: mismos quoteId/link, totales nuevos (los usa la
            // llamada de voz y el contexto anti-amnesia).
            const r3 = result as Record<string, unknown>
            const qid3 = typeof toolInput.quote_id === "string" ? toolInput.quote_id : ""
            if (qid3 && r3.ok === true) {
              await setFormalQuote(contact, qid3).catch(() => {})
              const prevs3 = await getQuotePointers(contact).catch(() => [])
              const prev = prevs3.find((pt) => pt.quoteId === qid3) || null
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
                rut: prev?.rut || undefined,
                empresa: prev?.empresa || undefined,
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

        if (
          "ok" in result && result.ok &&
          (("handoff" in result && result.handoff) || toolName === "derivar_a_ejecutivo")
        ) {
          handoff = true
          // Respaldo determinista (umbral 08-ago): tras un handoff exitoso el
          // modelo a veces devuelve el turno VACÍO (visto sistemático en la
          // E2E de derivaciones sobre-umbral) — si eso pasa, la respuesta al
          // cliente es el mensaje sugerido de la tool, no la disculpa genérica.
          const r = result as Record<string, unknown>
          const sugerido =
            (typeof r.mensajeSugeridoUsuario === "string" && r.mensajeSugeridoUsuario) ||
            (typeof r.mensajeParaProspecto === "string" && r.mensajeParaProspecto) ||
            ""
          if (sugerido) mensajeHandoffRespaldo = sugerido
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

  // TURNO MUDO LEGÍTIMO (caso Rodrigo 17-ago): cuando la entrega salió por la
  // PLANTILLA con botón, el prompt ordena cerrar sin texto — y este respaldo
  // convertía ese silencio intencional en "Disculpa, tuve un problema…".
  // Con la plantilla enviada, el turno vacío ES el resultado correcto.
  const plantillaEntregoElTurno = toolCalls.some(
    (c) =>
      c.name === "generar_link_cotizadora" &&
      c.ok &&
      (c.output as { plantillaEnviada?: boolean } | undefined)?.plantillaEnviada === true,
  )
  if (!finalText && !plantillaEntregoElTurno) {
    finalText =
      mensajeHandoffRespaldo ||
      "Disculpa, tuve un problema procesando tu mensaje. ¿Puedes repetirlo o decirme con qué te puedo ayudar?"
  }

  // CINTURÓN DE ENTREGA DEL LINK (caso Stephanie/Ciberlabs 21-ago): la tool
  // emitió la cotización formal OK pero el texto final salió SIN el link — el
  // cliente quedó con "tu cotización está lista para aceptar y pagar" y nada
  // que abrir (y los toques posteriores hablan de "el mismo link" fantasma).
  // Respaldo determinista: si generar_link_cotizadora fue exitosa, no entregó
  // por plantilla y el reply no trae ni el link corto ni el largo, se anexa.
  {
    const emision = toolCalls.find((c) => c.name === "generar_link_cotizadora" && c.ok)
    if (emision && finalText) {
      const out = (emision.output || {}) as {
        linkCorto?: string
        acceptanceUrl?: string
        plantillaEnviada?: boolean
      }
      const linkEntrega = (out.linkCorto || out.acceptanceUrl || "").trim()
      const yaLoTrae =
        (!!out.linkCorto && finalText.includes(out.linkCorto)) ||
        (!!out.acceptanceUrl && finalText.includes(out.acceptanceUrl))
      if (linkEntrega && !out.plantillaEnviada && !yaLoTrae) {
        finalText += `\n\nAquí revisas, aceptas y pagas tu cotización 👉 ${linkEntrega}`
        console.warn(
          `[agent-loop] cinturón de entrega: el reply salió sin el link de la cotización recién emitida — anexado (${linkEntrega})`,
        )
      }
    }
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
