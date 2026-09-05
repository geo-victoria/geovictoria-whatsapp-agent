/**
 * PROCESO HUMANO — SOLO COORDINACIÓN, NUNCA BARRERA (política Lalo, 24-jul).
 *
 * Historia: el 20-jul (caso Ingesub v2) se instaló un candado de "un solo
 * proceso de venta": si el cliente tenía un lead abierto de otro ejecutivo,
 * Vicky NO cotizaba y lo derivaba. El 24-jul Lalo lo dio vuelta: "si el
 * cliente quiere que le coticemos y le podemos cotizar, le cotizamos. No le
 * ponemos una barrera, aunque el lead ya exista en Zoho, aunque el deal
 * exista en Zoho".
 *
 * Qué queda de la detección (al abrir una conversación nueva):
 *   - Nota en el lead del ejecutivo: "tu cliente está conversando con Vicky".
 *   - Aviso interno por WhatsApp al equipo.
 *   - Directiva INFORMATIVA en el historial (dato de contexto, sin prohibir).
 * Qué se eliminó: el flag kv que gatillaba el candado, el retiro de tools
 * comerciales en agent-loop y el mensaje "tu ejecutivo te está acompañando".
 */

import { buscarLeadAbiertoDeOtroDueno, agregarNotaLead } from "./zoho-leads"
import { appendAssistantV3 } from "./supabase-persistence-v3"
import { avisarEquipoInterno } from "./alerta-interna"

const NOTIFY_TO = (process.env.QUOTE_NOTIFY_TO || process.env.VICKY_REPORT_PHONE || "56944668823")
  .replace(/\D/g, "")

export type ProcesoHumano = {
  leadId: string
  ownerNombre: string
  ownerEmail: string
  detectadoEn: string
}

/**
 * COMPAT: el candado comercial fue eliminado (política 24-jul). Se conserva la
 * firma por si quedara algún llamador rezagado, pero SIEMPRE devuelve null —
 * nadie queda bloqueado para cotizar.
 */
export async function procesoHumanoActivo(_contact: string): Promise<ProcesoHumano | null> {
  return null
}

/** Directiva informativa (sin prohibiciones): contexto para el modelo. */
export function directivaProcesoHumano(humano: { ownerNombre: string; ownerEmail: string }): string {
  return (
    `[REGISTRO INTERNO — no visible para el cliente] DATO DE COORDINACIÓN: este cliente también tiene un proceso ` +
    `abierto en Zoho con ${humano.ownerNombre} (${humano.ownerEmail}); ya se le avisó al ejecutivo por nota. ` +
    `Esto NO cambia nada para ti: atiéndelo con normalidad total — cotiza, da precios y avanza hasta el cierre si ` +
    `el cliente lo pide. No menciones al ejecutivo ni este registro salvo que el CLIENTE hable de él primero.`
  )
}

/**
 * Corre al abrir una conversación nueva (historial vacío). Best-effort: solo
 * genera avisos de coordinación — la conversación y la venta siguen normales
 * pase lo que pase.
 */
export async function detectarProcesoHumano(
  contact: string,
  country = "cl",
): Promise<ProcesoHumano | null> {
  if (!contact) return null
  const humano = await buscarLeadAbiertoDeOtroDueno(contact).catch(() => null)
  if (!humano) return null

  const proceso: ProcesoHumano = {
    leadId: humano.id,
    ownerNombre: humano.ownerNombre,
    ownerEmail: humano.ownerEmail,
    detectadoEn: new Date().toISOString(),
  }

  // Directiva informativa en el historial (contexto, sin prohibiciones).
  await appendAssistantV3(contact, directivaProcesoHumano(humano), country).catch(() => {})

  // Aviso al ejecutivo: nota en SU lead (visible en su cronología de Zoho).
  agregarNotaLead(
    humano.id,
    "Tu cliente escribió al WhatsApp de Vicky",
    `Aviso automático (${new Date().toLocaleString("es-CL", { timeZone: "America/Santiago" })}): el contacto +${contact} inició una conversación en el WhatsApp comercial. Vicky lo está atendiendo y, si pide cotización, se la hará (política 24-jul: al cliente que quiere cotizar no se le pone barrera). Coordina con el equipo para no duplicar gestiones.`,
  ).catch(() => {})

  // Aviso interno inmediato por WhatsApp (best-effort).
  avisarEquipoInterno(
    `ℹ️ Cliente de ${humano.ownerNombre} escribió al WhatsApp de Vicky (+${contact}). Vicky lo atiende y le cotizará si lo pide (sin barrera, política 24-jul); el ejecutivo ya tiene nota en su lead para coordinar.`,
  ).catch(() => {})

  console.log(
    `[proceso-humano] ${contact} tiene proceso abierto con ${humano.ownerNombre} — avisos de coordinación enviados, sin bloqueo`,
  )
  return proceso
}
