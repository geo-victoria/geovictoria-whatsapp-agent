/**
 * Endpoint POST /api/vic-botmaker-v3
 *
 * Adapter entre Botmaker y el agent-loop de V3.
 *
 * ─── Arquitectura: async + push (refactor 2026-05-29) ──────────────────
 *
 * Antes: el endpoint procesaba el mensaje sincrónamente y devolvía
 * { reply } a Botmaker. Cuando una cotización formal tardaba más que el
 * timeout del webhook (~17s), Botmaker reintentaba la request, y la segunda
 * llamada (descartada como concurrente con reply="") era la que Botmaker
 * tomaba como respuesta válida — el cliente no recibía nada aunque la
 * cotización sí se hubiera creado en Zoho.
 *
 * Ahora:
 *   1. El webhook responde INMEDIATO con reply vacío (always).
 *   2. Antes del response se dispara el typing indicator de WhatsApp.
 *   3. El procesamiento real corre en background con after() de next/server.
 *   4. El reply final se entrega vía push de Botmaker
 *      (/v2.0/chats-actions/send-messages).
 *   5. Lock distribuido en Supabase (vic_v3_processing_locks) reemplaza
 *      el Set<string> en memoria, que no servía en serverless.
 *
 * El filtro de teléfonos autorizados sigue viviendo en el Master Bot de
 * Botmaker — solo derivan a este endpoint los contactos en whitelist.
 */

import { NextResponse, after } from "next/server"
import { runAgentLoop, type ConversationMessage } from "@/lib/agent-loop"
import { getSystemPromptV3 } from "@/app/api/vic-sales-agent-v3/prompt"
import { fetchHistoryV3, appendTurnV3, getPrefEscalon } from "@/lib/supabase-persistence-v3"
import { acquireLock, releaseLock, hashMessage } from "@/lib/processing-lock-v3"
import { sendBotmakerMessage, sendTypingIndicator } from "@/lib/botmaker-push-v3"

export const dynamic = "force-dynamic"
export const maxDuration = 60

// ── Guardrails de seguridad ───────────────────────────────────────────
const MAX_INPUT_CHARS = 2000
const INJECT_RE =
  /###|IGNORE|DUMP|INSTRUC|SYSTEM PROMPT|\bPROMPT\b|\\u202|<script|DROP\s+TABLE|DELETE\s+FROM|UNION\s+SELECT/i

// ── Tipos ─────────────────────────────────────────────────────────────
type BotmakerRequest = { contact?: string; message?: string }

type ToolCallRecord = {
  name: string
  ok: boolean
  output?: unknown
}

type PdfUrlOutput = { pdfUrl?: string }

// ── Constantes de UX ──────────────────────────────────────────────────
const ERROR_FALLBACK_MSG =
  "Disculpa, tuve un problema procesando tu mensaje. ¿Puedes intentar de nuevo en un momento?"

const GENERIC_ERROR_MSG =
  "Tuve un problema técnico momentáneo. ¿Podrías repetir tu mensaje?"

// Circuit-breaker (C): tras varios errores seguidos en una misma conversación,
// escalamos a humano UNA vez en lugar de repetir el fallback en loop (en
// producción este loop llegó a 60 mensajes idénticos).
const ESCALADA_ERROR_MSG =
  "Disculpa, sigo teniendo un problema técnico. Ya le avisé a un ejecutivo para que se contacte contigo a la brevedad. 🙏"

// Saneador anti-voseo (D): la regla del prompt ya pide español chileno (tuteo),
// pero el modelo se escapa de forma intermitente ("Recordá", "Acá"). Esta capa
// determinista normaliza los voseos/argentinismos más comunes en el reply de
// salida, antes de persistir y enviar, preservando la mayúscula inicial. Usa
// límites Unicode (\p{L}) porque \b no funciona junto a vocales acentuadas.
const VOSEO_MAP: [RegExp, string][] = [
  [/(?<!\p{L})record[aá](?!\p{L})/giu, "recuerda"],
  [/(?<!\p{L})ac[aá](?!\p{L})/giu, "aquí"],
  [/(?<!\p{L})pod[eé]s(?!\p{L})/giu, "puedes"],
  [/(?<!\p{L})ten[eé]s(?!\p{L})/giu, "tienes"],
  [/(?<!\p{L})quer[eé]s(?!\p{L})/giu, "quieres"],
  [/(?<!\p{L})sab[eé]s(?!\p{L})/giu, "sabes"],
  [/(?<!\p{L})hac[eé]s(?!\p{L})/giu, "haces"],
  [/(?<!\p{L})mir[aá](?!\p{L})/giu, "mira"],
  [/(?<!\p{L})fijate(?!\p{L})/giu, "fíjate"],
  [/(?<!\p{L})avisame(?!\p{L})/giu, "avísame"],
  [/(?<!\p{L})contame(?!\p{L})/giu, "cuéntame"],
]

function sanitizarVoseo(texto: string): string {
  if (!texto) return texto
  let out = texto
  for (const [re, repl] of VOSEO_MAP) {
    out = out.replace(re, (match) =>
      match[0] === match[0].toUpperCase()
        ? repl.charAt(0).toUpperCase() + repl.slice(1)
        : repl,
    )
  }
  return out
}

// ── Utilidades ────────────────────────────────────────────────────────
function getEnv(name: string) {
  return (process.env[name] || "").trim()
}

function normalizeContact(raw: string): string {
  return raw.replace(/\D/g, "")
}

/**
 * Busca en los toolCalls una llamada exitosa a generar_link_cotizadora
 * y extrae el pdfUrl del output. Se usa solo para logging/observabilidad.
 */
function extractPdfUrl(
  toolCalls: ToolCallRecord[] | undefined,
): string | undefined {
  if (!toolCalls) return undefined
  for (const call of toolCalls) {
    if (call.name !== "generar_link_cotizadora" || !call.ok) continue
    const output = call.output as PdfUrlOutput | undefined
    if (output?.pdfUrl && typeof output.pdfUrl === "string") {
      return output.pdfUrl
    }
  }
  return undefined
}

// ── Procesamiento en background ───────────────────────────────────────
/**
 * Corre el agent-loop completo y entrega el reply vía push de Botmaker.
 *
 * Se invoca con after() de next/server para que Vercel mantenga el
 * container vivo después de que el webhook ya respondió a Botmaker.
 *
 * Pasos:
 *   1. runAgentLoop completo (puede tardar 20+ seg en cotización formal)
 *   2. Persistir turno en Supabase
 *   3. Enviar reply final vía push
 *   4. Liberar lock (siempre, incluso si hay error)
 */
async function processInBackground(
  contact: string,
  message: string,
  apiKey: string,
): Promise<void> {
  try {
    // 1. Cargar historial
    const history: ConversationMessage[] = await fetchHistoryV3(contact, 40)

    // 2. Correr el agent
    const result = await runAgentLoop({
      systemPrompt: getSystemPromptV3(contact),
      history,
      userMessage: message,
      apiKey,
      contact,
    })

    let reply = (result.reply || "").trim()

    // 2.5. Guardrail anti-alucinación de URL del PDF.
    // Si el reply contiene una URL del cotizador pero NO hubo una
    // invocación exitosa de generar_link_cotizadora en este turno, el
    // modelo construyó la URL desde su propio output (alucinación).
    // Sobrescribimos por un mensaje genérico y lo loggeamos para alertar.
    const hasCotizacionUrl = /cotizacion\.geovictoria\.com\/pdf\//i.test(reply)
    const toolCalls = (result.toolCalls || []) as ToolCallRecord[]
    // Tanto generar_link_cotizadora como aplicar_siguiente_descuento (commit
    // del descuento) regeneran un PDF legítimo del cotizador.
    const realCotizacion = toolCalls.some(
      (c) =>
        (c.name === "generar_link_cotizadora" ||
          c.name === "aplicar_siguiente_descuento") &&
        c.ok,
    )
    if (hasCotizacionUrl && !realCotizacion) {
      console.error(
        `[v3-bg] ALUCINACIÓN_URL contact=${contact} replyOriginal=${JSON.stringify(reply.slice(0, 400))}`,
      )
      reply =
        "Disculpa, tuve un problema generando tu cotización formal. ¿Me confirmas otra vez para procesarla?"
    }

    // 2.6. Guardrail anti-alucinación de descuento.
    // Si el reply menciona un % de descuento pero NO hubo una tool de descuento
    // exitosa en este turno, lo normal es que el modelo lo inventó. Pero hay dos
    // casos legítimos que NO debemos bloquear, y un loop que debemos cortar:
    //   (B1) el cliente acepta/reconfirma un % que YA está negociado/comiteado
    //        (incluido el tope) → dejar pasar; bloquear solo si el % es MAYOR al
    //        ya comiteado (eso sí sería avanzar sin pasar por el servidor).
    //   (B2) si el turno anterior ya fue la muletilla, NO repetirla: cerrar
    //        hacia una decisión / derivación en vez de quedar pegados en loop.
    const MULETILLA_DESCUENTO =
      "Permíteme procesar el descuento en el sistema para confirmarte el porcentaje exacto que puedo aplicarte. ¿Te parece?"
    const ofreceDescuento =
      /\d+\s*%\s*de\s+descuento|descuento\s+del?\s+\d+\s*%/i.test(reply)
    const realDescuento = toolCalls.some(
      (c) =>
        (c.name === "consultar_descuento_referencial" ||
          c.name === "consultar_siguiente_descuento" ||
          c.name === "aplicar_siguiente_descuento") &&
        c.ok,
    )
    // (B1) ¿El % mencionado ya está negociado/comiteado para este contacto?
    // pref_escalon es el "siguiente índice" (idx+1); el % recurrente comiteado
    // queda determinado por él. Reconfirmar ese % (o uno menor, o el de
    // instalación) es legítimo; reclamar uno MAYOR sin tool no lo es.
    const pctMatch = reply.match(/(\d+)\s*%/)
    const pctEnReply = pctMatch ? Number(pctMatch[1]) : null
    const prefEscalon = await getPrefEscalon(contact).catch(() => 0)
    const committedRecPct = prefEscalon >= 3 ? Math.min(30, (prefEscalon - 1) * 5) : 0
    const pctYaNegociado =
      pctEnReply !== null &&
      prefEscalon > 0 &&
      (pctEnReply <= committedRecPct || pctEnReply === 50 || pctEnReply === 25)

    if (ofreceDescuento && !realDescuento && !pctYaNegociado) {
      const ultimoAsistente = [...history]
        .reverse()
        .find((m) => m.role === "assistant")
        ?.content?.trim()
      if (ultimoAsistente === MULETILLA_DESCUENTO) {
        // (B2) Ya pedimos "procesar el descuento" el turno anterior: romper el
        // loop cerrando hacia una decisión o derivación.
        console.error(
          `[v3-bg] LOOP_MULETILLA_ROTO contact=${contact} replyOriginal=${JSON.stringify(reply.slice(0, 300))}`,
        )
        reply =
          "Para no darte más vueltas con los números: te dejo el mejor precio que te ofrecí y te paso la cotización formal, o si prefieres te contacto con un ejecutivo para revisar el precio. Cómo prefieres?"
      } else {
        console.error(
          `[v3-bg] ALUCINACIÓN_DESCUENTO contact=${contact} replyOriginal=${JSON.stringify(reply.slice(0, 400))}`,
        )
        reply = MULETILLA_DESCUENTO
      }
    }

    // 2.7. Saneador anti-voseo determinista (por si el modelo se escapó del
    // tuteo chileno pese a la regla del prompt).
    reply = sanitizarVoseo(reply)

    // 3. Persistir turno en Supabase
    await appendTurnV3(contact, message, reply).catch((err) => {
      console.error("[v3-bg] Error persistiendo turno:", err)
    })

    // 4. Enviar reply final vía push (solo si hay reply real)
    if (reply) {
      const sent = await sendBotmakerMessage(contact, reply)
      if (!sent) {
        console.error(
          `[v3-bg] No se pudo enviar reply final a Botmaker para ${contact}`,
        )
      }
    } else {
      console.warn(`[v3-bg] Reply vacío para ${contact}, no se envía push`)
    }

    const pdfUrl = extractPdfUrl(result.toolCalls as ToolCallRecord[])
    console.log(
      `[v3-bg] DONE contact=${contact} iters=${result.iterations} tools=${result.toolCalls?.length || 0} pdf=${!!pdfUrl}`,
    )
  } catch (err) {
    console.error(`[v3-bg] Error procesando ${contact}:`, err)
    // Circuit-breaker (C): si los turnos anteriores ya fueron mensajes de error,
    // no repitas el mismo fallback en loop (en producción llegó a 60×). Tras 2
    // errores seguidos, escala a un humano UNA vez y luego silencia.
    try {
      const recientes = await fetchHistoryV3(contact, 6).catch(() => [])
      const esError = (t?: string) =>
        t === ERROR_FALLBACK_MSG || t === GENERIC_ERROR_MSG || t === ESCALADA_ERROR_MSG
      const ultimosAsistente = recientes
        .filter((m) => m.role === "assistant")
        .slice(-2)
        .map((m) => m.content?.trim())
      const dosErroresSeguidos =
        ultimosAsistente.length >= 2 && ultimosAsistente.every(esError)
      let errReply: string
      if (dosErroresSeguidos) {
        if (ultimosAsistente[ultimosAsistente.length - 1] === ESCALADA_ERROR_MSG) {
          console.error(
            `[v3-bg] CIRCUIT_BREAKER contact=${contact}: errores en loop, silenciando (ya se escaló).`,
          )
          return
        }
        errReply = ESCALADA_ERROR_MSG
      } else {
        errReply = ERROR_FALLBACK_MSG
      }
      // Persistimos el mensaje de error para que el próximo turno pueda detectar
      // el loop (antes no se persistía y el contador nunca avanzaba).
      await appendTurnV3(contact, message, errReply).catch(() => {})
      await sendBotmakerMessage(contact, errReply).catch(() => {})
    } catch {
      // No-op
    }
  } finally {
    // Apagar el "escribiendo..." al terminar: la respuesta de Vicky ya se
    // entregó (o se envió el mensaje de error), así el indicador no queda
    // colgado y no aparece después del mensaje de Vicky.
    sendTypingIndicator(contact, false).catch(() => {})
    // 5. Siempre liberar el lock
    await releaseLock(contact).catch(() => {})
  }
}

// ── Webhook entrypoint ────────────────────────────────────────────────
export async function POST(request: Request): Promise<NextResponse> {
  try {
    // 1. Validar secret
    const secret = request.headers.get("x-secret") || ""
    const expected = getEnv("BOTMAKER_SECRET")
    if (expected && secret !== expected) {
      return NextResponse.json(
        { reply: "Unauthorized" },
        { status: 401 },
      )
    }

    // 2. Validar body
    const body = (await request.json()) as BotmakerRequest
    const contact = normalizeContact(body.contact || "")
    const message = (body.message || "").trim()

    if (!contact || !message) {
      return NextResponse.json(
        { reply: "Error: contact y message son requeridos." },
        { status: 400 },
      )
    }

    // 3. Guardrails de input (largo + prompt injection)
    if (message.length > MAX_INPUT_CHARS || INJECT_RE.test(message)) {
      return NextResponse.json({
        reply: "El formato del mensaje no es válido.",
      })
    }

    // 4. Validar API key de Anthropic
    const apiKey = getEnv("ANTHROPIC_API_KEY")
    if (!apiKey) {
      console.error("[v3-botmaker] ANTHROPIC_API_KEY no configurada")
      return NextResponse.json({
        reply:
          "Servicio no disponible temporalmente. Intenta de nuevo en unos minutos.",
      })
    }

    // 5. Adquirir lock distribuido (Supabase)
    const messageHash = hashMessage(contact, message)
    const lockResult = await acquireLock(contact, messageHash)

    if (!lockResult.acquired) {
      if (lockResult.existingHash === messageHash) {
        console.log(
          `[v3-botmaker] Retry duplicado para ${contact}, ignorando (mismo hash)`,
        )
      } else {
        console.log(
          `[v3-botmaker] Mensaje nuevo durante procesamiento para ${contact}, ignorando (el anterior está en curso)`,
        )
      }
      // Respuesta vacía rápida. La primera request entrega vía push.
      return NextResponse.json({ reply: "" })
    }

    // 6. Typing indicator (fire-and-forget, antes del response)
    sendTypingIndicator(contact).catch(() => {})

    // 7. Disparar procesamiento en background con after()
    console.log(
      `[v3-botmaker] IN contact=${contact} msg=${JSON.stringify(message.slice(0, 60))}`,
    )
    after(processInBackground(contact, message, apiKey))

    // 8. Responder INMEDIATO a Botmaker
    // El reply real se entrega vía push cuando el background termina.
    return NextResponse.json({ reply: "" })
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err)
    console.error("[v3-botmaker] Error procesando request:", errMsg)
    return NextResponse.json({
      reply: GENERIC_ERROR_MSG,
    })
  }
}

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 204,
    headers: { Allow: "OPTIONS, POST" },
  })
}
