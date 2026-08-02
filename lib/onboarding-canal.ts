/**
 * Lado CANAL del agente de onboarding: todo lo que toca vic_kv, Botmaker o al
 * equipo interno. El cerebro (lib/onboarding/) es puro y no sabe que esto
 * existe — este archivo es el único puente, y por eso vive FUERA de la
 * frontera que vigila tests/onboarding-frontera.test.ts.
 *
 * Alta AUTOMÁTICA (02-ago, endpoints de Nicolás vía lib/alta-empresa.ts):
 * confirmar_alta_empresa consulta exists ANTES de crear (candado) y crea la
 * empresa + admin por API. La plataforma le manda el correo de acceso al
 * admin. Tres salidas: ya existe → activación al equipo (posible cliente
 * actual, caso Cofradía); creada → confirmación al cliente; API caída o sin
 * env → aviso manual de siempre (un alta jamás se pierde).
 */

import { getKvValue, setKvValue } from "./supabase-persistence-v3"
import { avisarEquipoInterno } from "./alerta-interna"
import { altaApiConfigurada, existeEmpresa, crearEmpresaConAdmin } from "./alta-empresa"
export { entregarKickoffOnboarding } from "./onboarding-envio"
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
import { promptOnboardingCL } from "./onboarding/prompt"
import {
  TOOL_GUARDAR_DATOS_ONBOARDING,
  TOOL_CONFIRMAR_ALTA_EMPRESA,
} from "./onboarding/tools"

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
      // ── Alta AUTOMÁTICA por API (Nicolás), con candado consultar-antes-de-crear ──
      const fichaAlta =
        `Empresa: ${b.empresa.nombre}\n` +
        `RUT empresa: ${normalizarIdentificador(b.empresa.identificador!, "cl")}\n` +
        `Admin: ${b.admin.nombre} ${b.admin.apellido}\n` +
        `RUT admin: ${normalizarIdentificador(b.admin.identificador!, "cl")}\n` +
        `Correo admin: ${b.admin.email}` +
        (b.admin.idInterno ? `\nCódigo interno: ${b.admin.idInterno}` : "")

      if (altaApiConfigurada()) {
        const existe = await existeEmpresa(b.empresa.identificador!, "cl")
        if (existe?.exists) {
          // Empresa YA registrada en la plataforma: no se crea encima (caso
          // Cofradía — cliente actual que compra un upgrade). La activación
          // del plan nuevo la hace el equipo sobre la cuenta existente.
          await avisarEquipoInterno(
            `🏢 ALTA ONBOARDING CL: la empresa YA EXISTE en la plataforma (${existe.name || "sin nombre"}). ` +
              `Posible cliente actual con plan nuevo — activar sobre la cuenta existente, NO crear otra. ` +
              `Contacto +${contact}.\n${fichaAlta}`,
          )
          await setKvValue(claveAltaSolicitada(contact), new Date().toISOString()).catch(() => {})
          return {
            ok: true,
            mensajeParaProspecto:
              "¡Buenas noticias! Tu empresa ya tiene una cuenta creada en GeoVictoria 🙌 Para dejar tu " +
              "nuevo plan activo sobre esa misma cuenta, nuestro equipo lo habilita directamente — te " +
              "confirmo por este chat dentro de 24 horas hábiles. Cualquier duda mientras tanto, aquí estoy.",
          }
        }
        if (existe && !existe.exists) {
          const alta = await crearEmpresaConAdmin({
            pais: "cl",
            empresa: { nombre: b.empresa.nombre!, identificador: b.empresa.identificador! },
            admin: {
              nombre: b.admin.nombre!,
              apellido: b.admin.apellido!,
              identificador: b.admin.identificador!,
              email: b.admin.email!,
              idInterno: b.admin.idInterno,
            },
          })
          if (alta.ok) {
            await setKvValue(
              claveAltaSolicitada(contact),
              JSON.stringify({ at: new Date().toISOString(), companyId: alta.companyId, via: "api" }),
            ).catch(() => {})
            await avisarEquipoInterno(
              `✅ ALTA ONBOARDING CL creada POR API (companyId ${alta.companyId}, acceso ${alta.loginUserCreated ? "enviado" : "PENDIENTE"}) — contacto +${contact}.\n${fichaAlta}`,
            ).catch(() => {})
            return {
              ok: true,
              mensajeParaProspecto: alta.loginUserCreated
                ? `¡Tu cuenta quedó creada! 🎉 Te enviamos el correo de acceso a ${alta.workEmail} — si no ` +
                  `lo ves en unos minutos, revisa Promociones o Spam. Entra, cambia tu clave y me cuentas ` +
                  `cualquier duda de los primeros pasos por aquí mismo.`
                : `¡Tu cuenta quedó creada! 🎉 El acceso para ${alta.workEmail} te llega dentro de las ` +
                  `próximas horas — te aviso por aquí. Cualquier duda mientras tanto, aquí estoy.`,
            }
          }
          // Creación falló → cae al alta manual (jamás perder un alta).
          console.warn(`[onboarding] alta por API falló (${alta.error}) — cae a alta manual`)
        }
        // existe === null (servicio caído): cae al alta manual.
      }

      // Alta MANUAL: sin API configurada o con el servicio caído, el aviso
      // lleva los datos ya normalizados, listos para pegar en la plataforma.
      await avisarEquipoInterno(`🆕 ALTA ONBOARDING CL (crear a mano) de +${contact}:\n${fichaAlta}`)
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
