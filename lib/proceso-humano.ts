/**
 * PROCESO HUMANO ACTIVO — política "un solo proceso de venta" (Lalo, 20-jul,
 * caso Ingesub v2): si un cliente escribe a Vicky y YA tiene un lead abierto
 * trabajado por un ejecutivo, NO se abren dos ventas en paralelo. Vicky lo
 * saluda, le dice que su ejecutivo lo contactará (y le avisa al ejecutivo al
 * instante), y el candado duro impide cotizar/dar precios aunque el modelo
 * se confunda.
 *
 * Piezas:
 *   - detectarProcesoHumano(contact): corre al ABRIR una conversación nueva.
 *     Si hay lead abierto de otro dueño: flag durable en vic_kv, directiva en
 *     el historial (visible para el modelo en todos los turnos), nota en el
 *     lead del ejecutivo y aviso interno por WhatsApp.
 *   - procesoHumanoActivo(contact): lee el flag — lo usan los dispatch de
 *     tools comerciales como CANDADO DETERMINISTA (las tools de precio se
 *     niegan a correr).
 *
 * Para liberar a Vicky (el equipo decide que ella siga): borrar la key
 * vic_kv `proceso_humano_<contact>`.
 */

import { buscarLeadAbiertoDeOtroDueno, agregarNotaLead } from "./zoho-leads"
import { appendAssistantV3, getKvValue, setKvValue } from "./supabase-persistence-v3"
import { sendBotmakerMessage } from "./botmaker-push-v3"

const NOTIFY_TO = (process.env.QUOTE_NOTIFY_TO || process.env.VICKY_REPORT_PHONE || "56944668823")
  .replace(/\D/g, "")

export type ProcesoHumano = {
  leadId: string
  ownerNombre: string
  ownerEmail: string
  detectadoEn: string
}

export async function procesoHumanoActivo(contact: string): Promise<ProcesoHumano | null> {
  if (!contact) return null
  const raw = ((await getKvValue(`proceso_humano_${contact}`).catch(() => "")) || "").trim()
  if (!raw) return null
  try {
    const p = JSON.parse(raw) as ProcesoHumano
    return p?.ownerNombre ? p : null
  } catch {
    return null
  }
}

/**
 * Corre al abrir una conversación nueva (historial vacío). Best-effort: si
 * Zoho no responde, la conversación sigue normal (mejor atender que bloquear
 * por un timeout).
 */
export function directivaProcesoHumano(humano: { ownerNombre: string; ownerEmail: string }): string {
  return (
    `[REGISTRO INTERNO — no visible para el cliente] PROCESO HUMANO ACTIVO: este cliente ya está siendo atendido por ` +
    `${humano.ownerNombre} (${humano.ownerEmail}) — lead abierto en Zoho. POLÍTICA: un solo proceso de venta. NO cotices, ` +
    `NO des precios ni descuentos, NO pidas datos de cotización. Salúdalo con calidez, dile que ${humano.ownerNombre} lo está ` +
    `acompañando y que ya le avisamos que escribió — lo contactará a la brevedad. Puedes responder dudas generales del ` +
    `producto (sin montos). Si insiste en precios, reitera que su ejecutivo le prepara todo.`
  )
}

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
  await setKvValue(`proceso_humano_${contact}`, JSON.stringify(proceso)).catch(() => {})

  // Directiva en el historial: el modelo la ve en TODOS los turnos siguientes.
  await appendAssistantV3(contact, directivaProcesoHumano(humano), country).catch(() => {})

  // Aviso al ejecutivo: nota en SU lead (visible en su cronología de Zoho).
  agregarNotaLead(
    humano.id,
    "Tu cliente escribió al WhatsApp de Vicky",
    `Aviso automático (${new Date().toLocaleString("es-CL", { timeZone: "America/Santiago" })}): el contacto +${contact} inició una conversación en el WhatsApp comercial. Vicky NO le está cotizando (política de proceso único): le indicó que tú lo contactarás a la brevedad. Escríbele o llámalo cuanto antes.`,
  ).catch(() => {})

  // Aviso interno inmediato por WhatsApp (best-effort, misma línea que los
  // avisos de comprobantes).
  sendBotmakerMessage(
    NOTIFY_TO,
    `⚠️ Cliente de ${humano.ownerNombre} escribió al WhatsApp de Vicky (+${contact}). Vicky no cotizará (proceso único); se le avisó al ejecutivo por nota en Zoho. Si el equipo prefiere que Vicky lo tome, borrar la key vic_kv proceso_humano_${contact}.`,
  ).catch(() => {})

  console.warn(
    `[proceso-humano] ${contact} tiene proceso abierto con ${humano.ownerNombre} — candado comercial activado`,
  )
  return proceso
}

/** Mensaje de bloqueo que reciben las tools comerciales cuando hay candado. */
export function bloqueoComercial(p: ProcesoHumano): { ok: false; error: string } {
  return {
    ok: false,
    error:
      `BLOQUEADO — PROCESO HUMANO ACTIVO: este cliente ya está siendo atendido por ${p.ownerNombre}. ` +
      `NO le des precios, cotizaciones ni descuentos. Dile con calidez que ${p.ownerNombre} lo está acompañando, ` +
      `que ya le avisamos que escribió y lo contactará a la brevedad. Solo puedes ayudarlo con dudas generales del producto.`,
  }
}
