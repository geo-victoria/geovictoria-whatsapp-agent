import { NextResponse } from "next/server"
import { getFollowupCronSecret, getKvValue, setKvValue, getLastUserAt, appendAssistantV3 } from "@/lib/supabase-persistence-v3"
import { claveAltaSolicitada, claveCapacitacion, claveConfiguracion, claveBorrador } from "@/lib/onboarding/fase"
import { avisarEquipoInterno } from "@/lib/alerta-interna"
import { testContactSet } from "@/lib/funnel-analysis"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

/**
 * VIGÍA DEL ONBOARDING POR CHAT (punto 8 de la lista de publicación, Lalo
 * 05-sep): el cliente que paga y se queda callado no recibía nada más. Vicky
 * solo reaccionaba a lo que él escribiera, y la única red era que el relator
 * viera la Implementación sin Curso 1 en Zoho. Caso real del día: Maquinarias
 * Santa Sara aceptó cargar la nómina, no la mandó y nadie le ofreció la
 * capacitación hasta que se hizo a mano.
 *
 * Tres reglas, cada una UNA sola vez por contacto (candados vic_kv):
 *   1. Pagó y no completó el alta: a las 2 h de silencio, toque de Vicky
 *      retomando el alta; a las 24 h, aviso interno.
 *   2. Alta creada y sin capacitación agendada: al día hábil siguiente (24 h
 *      sin contar fines de semana), Vicky vuelve a ofrecer los cupos; a los
 *      tres días hábiles sin agendar, aviso al
 *      relator (por el canal interno, con el número de implementación).
 *   3. Capacitación mañana y sin nómina cargada: recordatorio de traer la
 *      lista, el día anterior.
 *
 * Reglas de envío: solo entre 9 y 20 h de Chile; nunca si el cliente
 * escribió hace menos de 2 h (está conversando, Vicky ya lo atiende); y
 * solo con la ventana de WhatsApp abierta (<23 h desde su último mensaje) —
 * fuera de ventana el texto libre muere, así que ahí solo sale el aviso
 * interno y el toque queda para cuando el cliente vuelva a escribir. Los
 * probadores internos (testContactSet) quedan fuera. Despachado por
 * JOBS_HUERFANOS cada 30 min. `?dry=1` lista candidatos sin enviar nada.
 */

const CRON_SECRET = (process.env.CRON_SECRET || "").trim()
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
const H = () => ({ apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` })

const HORA = 60 * 60 * 1000
const SILENCIO_MIN_MS = 2 * HORA
const VENTANA_WA_MS = 23 * HORA

async function autorizado(req: Request): Promise<boolean> {
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim()
  if (CRON_SECRET && bearer === CRON_SECRET) return true
  const key = (new URL(req.url).searchParams.get("key") || "").trim()
  if (CRON_SECRET && key === CRON_SECRET) return true
  if (key) {
    const kvSecret = await getFollowupCronSecret().catch(() => "")
    if (kvSecret && key === kvSecret) return true
  }
  return false
}

/** Hora local de Chile (0-23) y día de la semana (0 dom … 6 sáb) de una fecha. */
function enChile(d: Date): { hora: number; dia: number; fecha: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Santiago",
    hour: "numeric",
    hour12: false,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d)
  const get = (t: string) => parts.find((p) => p.type === t)?.value || ""
  const dias: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  return { hora: Number(get("hour")) % 24, dia: dias[get("weekday")] ?? 0, fecha: `${get("year")}-${get("month")}-${get("day")}` }
}

/** Horas transcurridas desde `desde` descontando sábados y domingos (Chile):
 *  24 = un día hábil completo, 72 = tres. Un alta del sábado cuenta desde el lunes. */
function horasHabilesDesde(desde: Date, hasta = new Date()): number {
  let n = 0
  const cursor = new Date(desde.getTime())
  // Paso de 1 hora; suficiente para umbrales de 24/72 h.
  while (cursor.getTime() + HORA <= hasta.getTime()) {
    const c = enChile(cursor)
    if (c.dia >= 1 && c.dia <= 5) n++
    cursor.setTime(cursor.getTime() + HORA)
  }
  return n
}

/** "martes, 8 de septiembre a las 08:30 AM" → fecha YYYY-MM-DD (año actual o siguiente). */
function fechaDeCuando(cuando: string, ahora = new Date()): string | null {
  const m = /(\d{1,2})\s+de\s+([a-záéíóú]+)/i.exec(cuando || "")
  if (!m) return null
  const meses = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"]
  const mes = meses.indexOf(m[2].toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace("setiembre", "septiembre"))
  if (mes < 0) return null
  const hoy = enChile(ahora)
  let anio = Number(hoy.fecha.slice(0, 4))
  const dia = Number(m[1])
  const md = `${String(mes + 1).padStart(2, "0")}-${String(dia).padStart(2, "0")}`
  if (md < hoy.fecha.slice(5)) anio += 1 // ya pasó este año → es del próximo
  return `${anio}-${md}`
}

function manana(ahora = new Date()): string {
  return enChile(new Date(ahora.getTime() + 24 * HORA)).fecha
}

type Candidato = {
  contact: string
  regla: "alta_pendiente" | "capacitacion_pendiente" | "nomina_pre_capacitacion"
  accion: "toque" | "aviso" | "sin_ventana" | "fuera_horario" | "dry"
  detalle?: string
}

async function contactosEnOnboarding(): Promise<string[]> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return []
  const filas = (await fetch(
    `${SUPABASE_URL}/rest/v1/vic_kv?key=like.fase_vicky_*&value=eq.onboarding&select=key&limit=300`,
    { headers: H(), cache: "no-store" },
  )
    .then((r) => (r.ok ? r.json() : []))
    .catch(() => [])) as Array<{ key: string }>
  return filas.map((f) => f.key.replace(/^fase_vicky_/, "")).filter((c) => /^569\d{8}$/.test(c))
}

async function enviarToque(contact: string, texto: string): Promise<boolean> {
  const { sendBotmakerMessage } = await import("@/lib/botmaker-push-v3")
  const ok = await sendBotmakerMessage(contact, texto).catch(() => false)
  if (ok) await appendAssistantV3(contact, texto, "cl").catch(() => {})
  return ok
}

export async function GET(req: Request): Promise<Response> {
  if (!(await autorizado(req))) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  const dry = new URL(req.url).searchParams.get("dry") === "1"
  const ahora = new Date()
  const cl = enChile(ahora)
  const enHorario = cl.hora >= 9 && cl.hora < 20
  const internos = testContactSet()
  const contactos = await contactosEnOnboarding()
  const candidatos: Candidato[] = []
  let toques = 0
  let avisos = 0

  for (const contact of contactos) {
    if (internos.has(contact)) continue
    try {
      const [altaRaw, capRaw, cfgRaw, borradorRaw, ultimo] = await Promise.all([
        getKvValue(claveAltaSolicitada(contact)).catch(() => null),
        getKvValue(claveCapacitacion(contact)).catch(() => null),
        getKvValue(claveConfiguracion(contact)).catch(() => null),
        getKvValue(claveBorrador(contact)).catch(() => null),
        getLastUserAt(contact).catch(() => null),
      ])
      const silencioMs = ultimo ? ahora.getTime() - ultimo.getTime() : Number.POSITIVE_INFINITY
      const ventanaAbierta = !!ultimo && silencioMs < VENTANA_WA_MS
      const conversando = silencioMs < SILENCIO_MIN_MS
      let cap: { bookingId?: string; cuando?: string; numero?: string; relator?: { nombre?: string } } = {}
      try { cap = capRaw ? (JSON.parse(capRaw) as typeof cap) : {} } catch { cap = {} }
      let altaAt: Date | null = null
      if (altaRaw) {
        try {
          const j = JSON.parse(altaRaw) as { at?: string }
          altaAt = new Date(j.at || altaRaw)
        } catch {
          altaAt = new Date(altaRaw)
        }
        if (Number.isNaN(altaAt.getTime())) altaAt = null
      }
      let trabajadores = 0
      try { trabajadores = cfgRaw ? (JSON.parse(cfgRaw) as { trabajadores?: unknown[] }).trabajadores?.length || 0 : 0 } catch { trabajadores = 0 }
      let nombre = ""
      try { nombre = borradorRaw ? String((JSON.parse(borradorRaw) as { admin?: { nombre?: string } }).admin?.nombre || "").trim().split(/\s+/)[0] : "" } catch { nombre = "" }
      const saludo = nombre ? `${nombre}, ` : ""
      const relator = cap.relator?.nombre || "tu relator"

      const disparar = async (regla: Candidato["regla"], claveToque: string, texto: string) => {
        if (await getKvValue(claveToque).catch(() => null)) return
        if (conversando) return
        if (dry) { candidatos.push({ contact, regla, accion: "dry", detalle: texto.slice(0, 80) }); return }
        if (!enHorario) { candidatos.push({ contact, regla, accion: "fuera_horario" }); return }
        if (!ventanaAbierta) {
          // Fuera de ventana el texto libre no llega; el aviso interno sale
          // igual (una vez) y el toque queda para cuando el cliente escriba.
          const claveAvisoV = `${claveToque}_sin_ventana`
          if (!(await getKvValue(claveAvisoV).catch(() => null))) {
            await avisarEquipoInterno(`⏳ ONBOARDING sin avance (${regla.replace(/_/g, " ")}) — +${contact}${cap.numero ? ` · ${cap.numero}` : ""}. La ventana de WhatsApp está cerrada: Vicky no puede escribirle hasta que él escriba. Relator: ${relator}.`).catch(() => false)
            await setKvValue(claveAvisoV, ahora.toISOString()).catch(() => {})
            avisos++
          }
          candidatos.push({ contact, regla, accion: "sin_ventana" })
          return
        }
        const ok = await enviarToque(contact, texto)
        if (ok) {
          await setKvValue(claveToque, ahora.toISOString()).catch(() => {})
          toques++
          candidatos.push({ contact, regla, accion: "toque" })
        }
      }
      const avisar = async (regla: Candidato["regla"], claveAviso: string, texto: string) => {
        if (await getKvValue(claveAviso).catch(() => null)) return
        if (dry) { candidatos.push({ contact, regla, accion: "dry", detalle: texto.slice(0, 80) }); return }
        await avisarEquipoInterno(texto).catch(() => false)
        await setKvValue(claveAviso, ahora.toISOString()).catch(() => {})
        avisos++
        candidatos.push({ contact, regla, accion: "aviso" })
      }

      // ── Regla 1: pagó y no completó el alta ──
      if (!altaAt) {
        if (ultimo && silencioMs >= 2 * HORA) {
          await disparar(
            "alta_pendiente",
            `onb_toque_alta_${contact}`,
            `${saludo}te quedó pendiente crear tu cuenta 🙂 Solo me falta que me confirmes los datos del administrador (nombre, apellido, RUT y correo) y en un minuto queda andando. ¿Seguimos?`,
          )
        }
        if (ultimo && silencioMs >= 24 * HORA) {
          await avisar(
            "alta_pendiente",
            `onb_alerta_alta_${contact}`,
            `⚠️ ONBOARDING: +${contact} pagó y lleva más de 24 h sin completar el alta por chat (Vicky ya le escribió una vez). Revisar y contactar.`,
          )
        }
        continue
      }

      // ── Regla 2: alta creada y sin capacitación ──
      if (!cap.bookingId) {
        const hh = horasHabilesDesde(altaAt, ahora)
        if (hh >= 24) {
          await disparar(
            "capacitacion_pendiente",
            `onb_toque_cap_${contact}`,
            `${saludo}tu cuenta ya está creada y nos falta agendar tu capacitación: es el Curso 1, 2 horas por videollamada con ${relator}, y es lo que deja a tu equipo usando la plataforma de verdad. ¿Te muestro los horarios disponibles de esta semana?`,
          )
        }
        if (hh >= 72) {
          await avisar(
            "capacitacion_pendiente",
            `onb_alerta_cap_${contact}`,
            `⚠️ ONBOARDING: +${contact}${cap.numero ? ` (${cap.numero})` : ""} tiene la cuenta creada hace más de 72 h hábiles y NO ha agendado el Curso 1; Vicky ya se lo ofreció dos veces. Relator asignado: ${relator} — conviene que lo llame.`,
          )
        }
        continue
      }

      // ── Regla 3: capacitación mañana y sin nómina ──
      if (cap.bookingId && cap.cuando && trabajadores === 0) {
        const fecha = fechaDeCuando(cap.cuando, ahora)
        if (fecha && fecha === manana(ahora)) {
          await disparar(
            "nomina_pre_capacitacion",
            `onb_toque_nomina_${contact}_${fecha}`,
            `${saludo}mañana tienes tu capacitación con ${relator} 🙌 Para aprovecharla al máximo conviene llegar con tus trabajadores ya cargados: si me mandas la lista (nombre, apellido, RUT, correo personal y grupo) los dejo listos hoy mismo.`,
          )
        }
      }
    } catch (e) {
      console.warn(`[onboarding-toques] ${contact} falló:`, e instanceof Error ? e.message : e)
    }
  }

  console.log(`[onboarding-toques] contactos=${contactos.length} toques=${toques} avisos=${avisos} horario=${enHorario ? "si" : "no"} dry=${dry}`)
  return NextResponse.json({ ok: true, dry, horaChile: cl.hora, enHorario, contactos: contactos.length, toques, avisos, candidatos })
}
