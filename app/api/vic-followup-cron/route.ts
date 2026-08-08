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
 * Cadencia (definida en la migración vic_v3_claim_followups): 2 toques a 1h y
 * 23h desde que Vicky respondió, gateados a horario hábil en la zona del
 * contacto (Lun-Sáb 9-19 local, sin feriados; vic_is_business_now). Ambos caen
 * dentro de la ventana de 24h de WhatsApp, así que el envío va como texto libre
 * vía push de Botmaker sin fallar por re-engagement fuera de ventana (131047).
 * Los toques multi-día (47h/7d/15d) van por plantilla HSM en el cron de
 * reactivación. El seguimiento CONSENSUADO ("te escribo el lunes") apaga esta
 * cadencia y deja un único toque programado (ver programar-seguimiento).
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
  closeFollowup,
  getConversationCountries,
  getKvValue,
  getQuotePointer,
  getFormalQuote,
} from "@/lib/supabase-persistence-v3"
import { hasRecentCallActivity, scheduleCallback } from "@/lib/dapta-voice"
import { estadoCotizacionParaSeguimiento } from "@/lib/zoho-quote-status"
import { sendBotmakerMessage } from "@/lib/botmaker-push-v3"
import { PERFIL_CO } from "@/lib/paises/co"
import { PERFIL_MX } from "@/lib/paises/mx"
import { sanitizarVoseo, normalizarFormatoWhatsApp, quitarSignosApertura } from "@/lib/voseo-v3"

export const dynamic = "force-dynamic"
export const maxDuration = 60

// Lote por tick: 8 nudges × ~2-3s de generación cabe holgado en maxDuration.
// Al tráfico actual (~10-15 toques/hora peak) un tick rara vez trae más de 1-2.
const CLAIM_BATCH = 8

// Contactos internos con cadencia acelerada para probar el flujo completo
// cotización → anuncio → llamada (Eduardo y Rodrigo, 14-jul). Al terminar las
// pruebas: quitar de aquí Y revertir los offsets de vic_v3_claim_followups.
const CONTACTOS_PRUEBA_RAPIDA = new Set(["56944668823", "56978385048"])

// COMPUERTA DE PRODUCCIÓN del canal de voz (pedido Lalo 15-jul tras el debut
// no planificado con +56979057075): mientras sea true, el anuncio "¿te llamo?"
// y la llamada de la hora 23 SOLO corren para los contactos de prueba. Poner
// en false (o setear VOICE_CALLS_PRODUCTION=1 en Vercel) cuando el equipo dé
// el visto bueno para clientes reales.
const LLAMADAS_SOLO_PRUEBA = (process.env.VOICE_CALLS_PRODUCTION || "").trim() !== "1"

// Modelo chico y rápido: el nudge es UNA frase corta, no necesita el modelo
// del agente principal.
const NUDGE_MODEL = "claude-haiku-4-5-20251001"

// Tono según el tramo de la cadencia (1-3): ~1h, ~1 día, ~3 días.
function instruccionDeTono(stage: number): string {
  if (stage <= 1)
    return "Tono liviano y natural, como quien retoma una conversación que quedó al aire. NO suenes a recordatorio formal."
  if (stage === 2)
    return "Tono cálido y servicial: retoma el punto exacto donde quedaron y ofrece continuar, sin presionar. Si en la conversación YA le mostraste un estimado o una cotización y no avanzó, pregúntale con tacto qué fue lo que no le terminó de calzar (precio, alcance, equipos…) para entender y poder ajustarlo."
  return "Último toque: cierre cordial. Si hubo un estimado o cotización, pregúntale qué fue lo que no se ajustó a lo que necesitaba —para poder mejorarla— o si prefiere dejarlo para más adelante; si no hubo propuesta, pregunta si sigue interesado en cotizar. Deja la puerta abierta."
}

// Fallbacks deterministas si el LLM falla o el output viola el guardrail.
// Neutros a propósito: sirven igual para una cotización a medias que para una
// conversación que recién partía (un "hola" sin intención identificada aún).
function fallbackPorStage(stage: number, country: string): string {
  if (country === "mx") {
    if (stage <= 1) return "Sigues por aquí? 😊 Cualquier duda me dices y continuamos"
    if (stage === 2) return "Hola! Retomamos donde quedamos? Aquí sigo 😊"
    return "Hola! Sigues interesado en cotizar con nosotros o lo dejamos para más adelante? Lo que decidas está bien 🙌"
  }
  if (country === "co") {
    if (stage <= 1) return "Sigues por ahí? 😊 Aquí quedo atenta si quieres continuar"
    if (stage === 2) return "Hola!! Retomamos donde quedamos? Quedo atenta 😊"
    return "Hola! Sigues interesado en cotizar con nosotros o lo dejamos para más adelante? Cualquier cosa, aquí estoy 🙌"
  }
  if (stage <= 1) return "¿Todo bien? Te perdí 😅 Aquí sigo si quieres continuar."
  if (stage === 2) return "Hola! ¿Retomamos donde quedamos? Quedé atenta 😊"
  return "Hola! ¿Sigues interesado en cotizar con nosotros o lo dejamos para más adelante? Cualquier cosa, aquí estoy 😊"
}

// Identidad y registro del nudge por país. Chile: tuteo chileno (histórico).
// Colombia: registro de USTED y español neutro — mismas reglas duras del
// prompt CO (nada de chilenismos ni tuteo).
function identidadPorPais(country: string): string {
  if (country === "mx") {
    return (
      "Eres Vicky, ejecutiva comercial de GeoVictoria MÉXICO (control de asistencia B2B). " +
      "REGISTRO OBLIGATORIO: tuteo mexicano cálido y profesional (tú/tienes/puedes); JAMÁS voseo (vos/tenés) ni chilenismos ('al tiro', 'po') ni colombianismos. Cercanía natural, máximo 1 emoji. "
    )
  }
  if (country === "co") {
    return (
      "Eres Vicky, ejecutiva comercial de GeoVictoria COLOMBIA (control de asistencia B2B). " +
      "REGISTRO OBLIGATORIO (feedback equipo CO): TUTEO colombiano cálido y cercano (tú/tienes/puedes, 'te hace sentido?'); JAMÁS voseo (vos/tenés/podés) ni chilenismos ('al tiro', 'po', 'cachái'). Entusiasmo natural: puedes usar signos de admiración de cierre ('Genial!!') y 1 emoji. "
    )
  }
  return (
    "Eres Vicky, vendedora chilena de GeoVictoria (control de asistencia B2B). " +
    "REGLAS DURAS: español chileno con tuteo (tú/tienes/puedes; JAMÁS vos/tenés/podés). "
  )
}

// Guardrail determinista del nudge: el toque NUNCA lleva precios, porcentajes
// ni links (eso vive en las tools del agente, no en un push). Si el modelo se
// escapó, usamos el fallback del tramo.
// El modelo a veces, en lugar de un toque, devuelve una EXPLICACIÓN de por qué
// no debería contactar (típico cuando el historial trae un opt-out que no se
// cerró: "No puedo escribir un mensaje de reenganche porque el cliente pidió
// que no le hables más… podría considerarse acoso…"). Ese meta-texto JAMÁS debe
// enviarse: si aparece, se omite el envío y se cierra el ciclo (el modelo nos
// está avisando que no hay que seguir contactando).
function nudgeEsMetaORechazo(texto: string): boolean {
  if (!texto) return false
  return /no\s+puedo\s+(escribir|enviar|generar|mandar|contactar|seguir|hacer)|mensaje\s+de\s+reenganche|\breenganche\b|\bacoso\b|no\s+le\s+(hables|escribas|contactes)|respetar\s+(su|el|la)|estrategia\s+(correcta|adecuada)|violar[ií]a|considerarse|dejar\s+de\s+(enviar|contactar|escribir|molestar|mensajes)|el\s+cliente\s+(ha|solicit|pidi|no\s+quiere|dej)/i.test(
    texto,
  )
}

function nudgeEsSeguro(texto: string): boolean {
  if (!texto) return false
  if (texto.length > 400) return false
  if (/\d+\s*%|\$\s?\d|\bUF\b|https?:\/\//i.test(texto)) return false
  // El modelo a veces se dirige al cliente con un nombre inventado — incluso
  // "Vicky" (el suyo propio, bug real visto en test). En un nudge de 2 frases
  // Vicky nunca necesita decir su propio nombre: si aparece, va el fallback.
  if (/\bvicky\b/i.test(texto)) return false
  return true
}

// Frase FIJA del toque de seguimiento post-cotización (definición Lalo 20-jul,
// reemplaza al nudge libre del LLM cuando ya hay cotización formal enviada).
// El nombre se extrae del historial (Haiku, solo el nombre); sin nombre, la
// frase va igual sin él.
function fraseSeguimientoCotizacion(nombre: string): string {
  const saludo = nombre ? `Disculpa ${nombre}` : "Disculpa"
  return `${saludo}, has tenido tiempo de revisar la cotización, hay algo que te frene para confirmarla?`
}

async function nombreClienteDesdeTranscript(
  client: Anthropic,
  transcript: string,
): Promise<string> {
  try {
    const response = await client.messages.create({
      model: NUDGE_MODEL,
      max_tokens: 20,
      system:
        "De la conversación que te entregan, devuelve SOLO el primer nombre de pila del CLIENTE (la persona que habla con Vicky), tal como él mismo lo dijo o como Vicky lo saluda. Si el nombre no aparece en ninguna parte, devuelve exactamente NINGUNO. Sin explicación, sin puntuación.",
      messages: [{ role: "user", content: transcript }],
    })
    const block = response.content.find((b) => b.type === "text")
    const raw = block && block.type === "text" ? block.text.trim() : ""
    // Solo un nombre de pila plausible: una palabra, letras, ni "NINGUNO" ni "Vicky".
    if (!/^[A-Za-zÁÉÍÓÚÑáéíóúñ]{2,20}$/.test(raw)) return ""
    if (/^(ninguno|vicky)$/i.test(raw)) return ""
    return raw
  } catch {
    return ""
  }
}

async function generarNudge(
  apiKey: string,
  contact: string,
  stage: number,
  country: string,
): Promise<string> {
  const history = await fetchHistoryV3(contact, 14).catch(() => [])
  const transcript = history
    .map((m) => `${m.role === "user" ? "Cliente" : "Vicky"}: ${m.content}`)
    .join("\n")
    .slice(-4000)

  // Toque 1 con COTIZACIÓN FORMAL ya enviada → frase fija de seguimiento
  // (determinística; el LLM solo aporta el nombre del cliente).
  if (stage <= 1) {
    const formal = await getFormalQuote(contact).catch(() => "")
    if (formal) {
      const nombre = await nombreClienteDesdeTranscript(new Anthropic({ apiKey }), transcript)
      return fraseSeguimientoCotizacion(nombre)
    }
  }

  // ¿El precio que vio llevaba reloj? (preform con marcador "recurrente" que
  // menciona reloj). Si es así, el PRIMER toque no es un "¿sigues ahí?": es la
  // oferta de una configuración más económica SIN el arriendo, con los marcajes
  // gratis (app / cuadrilla). Decisión comercial de Rodrigo jul-2026: la fuga
  // dominante es silencio justo tras ver un precio inflado con reloj.
  const vioPrecioConReloj = history.some(
    (m) =>
      m.role === "assistant" && /recurrente/i.test(m.content || "") && /reloj/i.test(m.content || ""),
  )
  const anguloBarato =
    stage <= 1 && vioPrecioConReloj
      ? " ÁNGULO DE ESTE TOQUE (prioridad): el precio que vio llevaba reloj control (con costo de arriendo). Ofrécele en una frase que existe una alternativa más económica SIN el reloj, marcando gratis con la app —o con la app de cuadrilla, donde todo el equipo marca en una sola tablet o celular de la empresa— y pregúntale si quiere verla. SIN montos, SIN porcentajes y SIN links (eso viene después si responde). Ejemplo del espíritu: '{Nombre}, si el valor era el tema: hay una opción más económica sin el reloj, marcando gratis con la app (o todos en una sola tablet con la cuadrilla). ¿Te la muestro?'. NUNCA abras con 'Oye' (regla de Eduardo)."
      : ""

  const client = new Anthropic({ apiKey })
  const system =
    identidadPorPais(country) +
    "El cliente dejó de responder. Escribe UN solo mensaje corto de WhatsApp (máximo 2 frases) para reengancharlo, retomando el punto EXACTO donde quedó la conversación. " +
    "Si la conversación recién partía y casi no hay contexto (solo un saludo o una pregunta suelta), usa un toque breve y humano tipo '¿Sigues ahí?' (o '¿sigue por ahí?' si tratas de usted) — NO inventes un tema que no existió. " +
    instruccionDeTono(stage) +
    anguloBarato +
    " " +
    "PROHIBIDO: mencionar precios, montos, porcentajes, descuentos, UF o links; inventar información nueva; usar más de un emoji; dirigirte al cliente por un nombre que NO aparezca dicho por él en la conversación (y JAMÁS lo llames 'Vicky' — Vicky eres tú). ENFOQUE CONSULTIVO, NO COBRADOR: en vez de EXIGIR los datos que faltaban, prioriza una pregunta de baja presión que invite al cliente a decir qué lo frena o qué duda tiene ('te quedó alguna duda?', 'hay algo que te falte para avanzar?'). Si en el historial YA le enviaste la cotización formal, además puedes recordarle suave que su cotización está en este mismo WhatsApp y que puede aceptarla cuando quiera —SIN repetir el link ni el monto—. Si solo hubo un estimado/preform (aún sin cotización formal), NO digas eso: solo la pregunta consultiva. El objetivo es que RESPONDA y saque su objeción, no presionarlo con el trámite. " +
    "Devuelve SOLO el texto del mensaje, sin comillas ni explicación."

  const response = await client.messages.create({
    model: NUDGE_MODEL,
    max_tokens: 150,
    system,
    messages: [
      {
        role: "user",
        content: `Conversación hasta ahora:\n${transcript}\n\nEscribe el mensaje de reenganche (toque ${stage} de 3).`,
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
    {
      const { estamparLatido } = await import("@/lib/latido")
      void estamparLatido("followup").catch(() => undefined)
    }
    return NextResponse.json({ ok: true, sent: 0 })
  }

  // País por conversación: define el registro del nudge (CL tuteo / CO usted)
  // y el canal de Botmaker por el que sale (la línea del país del contacto).
  const paises = await getConversationCountries(claims.map((c) => c.conversation_id)).catch(
    () => ({}) as Record<string, string>,
  )

  // 3. Generar + enviar cada toque (secuencial: el lote es chico).
  let sent = 0
  for (const claim of claims) {
    const country = paises[claim.conversation_id] || "cl"
    const channelId =
      country === "co"
        ? PERFIL_CO.canal.channelId
        : country === "mx"
          ? PERFIL_MX.canal.channelId
          : undefined

    // Toque de las 22h50 para el segmento con COTIZACIÓN FORMAL: en
    // vez del nudge LLM, Vicky ANUNCIA su llamada y la agenda para 10 minutos
    // después (~23h), condicionada al consentimiento (diseño Lalo 14-jul):
    // vic-callback-cron revisa la respuesta antes de discar — un "no" se
    // respeta; silencio o un "sí" disparan la llamada. Multi-país (19-jul):
    // Colombia incluida — el callback-cron rutea +57 al flujo/agente/caller CO
    // (gPvLR, línea +57 318 107 0737) con horario hábil de Bogotá.
    const habilitadoParaLlamada =
      !LLAMADAS_SOLO_PRUEBA || CONTACTOS_PRUEBA_RAPIDA.has(claim.contact)
    if (claim.stage === 2 && (country === "cl" || country === "co") && habilitadoParaLlamada) {
      const qp = await getQuotePointer(claim.contact).catch(() => null)
      // Anti-loop: el WhatsApp post-llamada re-arma la cadencia (cada respuesta
      // de Vicky reinicia el reloj), y sin este guard el ciclo anunciaba y
      // llamaba de nuevo al mismo contacto una y otra vez (visto en las pruebas
      // del 14-jul). Máximo UNA llamada del canal de voz por contacto por día.
      const yaLlamado = qp ? await hasRecentCallActivity(claim.contact, 24).catch(() => false) : false
      // Y la cotización debe seguir ABIERTA en Zoho: un cliente que ya aceptó/
      // pagó puede re-armar su cadencia conversando post-venta (caso Carlos,
      // 15-jul) — a él jamás se le anuncia una llamada de venta.
      const estadoQ =
        qp && !yaLlamado
          ? await estadoCotizacionParaSeguimiento(qp.quoteId)
          : { abierta: false, pctComiteado: 0 }
      const abierta = estadoQ.abierta
      // REGLA DE ORO: con candado no-llamar no se anuncia ni se agenda llamada
      // — el contacto sigue solo con toques de texto.
      const candadoNoLlamar =
        qp && abierta
          ? ((await getKvValue(`voz_no_llamar_${claim.contact}`).catch(() => "")) || "").trim()
          : ""
      if (qp && !yaLlamado && abierta && !candadoNoLlamar) {
        const anuncio = "¿Te parece si te llamo a tu celular y conversamos? 😊"
        const okAnuncio = await sendBotmakerMessage(claim.contact, anuncio, channelId).catch(
          () => false,
        )
        // Anuncio (22h50) → llamada (~23h): 10 min de gap. Contactos de prueba
        // internos: 3 min, para validar el flujo completo sin esperar (14-jul).
        const gapMin = LLAMADAS_SOLO_PRUEBA && CONTACTOS_PRUEBA_RAPIDA.has(claim.contact) ? 3 : 10
        let agendada = false
        if (okAnuncio) {
          sent++
          await appendAssistantV3(claim.contact, anuncio).catch(() => {})
          agendada = await scheduleCallback(
            claim.contact,
            new Date(Date.now() + gapMin * 60 * 1000).toISOString(),
            {
              tipo: "consent_call",
              announced_at: new Date().toISOString(),
              phone_number: `+${claim.contact}`,
              customer_name: "",
              company: "",
              monto_mensual: qp.totalClp ? String(Math.round(qp.totalClp)) : "",
              dias_desde_envio: "1",
              quote_id: qp.quoteId || "",
              // Descuento YA acordado (WhatsApp o llamada previa): la voz debe
              // citar el precio VIGENTE, no el original. monto_mensual se
              // mantiene pre-descuento a propósito (es la base del cálculo de
              // % del post-llamada — no tocar su semántica).
              pct_comiteado: estadoQ.pctComiteado > 0 ? String(estadoQ.pctComiteado) : "",
              precio_vigente:
                estadoQ.pctComiteado > 0 && qp.totalClp
                  ? String(Math.round(qp.totalClp * (1 - estadoQ.pctComiteado / 100)))
                  : "",
              motivo: "Llamada hora-23 (anunciada por WhatsApp a las 22h50)",
            },
          ).catch(() => false)
        }
        await logFollowup({
          conversationId: claim.conversation_id,
          contact: claim.contact,
          stage: claim.stage,
          content: anuncio,
          ok: okAnuncio,
          error: okAnuncio
            ? agendada
              ? undefined
              : "anuncio enviado pero la llamada NO quedó agendada"
            : "push del anuncio falló",
        }).catch(() => {})
        console.log(
          `[followup-cron] anuncio de llamada contact=${claim.contact} anuncio=${okAnuncio} llamadaAgendada=${agendada}`,
        )
        continue
      }
    }

    let nudge = ""
    let errorMsg = ""
    try {
      nudge = await generarNudge(apiKey, claim.contact, claim.stage, country)
    } catch (err) {
      errorMsg = `generación falló: ${err instanceof Error ? err.message : String(err)}`
      console.error(`[followup-cron] ${errorMsg} (contact=${claim.contact})`)
    }
    // Si el modelo devolvió una explicación de por qué NO contactar (meta /
    // rechazo), no se envía NADA y se cierra el ciclo: nos está avisando que el
    // cliente no quiere más mensajes (típicamente un opt-out no detectado).
    if (nudgeEsMetaORechazo(nudge)) {
      console.warn(
        `[followup-cron] Nudge meta/rechazo detectado; se omite y cierra ciclo. contact=${claim.contact} nudge=${JSON.stringify(nudge.slice(0, 200))}`,
      )
      await closeFollowup(claim.contact, "modelo_declino").catch(() => {})
      await logFollowup({
        conversationId: claim.conversation_id,
        contact: claim.contact,
        stage: claim.stage,
        content: nudge,
        ok: false,
        error: "nudge meta/rechazo: omitido, ciclo cerrado",
      }).catch(() => {})
      continue
    }
    if (!nudgeEsSeguro(nudge)) {
      if (nudge) {
        console.warn(
          `[followup-cron] Nudge violó guardrail, usando fallback. contact=${claim.contact} nudge=${JSON.stringify(nudge.slice(0, 200))}`,
        )
      }
      nudge = fallbackPorStage(claim.stage, country)
    }
    nudge = quitarSignosApertura(normalizarFormatoWhatsApp(sanitizarVoseo(nudge)))

    const ok = await sendBotmakerMessage(claim.contact, nudge, channelId).catch(() => false)
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
      `[followup-cron] toque=${claim.stage}/3 contact=${claim.contact} ok=${ok}`,
    )
  }

  // Latido (Lalo 08-ago): tick exitoso queda estampado.
  {
    const { estamparLatido } = await import("@/lib/latido")
    void estamparLatido("followup").catch(() => undefined)

  }
  return NextResponse.json({ ok: true, claimed: claims.length, sent })
}
