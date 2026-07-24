/**
 * PROCESO HUMANO ACTIVO — política "un solo proceso de venta" (Lalo, 20-jul,
 * caso Ingesub v2): si un cliente escribe a Vicky y YA tiene un lead abierto
 * trabajado por un ejecutivo, NO se abren dos ventas en paralelo. Vicky lo
 * atiende NORMAL (saludo, dudas, soporte) sin mencionar el proceso; SOLO si
 * pide atención comercial (cotizar, precios, llamada, reunión) le dice que su
 * ejecutivo lo acompaña (ajuste 22-jul, feedback Lalo: anunciarlo de entrada
 * se sentía como un rechazo). El candado duro impide cotizar/dar precios
 * aunque el modelo se confunda, y el ejecutivo recibe aviso al instante.
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
  // Ajuste 22-jul (feedback Lalo, prueba MX): NO anunciar el proceso humano en
  // el saludo — anunciarlo de entrada se siente como un rechazo y el cliente
  // quizás solo quería soporte o resolver una duda. El proceso humano solo se
  // menciona cuando el cliente PIDE atención comercial.
  return (
    `[REGISTRO INTERNO — no visible para el cliente] PROCESO HUMANO ACTIVO (dato interno, NO lo anuncies): este cliente ` +
    `ya está siendo atendido por ${humano.ownerNombre} (${humano.ownerEmail}) — lead abierto en Zoho. POLÍTICA: un solo ` +
    `proceso de venta. Atiéndelo NORMAL: saluda, responde dudas del producto y de soporte como con cualquier cliente, sin ` +
    `mencionar procesos, ejecutivos ni este registro. SOLO cuando pida atención comercial (cotización, precios, descuentos, ` +
    `que lo llamen o agendar una reunión): ahí NO cotices ni des montos — dile con calidez que ${humano.ownerNombre} lo está ` +
    `acompañando en su proceso, que ya le avisamos que escribió y lo contactará a la brevedad. Si solo pregunta o pide ayuda, ` +
    `resuélvelo tú sin tocar el tema.`
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
    `Aviso automático (${new Date().toLocaleString("es-CL", { timeZone: "America/Santiago" })}): el contacto +${contact} inició una conversación en el WhatsApp comercial. Vicky lo atiende en dudas generales pero NO le cotizará (política de proceso único); si pide cotización, llamada o reunión, le dirá que tú lo estás acompañando. Escríbele o llámalo cuanto antes.`,
  ).catch(() => {})

  // Aviso interno inmediato por WhatsApp (best-effort, misma línea que los
  // avisos de comprobantes).
  sendBotmakerMessage(
    NOTIFY_TO,
    `⚠️ Cliente de ${humano.ownerNombre} escribió al WhatsApp de Vicky (+${contact}). Vicky lo atiende en dudas generales sin cotizar (proceso único) y solo menciona al ejecutivo si pide cotización/llamada/reunión; ya se avisó por nota en Zoho. Si el equipo prefiere que Vicky lo tome completo, borrar la key vic_kv proceso_humano_${contact}.`,
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
      `NO le des precios, cotizaciones ni descuentos. Este es el momento de decírselo (pidió atención comercial): ` +
      `con calidez, cuéntale que ${p.ownerNombre} lo está acompañando en su proceso, que ya le avisamos que escribió ` +
      `y lo contactará a la brevedad. Sigue ayudándolo tú con cualquier duda general del producto.`,
  }
}
