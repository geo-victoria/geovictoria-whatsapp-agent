/**
 * LA REUNIÓN QUEDA ESCRITA EN ZOHO (29-ago, hallazgo del saneamiento).
 *
 * EL PROBLEMA: cuando Vicky agenda, la reunión existe en Cal.com y en el
 * calendario del anfitrión — y en ninguna otra parte. En el CRM no queda
 * evento, ni tarea, ni rastro. Quien abre el lead no tiene forma de saber que
 * hay una reunión, y quien no es el anfitrión no se entera nunca.
 *
 * LO QUE COSTÓ: José Pablo Gonzáles, cadena de restaurantes de 550 personas,
 * agendó a las 15:34 para las 16:40 del mismo día, confirmó asistencia y
 * esperó solo en la sala. Su lead era de otra persona, el correo de "nuevo
 * lead" fue a una tercera, y ninguna sabía de la reunión porque el CRM no la
 * conocía. Al día siguiente otro ejecutivo hizo el levantamiento por su cuenta
 * — 230 personas, piloto comprometido — y ESE tampoco quedó en Zoho.
 *
 * QUÉ ESCRIBE, todo colgado del lead:
 *   · un EVENTO con la hora real, el link y el anfitrión como dueño;
 *   · una TAREA para el anfitrión, vencida el día de la reunión;
 *   · una NOTA con los datos del prospecto y el link, para quien abra el lead.
 *
 * CÓMO NO ROMPE NADA (regla de Lalo): corre DESPUÉS de que la reserva ya está
 * confirmada y persistida, como paso adicional. Cada escritura es
 * independiente y best-effort: si Zoho no responde, la reunión existe igual,
 * el cliente ya recibió su invitación y nadie pierde nada. Nunca lanza.
 * Apagable sin deploy con VICKY_REUNION_EN_ZOHO=0.
 */

import { getZohoAccessToken } from "./zoho-token"

export type ReunionParaZoho = {
  leadId?: string
  contact: string
  prospectName?: string
  prospectEmail?: string
  startIso: string
  timezone?: string
  meetingUrl?: string
  organizerEmail?: string
  bookingUid?: string
}

export type ResultadoReunionZoho = {
  eventoId?: string
  tareaId?: string
  notaOk?: boolean
  omitido?: string
}

function activo(): boolean {
  return (process.env.VICKY_REUNION_EN_ZOHO || "").trim() !== "0"
}

/** Zoho quiere la hora local con offset; Cal entrega ISO en UTC. */
function horaZoho(iso: string, timezone?: string): string | null {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  try {
    const tz = timezone || "America/Santiago"
    const f = new Intl.DateTimeFormat("sv-SE", {
      timeZone: tz,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    })
    const local = f.format(new Date(t)).replace(" ", "T")
    // Offset real de ESA fecha en ESA zona (respeta cambios de horario).
    const utc = new Date(t)
    const comoLocal = new Date(local + "Z")
    const min = Math.round((comoLocal.getTime() - utc.getTime()) / 60000)
    const signo = min >= 0 ? "+" : "-"
    const abs = Math.abs(min)
    const hh = String(Math.floor(abs / 60)).padStart(2, "0")
    const mm = String(abs % 60).padStart(2, "0")
    return `${local}${signo}${hh}:${mm}`
  } catch {
    return null
  }
}

/** Resuelve el id de usuario Zoho del anfitrión por su correo. */
async function usuarioPorEmail(email: string, token: string, api: string): Promise<string> {
  if (!email) return ""
  try {
    const r = await fetch(`${api}/crm/v3/users?type=ActiveUsers`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      cache: "no-store",
    })
    if (r.status !== 200) return ""
    const users = ((await r.json().catch(() => ({}))) as {
      users?: Array<{ id?: string; email?: string }>
    }).users || []
    const u = users.find((x) => (x.email || "").toLowerCase() === email.toLowerCase())
    return String(u?.id || "")
  } catch {
    return ""
  }
}

/**
 * Deja la reunión escrita en el CRM. Best-effort puro: nunca lanza, y cada
 * pieza se intenta por separado para que el fallo de una no impida las otras.
 */
export async function escribirReunionEnZoho(r: ReunionParaZoho): Promise<ResultadoReunionZoho> {
  if (!activo()) return { omitido: "apagado por env" }
  if (!r.leadId || !r.startIso) return { omitido: "sin lead o sin hora" }
  const out: ResultadoReunionZoho = {}
  try {
    const token = await getZohoAccessToken()
    const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
    const H = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }

    const inicio = horaZoho(r.startIso, r.timezone)
    if (!inicio) return { omitido: "hora ilegible" }
    const fin = horaZoho(new Date(Date.parse(r.startIso) + 20 * 60_000).toISOString(), r.timezone)
    const dia = inicio.slice(0, 10)
    const quien = (r.prospectName || "").trim() || `+${r.contact}`
    const anfitrion = (r.organizerEmail || "").trim()
    const ownerId = anfitrion ? await usuarioPorEmail(anfitrion, token, api) : ""
    const duenoZoho = ownerId ? { Owner: { id: ownerId } } : {}

    // 1. EVENTO — lo que hacía falta para que la reunión sea visible.
    try {
      const ev = await fetch(`${api}/crm/v3/Events`, {
        method: "POST",
        headers: H,
        cache: "no-store",
        body: JSON.stringify({
          data: [{
            Event_Title: `Reunión con ${quien} (agendada por Vicky)`,
            Start_DateTime: inicio,
            End_DateTime: fin || inicio,
            What_Id: { id: r.leadId },
            $se_module: "Leads",
            Description:
              `Reunión agendada por Vicky desde WhatsApp.\n` +
              `Prospecto: ${quien}${r.prospectEmail ? ` · ${r.prospectEmail}` : ""}\n` +
              `WhatsApp: +${r.contact}\n` +
              (anfitrion ? `Anfitrión: ${anfitrion}\n` : "") +
              (r.meetingUrl ? `Link: ${r.meetingUrl}\n` : ""),
            ...duenoZoho,
          }],
          trigger: ["workflow", "blueprint"],
        }),
      })
      const d = (await ev.json().catch(() => ({}))) as { data?: Array<{ details?: { id?: string } }> }
      out.eventoId = String(d?.data?.[0]?.details?.id || "") || undefined
    } catch { /* el evento es lo más valioso, pero no bloquea el resto */ }

    // 2. TAREA para el anfitrión, vencida el día de la reunión.
    try {
      const tk = await fetch(`${api}/crm/v3/Tasks`, {
        method: "POST",
        headers: H,
        cache: "no-store",
        body: JSON.stringify({
          data: [{
            Subject: `Reunión con ${quien} — agendada por Vicky`,
            Due_Date: dia,
            Status: "No iniciado",
            Priority: "Alta",
            What_Id: { id: r.leadId },
            $se_module: "Leads",
            Description:
              `Reunión ${inicio.slice(0, 16).replace("T", " ")} (${r.timezone || "America/Santiago"}).\n` +
              `WhatsApp del prospecto: +${r.contact}` +
              (r.meetingUrl ? `\nLink: ${r.meetingUrl}` : ""),
            ...duenoZoho,
          }],
          trigger: ["workflow", "blueprint"],
        }),
      })
      const d = (await tk.json().catch(() => ({}))) as { data?: Array<{ details?: { id?: string } }> }
      out.tareaId = String(d?.data?.[0]?.details?.id || "") || undefined
    } catch { /* sin tarea, el evento y la nota igual quedan */ }

    // 3. NOTA — para quien abra el lead sin mirar el calendario.
    try {
      const nt = await fetch(`${api}/crm/v3/Notes`, {
        method: "POST",
        headers: H,
        cache: "no-store",
        body: JSON.stringify({
          data: [{
            Note_Title: `Reunión agendada por Vicky — ${inicio.slice(0, 16).replace("T", " ")}`,
            Note_Content:
              `El prospecto agendó una reunión desde WhatsApp.\n\n` +
              `Cuándo: ${inicio.slice(0, 16).replace("T", " ")} (${r.timezone || "America/Santiago"})\n` +
              `Con: ${anfitrion || "por asignar"}\n` +
              `Prospecto: ${quien}${r.prospectEmail ? ` · ${r.prospectEmail}` : ""}\n` +
              `WhatsApp: +${r.contact}\n` +
              (r.meetingUrl ? `Link: ${r.meetingUrl}\n` : "") +
              (r.bookingUid ? `\nReserva Cal: ${r.bookingUid}` : ""),
            Parent_Id: { id: r.leadId },
            se_module: "Leads",
          }],
        }),
      })
      out.notaOk = nt.ok
    } catch { /* la nota es la menos crítica */ }

    console.log(
      `[reunion-zoho] lead ${r.leadId}: evento=${out.eventoId || "-"} tarea=${out.tareaId || "-"} nota=${out.notaOk ? "ok" : "-"}`,
    )
    return out
  } catch (e) {
    console.warn("[reunion-zoho] falló:", e instanceof Error ? e.message : e)
    return { omitido: "excepción" }
  }
}
