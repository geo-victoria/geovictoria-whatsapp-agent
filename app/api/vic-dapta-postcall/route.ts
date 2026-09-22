/**
 * POST /api/vic-dapta-postcall — Retorno de llamadas de voz (Dapta → Vicky).
 *
 * Principio: la Vicky de WhatsApp y la Vicky de teléfono son LA MISMA Vicky.
 * Este endpoint es la mitad "al salir" de esa identidad compartida: cuando el
 * agente de voz de Dapta termina una llamada (dapta_webhook del agente apunta
 * acá), el resultado — estado, cambios pedidos a la cotización, resumen — se
 * anota en la MISMA conversación del contacto (vic_v3_messages), de modo que
 * el próximo turno de WhatsApp arranque sabiendo qué se habló por teléfono.
 *
 * La nota se persiste como mensaje del asistente con el marcador
 * [REGISTRO INTERNO — LLAMADA TELEFÓNICA], la convención de bloques internos
 * que el prompt ya usa (audio/imagen): contexto para Vicky, invisible para el
 * cliente (no se envía nada por Botmaker desde aquí).
 *
 * El payload exacto de Dapta se captura SIEMPRE en vic_kv
 * (debug_last_dapta_postcall) para iterar el parseo con datos reales — misma
 * técnica que debug_last_co_payload.
 *
 * Auth: ?secret=<vic_kv.dapta_postcall_secret> (Dapta no permite headers
 * custom en el webhook post-llamada, por eso va en la query, igual que los
 * x-api-key de los propios flujos de Dapta).
 */

import crypto from "crypto"
import { NextResponse } from "next/server"
import {
  appendAssistantV3,
  getKvValue,
  getLastUserAt,
  getQuotePointer,
  setKvValue,
  setQuotePointer,
} from "@/lib/supabase-persistence-v3"
import { cancelarCallbacksPendientes, existeCallbackAutoReciente, parseFechaRecontacto, scheduleCallback } from "@/lib/dapta-voice"
import { sendBotmakerMessage, sendBotmakerTemplate } from "@/lib/botmaker-push-v3"
import { PERFIL_CO } from "@/lib/paises/co"

const COTIZADORA_API_BASE = (
  process.env.COTIZADORA_API_BASE || "https://cotizacion.geovictoria.com"
).trim()
const VICKY_COTIZADORA_SECRET = (process.env.VICKY_COTIZADORA_SECRET || "").trim()

// URL propia (mismo deployment) para reinyectar el evento al pipeline de la
// Vicky de WhatsApp — mismo default que vic-outbound-poll.
const SELF_BASE = (
  process.env.OUTBOUND_SELF_URL ||
  "https://geovictoria-whatsapp-agent-git-vicky-v3-geo-victoria.vercel.app"
).trim().replace(/\/+$/, "")
const BOTMAKER_SECRET = (process.env.BOTMAKER_SECRET || "").trim()

// Plantillas Utility para entregar lo prometido en la llamada cuando la
// ventana de 24h de WhatsApp está CERRADA (caso real 20-jul: el post-llamada
// compuso el mensaje con el link y Botmaker lo descartó por ventana vencida).
// Patrón Marcela: plantilla corta que invita a responder — la respuesta abre
// la ventana y la Vicky de texto entrega el link con todo el contexto.
const TPL_POSTCALL = (process.env.POSTCALL_TEMPLATE || "vicky_cotizacion_actualizada_llamada").trim()
const TPL_POSTCALL_CO = (process.env.POSTCALL_TEMPLATE_CO || "vicky_co_cotizacion_actualizada_llamada").trim()
// La ventana real es 24h desde el último mensaje del cliente; margen de 30
// min para no apostar al borde.
const VENTANA_SEGURA_MS = 23.5 * 60 * 60 * 1000

async function ventanaAbierta(contact: string): Promise<boolean> {
  const last = await getLastUserAt(contact).catch(() => null)
  return !!last && Date.now() - last.getTime() < VENTANA_SEGURA_MS
}

/**
 * Envía la plantilla post-llamada por la línea del país del contacto. Diseño
 * final (Lalo, 20-jul, optimizado a tasa de cierre): al cliente que acordó un
 * precio por teléfono no se le pregunta nada ni se le hace buscar — la
 * plantilla informa el PRECIO FINAL aplicado (gancho comercial visible sin
 * abrir nada) y trae un botón de un tap a su cotización (URL dinámica de Meta
 * con el link corto firmado /q/<quoteId>-<hmac>; el token completo no cabe y
 * Meta prohíbe URLs por variable de cuerpo). Requiere precio APLICADO en el
 * sistema y quoteId → solo se usa cuando el descuento quedó comiteado.
 */
function codigoLinkCorto(quoteId: string): string {
  if (!quoteId || !VICKY_COTIZADORA_SECRET) return ""
  const hmac = crypto
    .createHmac("sha256", VICKY_COTIZADORA_SECRET)
    .update(quoteId)
    .digest("hex")
    .slice(0, 10)
  return `${quoteId}-${hmac}`
}

async function enviarPlantillaPostcall(
  contact: string,
  nombre: string,
  quoteId: string,
  precioFinalClp: number,
): Promise<boolean> {
  const codigo = codigoLinkCorto(quoteId)
  if (!codigo || !(precioFinalClp > 0)) return false
  const esCO = contact.startsWith("57")
  return sendBotmakerTemplate(
    contact,
    esCO ? TPL_POSTCALL_CO : TPL_POSTCALL,
    {
      nombre: nombre || "de nuevo",
      precio: precioFinalClp.toLocaleString("es-CL"),
      codigo,
    },
    esCO ? PERFIL_CO.canal.channelId : undefined,
  ).catch(() => false)
}

export const dynamic = "force-dynamic"
export const maxDuration = 30

type Dict = Record<string, unknown>

function asDict(v: unknown): Dict {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Dict) : {}
}

function firstString(...vals: unknown[]): string {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim()
  }
  return ""
}

/** Normaliza +56 9 4466 8823 / +56944668823 → 56944668823 (formato contact). */
function toContact(phone: string): string {
  return phone.replace(/[^\d]/g, "")
}

export async function POST(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const provided = (url.searchParams.get("secret") || "").trim()
  const expected = ((await getKvValue("dapta_postcall_secret").catch(() => "")) || "").trim()
  if (!expected || provided !== expected) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }

  const body = asDict(await req.json().catch(() => null))

  // Captura cruda para iterar el parseo con payloads reales.
  await setKvValue(
    "debug_last_dapta_postcall",
    JSON.stringify({ at: new Date().toISOString(), body }).slice(0, 8000),
  ).catch(() => {})

  // Dapta/Retell anidan el evento de formas distintas según la versión:
  // {call: {...}} | {data: {...}} | el objeto de la llamada directo.
  const call = { ...body, ...asDict(body.data), ...asDict(body.call) }

  const toNumber = firstString(call.to_number, call.toNumber, asDict(call.telephony_identifier).to_number)
  const contact = toContact(toNumber)
  if (!contact) {
    // Sin teléfono no hay conversación que anotar; el debug ya quedó guardado.
    return NextResponse.json({ ok: true, anotado: false, motivo: "payload sin to_number" })
  }

  const analysis = asDict(call.call_analysis)
  const custom = asDict(analysis.custom_analysis_data)
  const estado = firstString(custom.estado_seguimiento)
  const cambio = firstString(custom.cambio_cotizacion_solicitado)
  const precioAcordado = Number(custom.precio_acordado || 0) || 0
  const objecion = firstString(custom.objecion_detalle)
  const recontacto = firstString(custom.mejor_momento_recontacto)
  const resumen = firstString(custom.resumen_llamada, analysis.call_summary)
  const duracionS = Math.round(Number(call.duration_ms || 0) / 1000)
  const corte = firstString(call.disconnection_reason)

  const lineas = [
    "[REGISTRO INTERNO — LLAMADA TELEFÓNICA DE VICKY (el cliente NO ve este mensaje; úsalo como contexto: tú misma hiciste esta llamada)]",
    estado ? `Estado: ${estado}` : "",
    precioAcordado ? `Precio mensual ACORDADO en la llamada: $${precioAcordado}` : "",
    cambio ? `Cambio solicitado a la cotización: ${cambio}` : "",
    objecion ? `Objeción: ${objecion}` : "",
    recontacto ? `Mejor momento para recontactar: ${recontacto}` : "",
    resumen ? `Resumen: ${resumen}` : "",
    duracionS ? `Duración: ${duracionS}s${corte ? ` (fin: ${corte})` : ""}` : "",
  ].filter(Boolean)

  await appendAssistantV3(contact, lineas.join("\n"))

  // REGLA DE ORO (Lalo, 20-jul): "no me llamen más" es sagrado en TODOS los
  // canales. Candado determinista (no una nota para el modelo): flag durable
  // en vic_kv + cancelación de toda llamada ya agendada. Solo se levanta si el
  // cliente vuelve a pedir explícitamente que lo llamen.
  if (estado === "pidio_no_llamar") {
    await setKvValue(`voz_no_llamar_${contact}`, new Date().toISOString()).catch(() => {})
    await cancelarCallbacksPendientes(contact).catch(() => {})
    await appendAssistantV3(
      contact,
      "[REGISTRO INTERNO] El cliente pidió por teléfono que NO lo llamen más — candado activado: el sistema no volverá a llamarlo. Respetar SIEMPRE; WhatsApp sigue disponible solo si él escribe primero. El candado solo se levanta si él pide explícitamente una llamada.",
    ).catch(() => {})
  }
  console.log(
    `[dapta-postcall] contact=${contact} estado=${estado || "?"} cambio=${cambio ? "sí" : "no"} dur=${duracionS}s`,
  )

  // REGISTRO DE CAMPAÑA (Lalo 01-sep, "visualizar en el dash cuándo la
  // llamada tocó al usuario y si generó una venta"): el resultado se estampa
  // en la fila más reciente de vic_llamadas del contacto (la creó el disparo
  // manual de vic-admin-llamada). Best-effort — jamás bloquea el postcall.
  try {
    const supaUrl = (process.env.SUPABASE_URL || "").trim()
    const supaKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
    if (supaUrl && supaKey) {
      const H = { apikey: supaKey, Authorization: `Bearer ${supaKey}`, "Content-Type": "application/json" }
      const ult = await fetch(
        `${supaUrl}/rest/v1/vic_llamadas?contact=eq.${contact}&order=disparada_at.desc&limit=1&select=id`,
        { headers: H, cache: "no-store" },
      )
      const fila = ((await ult.json().catch(() => [])) as Array<{ id?: number }>)[0]
      if (fila?.id) {
        await fetch(`${supaUrl}/rest/v1/vic_llamadas?id=eq.${fila.id}`, {
          method: "PATCH",
          headers: H,
          body: JSON.stringify({
            resultado: estado || (duracionS > 0 ? "sin_estado" : "no_contesta"),
            resumen: (resumen || "").slice(0, 2000),
            resultado_at: new Date().toISOString(),
          }),
          cache: "no-store",
        })
      }
    }
  } catch { /* best-effort */ }

  // ── Acción 1: cumplir la promesa "te la mando por WhatsApp" ───────────────
  // Si el cliente pidió modificar la cotización, reinyectamos un EVENTO INTERNO
  // al pipeline normal de la Vicky de WhatsApp (mismo webhook que Botmaker):
  // así la cotización actualizada sale por el flujo real de cotización, con
  // ruteo de modelo, tools y guardrails anti-alucinación incluidos.
  // ── Acción 0 (determinista): descuento telefónico exacto ──────────────────
  // Precio acordado en la llamada + cotización formal real → el descuento se
  // comitea DIRECTO contra el cotizador (sin modelo de por medio): "lo acordado
  // por teléfono = lo aplicado", siempre. El mensaje al cliente sale con el
  // texto que devuelve el endpoint.
  const vars = asDict(call.dynamic_variables)
  const quoteId = firstString(vars.quote_id)
  const montoOriginal = Number(String(vars.monto_mensual || "").replace(/[^\d]/g, "")) || 0
  let descuentoAplicado = false
  if (precioAcordado > 0 && montoOriginal > 0 && quoteId && !/^TEST-/i.test(quoteId)) {
    // pct hacia ARRIBA con 1 decimal: el precio final nunca queda sobre lo prometido.
    const pctCrudo = Math.ceil((1 - precioAcordado / montoOriginal) * 1000) / 10
    const pctExacto = Math.min(25, pctCrudo)
    if (pctExacto > 0) {
      const r = await fetch(`${COTIZADORA_API_BASE}/api/quote-acceptance/aplicar-descuento-telefonico`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(VICKY_COTIZADORA_SECRET ? { "x-vicky-secret": VICKY_COTIZADORA_SECRET } : {}),
        },
        body: JSON.stringify({ quoteId, pctExacto }),
        cache: "no-store",
      }).catch(() => null)
      const data = (await r?.json().catch(() => null)) as {
        ok?: boolean
        mensaje_para_prospecto?: string
        acceptance_url?: string
        link_pdf?: string
      } | null
      // Puntero al día con el link regenerado (mismo fix que en agent-loop:
      // sin esto el guardrail bloquea reenvíos legítimos del link nuevo).
      if (r?.ok && data?.ok && data.acceptance_url) {
        const prev = await getQuotePointer(contact).catch(() => null)
        await setQuotePointer(contact, {
          quoteId,
          dealId: prev?.dealId || undefined,
          acceptanceUrl: data.acceptance_url,
          pdfUrl: data.link_pdf || prev?.pdfUrl || undefined,
          // totalClp es la BASE SIN DESCUENTO (monto_mensual de futuras
          // llamadas y base del cálculo de %). Guardar aquí el precio
          // prometido componía descuentos en la siguiente negociación
          // (bug detectado en la prueba del 20-jul).
          totalClp: prev?.totalClp || montoOriginal || undefined,
          totalUf: prev?.totalUf ?? undefined,
        }).catch(() => {})
      }
      if (r?.ok && data?.ok && data.mensaje_para_prospecto) {
        let msgProspecto = data.mensaje_para_prospecto
        // La voz aceptó bajo el piso (pct crudo > tope): el sistema aplicó el
        // tope y el precio final difiere de lo dicho en la llamada. Un buen
        // vendedor lo aclara al tiro, con transparencia — no deja que el
        // cliente lo descubra solo en la página.
        const precioFinalAplicado = Math.round(montoOriginal * (1 - pctExacto / 100))
        if (pctCrudo > 25) {
          msgProspecto +=
            `\n\nUn alcance de transparencia sobre lo que hablamos: el descuento máximo que tengo autorizado es ${pctExacto}%, ` +
            `así que el valor final quedó en $${precioFinalAplicado.toLocaleString("es-CL")} mensual, IVA incluido — ` +
            `levemente distinto del monto que alcanzamos a mencionar por teléfono. Si eso te cambia la decisión, me dices y lo conversamos 😊`
        }
        // Ventana de 24h ABIERTA → texto libre con el link, como siempre.
        // CERRADA (o el push falló igual) → plantilla Utility que ENTREGA:
        // precio final en el cuerpo + botón de un tap a su cotización.
        const abierta = await ventanaAbierta(contact)
        let enviado = abierta ? await sendBotmakerMessage(contact, msgProspecto).catch(() => false) : false
        if (enviado) {
          descuentoAplicado = true
          await appendAssistantV3(contact, msgProspecto).catch(() => {})
        } else {
          const porPlantilla = await enviarPlantillaPostcall(contact, firstString(vars.customer_name), quoteId, precioFinalAplicado)
          if (porPlantilla) {
            descuentoAplicado = true
            await appendAssistantV3(
              contact,
              `[REGISTRO INTERNO — no visible para el cliente] La ventana de 24h estaba cerrada: se le envió la plantilla post-llamada. ` +
                `Cuando el cliente responda, entrégale ESTE mensaje (es lo prometido en la llamada, cópialo tal cual): ${msgProspecto}`,
            ).catch(() => {})
          }
          console.log(
            `[dapta-postcall] ventana ${abierta ? "abierta pero push falló" : "cerrada"} contact=${contact} → plantilla=${porPlantilla}`,
          )
        }
      }
      console.log(
        `[dapta-postcall] descuento telefónico contact=${contact} quote=${quoteId} pct=${pctExacto} ok=${descuentoAplicado}`,
      )
    }
  }

  let recotizacion = false
  const debeRecotizar =
    !descuentoAplicado &&
    (cambio || estado === "pide_actualizar_cotizacion" || estado === "descuento_acordado" || precioAcordado > 0)
  if (debeRecotizar && BOTMAKER_SECRET) {
    const pedido = [
      cambio ? `cambio pedido: ${cambio}` : "",
      precioAcordado
        ? `PRECIO MENSUAL ACORDADO EN LA LLAMADA: $${precioAcordado} (aplica con tus herramientas el descuento necesario para llegar a ese valor; si tus descuentos autorizados no alcanzan EXACTAMENTE ese monto, aplica el máximo y explícale con transparencia el valor final — nunca prometas un precio que el sistema no registró)`
        : "",
    ]
      .filter(Boolean)
      .join("; ")
    const abierta = await ventanaAbierta(contact)
    if (!abierta) {
      // Ventana cerrada y SIN precio nuevo comiteado. La plantilla con el
      // precio VIGENTE de su cotización SÍ es honesta (aprendizaje tanda
      // 01-sep: Juan y Simon quedaron en deuda hasta el cumplimiento manual)
      // — se envía con el monto vigente y la nota interna guarda lo
      // comprometido para cuando el cliente responda.
      const montoVigente = Number(String(vars.monto_mensual || "").replace(/[^\d]/g, "")) || 0
      const plantillaOk =
        quoteId && montoVigente > 0
          ? await enviarPlantillaPostcall(contact, firstString(vars.customer_name), quoteId, montoVigente)
          : false
      await appendAssistantV3(
        contact,
        `[REGISTRO INTERNO — no visible para el cliente] Llamada recién terminada y ventana de 24h CERRADA` +
          (plantillaOk
            ? ` — se le envió la PLANTILLA con su cotización al precio vigente.`
            : ` (tampoco se pudo enviar plantilla).`) +
          ` En el PRÓXIMO contacto (respuesta del cliente o toque programado), cumple lo comprometido en la llamada SIN volver a preguntar lo ya confirmado: ${pedido || resumen || "ver registro de la llamada"}.`,
      ).catch(() => {})
      console.log(`[dapta-postcall] ventana cerrada sin precio aplicado contact=${contact} → plantilla=${plantillaOk}`)
    } else {
      const evento =
        `[EVENTO INTERNO — LLAMADA TELEFÓNICA RECIÉN TERMINADA (esto NO lo escribió el cliente)] ` +
        `Acabas de hablar por teléfono con este cliente y le PROMETISTE enviarle la cotización actualizada por WhatsApp. ` +
        `Lo comprometido: ${pedido || resumen || "ver registro de la llamada en el historial"}. ` +
        `Actúa AHORA: salúdalo en una línea haciendo referencia a la llamada ("como te prometí por teléfono..."), ` +
        `genera la cotización actualizada con tus herramientas y envíale el link. ` +
        `PROHIBIDO pedir confirmación o preguntar "¿me confirmas?": la confirmación YA OCURRIÓ por teléfono — la regla de ` +
        `"repite el cambio y espera confirmación" de actualizar_cotizacion NO aplica a este evento (caso real 01-sep: en vez de ` +
        `ejecutar, se le preguntó al cliente de nuevo y la promesa de la llamada quedó rota). Llama la tool EN ESTE MISMO TURNO. ` +
        `Solo si falta un dato imprescindible para cotizar, pídelo directo y corto.`
      const r = await fetch(`${SELF_BASE}/api/vic-botmaker-v3`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-secret": BOTMAKER_SECRET },
        body: JSON.stringify({ contact, message: evento }),
        cache: "no-store",
      }).catch(() => null)
      recotizacion = !!r?.ok
      console.log(`[dapta-postcall] recotización reinyectada contact=${contact} ok=${recotizacion}`)
    }
  }

  // ── Acción 2: agendar la llamada devuelta ──────────────────────────────────
  // Si pidió que lo llamen en otro momento, interpretamos el "cuándo" y la
  // dejamos en vic_scheduled_calls; vic-callback-cron la disparará a la hora.
  let callbackAgendado: string | null = null
  if (recontacto) {
    const dueAt = await parseFechaRecontacto(recontacto, new Date())
    if (dueAt) {
      const ok = await scheduleCallback(contact, dueAt, {
        phone_number: toNumber,
        customer_name: firstString(vars.customer_name),
        company: firstString(vars.company),
        monto_mensual: firstString(vars.monto_mensual),
        dias_desde_envio: firstString(vars.dias_desde_envio),
        quote_id: firstString(vars.quote_id),
        id_zoho: firstString(vars.id_zoho),
        motivo: `Llamada devuelta pedida por el cliente ("${recontacto}")`,
      })
      if (ok) {
        callbackAgendado = dueAt
        await appendAssistantV3(
          contact,
          `[REGISTRO INTERNO] Llamada devuelta agendada para ${new Date(dueAt).toLocaleString("es-CL", { timeZone: "America/Santiago" })} (pidió: "${recontacto}").`,
        ).catch(() => {})
      }
      console.log(`[dapta-postcall] callback contact=${contact} due=${dueAt} ok=${ok}`)
    } else {
      console.warn(`[dapta-postcall] recontacto no interpretable: "${recontacto}"`)
    }
  }

  // ── Reglas de continuidad (20-jul, debut de producción) ────────────────────
  // Una llamada nunca termina en callejón sin salida:
  //   - "pide_tiempo" sin hora parseable (caso Constanza: "después" y cortó
  //     antes de dar hora) → volver a llamar UNA HORA después (decisión Lalo:
  //     "después" significa más tarde hoy, no mañana). Si cae fuera de horario
  //     hábil, el cron de llamadas la retiene solo hasta la próxima ventana.
  //   - "no_contesta" → UN reintento al siguiente día hábil a las 15:00, en
  //     horario distinto al primer intento.
  // PIDE_TIEMPO → cotización a mano por plantilla (Lalo 01-sep, tras la tanda:
  // "quizás un reenvío del pdf y la url para que lo tengan a mano"). Con la
  // ventana cerrada, la plantilla con el precio vigente le deja el botón a su
  // cotización sin esperar el próximo toque. Best-effort, no toca el callback.
  if (estado === "pide_tiempo") {
    const quoteIdPT = firstString(vars.quote_id)
    const montoPT = Number(String(vars.monto_mensual || "").replace(/[^\d]/g, "")) || 0
    if (quoteIdPT && montoPT > 0 && !(await ventanaAbierta(contact))) {
      const ok = await enviarPlantillaPostcall(contact, firstString(vars.customer_name), quoteIdPT, montoPT)
      if (ok) {
        await appendAssistantV3(
          contact,
          `[REGISTRO INTERNO — no visible para el cliente] El cliente pidió tiempo en la llamada; se le dejó su cotización a mano por plantilla (precio vigente $${montoPT.toLocaleString("es-CL")}).`,
        ).catch(() => {})
      }
      console.log(`[dapta-postcall] pide_tiempo plantilla contact=${contact} ok=${ok}`)
    }
  }

  // Guarda anti-loop: máximo un auto-agendamiento de cada tipo por semana.
  if (!callbackAgendado && (estado === "pide_tiempo" || estado === "no_contesta")) {
    const esCO = contact.startsWith("57")
    const tipoAuto = estado === "pide_tiempo" ? "devolucion_pide_tiempo" : "reintento_no_contesta"
    const yaHubo = await existeCallbackAutoReciente(contact, tipoAuto).catch(() => true)
    if (!yaHubo) {
      const due = new Date()
      if (estado === "pide_tiempo") {
        due.setTime(due.getTime() + 60 * 60 * 1000)
      } else {
        // 15:00 locales del siguiente día hábil → UTC (CL invierno -4; CO -5).
        due.setUTCDate(due.getUTCDate() + 1)
        due.setUTCHours(esCO ? 20 : 19, 0, 0, 0)
        while ([0, 6].includes(due.getUTCDay())) due.setUTCDate(due.getUTCDate() + 1)
      }
      const motivoAuto =
        estado === "pide_tiempo"
          ? "El cliente pidió en la llamada anterior que lo llamaran después (sin dar hora) — devolución comprometida"
          : "Reintento único: la llamada anterior no logró conexión efectiva"
      const ok = await scheduleCallback(contact, due.toISOString(), {
        tipo: tipoAuto,
        phone_number: toNumber,
        customer_name: firstString(vars.customer_name),
        company: firstString(vars.company),
        monto_mensual: firstString(vars.monto_mensual),
        dias_desde_envio: firstString(vars.dias_desde_envio),
        quote_id: firstString(vars.quote_id),
        motivo: motivoAuto,
      }).catch(() => false)
      if (ok) {
        callbackAgendado = due.toISOString()
        await appendAssistantV3(
          contact,
          `[REGISTRO INTERNO] ${motivoAuto}. Llamada agendada para ${due.toLocaleString("es-CL", { timeZone: esCO ? "America/Bogota" : "America/Santiago" })}.`,
        ).catch(() => {})
      }
      console.log(`[dapta-postcall] continuidad ${tipoAuto} contact=${contact} due=${due.toISOString()} ok=${ok}`)
    } else {
      console.log(`[dapta-postcall] continuidad ${tipoAuto} contact=${contact} omitida (ya hubo una esta semana)`)
    }
  }

  return NextResponse.json({
    ok: true,
    anotado: true,
    contact,
    estado: estado || null,
    recotizacion,
    callback_agendado: callbackAgendado,
  })
}
