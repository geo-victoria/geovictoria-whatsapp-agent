/**
 * POST /api/vic-callback-cron — Dispara las llamadas devueltas agendadas.
 *
 * Cuando un cliente le dice a la Vicky de voz "llámame después", el
 * post-llamada (vic-dapta-postcall) interpreta el "cuándo" y agenda una fila
 * en vic_scheduled_calls. Este cron (pg_cron cada 10 min) reclama las
 * vencidas y re-invoca el flujo de Dapta ("Inicio llamado Seguimiento
 * Cotización Formal") con el mismo payload de la llamada original + el motivo,
 * para que Vicky llame a la hora comprometida.
 *
 * Ventana de cortesía: solo dispara entre 09:00 y 20:00 de Chile; una llamada
 * vencida fuera de ese rango espera al siguiente tick dentro del horario.
 *
 * Auth: x-cron-secret == vic_kv.followup_cron_secret.
 * URL del flujo Dapta: vic_kv.dapta_flow_seguimiento_webhook (incluye su
 * x-api-key en la query, igual que la usan los propios flujos de Dapta).
 */

import { NextResponse } from "next/server"
import { appendAssistantV3, getFollowupCronSecret, getKvValue } from "@/lib/supabase-persistence-v3"
import {
  claimDueCallbacks,
  clasificarConsentimiento,
  fetchUserRepliesSince,
  markCallbackDone,
} from "@/lib/dapta-voice"

export const dynamic = "force-dynamic"
export const maxDuration = 60

function horaChile(): number {
  return Number(
    new Intl.DateTimeFormat("es-CL", {
      timeZone: "America/Santiago",
      hour: "numeric",
      hour12: false,
    }).format(new Date()),
  )
}

export async function POST(req: Request): Promise<Response> {
  const provided = (req.headers.get("x-cron-secret") || "").trim()
  const expected = await getFollowupCronSecret().catch(() => "")
  if (!expected || provided !== expected) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }

  const hora = horaChile()
  if (hora < 9 || hora >= 20) {
    return NextResponse.json({ ok: true, disparadas: 0, motivo: "fuera de horario" })
  }

  const flowUrl = ((await getKvValue("dapta_flow_seguimiento_webhook").catch(() => "")) || "").trim()
  if (!flowUrl) {
    return NextResponse.json(
      { ok: false, error: "vic_kv.dapta_flow_seguimiento_webhook no configurada" },
      { status: 503 },
    )
  }

  const due = await claimDueCallbacks(5)
  let disparadas = 0
  const detalle: Array<Record<string, unknown>> = []
  for (const cb of due) {
    const payload = cb.payload || {}
    const motivo = String(payload.motivo || "Llamada devuelta agendada")

    // Gate de consentimiento (llamada hora-23): el anuncio "¿te parece si te
    // llamo?" salió a las 22h50. Si el cliente respondió, un "sí" explícito
    // dispara; un "no" se respeta SIEMPRE; cualquier otra respuesta también
    // frena la llamada (la Vicky de texto ya está conversando con él — llamar
    // encima sería invasivo). El silencio dispara.
    if (payload.tipo === "consent_call" && payload.announced_at) {
      const respuestas = await fetchUserRepliesSince(
        cb.contact,
        String(payload.announced_at),
      ).catch(() => [] as string[])
      if (respuestas.length > 0) {
        const veredicto = await clasificarConsentimiento(respuestas.join("\n"))
        if (veredicto !== "si") {
          await markCallbackDone(cb.id, veredicto === "no" ? "declined" : "skipped")
          if (veredicto === "no") {
            await appendAssistantV3(
              cb.contact,
              "[REGISTRO INTERNO] El cliente pidió que NO lo llamaran (respuesta al anuncio de las 22h50). Llamada cancelada — respetar: no volver a ofrecer llamada salvo que él lo pida.",
            ).catch(() => {})
          }
          detalle.push({ id: cb.id, contact: cb.contact, consentimiento: veredicto, ok: false })
          console.log(`[callback-cron] ${cb.contact} consentimiento=${veredicto} → NO se llama`)
          continue
        }
      }
    }
    // El encuadre de la apertura depende de POR QUÉ sale esta llamada.
    const contexto =
      payload.tipo === "consent_call"
        ? `${motivo}. Hace unos minutos le enviaste por WhatsApp "¿te parece si te llamo a tu celular y conversamos?" y no se negó (aceptó o no alcanzó a responder). Usa tu apertura estándar con naturalidad.`
        : `${motivo}. Esta llamada es la DEVOLUCIÓN comprometida: el cliente pidió que lo llamaras a esta hora, ` +
          `así que abre reconociéndolo ("hola, soy Vicky de GeoVictoria, quedamos en que te llamaba ahora...") en vez del saludo estándar.`
    const res = await fetch(flowUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, contexto }),
      cache: "no-store",
    }).catch(() => null)
    const ok = !!res?.ok
    await markCallbackDone(cb.id, ok ? "done" : "failed")
    if (ok) disparadas++
    detalle.push({ id: cb.id, contact: cb.contact, due_at: cb.due_at, ok })
    console.log(`[callback-cron] ${cb.contact} due=${cb.due_at} → ${ok ? "llamada disparada" : "FALLÓ"}`)
  }

  return NextResponse.json({ ok: true, pendientes: due.length, disparadas, detalle })
}
