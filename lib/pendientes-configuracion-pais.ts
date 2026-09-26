/**
 * PENDIENTES DE CONFIGURACIÓN POR PAÍS (26-sep, Lalo: "agreguemos en el correo a
 * Colombia y México lo pendiente de Cal.com — convirtámoslo en un correo de las
 * cosas pendientes por configurar del país").
 *
 * Por persona del equipo de la FICHA OPERATIVA revisa en vivo:
 *   - Espejo de WhatsApp: vic_kv wa_espejo_status_<sesión> = "conectado".
 *   - Calendario (Cal.com): tiene evento de seguimiento (eventoSeguimientoDe) y
 *     el host del evento es ELLA/ÉL (no un host interino).
 *   - Teléfono corporativo: en la ficha operativa o en su usuario de Zoho.
 * Lo que ya está listo no aparece; si una persona no tiene nada pendiente, no
 * recibe el correo.
 */
import { getKvValue } from "./supabase-persistence-v3"
import { equipoOperativo, fichaOperativa } from "./paises/ficha-operativa"
import { eventoSeguimientoDe } from "./eventos-seguimiento"

const CAL_API_KEY = (process.env.CAL_API_KEY || "").trim()
const CAL_TEAM_ID = (process.env.CAL_TEAM_ID || "91540").trim()
const BASE = (process.env.VICKY_AGENT_BASE_URL || "https://geovictoria-whatsapp-agent-git-vicky-v3-geo-victoria.vercel.app").replace(/\/$/, "")
const CC_FIJA = (process.env.VICKY_CORREO_ESPEJOS_CC || "rlewit@geovictoria.com")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean)

export type PendientePersona = {
  nombre: string
  email: string
  rol: string
  espejo: { pendiente: boolean; link: string; estado: string } | null
  calendario: { pendiente: boolean; motivo: string } | null
  telefono: { pendiente: boolean } | null
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

async function cal(path: string, version: string): Promise<unknown> {
  if (!CAL_API_KEY) return null
  const r = await fetch(`https://api.cal.com/v2${path}`, {
    headers: { Authorization: `Bearer ${CAL_API_KEY}`, "cal-api-version": version },
    cache: "no-store",
  }).catch(() => null)
  return r?.ok ? r.json().catch(() => null) : null
}

/** eventTypeId → correos de sus hosts (vía memberships del equipo). */
async function hostsPorEvento(): Promise<Map<string, string[]> | null> {
  const [evs, mem] = await Promise.all([
    cal(`/teams/${CAL_TEAM_ID}/event-types`, "2024-06-14") as Promise<{ data?: Array<{ id: number; hosts?: Array<{ userId: number }> }> } | null>,
    cal(`/teams/${CAL_TEAM_ID}/memberships`, "2024-08-13") as Promise<{ data?: Array<{ userId: number; user?: { email?: string } }> } | null>,
  ])
  if (!evs?.data || !mem?.data) return null
  const email = new Map(mem.data.map((m) => [m.userId, String(m.user?.email || "").toLowerCase()]))
  const out = new Map<string, string[]>()
  for (const e of evs.data) out.set(String(e.id), (e.hosts || []).map((h) => email.get(h.userId) || "").filter(Boolean))
  return out
}

async function telefonoZoho(zohoId: string): Promise<string> {
  if (!zohoId) return ""
  try {
    const { getZohoAccessToken } = await import("./zoho-token")
    const token = await getZohoAccessToken()
    const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
    const r = await fetch(`${api}/crm/v8/users/${zohoId}`, { headers: { Authorization: `Zoho-oauthtoken ${token}` }, cache: "no-store" })
    if (!r.ok) return ""
    const u = ((await r.json().catch(() => ({}))) as { users?: Array<{ phone?: string; mobile?: string }> }).users?.[0]
    return String(u?.phone || u?.mobile || "").trim()
  } catch {
    return ""
  }
}

export async function pendientesDelPais(pais: string): Promise<{
  pais: string
  nombrePais: string
  personas: PendientePersona[]
  to: string[]
  cc: string[]
  sinWorker: string[]
  calLeido: boolean
}> {
  const ficha = fichaOperativa(pais)
  const hosts = await hostsPorEvento()
  const personas: PendientePersona[] = []
  const sinWorker: string[] = []
  for (const p of equipoOperativo(pais)) {
    // Espejo: solo quien tiene sesión declarada (la gestora de venta autónoma no lleva).
    let espejo: PendientePersona["espejo"] = null
    if (p.sesion) {
      const st = String((await getKvValue(`wa_espejo_status_${p.sesion}`).catch(() => null)) || "")
      let estado = "sin_sesion_en_worker"
      try {
        if (st) estado = String((JSON.parse(st) as { estado?: string }).estado || "desconocido")
      } catch {
        /* ilegible */
      }
      if (estado === "sin_sesion_en_worker") sinWorker.push(p.sesion)
      const token = String((await getKvValue(`espejo_link_${p.sesion}`).catch(() => null)) || "")
      const link = token ? `${BASE}/api/vic-admin-wa-espejo?session=${encodeURIComponent(p.sesion)}&t=${encodeURIComponent(token)}` : ""
      espejo = { pendiente: estado !== "conectado", link, estado }
    }
    // Calendario: telemarketing siempre lo necesita (las reuniones siguen al dueño del trato);
    // SDR solo si ya tiene un evento asignado.
    let calendario: PendientePersona["calendario"] = null
    const evento = eventoSeguimientoDe(p.email)
    if (evento || p.rol === "telemarketing") {
      if (!evento) calendario = { pendiente: true, motivo: "sin_evento" }
      else if (hosts) {
        const h = hosts.get(evento) || []
        calendario = h.includes(p.email) ? { pendiente: false, motivo: "ok" } : { pendiente: true, motivo: "host_interino" }
      }
    }
    // Teléfono corporativo (sin él Vicky no puede presentar a la persona al cliente).
    const tel = p.telefono || (await telefonoZoho(p.zohoId))
    const telefono = { pendiente: !tel }
    if (espejo?.pendiente || calendario?.pendiente || telefono.pendiente) {
      personas.push({ nombre: p.nombre, email: p.email, rol: p.rol, espejo, calendario, telefono })
    }
  }
  const lideres = [ficha.equipo.lider, ficha.equipo.liderSdr].filter(Boolean).map((e) => String(e).toLowerCase())
  const to = personas.map((p) => p.email)
  const cc = Array.from(new Set([...lideres, ...CC_FIJA])).filter((e) => !to.includes(e))
  const nombrePais = { cl: "Chile", pe: "Perú", co: "Colombia", mx: "México" }[ficha.pais] || ficha.pais
  return { pais: ficha.pais, nombrePais, personas, to, cc, sinWorker, calLeido: Boolean(hosts) }
}

export function correoPendientes(d: Awaited<ReturnType<typeof pendientesDelPais>>, firma: string): { asunto: string; html: string } {
  const celda = (s: string) => `<td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;vertical-align:top">${s}</td>`
  const ok = `<span style="color:#15803d">✓ listo</span>`
  const na = `<span style="color:#9ca3af">—</span>`
  const filas = d.personas
    .map((p) => {
      const esp = !p.espejo
        ? na
        : !p.espejo.pendiente
          ? ok
          : p.espejo.link
            ? `<a href="${p.espejo.link}" style="color:#1d4ed8;font-weight:bold">Vincular (abrir mi QR)</a>`
            : "Pendiente (link en preparación)"
      const calTxt = !p.calendario
        ? na
        : !p.calendario.pendiente
          ? ok
          : p.calendario.motivo === "sin_evento"
            ? "Pendiente: crear tu cuenta en Cal.com y conectar tu calendario (te llegará la invitación)"
            : "Pendiente: acepta la invitación de Cal.com y conecta tu calendario de Outlook"
      const telTxt = p.telefono?.pendiente ? "Pendiente: se registra solo al vincular tu WhatsApp" : ok
      return `<tr>${celda(esc(p.nombre))}${celda(esp)}${celda(calTxt)}${celda(telTxt)}</tr>`
    })
    .join("")
  const asunto = `Vicky ${d.nombrePais}: lo que te falta configurar`
  const html =
    `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#1f2937;max-width:720px">` +
    `<p>Hola equipo 👋</p>` +
    `<p>Para que Vicky trabaje con ustedes en ${esc(d.nombrePais)} nos faltan algunas configuraciones. ` +
    `Abajo está lo pendiente de cada uno; lo que ya está listo aparece con ✓.</p>` +
    `<table style="border-collapse:collapse;margin:12px 0;border:1px solid #e5e7eb;font-size:13px">` +
    `<tr style="background:#f3f4f6"><th style="padding:8px 10px;text-align:left">Ejecutivo</th>` +
    `<th style="padding:8px 10px;text-align:left">WhatsApp (espejo)</th>` +
    `<th style="padding:8px 10px;text-align:left">Calendario (Cal.com)</th>` +
    `<th style="padding:8px 10px;text-align:left">Teléfono corporativo</th></tr>` +
    filas +
    `</table>` +
    `<p><strong>1. WhatsApp (espejo).</strong> Es como Samu, pero para WhatsApp: tus conversaciones y llamadas con clientes quedan ` +
    `como nota en el trato de Zoho, sin copiar nada. Así tu gestión cuenta (venta asistida) y Vicky no le escribe a un cliente que ya atendiste. ` +
    `Abre <strong>tu</strong> link en el computador → en el celular con tu WhatsApp corporativo: <em>Configuración → Dispositivos vinculados → ` +
    `Vincular un dispositivo</em> → escanea el QR. La página dirá "conectado".</p>` +
    `<p><strong>2. Calendario (Cal.com).</strong> Cuando un cliente pide reunión, Vicky la agenda en <strong>tu</strong> calendario ` +
    `con tu disponibilidad real. Acepta la invitación de Cal.com que te llegó por correo, entra y conecta tu calendario de Outlook ` +
    `(Configuración → Calendarios). Mientras no lo hagas, esas reuniones no quedan en tu agenda.</p>` +
    `<p><strong>3. Teléfono corporativo.</strong> Vicky te presenta al cliente con tu nombre y tu número. Se registra solo al ` +
    `vincular tu WhatsApp (paso 1).</p>` +
    `<p style="color:#6b7280;font-size:13px">Usa solo tu propio link: cada uno queda asociado a tu nombre y abre únicamente tu código QR ` +
    `(nadie ve tus chats desde ahí). Si el QR expira, recarga la página.</p>` +
    `<p>Cualquier duda, respondan este correo.<br>${esc(firma)}</p></div>`
  return { asunto, html }
}
