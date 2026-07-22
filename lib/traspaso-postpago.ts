/**
 * Cierre de cadencia + TRASPASO post-pago, compartido por dos vías:
 *
 *   1. Webhook vic-quote-notify (tiempo real): el cotizador avisa al pagar.
 *   2. Barrido horario en vic-deal-stage-cron (red de seguridad): cubre el
 *      caso Constanza/COT233 (20-jul) — el cotizador registró el pago pero el
 *      request al agente nunca salió (faltan VICKY_AGENT_NOTIFY_URL /
 *      VICKY_AGENT_CRON_SECRET en su Vercel) y el cliente quedó sin traspaso
 *      y con la llamada agendada viva.
 *
 * Idempotente: el traspaso se envía UNA vez por cotización (candado kv
 * traspaso_postpago_<quoteId>), venga por la vía que venga.
 */

import {
  appendAssistantV3,
  closeFollowup,
  findContactByQuoteId,
  getKvValue,
  setKvValue,
} from "./supabase-persistence-v3"
import { cancelPendingCallbacks } from "./dapta-voice"
import { sendBotmakerMessage } from "./botmaker-push-v3"
import { PERFIL_CO } from "./paises/co"

export type ResultadoTraspaso = {
  contact?: string
  traspaso: "enviado" | "ya_enviado" | "push_fallo" | "omitido" | "sin_contacto"
}

/**
 * Cierra toda la proactividad del contacto dueño de la cotización (nudges,
 * anuncios y llamadas agendadas) y, si `enviarTraspaso`, le presenta a su
 * ejecutivo humano. Best-effort en cada paso; nunca lanza.
 */
export async function cerrarYTraspasarPostPago(
  quoteId: string,
  opts: { enviarTraspaso?: boolean } = {},
): Promise<ResultadoTraspaso> {
  const enviarTraspaso = opts.enviarTraspaso !== false
  const contact = await findContactByQuoteId(quoteId).catch(() => null)
  if (!contact) return { traspaso: "sin_contacto" }

  await closeFollowup(contact, "cotizacion_aceptada").catch(() => {})
  await cancelPendingCallbacks(contact).catch(() => {})

  if (!enviarTraspaso) return { contact, traspaso: "omitido" }

  const kvKey = `traspaso_postpago_${quoteId}`
  const ya = await getKvValue(kvKey).catch(() => null)
  if (ya) return { contact, traspaso: "ya_enviado" }

  const esCO = contact.startsWith("57")
  const esMX = contact.startsWith("521") || (contact.startsWith("52") && contact.length === 12)
  const ejecutivo = esMX
    ? { nombre: "Yahel Segura", email: "ysegura@geovictoria.com", telefono: "+52 55 3763 6604" }
    : esCO
      ? PERFIL_CO.equipo.ejecutivo
      : { nombre: "Anderson Díaz", email: "adiazg@geovictoria.com", telefono: "+56 9 3937 2058" }
  const traspaso =
    `¡Felicitaciones y bienvenido a GeoVictoria! 🎉 Tu pago quedó registrado.\n\n` +
    `De aquí en adelante te acompaña *${ejecutivo.nombre}*, tu ejecutivo comercial, quien te contactará para coordinar la puesta en marcha:\n` +
    (ejecutivo.telefono ? `📱 ${ejecutivo.telefono}\n` : "") +
    `✉️ ${ejecutivo.email}`
  const pushed = await sendBotmakerMessage(
    contact,
    traspaso,
    esCO ? PERFIL_CO.canal.channelId : undefined,
  ).catch(() => false)
  if (!pushed) return { contact, traspaso: "push_fallo" }
  await setKvValue(kvKey, new Date().toISOString()).catch(() => {})
  await appendAssistantV3(contact, traspaso, esCO ? "co" : "cl").catch(() => {})
  return { contact, traspaso: "enviado" }
}
