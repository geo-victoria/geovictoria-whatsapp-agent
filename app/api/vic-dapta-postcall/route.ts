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

import { NextResponse } from "next/server"
import {
  appendAssistantV3,
  getKvValue,
  getQuotePointer,
  setKvValue,
  setQuotePointer,
} from "@/lib/supabase-persistence-v3"
import { parseFechaRecontacto, scheduleCallback } from "@/lib/dapta-voice"
import { sendBotmakerMessage } from "@/lib/botmaker-push-v3"

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
  console.log(
    `[dapta-postcall] contact=${contact} estado=${estado || "?"} cambio=${cambio ? "sí" : "no"} dur=${duracionS}s`,
  )

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
    const pctExacto = Math.min(25, Math.ceil((1 - precioAcordado / montoOriginal) * 1000) / 10)
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
          totalClp: precioAcordado || prev?.totalClp || undefined,
          totalUf: prev?.totalUf ?? undefined,
        }).catch(() => {})
      }
      if (r?.ok && data?.ok && data.mensaje_para_prospecto) {
        const enviado = await sendBotmakerMessage(contact, data.mensaje_para_prospecto).catch(
          () => false,
        )
        if (enviado) {
          descuentoAplicado = true
          await appendAssistantV3(contact, data.mensaje_para_prospecto).catch(() => {})
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
        ? `PRECIO MENSUAL ACORDADO EN LA LLAMADA: $${precioAcordado} (ya autorizado — está dentro del descuento máximo del 25%; aplica con tus herramientas el descuento necesario para llegar EXACTAMENTE a ese valor, no lo renegocies)`
        : "",
    ]
      .filter(Boolean)
      .join("; ")
    const evento =
      `[EVENTO INTERNO — LLAMADA TELEFÓNICA RECIÉN TERMINADA (esto NO lo escribió el cliente)] ` +
      `Acabas de hablar por teléfono con este cliente y le PROMETISTE enviarle la cotización actualizada por WhatsApp. ` +
      `Lo comprometido: ${pedido || resumen || "ver registro de la llamada en el historial"}. ` +
      `Actúa AHORA: salúdalo en una línea haciendo referencia a la llamada ("como te prometí por teléfono..."), ` +
      `genera la cotización actualizada con tus herramientas y envíale el link. ` +
      `No le vuelvas a preguntar lo que ya confirmó en la llamada; si falta un dato imprescindible para cotizar, pídelo directo y corto.`
    const r = await fetch(`${SELF_BASE}/api/vic-botmaker-v3`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-secret": BOTMAKER_SECRET },
      body: JSON.stringify({ contact, message: evento }),
      cache: "no-store",
    }).catch(() => null)
    recotizacion = !!r?.ok
    console.log(`[dapta-postcall] recotización reinyectada contact=${contact} ok=${recotizacion}`)
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

  return NextResponse.json({
    ok: true,
    anotado: true,
    contact,
    estado: estado || null,
    recotizacion,
    callback_agendado: callbackAgendado,
  })
}
