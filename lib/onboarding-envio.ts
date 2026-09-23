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
  PLANTILLA_ONBOARDING_CL,
  PLANTILLA_ONBOARDING_PE,
  PLANTILLA_ONBOARDING_CO,
  gatesAltaPais,
  paramsPlantillaAltaFlow,
  paramsPlantillaOnboarding,
  plantillasAltaPais,
  renderPlantillaOnboarding,
} from "./onboarding/plantilla"
import { paisDeContacto } from "./ruteo-pais"

// El kickoff del alta es TRANSACCIONAL (07-sep, caso TESLA AUSTRAL): el
// cliente acaba de pagar y este mensaje es la consecuencia directa. El gate de
// proactividad lo registra pero no lo bloquea — el anti-ráfaga (la presentación
// del traspaso salió minutos antes) dejó a un pagador sin formulario de alta.
const TRANSACCIONAL = { transaccional: true } as const

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
  // PERÚ (21-sep): el MISMO híbrido de Chile con sus plantillas del bot Vicky
  // Perú y gates propios (`alta_flow_kickoff_pe` / `alta_qr_intent_pe`); con
  // los gates apagados el alta es CONVERSACIONAL: texto en ventana y, fuera de
  // ventana, la plantilla UTILITY `vicky_pe_alta_cuenta`.
  const { paisProbador } = await import("./probador-pais")
  const overridePais = await paisProbador(contact).catch(() => null)
  const paisEf = overridePais ?? paisDeContacto(contact)
  const esPE = paisEf === "pe"
  // COLOMBIA (23-sep): mismo híbrido; QR chilena (neutra) + kickoff conversacional con NIT.
  const paisAlta: "cl" | "pe" | "co" = esPE ? "pe" : paisEf === "co" ? "co" : "cl"
  const gates = gatesAltaPais(paisAlta)
  const tplsBase = plantillasAltaPais(paisAlta)
  // NOMBRE DE LA PLANTILLA FLOW POR KV (21-sep, flow único): una plantilla no
  // se edita, así que al publicar un flow nuevo hay que crear otra plantilla
  // que lo apunte. vic_kv `alta_flow_tpl_<pais>` la cambia SIN deploy.
  const tplFlowOverride = ((await getKvValue(`alta_flow_tpl_${paisAlta}`).catch(() => null)) || "").trim()
  const tplsAlta = tplFlowOverride ? { ...tplsBase, flow: { ...tplsBase.flow, name: tplFlowOverride } } : tplsBase
  const flowOnGate = ((await getKvValue(gates.flow).catch(() => null)) || "").trim() === "on"
  // ALTA POR FORMULARIO (28-ago): con el gate encendido, el kickoff es la
  // plantilla con botón FLOW (alta_cuenta_v2_flow) — dentro o fuera de
  // ventana da igual, las plantillas entran siempre. Gate en vic_kv para
  // encender SIN deploy recién cuando Meta apruebe la clv4 (una plantilla
  // PENDING se "acepta" y se bota — cicatriz 25-ago). Si el envío falla,
  // sigue el camino clásico conversacional: nadie se queda sin alta.
  const flowOn = flowOnGate
  if (flowOn) {
    const params = paramsPlantillaAltaFlow(nombreCliente, empresa)
    // HÍBRIDO POR VENTANA (Lalo 28-ago): con ventana VENCIDA (designado frío)
    // el botón FLOW directo abre un formulario cuyo cierre no puede retomar el
    // chat (Meta 131047) — va la plantilla QUICK-REPLY: su tap es mensaje del
    // usuario (abre ventana) y el intent de Botmaker manda el flow en sesión
    // con identificación garantizada. Gate vic_kv `alta_qr_intent` = "on"
    // (recién cuando el bloque #altaflow→v3 esté cableado en Botmaker); sin
    // gate o si la QR falla, cae a la plantilla FLOW de siempre.
    const ultimoMsg = await getLastUserAt(contact).catch(() => null)
    const ventanaViva = !!ultimoMsg && Date.now() - ultimoMsg.getTime() < 23 * 3600e3
    const qrOn = ((await getKvValue(gates.qr).catch(() => null)) || "").trim() === "on"
    // QR PRIMERO (22-sep, Lalo "es extraño pedir que confirme el WhatsApp si lo
    // está haciendo desde su WhatsApp"): la plantilla FLOW abre el formulario
    // por el INIT de Meta y la Code Action nunca resuelve el número
    // (`contact=VACIO` en todos los logs), así que el flow parte en la pantalla
    // de confirmación del número. El tap del quick-reply, en cambio, dispara el
    // bloque `#altaflow` de Botmaker, que abre el flow v6 en la pantalla EMPRESA
    // con las variables alta_* ya sembradas (nombre, RUT, teléfono, etiquetas):
    // cero pantalla de número. Con vic_kv `alta_qr_primero`="on" el QR sale
    // también con la ventana viva; la plantilla FLOW queda de respaldo si el QR
    // falla. Sin el gate, conducta de siempre (QR solo en frío).
    const qrPrimero = ((await getKvValue("alta_qr_primero").catch(() => null)) || "").trim() === "on"
    if (qrOn && (!ventanaViva || qrPrimero)) {
      // SIEMBRA de variables alta_* ANTES de la plantilla (28-ago noche): el
      // tap del botón dispara el intent #altaflow directo en Botmaker (no pasa
      // por este webhook), así que el bloque interpola ${alta_*} — que deben
      // estar sembradas de antes. trigger-intent exige un intent: se usa el
      // flujo VACÍO #setvars (no manda mensajes; solo aplica las variables).
      try {
        const { triggerBotmakerIntent } = await import("./botmaker-push-v3")
        const { prefillAltaFlow, variablesAltaFlow } = await import("./onboarding-altaflow-tap")
        const prefill = await prefillAltaFlow(contact)
        // Con alta_nombre (primer nombre) para personalizar el MENSAJE del
        // bloque — la entrega del formulario saluda por nombre.
        await triggerBotmakerIntent(contact, "#setvars", variablesAltaFlow(contact, prefill, true))
      } catch (e) {
        console.warn(`[onboarding-envio] siembra de variables alta_* falló para ${contact}:`, e instanceof Error ? e.message : e)
      }
      const okQr = await sendBotmakerTemplate(contact, tplsAlta.qr.name, params, undefined, TRANSACCIONAL).catch(() => false)
      if (okQr) return { via: "flow", texto: "" }
      console.warn(`[onboarding-envio] plantilla QR falló para ${contact}; se intenta la plantilla FLOW`)
    }
    const okFlow = tplsAlta.flow.name ? await sendBotmakerTemplate(contact, tplsAlta.flow.name, params, undefined, TRANSACCIONAL).catch(() => false) : false
    if (okFlow) return { via: "flow", texto: "" }
    console.warn(`[onboarding-envio] plantilla flow falló para ${contact}; kickoff clásico de respaldo`)
  }
  const params = paramsPlantillaOnboarding(empresa, rut, paisAlta)
  const texto = renderPlantillaOnboarding(params, paisAlta)

  const ultimo = await getLastUserAt(contact).catch(() => null)
  const abierta = !!ultimo && Date.now() - ultimo.getTime() < 24 * 3600e3
  if (abierta) {
    const ok = await sendBotmakerMessage(contact, texto, undefined, TRANSACCIONAL).catch(() => false)
    if (ok) return { via: "texto", texto }
    // La ventana pudo cerrarse entre la consulta y el envío: se reintenta por
    // plantilla antes de darlo por perdido.
  }
  const ok = await sendBotmakerTemplate(
    contact,
    (paisAlta === "pe" ? PLANTILLA_ONBOARDING_PE : paisAlta === "co" ? PLANTILLA_ONBOARDING_CO : PLANTILLA_ONBOARDING_CL).name,
    params,
    undefined,
    TRANSACCIONAL,
  ).catch(() => false)
  return { via: ok ? "plantilla" : "fallo", texto }
}
