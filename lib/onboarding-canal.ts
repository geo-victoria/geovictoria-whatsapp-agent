/**
 * Lado CANAL del agente de onboarding: todo lo que toca vic_kv, Botmaker o al
 * equipo interno. El cerebro (lib/onboarding/) es puro y no sabe que esto
 * existe — este archivo es el único puente, y por eso vive FUERA de la
 * frontera que vigila tests/onboarding-frontera.test.ts.
 *
 * Pre-API: confirmar_alta_empresa notifica al equipo para el alta MANUAL
 * (mismo patrón que el fallback de comprobantes). Cuando existan los
 * endpoints de alta (Nicolás), el aviso se reemplaza por la llamada HTTP —
 * consultar-antes-de-crear como candado — sin tocar prompt ni conversación.
 */

import { getKvValue, setKvValue, getLastUserAt } from "./supabase-persistence-v3"
import { sendBotmakerMessage, sendBotmakerTemplate } from "./botmaker-push-v3"
import { avisarEquipoInterno } from "./alerta-interna"
import { PLANTILLA_ONBOARDING_CL, paramsPlantillaOnboarding } from "./onboarding/plantilla"
import { dispatchTool } from "./tools"
import { consultarAgenteSoporteSchema } from "./tools/consultar-agente-soporte"
import {
  onboardingEnabled,
  faseEfectiva,
  claveFase,
  claveBorrador,
  claveAltaSolicitada,
  type FaseVicky,
} from "./onboarding/fase"
import {
  parsearBorrador,
  borradorVacio,
  aplicarDatos,
  problemas,
  camposPendientes,
  borradorCompleto,
  resumenParaConfirmar,
  normalizarIdentificador,
  type DatosParciales,
  type Borrador,
} from "./onboarding/borrador"
import { promptOnboardingCL, mensajeKickoffCL } from "./onboarding/prompt"
import {
  TOOL_GUARDAR_DATOS_ONBOARDING,
  TOOL_CONFIRMAR_ALTA_EMPRESA,
} from "./onboarding/tools"

export { mensajeKickoffCL }

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
  texto: string,
  empresa?: string,
): Promise<"texto" | "plantilla" | "fallo"> {
  const ultimo = await getLastUserAt(contact).catch(() => null)
  const abierta = !!ultimo && Date.now() - ultimo.getTime() < 24 * 3600e3
  if (abierta) {
    const ok = await sendBotmakerMessage(contact, texto).catch(() => false)
    if (ok) return "texto"
    // La ventana pudo cerrarse entre la consulta y el envío: se reintenta por
    // plantilla antes de darlo por perdido.
  }
  const ok = await sendBotmakerTemplate(
    contact,
    PLANTILLA_ONBOARDING_CL.name,
    paramsPlantillaOnboarding(empresa),
  ).catch(() => false)
  return ok ? "plantilla" : "fallo"
}

/**
 * Fase del contacto para el gate del webhook. Con el flag apagado devuelve
 * "venta" SIN tocar el kv: cero latencia agregada al camino de venta.
 */
export async function faseDelContacto(contact: string): Promise<FaseVicky> {
  if (!onboardingEnabled()) return "venta"
  const crudo = await getKvValue(claveFase(contact)).catch(() => null)
  return faseEfectiva(crudo)
}

async function cargarBorrador(contact: string): Promise<Borrador> {
  const json = await getKvValue(claveBorrador(contact)).catch(() => null)
  return parsearBorrador(json) ?? borradorVacio("cl")
}

/**
 * Prompt + toolset de la fase onboarding para runAgentLoop (mismo enganche
 * que usa MX). El dispatch relee el borrador de vic_kv en cada llamada: el
 * estado que manda es el persistido, nunca el de la memoria del turno.
 */
export async function armarOnboarding(contact: string): Promise<{
  systemPrompt: string
  tools: { schemas: unknown[]; dispatch: (name: string, input: unknown) => Promise<unknown> }
}> {
  const borrador = await cargarBorrador(contact)
  const altaSolicitada = !!(await getKvValue(claveAltaSolicitada(contact)).catch(() => null))

  const dispatch = async (name: string, input: unknown): Promise<unknown> => {
    if (name === TOOL_GUARDAR_DATOS_ONBOARDING.name) {
      const datos = (input || {}) as DatosParciales
      const actualizado = aplicarDatos(await cargarBorrador(contact), datos)
      await setKvValue(claveBorrador(contact), JSON.stringify(actualizado))
      const completo = borradorCompleto(actualizado)
      return {
        ok: true,
        completo,
        pendientes: camposPendientes(actualizado),
        problemas: problemas(actualizado).filter((p) => p.detalle !== "falta"),
        ...(completo
          ? {
              resumenParaConfirmar: resumenParaConfirmar(actualizado),
              instruccion:
                "Muestra este resumen tal cual y pide confirmación explícita. NO llames confirmar_alta_empresa hasta el sí claro del cliente.",
            }
          : {
              instruccion:
                "Pide lo pendiente agrupado (2-3 datos por mensaje); si hay problemas, re-pide SOLO esos campos.",
            }),
      }
    }

    if (name === TOOL_CONFIRMAR_ALTA_EMPRESA.name) {
      const confirmado = (input as { confirmacion_explicita?: boolean })?.confirmacion_explicita
      if (confirmado !== true) {
        return {
          ok: false,
          error:
            "Falta la confirmación explícita del cliente al resumen. Muéstralo y espera un sí claro.",
        }
      }
      const b = await cargarBorrador(contact)
      if (!borradorCompleto(b)) {
        return { ok: false, error: "El borrador no está completo.", pendientes: camposPendientes(b) }
      }
      const ya = await getKvValue(claveAltaSolicitada(contact)).catch(() => null)
      if (ya) {
        return {
          ok: true,
          yaSolicitada: true,
          mensajeParaProspecto:
            "Tu alta ya está en proceso 🙌 La cuenta queda activa dentro de 24 horas hábiles y te aviso por acá.",
        }
      }
      // Alta MANUAL hasta que exista el endpoint: el aviso lleva los datos ya
      // normalizados, listos para pegar en la plataforma.
      await avisarEquipoInterno(
        `🆕 ALTA ONBOARDING CL (crear a mano — aún sin endpoint) de +${contact}:\n` +
          `Empresa: ${b.empresa.nombre}\n` +
          `RUT empresa: ${normalizarIdentificador(b.empresa.identificador!, "cl")}\n` +
          `Admin: ${b.admin.nombre} ${b.admin.apellido}\n` +
          `RUT admin: ${normalizarIdentificador(b.admin.identificador!, "cl")}\n` +
          `Correo admin: ${b.admin.email}` +
          (b.admin.idInterno ? `\nCódigo interno: ${b.admin.idInterno}` : ""),
      )
      await setKvValue(claveAltaSolicitada(contact), new Date().toISOString()).catch(() => {})
      return {
        ok: true,
        mensajeParaProspecto:
          "Listo, quedó solicitada la creación de tu cuenta 🎉 Queda activa dentro de 24 horas " +
          "hábiles y te aviso por este mismo chat con tu acceso. Cualquier duda mientras tanto, aquí estoy.",
      }
    }

    // Dudas de uso de la plataforma: el oráculo de soporte de siempre.
    if (name === consultarAgenteSoporteSchema.name)
      return dispatchTool(name, (input || {}) as Record<string, unknown>)

    return { ok: false, error: `Tool desconocida en fase onboarding: ${name}` }
  }

  return {
    systemPrompt: promptOnboardingCL(borrador, { altaSolicitada }),
    tools: {
      schemas: [
        TOOL_GUARDAR_DATOS_ONBOARDING,
        TOOL_CONFIRMAR_ALTA_EMPRESA,
        consultarAgenteSoporteSchema,
      ] as unknown as unknown[],
      dispatch,
    },
  }
}
