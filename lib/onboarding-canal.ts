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

// URL de inicio de sesión de la plataforma para el instructivo post-alta.
// Sin env, el copy dice "la plataforma GeoVictoria" sin link (jamás inventar).
const LOGIN_URL = (process.env.VICKY_PLATAFORMA_LOGIN_URL || "").trim()
export { entregarKickoffOnboarding } from "./onboarding-envio"
import { dispatchTool } from "./tools"
import { consultarAgenteSoporteSchema } from "./tools/consultar-agente-soporte"
import {
  onboardingEnabled,
  faseEfectiva,
  esFase,
  claveFase,
  claveBorrador,
  claveAltaSolicitada,
  claveConfiguracion,
  type FaseVicky,
} from "./onboarding/fase"
import {
  configuracionVacia,
  parsearNominaPegada,
  pendientesConfiguracion,
  resumenConfiguracion,
  type Configuracion,
  type TurnoCfg,
} from "./onboarding/configuracion"
import { promptConfiguracionCL } from "./onboarding/prompt"
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
  TOOL_GUARDAR_NOMINA,
  TOOL_DEFINIR_TURNO,
  TOOL_ARMAR_PLANIFICACION,
  TOOL_ASIGNAR_PLANIFICACION,
  TOOL_ELIMINAR_TRABAJADOR,
  TOOL_CONFIRMAR_CONFIGURACION,
} from "./onboarding/tools"

/**
 * PILOTO POR CONTACTO (24-ago, "partimos probando directamente por
 * WhatsApp"): con el flag global apagado, los contactos listados en vic_kv
 * `onboarding_piloto` (teléfonos separados por coma) SÍ entran a la fase de
 * onboarding. Los enrola vic-onboarding-invocar al invocarlos — así el
 * piloto se maneja sin deploy y sin exponer a ningún cliente real.
 */
async function esContactoPiloto(contact: string): Promise<boolean> {
  try {
    const lista = (await getKvValue("onboarding_piloto")) || ""
    const fono = contact.replace(/\D/g, "")
    return lista
      .split(",")
      .map((s) => s.replace(/\D/g, ""))
      .filter(Boolean)
      .includes(fono)
  } catch (e) {
    // Cazador del flip 25-ago (contacto en onboarding atendido por venta):
    // si esta lectura falla, el gate cae a venta EN SILENCIO — dejar huella.
    console.warn(`[onboarding-gate] esContactoPiloto FALLÓ para ${contact}:`, e instanceof Error ? e.message : e)
    return false
  }
}

/**
 * Fase del contacto para el gate del webhook. Con el flag apagado devuelve
 * "venta" SIN tocar el kv (cero latencia al camino de venta) — salvo que el
 * contacto esté en el piloto.
 */
export async function faseDelContacto(contact: string): Promise<FaseVicky> {
  if (!onboardingEnabled()) {
    if (!(await esContactoPiloto(contact))) return "venta"
    const crudoPiloto = await getKvValue(claveFase(contact)).catch((e) => {
      console.warn(`[onboarding-gate] lectura de fase FALLÓ para ${contact}:`, e instanceof Error ? e.message : e)
      return null
    })
    const fase = esFase(crudoPiloto) ? crudoPiloto : "venta"
    // Piloto: la decisión del gate SIEMPRE deja huella (cazador del flip 25-ago).
    console.log(`[onboarding-gate] contact=${contact} piloto=si kv=${JSON.stringify(crudoPiloto)} → fase=${fase}`)
    return fase
  }
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

  // ── F2: estado de la CONFIGURACIÓN (nómina/turnos/planificaciones) ──
  const cargarConfig = async (): Promise<Configuracion> => {
    try {
      const raw = await getKvValue(claveConfiguracion(contact))
      if (raw) return { ...configuracionVacia(), ...(JSON.parse(raw) as Partial<Configuracion>) }
    } catch {}
    return configuracionVacia()
  }
  const guardarConfig = async (cfg: Configuracion) =>
    setKvValue(claveConfiguracion(contact), JSON.stringify(cfg)).catch(() => {})
  /** Respuesta estándar de las tools F2: estado + faltas en cotidiano. */
  const estadoConfig = (cfg: Configuracion) => {
    const faltas = pendientesConfiguracion(cfg)
    return {
      resumen: resumenConfiguracion(cfg),
      pendientes: faltas.map((f) => f.mensaje),
      listoParaCerrar: faltas.length === 0 && cfg.trabajadores.length > 0,
    }
  }

  const dispatch = async (name: string, input: unknown): Promise<unknown> => {
    // ── Tools F2 (fase configuración) ──
    if (name === TOOL_GUARDAR_NOMINA.name) {
      const inp = (input || {}) as { filas?: string; reemplazar?: boolean }
      const nuevas = parsearNominaPegada(String(inp.filas || ""))
      if (!nuevas.length) return { ok: false, error: "No llegó ninguna fila legible." }
      const cfg = await cargarConfig()
      if (inp.reemplazar) {
        cfg.trabajadores = nuevas
      } else {
        // UPSERT por RUT (caso 25-ago: el mismo trabajador puede venir en la
        // foto Y en el excel — no se duplica; y un dato ya completado por
        // chat no se pierde porque la planilla re-enviada lo traiga vacío).
        const compacto = (v: string | undefined) => String(v || "").replace(/[^0-9kK]/g, "").toUpperCase()
        for (const n of nuevas) {
          const rut = compacto(n.rut)
          const idx = rut ? cfg.trabajadores.findIndex((t) => compacto(t.rut) === rut) : -1
          if (idx >= 0) {
            const prev = cfg.trabajadores[idx]
            cfg.trabajadores[idx] = {
              rut: n.rut || prev.rut,
              correo: n.correo || prev.correo,
              nombres: n.nombres || prev.nombres,
              apellidos: n.apellidos || prev.apellidos,
              grupo: n.grupo || prev.grupo,
              telefono1: n.telefono1 || prev.telefono1,
              telefono2: n.telefono2 || prev.telefono2,
              telefono3: n.telefono3 || prev.telefono3,
            }
          } else {
            cfg.trabajadores.push(n)
          }
        }
      }
      await guardarConfig(cfg)
      return {
        ok: true,
        agregados: nuevas.length,
        totalNomina: cfg.trabajadores.length,
        ...estadoConfig(cfg),
        instruccion:
          "Si hay pendientes de la nómina, pídelos de a pocos (los correos personales primero). " +
          "Con la nómina sana, ofrece turnos/planificaciones como OPCIONALES o cerrar.",
      }
    }
    if (name === TOOL_ELIMINAR_TRABAJADOR.name) {
      const rut = String((input as { rut?: string })?.rut || "")
      const compacto = (v: string | undefined) => String(v || "").replace(/[^0-9kK]/g, "").toUpperCase()
      const clave = compacto(rut)
      if (!clave) return { ok: false, error: "Falta el RUT del trabajador a eliminar." }
      const cfg = await cargarConfig()
      const idx = cfg.trabajadores.findIndex((t) => compacto(t.rut) === clave)
      if (idx < 0) return { ok: false, error: `No hay ningún trabajador con RUT ${rut} en la nómina.` }
      const [fuera] = cfg.trabajadores.splice(idx, 1)
      cfg.asignaciones = cfg.asignaciones.filter((a) => compacto(a.rutTrabajador) !== clave)
      await guardarConfig(cfg)
      return {
        ok: true,
        eliminado: `${fuera.nombres || ""} ${fuera.apellidos || ""}`.trim() || fuera.rut,
        ...estadoConfig(cfg),
      }
    }
    if (name === TOOL_DEFINIR_TURNO.name) {
      const t = (input || {}) as TurnoCfg
      if (!String(t.nombre || "").trim()) return { ok: false, error: "El turno necesita nombre." }
      const cfg = await cargarConfig()
      const clave = String(t.nombre).trim().toLowerCase()
      const idx = cfg.turnos.findIndex((x) => String(x.nombre || "").trim().toLowerCase() === clave)
      if (idx >= 0) cfg.turnos[idx] = { ...cfg.turnos[idx], ...t }
      else cfg.turnos.push(t)
      await guardarConfig(cfg)
      return { ok: true, ...estadoConfig(cfg) }
    }
    if (name === TOOL_ARMAR_PLANIFICACION.name) {
      const p = (input || {}) as { nombre?: string; diasTurnos?: string[] }
      if (!String(p.nombre || "").trim()) return { ok: false, error: "La planificación necesita nombre." }
      const dias = Array.from({ length: 7 }, (_, i) => String((p.diasTurnos || [])[i] || "").trim())
      const cfg = await cargarConfig()
      const clave = String(p.nombre).trim().toLowerCase()
      const idx = cfg.planificaciones.findIndex((x) => String(x.nombre || "").trim().toLowerCase() === clave)
      if (idx >= 0) cfg.planificaciones[idx] = { nombre: p.nombre, diasTurnos: dias }
      else cfg.planificaciones.push({ nombre: p.nombre, diasTurnos: dias })
      await guardarConfig(cfg)
      return { ok: true, ...estadoConfig(cfg) }
    }
    if (name === TOOL_ASIGNAR_PLANIFICACION.name) {
      const a = (input || {}) as {
        planificacion?: string
        rutsTrabajadores?: string[]
        todos?: boolean
        desde?: string
        hasta?: string
      }
      const cfg = await cargarConfig()
      const compacto = (v: string | undefined) => String(v || "").replace(/[^0-9kK]/g, "").toUpperCase()
      const ruts = a.todos
        ? cfg.trabajadores.map((t) => t.rut).filter(Boolean)
        : (a.rutsTrabajadores || []).filter(Boolean)
      if (!ruts.length) return { ok: false, error: "Sin trabajadores a asignar (¿todos=true o lista de RUTs?)." }
      for (const rut of ruts) {
        const idx = cfg.asignaciones.findIndex((x) => compacto(x.rutTrabajador) === compacto(rut))
        const fila = { rutTrabajador: rut, planificacion: a.planificacion, desde: a.desde, hasta: a.hasta }
        if (idx >= 0) cfg.asignaciones[idx] = fila
        else cfg.asignaciones.push(fila)
      }
      await guardarConfig(cfg)
      return { ok: true, asignados: ruts.length, ...estadoConfig(cfg) }
    }
    if (name === TOOL_CONFIRMAR_CONFIGURACION.name) {
      const confirmado = (input as { confirmacion_explicita?: boolean })?.confirmacion_explicita
      if (confirmado !== true) {
        return { ok: false, error: "Falta la confirmación explícita del cliente al resumen." }
      }
      const cfg = await cargarConfig()
      const faltas = pendientesConfiguracion(cfg)
      if (faltas.length) {
        // EL CANDADO (Lalo 25-ago): lo compartido se completa entero.
        return { ok: false, pendientes: faltas.map((f) => f.mensaje), instruccion: "Conversa estos puntos de a uno; recién con la lista vacía se puede cerrar." }
      }
      if (!cfg.trabajadores.length) {
        return { ok: false, error: "No hay nómina cargada — sin trabajadores no hay nada que cerrar." }
      }
      // Sesión del wizard: crear/reusar → escribir → cerrar (planillas + Flow).
      const { asegurarSesionWizard, escribirConfiguracionWizard, cerrarWizard } = await import("./wizard-sesion")
      const extras = await getKvValue(`onboarding_flow_extras_${contact}`)
        .then((v) => (v ? (JSON.parse(v) as { giro?: string; direccion?: string; comuna?: string }) : {}))
        .catch(() => ({}))
      let dealId = ""
      try {
        const { getQuotePointer } = await import("./supabase-persistence-v3")
        dealId = (await getQuotePointer(contact))?.dealId || ""
      } catch {}
      const b = await cargarBorrador(contact)
      const fallaOperativa = async (detalle: string) => {
        await avisarEquipoInterno(
          `⚠️ CONFIGURACIÓN ONBOARDING de +${contact} NO pudo cerrarse sola (${detalle}). ` +
            `La configuración conversada está íntegra en vic_kv ${claveConfiguracion(contact)} — cerrar a mano en el wizard.`,
        ).catch(() => {})
        return {
          ok: true,
          cerradoEnProceso: true,
          mensajeParaProspecto:
            "¡Quedó todo registrado! 🙌 Estoy dejando tu configuración cargada en la plataforma — te confirmo por este chat apenas esté lista (dentro del día hábil).",
        }
      }
      const ses = await asegurarSesionWizard(contact, b, { dealId, extras })
      if ("error" in ses) return await fallaOperativa(`sesión: ${ses.error}`)
      const w = await escribirConfiguracionWizard(ses.token, cfg)
      if ("error" in w) return await fallaOperativa(`escritura: ${w.error}`)
      const cierre = await cerrarWizard(ses.token, { idZoho: dealId || undefined })
      if ("error" in cierre) return await fallaOperativa(`cierre: ${cierre.error}`)
      await setKvValue(claveFase(contact), "completado").catch(() => {})
      await avisarEquipoInterno(
        `✅ CONFIGURACIÓN ONBOARDING de +${contact} cerrada por chat: ${cfg.trabajadores.length} trabajadores, ` +
          `${cfg.turnos.length} turnos, ${cfg.planificaciones.length} planificaciones. Sesión wizard ${ses.token}.`,
      ).catch(() => {})
      return {
        ok: true,
        mensajeParaProspecto:
          `¡Listo! Tu configuración quedó andando: ${cfg.trabajadores.length} trabajador${cfg.trabajadores.length === 1 ? "" : "es"}` +
          (cfg.planificaciones.length ? " con sus turnos y planificaciones" : "") +
          ". El equipo de implementación toma el relevo desde aquí — te llegará un correo con los próximos pasos y tu capacitación. Cualquier duda, este chat sigue abierto 😊",
      }
    }
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

      // Empresa YA registrada en la plataforma: no se crea encima (caso
      // Cofradía — cliente actual que compra un upgrade). La activación del
      // plan nuevo la hace el equipo sobre la cuenta existente. Se usa tanto
      // cuando lo dice exists como cuando lo atrapa el 409 del propio
      // servicio (carrera entre el exists y el create).
      const responderYaExiste = async (nombreExistente: string | null) => {
        await avisarEquipoInterno(
          `🏢 ALTA ONBOARDING CL: la empresa YA EXISTE en la plataforma (${nombreExistente || "sin nombre"}). ` +
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

      // SIMULACIÓN DEL ALTA (Lalo 25-ago): con la API de Nicolás caída, el
      // piloto ve la experiencia completa del alta exitosa — cuenta "creada"
      // + réplica del correo de bienvenida con contraseña temporal FALSA.
      // Doble candado: vic_kv alta_simulada=on Y contacto en el piloto.
      const simulada =
        (await getKvValue("alta_simulada").catch(() => null)) === "on" && (await esContactoPiloto(contact))
      if (altaApiConfigurada()) {
        const existe = simulada ? { exists: false, name: null } : await existeEmpresa(b.empresa.identificador!, "cl")
        if (existe?.exists) return await responderYaExiste(existe.name)
        if (existe && !existe.exists) {
          const alta = simulada
            ? await (async () => {
                const { enviarCorreoBienvenidaSimulado } = await import("./alta-simulada")
                const correo = await enviarCorreoBienvenidaSimulado({
                  nombre: b.admin.nombre!,
                  apellido: b.admin.apellido!,
                  email: b.admin.email!,
                })
                return {
                  ok: true as const,
                  companyId: `SIM-${Date.now()}`,
                  loginUserCreated: correo.ok,
                  workEmail: b.admin.email!,
                }
              })()
            : await crearEmpresaConAdmin({
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
          // Carrera entre el exists y el create: el 409 del propio servicio
          // (company_already_exists, verificado 02-ago) la atrapa — mismo
          // camino que exists=true, jamás alta manual duplicada.
          if (!alta.ok && alta.yaExiste) return await responderYaExiste(null)
          if (alta.ok) {
            await setKvValue(
              claveAltaSolicitada(contact),
              JSON.stringify({ at: new Date().toISOString(), companyId: alta.companyId, via: simulada ? "simulada" : "api" }),
            ).catch(() => {})
            await avisarEquipoInterno(
              `✅ ALTA ONBOARDING CL ${simulada ? "SIMULADA (piloto, sin API real)" : "creada POR API"} (companyId ${alta.companyId}) — contacto +${contact}.\n${fichaAlta}`,
            ).catch(() => {})
            // Correo de INSTRUCCIONES de ingreso (Lalo 25-ago, referencia
            // plantillas GeoAvanzado): viaja junto al de la contraseña,
            // best-effort — jamás bloquea el alta.
            import("./onboarding-correos")
              .then((m) =>
                m.enviarCorreoInstruccionesOnboarding({
                  adminNombre: `${b.admin.nombre} ${b.admin.apellido}`.trim(),
                  adminEmail: b.admin.email!,
                  empresa: b.empresa.nombre!,
                }),
              )
              .catch(() => {})
            // Copy en TERCERA persona sobre el admin (Lalo 02-ago): quien
            // chatea puede ser el admin o el comprador que nombró a otra
            // persona — hablar del admin por nombre y correo sirve en ambos
            // casos. La contraseña temporal viaja SOLO por el correo de la
            // plataforma: Vicky nunca la conoce ni la menciona.
            // Pasos de ingreso = pieza única compartida con el correo de
            // instrucciones (Lalo 25-ago, "versión WhatsApp del instructivo").
            const { pasosIngresoWhatsApp } = await import("./onboarding/instructivo")
            return {
              ok: true,
              mensajeParaProspecto:
                `¡${b.empresa.nombre} ya tiene su cuenta creada en GeoVictoria! 🎉\n\n` +
                `El acceso quedó a nombre de ${b.admin.nombre} ${b.admin.apellido}: la plataforma le envió un correo a ${alta.workEmail} con su contraseña temporal.\n\n` +
                `Para partir:\n${pasosIngresoWhatsApp({ loginUrl: LOGIN_URL || undefined })}\n\n` +
                `Y si quieres, aquí mismo dejamos cargados a tus trabajadores para que puedan marcar — me mandas la nómina en excel, foto o texto y yo la subo. ¿La cargamos?`,
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
    // Con el alta ya solicitada, el agente pasa a la fase de CONFIGURACIÓN
    // (F2): nómina + turnos/planificaciones opcionales, con el candado
    // determinista. Antes del alta, el prompt y las tools son los del alta.
    systemPrompt: altaSolicitada
      ? await (async () => {
          const cfg = await cargarConfig()
          const faltas = pendientesConfiguracion(cfg)
          const altaVia = await getKvValue(claveAltaSolicitada(contact)).catch(() => null)
          return promptConfiguracionCL({
            resumen: resumenConfiguracion(cfg),
            pendientes: faltas.map((f) => f.mensaje),
            nTrabajadores: cfg.trabajadores.length,
            altaCreada: /companyId/.test(String(altaVia || "")),
          })
        })()
      : promptOnboardingCL(borrador, { altaSolicitada }),
    tools: {
      schemas: (altaSolicitada
        ? [
            TOOL_GUARDAR_NOMINA,
            TOOL_DEFINIR_TURNO,
            TOOL_ARMAR_PLANIFICACION,
            TOOL_ASIGNAR_PLANIFICACION,
            TOOL_ELIMINAR_TRABAJADOR,
            TOOL_CONFIRMAR_CONFIGURACION,
            consultarAgenteSoporteSchema,
          ]
        : [
            TOOL_GUARDAR_DATOS_ONBOARDING,
            TOOL_CONFIRMAR_ALTA_EMPRESA,
            consultarAgenteSoporteSchema,
          ]) as unknown as unknown[],
      dispatch,
    },
  }
}
