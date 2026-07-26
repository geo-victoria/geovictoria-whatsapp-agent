/**
 * Entrega del mensaje de arranque del onboarding.
 *
 * VIVE APARTE DE onboarding-canal.ts A PROPÓSITO: ese módulo importa
 * `dispatchTool` de ./tools, y ./tools importa registrar-comprobante, que a su
 * vez necesita esta función. El ciclo rompía `next build` con un
 * "Cannot access before initialization" que ni tsc ni los tests veían — solo
 * aparece al armar el grafo real del bundle. Acá no hay nada de ./tools, así
 * que el ciclo no existe.
 */

import { getLastUserAt } from "./supabase-persistence-v3"
import { sendBotmakerMessage, sendBotmakerTemplate } from "./botmaker-push-v3"
import {
  PLANTILLA_ONBOARDING_CL,
  paramsPlantillaOnboarding,
  renderPlantillaOnboarding,
} from "./onboarding/plantilla"

/**
 * Entrega el kickoff del onboarding respetando la ventana de 24 h de WhatsApp.
 *
 * Dentro de ventana: texto libre, con el mensaje completo.
 * Fuera de ventana: el texto libre moriría en silencio, así que va la plantilla
 * HSM — que no lleva el alta, solo reabre la ventana. Cuando el cliente
 * responde, el webhook lo encuentra en fase onboarding y el agente sigue.
 *
 * Devuelve cómo salió, para que el llamador lo registre en el historial solo
 * cuando corresponda (la plantilla no es el mensaje de Vicky).
 */
export async function entregarKickoffOnboarding(
  contact: string,
  empresa?: string,
  rut?: string,
): Promise<{ via: "texto" | "plantilla" | "fallo"; texto: string }> {
  const params = paramsPlantillaOnboarding(empresa, rut)
  const texto = renderPlantillaOnboarding(params)

  const ultimo = await getLastUserAt(contact).catch(() => null)
  const abierta = !!ultimo && Date.now() - ultimo.getTime() < 24 * 3600e3
  if (abierta) {
    const ok = await sendBotmakerMessage(contact, texto).catch(() => false)
    if (ok) return { via: "texto", texto }
    // La ventana pudo cerrarse entre la consulta y el envío: se reintenta por
    // plantilla antes de darlo por perdido.
  }
  const ok = await sendBotmakerTemplate(
    contact,
    PLANTILLA_ONBOARDING_CL.name,
    params,
  ).catch(() => false)
  return { via: ok ? "plantilla" : "fallo", texto }
}
