/**
 * Aviso interno por WhatsApp al equipo (QUOTE_NOTIFY_TO) — para los últimos
 * recursos donde antes le cobrábamos el fallo al cliente.
 *
 * Auditoría de barreras 20-jul: cuando una tool de registro (callback/reunión)
 * fallaba incluso tras el reintento forzado, el fallback le pedía al cliente
 * RE-TIPEAR nombre/empresa/teléfono que ya estaban en el historial (≥7 casos,
 * incluido un cliente urgido que los escribió 3 veces). Ahora el fallback no
 * re-pide nada: avisa al equipo con este helper para completar el registro a
 * mano. Best-effort: nunca lanza.
 */

import { sendBotmakerMessage } from "./botmaker-push-v3"

const NOTIFY_TO = (process.env.QUOTE_NOTIFY_TO || process.env.VICKY_REPORT_PHONE || "56944668823")
  .trim()
  .replace(/\D/g, "")

export async function avisarEquipoInterno(texto: string): Promise<void> {
  if (!NOTIFY_TO || !texto) return
  await sendBotmakerMessage(NOTIFY_TO, texto).catch((e) =>
    console.error("[alerta-interna] push al equipo falló:", e),
  )
}
