/**
 * Endpoint POST /api/vic-meeting-reminders
 *
 * Recordatorios de reuniones por WhatsApp. Lo invoca pg_cron (Supabase) cada
 * minuto, igual que el cron de re-engagement. Cal.com NO puede gatillar esto
 * (sus webhooks no tienen trigger "antes del evento" y sus Workflows de
 * WhatsApp no son personalizables ni llaman a un webhook propio), así que el
 * timing lo orquestamos nosotros desde vic_v3_meetings.
 *
 * Flujo por tick:
 *   1. Auth contra el secret compartido en vic_kv (mismo que el followup cron).
 *   2. getDueMeetingReminders: reuniones con reminder_at vencido, aún no
 *      enviadas y futuras.
 *   3. Por cada una: claim ATÓMICO (claimMeetingReminder) para no duplicar entre
 *      ticks; si gana el claim, envía la plantilla HSM con [nombre, hora]. Si el
 *      envío falla, revierte el claim para reintentar en el próximo tick.
 *
 * Requiere la plantilla HSM aprobada (MEETING_REMINDER_TEMPLATE_NAME) y que el
 * pg_cron esté programado apuntando a este endpoint.
 */

import { NextResponse } from "next/server"
import {
  getDueMeetingReminders,
  claimMeetingReminder,
  unclaimMeetingReminder,
  getFollowupCronSecret,
  getContactCountry,
} from "@/lib/supabase-persistence-v3"
import { sendBotmakerTemplate } from "@/lib/botmaker-push-v3"
import { PERFIL_CO } from "@/lib/paises/co"

export const dynamic = "force-dynamic"
export const maxDuration = 60

// Nombre de la plantilla aprobada en Botmaker/Meta (ruleNameOrId).
const TEMPLATE_NAME = (process.env.MEETING_REMINDER_TEMPLATE_NAME || "recordatorio_reunion").trim()
// Colombia: por defecto REUTILIZA la plantilla chilena (WABA compartida,
// verificado 13-jul) pero sale por el canal CO. Si el equipo CO crea la suya
// (vicky_co_recordatorio_reunion), basta setear esta env.
const TEMPLATE_NAME_CO = (process.env.MEETING_REMINDER_TEMPLATE_NAME_CO || TEMPLATE_NAME).trim()
const CLAIM_BATCH = 20

export async function POST(req: Request) {
  const provided = (req.headers.get("x-cron-secret") || "").trim()
  const expected = await getFollowupCronSecret()
  if (!expected || provided !== expected) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }

  const due = await getDueMeetingReminders(CLAIM_BATCH)
  if (due.length === 0) {
    return NextResponse.json({ ok: true, sent: 0 })
  }

  let sent = 0
  for (const m of due) {
    // FILTROS (biblia F3, 12-ago — antes este cron no miraba NADA): contactos
    // internos de prueba y opt-outs no reciben el recordatorio. El claim se
    // toma igual para que la fila no se reintente cada 5 minutos.
    const { isTestContact, testContactSet } = await import("@/lib/funnel-analysis")
    if (isTestContact((m.contact || "").replace(/\D/g, ""), testContactSet())) {
      await claimMeetingReminder(m.booking_uid)
      continue
    }
    // País del contacto: define plantilla y canal (CO → línea +57).
    const country = await getContactCountry(m.contact).catch(() => "cl")
    const esCO = country === "co"
    // Claim atómico: solo el primer tick que lo tome envía.
    const claimed = await claimMeetingReminder(m.booking_uid)
    if (!claimed) continue

    const nombre = (m.prospect_name || "").trim().split(/\s+/)[0] || "hola"
    const hora = new Intl.DateTimeFormat("es-CL", {
      timeZone: m.timezone || "America/Santiago",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(m.start_at))

    const ok = await sendBotmakerTemplate(
      m.contact,
      esCO ? TEMPLATE_NAME_CO : TEMPLATE_NAME,
      { nombre, hora_reunion: hora },
      esCO ? PERFIL_CO.canal.channelId : undefined,
    ).catch(() => false)

    if (ok) {
      sent++
      // RASTRO EN EL HISTORIAL (biblia F3): antes el recordatorio era un envío
      // INVISIBLE — ni Vicky ni la maquinaria sabían que salió, y si el
      // cliente respondía "¿qué reunión?", el agente no tenía contexto.
      const { appendAssistantV3 } = await import("@/lib/supabase-persistence-v3")
      await appendAssistantV3(
        m.contact,
        `Te envié el recordatorio de tu reunión de hoy a las ${hora} 😊 Cualquier cambio de horario me avisas por aquí.`,
      ).catch(() => {})
    } else {
      // Revertir el claim para reintentar en el próximo tick.
      await unclaimMeetingReminder(m.booking_uid).catch(() => {})
    }
    console.log(
      `[meeting-reminders] uid=${m.booking_uid} contact=${m.contact} ok=${ok}`,
    )
  }

  return NextResponse.json({ ok: true, due: due.length, sent })
}
