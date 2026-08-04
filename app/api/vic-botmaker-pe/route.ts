/**
 * Webhook Botmaker — línea PERÚ (+51 922 067 167).
 *
 * VERSIÓN DE CONTENCIÓN (04-ago): la acción de código de Botmaker ya está
 * activa pero Vicky PE aún no se construye (Fases 1-2 en curso). Sin este
 * endpoint, cada mensaje caería al catch de la acción y el cliente recibiría
 * "estamos con un inconveniente técnico". Acá:
 *   1. se valida el secret (env BOTMAKER_SECRET_PE o vic_kv botmaker_secret_pe),
 *   2. se persiste el mensaje en la conversación (country "pe") — cuando
 *      Vicky PE despierte, tendrá el historial completo,
 *   3. se avisa al equipo interno (lead peruano vivo, atenderlo a mano),
 *   4. se responde UNA VEZ por 24 h un saludo de bienvenida honesto (sin
 *      claims); los mensajes siguientes solo se registran y avisan.
 *
 * Cuando Vicky PE esté lista, este handler se reemplaza por el agente real
 * (patrón vic-botmaker-mx) sin tocar nada en Botmaker.
 */

import { NextResponse } from "next/server"
import { appendTurnV3, getKvValue, setKvValue } from "@/lib/supabase-persistence-v3"
import { avisarEquipoInterno } from "@/lib/alerta-interna"

export const dynamic = "force-dynamic"
export const maxDuration = 30

const HOLD_TTL_MS = 24 * 60 * 60 * 1000

const SALUDO_PE =
  "¡Hola! Gracias por escribir a GeoVictoria Perú 🙌 Somos especialistas en control de asistencia. " +
  "Cuéntame brevemente qué necesitas (cuántas personas trabajan contigo y si buscas app, web o reloj de control) " +
  "y uno de nuestros especialistas te contactará muy pronto para ayudarte."

async function secretValido(recibido: string): Promise<boolean> {
  const env = (process.env.BOTMAKER_SECRET_PE || "").trim()
  if (env && recibido === env) return true
  const kv = ((await getKvValue("botmaker_secret_pe").catch(() => null)) || "").trim()
  return Boolean(kv && recibido === kv)
}

export async function POST(req: Request): Promise<Response> {
  const recibido = (req.headers.get("x-secret") || "").trim()
  if (!(await secretValido(recibido))) {
    return NextResponse.json({ reply: "" }, { status: 401 })
  }
  let body: {
    contact?: string
    message?: string
    audioURL?: string
    imageUrl?: string
    fileUrl?: string
  } = {}
  try {
    body = (await req.json()) as typeof body
  } catch {
    return NextResponse.json({ reply: "" }, { status: 400 })
  }
  const contact = (body.contact || "").replace(/\D/g, "")
  const message = (body.message || "").toString().slice(0, 2000)
  if (!contact) return NextResponse.json({ reply: "" })

  const adjunto = body.audioURL ? " [nota de voz]" : body.fileUrl ? " [documento]" : body.imageUrl ? " [imagen]" : ""
  const holdKey = `pe_hold_${contact}`
  const ya = await getKvValue(holdKey).catch(() => null)
  const dentroDeHold = Boolean(ya && Date.now() - new Date(ya).getTime() < HOLD_TTL_MS)
  const reply = dentroDeHold ? "" : SALUDO_PE

  // Historial primero (best-effort): cuando Vicky PE despierte, sabrá todo.
  await appendTurnV3(contact, `${message || adjunto.trim() || "(sin texto)"}${message ? adjunto : ""}`, reply || "(sin respuesta — contención PE)", "pe").catch(() => {})
  if (!dentroDeHold) await setKvValue(holdKey, new Date().toISOString()).catch(() => {})

  await avisarEquipoInterno(
    `🇵🇪 LÍNEA PERÚ (Vicky PE aún en construcción — atender a mano): +${contact} escribió: ` +
      `${(message || adjunto.trim() || "(sin texto)").slice(0, 300)}`,
  ).catch(() => {})

  console.log(`[vicky-pe-hold] contact=${contact} msg=${JSON.stringify(message).slice(0, 80)}${adjunto} saludo=${reply ? "si" : "no"}`)
  return NextResponse.json({ reply })
}
