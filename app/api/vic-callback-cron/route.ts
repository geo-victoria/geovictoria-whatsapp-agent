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
import {
  appendAssistantV3,
  fetchHistoryV3,
  getFollowupCronSecret,
  getKvValue,
  setKvValue,
} from "@/lib/supabase-persistence-v3"
import {
  claimDueCallbacks,
  clasificarConsentimiento,
  fetchUserRepliesSince,
  markCallbackDone,
  unclaimCallback,
} from "@/lib/dapta-voice"
import { estadoCotizacionParaSeguimiento } from "@/lib/zoho-quote-status"
import { llamadaExisteEnDapta } from "@/lib/dapta-verify"
import { avisarEquipoInterno } from "@/lib/alerta-interna"
import { fetchDoneCallbacksRecientes } from "@/lib/dapta-voice"

export const dynamic = "force-dynamic"
export const maxDuration = 60

function horaEn(timeZone: string): number {
  return Number(
    new Intl.DateTimeFormat("es-CL", {
      timeZone,
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

  // BARRIDO ACELERADO (Lalo 10-ago): este cron es el de mayor frecuencia del
  // scheduler externo (~cada 2 min), así que además de lo suyo despacha los
  // jobs del despachador de huérfanos — incluidos loop y ptv con cadencia de
  // 2 minutos, para que toques y traspasos salgan pegados a su reloj y no
  // hasta 10 minutos tarde. ANTES del gate horario a propósito: los toques
  // del loop corren 9-21 TODOS los días (finde incluido) y las cadencias de
  // los huérfanos las gobierna cada cron, no este. Best-effort con timeout
  // interno: jamás atrasa ni tumba los callbacks.
  {
    const { despacharHuerfanos } = await import("@/lib/despachador-huerfanos")
    await despacharHuerfanos().catch(() => undefined)
  }

  // Horario hábil por PAÍS del contacto (multi-país, 17-jul): un +57 no se
  // llama en horario chileno — Bogotá va 1-2h detrás de Santiago. Y solo
  // días hábiles (19-jul, paridad con la regla Lunes-Viernes de los toques).
  const diaHabilEn = (timeZone: string): boolean => {
    const dia = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(new Date())
    return dia !== "Sat" && dia !== "Sun"
  }
  const horaCl = horaEn("America/Santiago")
  const horaCo = horaEn("America/Bogota")
  const horaMx = horaEn("America/Mexico_City")
  const clEnHorario = diaHabilEn("America/Santiago") && horaCl >= 9 && horaCl < 20
  const coEnHorario = diaHabilEn("America/Bogota") && horaCo >= 9 && horaCo < 19
  const mxEnHorario = diaHabilEn("America/Mexico_City") && horaMx >= 9 && horaMx < 19
  if (!clEnHorario && !coEnHorario && !mxEnHorario) {
    return NextResponse.json({ ok: true, disparadas: 0, motivo: "fuera de horario (CL, CO y MX)" })
  }

  const flowUrl = ((await getKvValue("dapta_flow_seguimiento_webhook").catch(() => "")) || "").trim()
  // Flujo CO propio (agente/línea +57 de Dapta). Opcional: sin él, los
  // callbacks a +57 quedan pendientes con log — NUNCA salen por el flujo CL
  // (saludo chileno + caller equivocado sería peor que esperar).
  const flowUrlCo = ((await getKvValue("dapta_flow_seguimiento_webhook_co").catch(() => "")) || "").trim()
  // Flujo MX (22-jul, agente eac2e39b "Victoria - Seguimiento - México" con la
  // voz Lupe): se activa SOLO seteando vic_kv.dapta_flow_seguimiento_webhook_mx
  // cuando exista el número +52 en Dapta — sin deploy. Mientras esté vacía,
  // los +52 siguen quedando pendientes con aviso (jamás salen por CL/CO).
  const flowUrlMx = ((await getKvValue("dapta_flow_seguimiento_webhook_mx").catch(() => "")) || "").trim()
  if (!flowUrl) {
    return NextResponse.json(
      { ok: false, error: "vic_kv.dapta_flow_seguimiento_webhook no configurada" },
      { status: 503 },
    )
  }

  // VERIFICACIÓN ANTI-FALSO-POSITIVO (caso Alejandro, 21-jul): el flujo de
  // Dapta responde 200 aunque la llamada nunca se cree (p. ej. agente sin
  // número de voz asignado). Cada corrida revisa las llamadas marcadas "done"
  // de las últimas 2h (con ≥10 min de gracia) contra la API de Dapta: si la
  // llamada NO existe, alerta interna al equipo. Una sola vez por fila (kv).
  const verificadas: Array<Record<string, unknown>> = []
  try {
    const recientes = await fetchDoneCallbacksRecientes(2)
    for (const cb of recientes) {
      const yaVerificada = await getKvValue(`llamada_verificada_${cb.id}`).catch(() => null)
      if (yaVerificada) continue
      const dueMs = Date.parse(cb.due_at)
      if (!Number.isFinite(dueMs) || Date.now() - dueMs < 10 * 60 * 1000) continue
      const phone = String((cb.payload || {}).phone_number || cb.contact || "")
      const veredicto = await llamadaExisteEnDapta(phone, cb.due_at)
      if (veredicto === "unknown") continue // sin PAT o API caída: reintenta la próxima corrida
      await setKvValue(`llamada_verificada_${cb.id}`, veredicto).catch(() => {})
      verificadas.push({ id: cb.id, contact: cb.contact, veredicto })
      if (veredicto === "no_encontrada") {
        console.error(`[callback-cron] llamada ${cb.id} (${cb.contact}) marcada disparada pero NO existe en Dapta`)
        await avisarEquipoInterno(
          `⚠️ Llamada de voz FANTASMA — el flujo de Dapta aceptó la llamada a +${cb.contact} (${cb.due_at}) pero nunca se creó. Revisar el agente/canal en Dapta (¿número de voz asignado?).`,
        )
      }
    }
  } catch (e) {
    console.error("[callback-cron] verificación anti-falso-positivo falló:", e)
  }

  const due = await claimDueCallbacks(5)
  let disparadas = 0
  const detalle: Array<Record<string, unknown>> = []
  for (const cb of due) {
    const payload = cb.payload || {}
    const motivo = String(payload.motivo || "Llamada devuelta agendada")

    // REGLA DE ORO: si el cliente pidió que no lo llamen más (candado
    // voz_no_llamar), NINGUNA llamada agendada se dispara, venga de donde
    // venga. Se marca declined y se respeta para siempre.
    const candadoNoLlamar = ((await getKvValue(`voz_no_llamar_${cb.contact}`).catch(() => "")) || "").trim()
    if (candadoNoLlamar) {
      await markCallbackDone(cb.id, "declined")
      detalle.push({ id: cb.id, contact: cb.contact, cancelada: "candado no-llamar" })
      console.log(`[callback-cron] ${cb.contact} tiene candado no-llamar → llamada cancelada`)
      continue
    }

    // País por prefijo: define flujo/agente/línea de salida y horario hábil.
    // CL (+56) y CO (+57) tienen canal de voz; MX (+52) lo tiene cuando el
    // flujo MX esté configurado en vic_kv. Cualquier otro prefijo queda
    // pendiente con log — JAMÁS se disca por el flujo de otro país.
    const esCL = cb.contact.startsWith("56")
    const esCO = cb.contact.startsWith("57")
    const esMX =
      cb.contact.startsWith("521") || (cb.contact.startsWith("52") && cb.contact.length === 12)
    if (!esCL && !esCO && !esMX) {
      unclaimCallback(cb.id).catch(() => {})
      console.warn(`[callback-cron] ${cb.contact}: sin canal de voz para su país — llamada pendiente (no se disca por flujo CL/CO/MX).`)
      detalle.push({ id: cb.id, contact: cb.contact, due_at: cb.due_at, ok: false, motivo: "sin_canal_voz_pais" })
      continue
    }
    if ((esCO && !coEnHorario) || (esMX && !mxEnHorario) || (esCL && !clEnHorario)) {
      await unclaimCallback(cb.id)
      detalle.push({ id: cb.id, contact: cb.contact, esperando: "horario hábil del país" })
      continue
    }
    if (esCO && !flowUrlCo) {
      await unclaimCallback(cb.id)
      console.warn(
        `[callback-cron] ${cb.contact} es CO y vic_kv.dapta_flow_seguimiento_webhook_co no está configurada — queda pendiente (no se llama por el flujo CL).`,
      )
      detalle.push({ id: cb.id, contact: cb.contact, esperando: "flujo Dapta CO" })
      continue
    }
    if (esMX && !flowUrlMx) {
      await unclaimCallback(cb.id)
      console.warn(
        `[callback-cron] ${cb.contact} es MX y vic_kv.dapta_flow_seguimiento_webhook_mx no está configurada — queda pendiente (falta el número +52 en Dapta).`,
      )
      detalle.push({ id: cb.id, contact: cb.contact, esperando: "flujo Dapta MX" })
      continue
    }

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
            // Candado durable: el "no" al anuncio también es "no me llamen".
            await setKvValue(`voz_no_llamar_${cb.contact}`, new Date().toISOString()).catch(() => {})
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
    const base =
      payload.tipo === "consent_call"
        ? `${motivo}. Hace unos minutos le enviaste por WhatsApp "¿te parece si te llamo a tu celular y conversamos?" y no se negó (aceptó o no alcanzó a responder). Usa tu apertura estándar con naturalidad.`
        : payload.tipo === "loop_v2"
          ? // Toque de llamada del loop (25-jul): PROACTIVA — el cliente NO
            // pidió esta llamada; JAMÁS decir "quedamos en que te llamaba".
            `${motivo}. Esta llamada es PROACTIVA: el cliente dejó una solicitud de cotización y quedó a medio camino — ` +
            `NUNCA digas que él pidió esta llamada. Apertura corta y natural: "hola, soy Vicky de GeoVictoria, ¿tienes 2 minutos?", ` +
            `y retoma su cotización buscando el siguiente paso según la conversación (datos que faltan, el RUT para la formal, o ayudarle con el pago). ` +
            `Si dice que no puede ahora, agradece y despídete corta — sin insistir.`
          : `${motivo}. Esta llamada es la DEVOLUCIÓN comprometida: el cliente pidió que lo llamaras a esta hora, ` +
            `así que abre reconociéndolo ("hola, soy Vicky de GeoVictoria, quedamos en que te llamaba ahora...") en vez del saludo estándar.`

    // Memoria de la ejecutiva (principio 20-jul): la Vicky de voz es LA MISMA
    // ejecutiva que la de WhatsApp — un humano con memoria sana no cita el
    // precio viejo ni olvida el descuento que ya dio, así que la llamada sale
    // con el estado comercial y los últimos mensajes inyectados como DATO (no
    // depende de que el modelo "recuerde").
    let memoria = ""
    // El estado se consulta FRESCO al momento de marcar (no el de cuando se
    // agendó): entre el anuncio y una devolución de "llámame mañana" el
    // cliente pudo negociar más descuento por WhatsApp. Fallback: lo agendado.
    let pctComiteado = Number(payload.pct_comiteado || 0) || 0
    let precioVigente = String(payload.precio_vigente || "").trim()
    const quoteIdPayload = String(payload.quote_id || "").trim()
    const montoOriginal = Number(String(payload.monto_mensual || "").replace(/[^\d]/g, "")) || 0
    if (quoteIdPayload && montoOriginal > 0) {
      const fresco = await estadoCotizacionParaSeguimiento(quoteIdPayload).catch(() => null)
      if (fresco && fresco.pctComiteado > 0) {
        pctComiteado = fresco.pctComiteado
        precioVigente = String(Math.round(montoOriginal * (1 - fresco.pctComiteado / 100)))
      }
    }
    if (pctComiteado > 0 && precioVigente) {
      memoria +=
        ` ESTADO COMERCIAL VIGENTE: este cliente YA tiene un ${pctComiteado}% de descuento acordado — ` +
        `su precio vigente es ${precioVigente} pesos mensuales, IVA incluido. Cita SIEMPRE ese precio ` +
        `vigente como el valor de su cotización (NUNCA el monto original sin descuento) y cualquier ` +
        `negociación parte de ahí hacia abajo. Jamás le digas un precio mayor al vigente.`
    }
    const historial = await fetchHistoryV3(cb.contact, 12).catch(() => [])
    if (historial.length > 0) {
      const ultimos = historial
        .slice(-10)
        .map((m) => `${m.role === "user" ? "Cliente" : "Vicky"}: ${String(m.content).replace(/\s+/g, " ").slice(0, 160)}`)
        .join(" || ")
      memoria += ` ÚLTIMOS MENSAJES DE LA CONVERSACIÓN DE WHATSAPP (tu propia memoria — úsala con naturalidad y no contradigas nada de lo ya acordado): ${ultimos}`
    }
    const contexto = base + memoria
    const res = await fetch(esMX ? flowUrlMx : esCO ? flowUrlCo : flowUrl, {
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

  return NextResponse.json({ ok: true, pendientes: due.length, disparadas, detalle, verificadas })
}
