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
  setKvValue,
} from "@/lib/supabase-persistence-v3"

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
  const objecion = firstString(custom.objecion_detalle)
  const recontacto = firstString(custom.mejor_momento_recontacto)
  const resumen = firstString(custom.resumen_llamada, analysis.call_summary)
  const duracionS = Math.round(Number(call.duration_ms || 0) / 1000)
  const corte = firstString(call.disconnection_reason)

  const lineas = [
    "[REGISTRO INTERNO — LLAMADA TELEFÓNICA DE VICKY (el cliente NO ve este mensaje; úsalo como contexto: tú misma hiciste esta llamada)]",
    estado ? `Estado: ${estado}` : "",
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

  return NextResponse.json({ ok: true, anotado: true, contact, estado: estado || null })
}
