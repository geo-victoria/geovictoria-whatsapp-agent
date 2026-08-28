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

import { getKvValue, getLastUserAt } from "./supabase-persistence-v3"
import { sendBotmakerMessage, sendBotmakerTemplate } from "./botmaker-push-v3"
import {
  PLANTILLA_ALTA_FLOW_CL,
  PLANTILLA_ONBOARDING_CL,
  paramsPlantillaAltaFlow,
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
  nombreCliente?: string,
): Promise<{ via: "texto" | "plantilla" | "flow" | "fallo"; texto: string }> {
  // ALTA POR FORMULARIO (28-ago): con el gate encendido, el kickoff es la
  // plantilla con botón FLOW (alta_cuenta_v2_flow) — dentro o fuera de
  // ventana da igual, las plantillas entran siempre. Gate en vic_kv para
  // encender SIN deploy recién cuando Meta apruebe la clv4 (una plantilla
  // PENDING se "acepta" y se bota — cicatriz 25-ago). Si el envío falla,
  // sigue el camino clásico conversacional: nadie se queda sin alta.
  const flowOn = ((await getKvValue("alta_flow_kickoff").catch(() => null)) || "").trim() === "on"
  if (flowOn) {
    const okFlow = await sendBotmakerTemplate(
      contact,
      PLANTILLA_ALTA_FLOW_CL.name,
      paramsPlantillaAltaFlow(nombreCliente, empresa),
    ).catch(() => false)
    if (okFlow) return { via: "flow", texto: "" }
    console.warn(`[onboarding-envio] plantilla flow falló para ${contact}; kickoff clásico de respaldo`)
  }
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
