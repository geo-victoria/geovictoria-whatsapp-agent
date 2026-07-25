/**
 * Tools de Vicky COLOMBIA — paridad con Vicky Chile.
 *
 * Set independiente del chileno — se inyecta a runAgentLoop vía el parámetro
 * `tools` del loop. Los precios SIEMPRE salen de acá (regla dura heredada de
 * Chile: el modelo copia mensajeParaProspecto, jamás calcula).
 *
 * Capacidades: cotización referencial, cotización FORMAL online (link de
 * aceptación + pago), derivación a ejecutivo (lead CO), soporte operativo
 * (mismo agente Foundry de Chile, con escalamiento a canales CO),
 * opt-out/perdido (marcar_no_contactar) y seguimiento consensuado
 * (programar_seguimiento) — las dos últimas son SEÑALES que procesa el route.
 * Pendientes de habilitación externa: agendar reuniones (falta calendario
 * Cal.com del equipo CO) y descuentos (sin escalera CO por decisión v1).
 */

import { cotizarCO, formatearCOP, type PuntoInstalacionCO } from "./cotizar"
import { clasificarUbicacionCO } from "./geografia"
import { nitValido, normalizarNit } from "./nit"
import { createZohoLead } from "../../zoho-leads"
import {
  consultarAgenteSoporte,
  consultarAgenteSoporteSchema,
} from "../../tools/consultar-agente-soporte"
import {
  marcarNoContactar,
  marcarNoContactarSchema,
} from "../../tools/marcar-no-contactar"
import { programarSeguimiento } from "../../tools/programar-seguimiento"
import {
  reenviarCotizacionCorreo,
  reenviarCotizacionCorreoSchema,
} from "../../tools/reenviar-cotizacion-correo"
import { agendarReunion } from "../../tools/agendar-reunion"
import { reagendarReunion } from "../../tools/reagendar-reunion"
import { checkSlotAvailability } from "../../calendar"

const COTIZADORA_API_BASE = (
  process.env.COTIZADORA_API_BASE || "https://cotizacion.geovictoria.com"
).trim()
const SECRET_COTIZADORA_CO = (
  process.env.VICKY_COTIZADORA_SECRET_CO ||
  process.env.VICKY_COTIZADORA_SECRET ||
  ""
).trim()

// Tómbola CO (SDRs observados en Zoho el 09-jul; emails por confirmar).
const SDR_CO_IDS = [
  "3525045000613817111", // Galindo
  "3525045000619732095", // Guerrero
  "3525045000639899035", // Quiroga Chia
]

// Ejecutivo comercial CO (Alejandro Gordillo) — paridad con Chile: los leads
// que nacen de un fallo/fallback del flujo de COTIZACIÓN quedan a su nombre
// (en CL van directo a Anderson, no a tómbola), porque él ya es dueño de las
// cotizaciones formales CO (VICKY_CO_OWNER_ID del cotizador) y retoma con
// todo el contexto.
const EJECUTIVO_CO_ZOHO_ID = (process.env.ZOHO_EJECUTIVO_CO_ID || "3525045000203758005").trim()

// Reparto determinista sin estado: hash del teléfono → índice. Distribuye
// parejo con volumen y evita depender de un contador compartido para el v1.
function ownerCoPara(contact: string): string {
  let h = 0
  for (const ch of contact) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return SDR_CO_IDS[h % SDR_CO_IDS.length]
}

// ── Reuniones CO (Cal.com) ──────────────────────────────────────────────────
// Gated por env: CAL_EVENT_TYPE_ID_CO = event type de Cal.com del equipo
// comercial de Colombia (event type 6292070, round robin CO). Sin la env,
// las tools de agenda NO se exponen al modelo y el prompt instruye derivar.
// Cuando el equipo cree el event type, basta setear la env + redeploy.
const CAL_EVENT_TYPE_ID_CO = (process.env.CAL_EVENT_TYPE_ID_CO || "").trim()
export const REUNIONES_CO_HABILITADAS = Boolean(CAL_EVENT_TYPE_ID_CO)

const TZ_CO = "America/Bogota"

function fechaLegibleCO(slotIso: string): string {
  return new Date(slotIso).toLocaleString("es-CO", {
    timeZone: TZ_CO,
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
}

// Escalamiento de soporte CO: el mensaje chileno trae teléfonos de Chile; acá
// van los canales válidos para Colombia (correo + horario). Cuando el equipo
// CO confirme un WhatsApp/teléfono local de soporte, se agrega aquí.
const MENSAJE_ESCALAMIENTO_SOPORTE_CO =
  "Para esta consulta te recomiendo escribir directamente a nuestro equipo de soporte:\n" +
  "📧 Email: *soporte@geovictoria.com*\n" +
  "Atienden de lunes a viernes de 8:30 a 18:30 y te ayudarán enseguida 🙌"

// programar_seguimiento con la zona horaria de Colombia como default (el
// resto del schema chileno aplica igual).
const programarSeguimientoSchemaCO = {
  name: "programar_seguimiento",
  description:
    "Úsala SOLO cuando el cliente da una señal EXPLÍCITA de que la decisión depende de otra persona o de otro factor y hay que esperar (ej. 'lo tengo que revisar con mi jefe', 'lo consulto con mi socio', 'espero la aprobación', 'escríbame el lunes'), Y acordaron CUÁNDO retomar. ANTES de llamarla, pregúntele al cliente cuándo sería un buen momento para escribirle. Con esto se programa UN solo seguimiento a esa fecha y se apagan los recordatorios automáticos de esta conversación. NO la use si el cliente solo quedó en silencio o se despidió sin dar un motivo de espera.",
  input_schema: {
    type: "object" as const,
    properties: {
      cuandoIso: {
        type: "string" as const,
        description:
          "Fecha y hora acordada para retomar, en formato ISO 8601 con zona horaria (ej. '2026-07-14T10:00:00-05:00'). Interpreta lo que dijo el cliente ('el lunes', 'en dos semanas') en SU zona horaria (default Colombia/America/Bogota, UTC-5) y conviértelo a este formato. Debe ser una fecha futura.",
      },
      motivo: {
        type: "string" as const,
        description:
          "Nota breve del factor de decisión (opcional), ej. 'lo consulta con su jefe', 'espera aprobación de presupuesto'.",
        maxLength: 200,
      },
    },
    required: ["cuandoIso"],
  },
}

export const TOOL_SCHEMAS_CO = [
  {
    name: "cotizar_referencial",
    description:
      "Calcula la cotización referencial de Colombia (1 a 50 usuarios) en pesos colombianos. Devuelve un `mensajeParaProspecto` listo para copiar TAL CUAL al prospecto — con la mensualidad y el pago inicial (activación = primer mes por adelantado; equipos/envío/instalación si aplican; el IVA del reloj ya viene indicado donde corresponde). NUNCA calcules ni enuncies precios tú: esta tool es la única fuente. Si la configuración lleva reloj, incluye `reloj` (modalidad y cantidad) y `puntosInstalacion` (uno por punto físico, con la ciudad/municipio tal como la dijo el cliente). En arriendo el envío y la instalación son GRATIS; en venta se cobran según zona (capital de departamento vs resto) — la tool clasifica la zona, tú solo transcribes la ubicación.",
    input_schema: {
      type: "object" as const,
      properties: {
        userCount: {
          type: "number" as const,
          description: "Cantidad de personas que marcarán asistencia (1-50).",
          minimum: 1,
          maximum: 50,
        },
        reloj: {
          type: "object" as const,
          properties: {
            modalidad: { type: "string" as const, enum: ["arriendo", "venta"] },
            cantidad: { type: "number" as const, minimum: 1, maximum: 50 },
          },
          required: ["modalidad", "cantidad"],
          description: "Solo si la configuración lleva equipo biométrico físico.",
        },
        puntosInstalacion: {
          type: "array" as const,
          items: {
            type: "object" as const,
            properties: {
              ubicacion: {
                type: "string" as const,
                description: "Ciudad/municipio tal como lo dijo el cliente (la tool clasifica capital/resto).",
              },
              autoInstalada: {
                type: "boolean" as const,
                description: "true si el cliente instalará el reloj por su cuenta.",
              },
            },
            required: ["ubicacion", "autoInstalada"],
          },
          description: "Un punto por cada lugar físico con reloj. Obligatorio si hay reloj en VENTA.",
        },
      },
      required: ["userCount"],
    },
  },
  {
    name: "generar_link_cotizadora",
    description:
      "Genera la COTIZACIÓN FORMAL de Colombia en el sistema (registro en el CRM + PDF + link de aceptación online donde el cliente revisa, acepta y paga con tarjeta). Úsala SOLO cuando el cliente ya vio el precio referencial, aceptó avanzar y te entregó los CUATRO datos: nombre completo, empresa, NIT (con dígito de verificación, ej. 900.123.456-7) y correo. Pasa la MISMA configuración con que cotizaste (userCount, reloj, puntosInstalacion). Devuelve `mensajeParaProspecto` con el link — cópialo TAL CUAL. Si el NIT es inválido devuelve error: pídele al cliente confirmarlo y vuelve a llamar. UNA sola cotización formal por conversación.",
    input_schema: {
      type: "object" as const,
      properties: {
        empresa: { type: "string" as const, description: "Razón social de la empresa." },
        contacto: { type: "string" as const, description: "Nombre completo de la persona." },
        nit: { type: "string" as const, description: "NIT con dígito de verificación (ej. 900.123.456-7)." },
        email: { type: "string" as const, description: "Correo del contacto." },
        userCount: { type: "number" as const, minimum: 1, maximum: 50 },
        reloj: {
          type: "object" as const,
          properties: {
            modalidad: { type: "string" as const, enum: ["arriendo", "venta"] },
            cantidad: { type: "number" as const, minimum: 1, maximum: 50 },
          },
          required: ["modalidad", "cantidad"],
        },
        puntosInstalacion: {
          type: "array" as const,
          items: {
            type: "object" as const,
            properties: {
              ubicacion: { type: "string" as const },
              autoInstalada: { type: "boolean" as const },
            },
            required: ["ubicacion", "autoInstalada"],
          },
        },
      },
      required: ["empresa", "contacto", "nit", "email", "userCount"],
    },
  },
  {
    name: "derivar_a_ejecutivo",
    description:
      "Registra al prospecto como lead en el CRM (territorio Colombia) y lo deriva al equipo comercial de GeoVictoria Colombia, que lo contactará para continuar (cotización formal, preguntas fuera de alcance, más de 50 usuarios, o solicitud explícita de hablar con una persona). Pasa TODO lo que sepas del prospecto. Si ya acordó una configuración y precios con la tool de cotización, inclúyelos en `resumen` para que el ejecutivo emita la cotización formal sin re-preguntar. Devuelve `mensajeParaProspecto` para confirmarle al cliente.",
    input_schema: {
      type: "object" as const,
      properties: {
        nombre: { type: "string" as const, description: "Nombre de la persona." },
        empresa: { type: "string" as const, description: "Nombre o razón social de la empresa." },
        email: { type: "string" as const, description: "Email del prospecto (si lo dio)." },
        nit: { type: "string" as const, description: "NIT de la empresa (si lo dio)." },
        trabajadores: { type: "number" as const, description: "Cantidad de personas (si la dio)." },
        ciudad: { type: "string" as const, description: "Ciudad (si la dio)." },
        motivo: {
          type: "string" as const,
          enum: ["cotizacion_formal", "fuera_de_alcance", "mas_de_50", "pidio_persona", "otro"],
        },
        resumen: {
          type: "string" as const,
          description: "Resumen para el ejecutivo: necesidad, configuración acordada, precios cotizados, dolores mencionados.",
        },
      },
      required: ["nombre", "motivo", "resumen"],
    },
  },
  // Soporte operativo: mismo agente Foundry de Chile (conocimiento de la
  // plataforma, país-agnóstico); el escalamiento humano usa canales CO.
  consultarAgenteSoporteSchema,
  // Señales de ciclo de contacto (mismas de Chile; las procesa el route CO).
  marcarNoContactarSchema,
  programarSeguimientoSchemaCO,
  // Agenda de reuniones (solo si el event type CO de Cal.com está configurado).
  ...(REUNIONES_CO_HABILITADAS
    ? [
        {
          name: "consultar_disponibilidad_horario",
          description:
            "Verifica si una fecha y hora propuesta POR EL CLIENTE está disponible en el calendario del equipo comercial de Colombia. Úsala cuando el cliente proponga un horario específico para una reunión (ej. 'el jueves a las 11'). Tú NUNCA propones horarios primero. Interpreta la propuesta en la zona horaria de Colombia (America/Bogota, UTC-5). Si hay un slot a menos de 15 min de la propuesta, devuelve 'disponible_exacto' (pasa ese slotIso a agendar_reunion). Si no, devuelve alternativas del mismo día o de días cercanos: preséntaselas en prosa natural y espera a que elija.",
          input_schema: {
            type: "object" as const,
            properties: {
              fechaPropuesta: {
                type: "string" as const,
                description:
                  "Fecha y hora propuesta por el cliente, en ISO 8601 con timezone (ej. '2026-07-15T15:00:00-05:00'), interpretada en America/Bogota.",
              },
            },
            required: ["fechaPropuesta"],
          },
        },
        {
          name: "agendar_reunion",
          description:
            "Agenda una reunión con un ejecutivo del equipo comercial de Colombia. Crea la reunión en el calendario, registra el lead en el CRM a nombre del ejecutivo asignado y crea el evento. Llamar SOLO cuando el cliente confirmó explícitamente un horario específico (idealmente tras consultar_disponibilidad_horario con 'disponible_exacto', usando el slotIso que devolvió). Antes de invocarla capture nombre completo, correo y empresa — son obligatorios.",
          input_schema: {
            type: "object" as const,
            properties: {
              slotIso: {
                type: "string" as const,
                description:
                  "Slot ISO 8601 confirmado por el cliente (el slotIso de consultar_disponibilidad_horario si hubo match exacto).",
              },
              prospectName: { type: "string" as const, description: "Nombre completo del cliente." },
              prospectEmail: { type: "string" as const, description: "Correo del cliente (recibe la invitación)." },
              empresa: { type: "string" as const, description: "Empresa del cliente." },
              telefono: { type: "string" as const, description: "Teléfono del cliente." },
              trabajadores: { type: "string" as const, description: "Cantidad de personas, si la dio." },
              necesidad: { type: "string" as const, description: "Qué busca el cliente." },
              cargo: { type: "string" as const, description: "Cargo del contacto, si lo mencionó." },
            },
            required: ["slotIso", "prospectName", "prospectEmail"],
          },
        },
        {
          name: "reagendar_reunion",
          description:
            "Reagenda la reunión que el cliente YA tiene agendada a un nuevo horario. Úsala cuando un cliente con reunión existente pide cambiarla de día/hora. Llama SOLO con un slot confirmado por el cliente (idealmente tras consultar_disponibilidad_horario con 'disponible_exacto'). NO uses agendar_reunion para reagendar: esa crea una reunión nueva. No necesita identificador: ubica automáticamente la reunión futura del cliente.",
          input_schema: {
            type: "object" as const,
            properties: {
              newSlotIso: {
                type: "string" as const,
                description: "Nuevo slot ISO 8601 confirmado por el cliente.",
              },
            },
            required: ["newSlotIso"],
          },
        },
      ]
    : []),
  // Reenvío de la cotización formal a un tercero — SOLO por correo (regla
  // Lalo 20-jul: no invadir por WhatsApp a quien no pidió contacto).
  reenviarCotizacionCorreoSchema,
]

type CotizarInput = {
  userCount?: number
  reloj?: { modalidad?: "arriendo" | "venta"; cantidad?: number }
  puntosInstalacion?: Array<{ ubicacion?: string; autoInstalada?: boolean }>
}

type DerivarInput = {
  nombre?: string
  empresa?: string
  email?: string
  nit?: string
  trabajadores?: number
  ciudad?: string
  motivo?: string
  resumen?: string
}

export function buildDispatchCO(contact: string) {
  return async function dispatchToolCO(name: string, input: unknown): Promise<unknown> {
    try {
      if (name === "cotizar_referencial") {
        const i = (input || {}) as CotizarInput
        const userCount = Number(i.userCount || 0)
        const advertencias: string[] = []
        let puntos: PuntoInstalacionCO[] = []
        if (i.reloj && i.reloj.modalidad === "venta") {
          const entradas = Array.isArray(i.puntosInstalacion) ? i.puntosInstalacion : []
          if (entradas.length === 0) {
            return {
              ok: false,
              error:
                "El reloj en VENTA requiere puntosInstalacion (ciudad y autoInstalada por punto). Pregunta la ubicación y si instalan ellos o GeoVictoria, y vuelve a llamar la tool.",
            }
          }
          puntos = entradas.map((p) => {
            const c = clasificarUbicacionCO(String(p?.ubicacion || ""))
            if (!c.reconocida) {
              advertencias.push(
                `Ubicación '${p?.ubicacion}' no reconocida como capital de departamento: se aplicó tarifa de resto del país.`,
              )
            }
            return {
              ubicacion: String(p?.ubicacion || ""),
              zona: c.zona,
              autoInstalada: p?.autoInstalada === true,
            }
          })
        }
        const r = cotizarCO({
          userCount,
          reloj:
            i.reloj && i.reloj.modalidad && Number(i.reloj.cantidad) > 0
              ? { modalidad: i.reloj.modalidad, cantidad: Number(i.reloj.cantidad) }
              : undefined,
          puntos,
        })
        return { ok: true, mensajeParaProspecto: r.mensajeParaProspecto, advertencias }
      }

      if (name === "generar_link_cotizadora") {
        const i = (input || {}) as {
          empresa?: string
          contacto?: string
          nit?: string
          email?: string
          userCount?: number
          reloj?: { modalidad?: "arriendo" | "venta"; cantidad?: number }
          puntosInstalacion?: Array<{ ubicacion?: string; autoInstalada?: boolean }>
        }
        if (!SECRET_COTIZADORA_CO) {
          return { ok: false, error: "Cotizadora CO no configurada (secreto faltante). Deriva al ejecutivo." }
        }
        if (!i.nit || !nitValido(i.nit)) {
          return {
            ok: false,
            error: `El NIT '${i.nit || ""}' no es válido (el dígito de verificación no cuadra). Pídele al cliente confirmar el NIT completo (ej. 900.123.456-7) y vuelve a llamar la tool.`,
          }
        }
        if (!i.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(i.email)) {
          return { ok: false, error: `El correo '${i.email || ""}' no tiene formato válido. Pídelo de nuevo.` }
        }
        // Misma clasificación de puntos que la referencial (venta exige puntos).
        let puntos: PuntoInstalacionCO[] = []
        if (i.reloj?.modalidad === "venta") {
          const entradas = Array.isArray(i.puntosInstalacion) ? i.puntosInstalacion : []
          if (entradas.length === 0) {
            return { ok: false, error: "El reloj en VENTA requiere puntosInstalacion. Pregunta ciudad y quién instala." }
          }
          puntos = entradas.map((p) => ({
            ubicacion: String(p?.ubicacion || ""),
            zona: clasificarUbicacionCO(String(p?.ubicacion || "")).zona,
            autoInstalada: p?.autoInstalada === true,
          }))
        }
        const calculo = cotizarCO({
          userCount: Number(i.userCount || 0),
          reloj:
            i.reloj && i.reloj.modalidad && Number(i.reloj.cantidad) > 0
              ? { modalidad: i.reloj.modalidad, cantidad: Number(i.reloj.cantidad) }
              : undefined,
          puntos,
        })
        const res = await fetch(`${COTIZADORA_API_BASE}/api/quote-acceptance/create-from-vicky-co`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-vicky-secret": SECRET_COTIZADORA_CO },
          body: JSON.stringify({
            empresa: i.empresa,
            contacto: i.contacto,
            contactoEmail: i.email,
            nit: normalizarNit(i.nit),
            contactoTelefono: `+${contact}`,
            userCount: Number(i.userCount || 0),
            items: calculo.itemsCotizador,
          }),
          cache: "no-store",
        })
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean
          acceptanceUrl?: string
          quoteId?: string
          error?: string
        }
        if (!res.ok || !data.ok || !data.acceptanceUrl) {
          console.error(`[co-tools] create-from-vicky-co falló contact=${contact}:`, JSON.stringify(data).slice(0, 300))
          return {
            ok: false,
            error: `No se pudo generar la cotización formal (${data.error || res.status}). NO insistas: usa derivar_a_ejecutivo (motivo cotizacion_formal) con toda la configuración en el resumen.`,
          }
        }
        return {
          ok: true,
          quoteId: data.quoteId,
          // Campos que el agent-loop persiste en el puntero durable de la
          // cotización (anti-amnesia: retomar la formal en turnos futuros).
          acceptanceUrl: data.acceptanceUrl,
          totalCLP: calculo.pagoInicialTotal,
          mensajeParaProspecto: `Listo!! Tu cotización formal quedó generada 🎉\n\nAquí la revisas, la aceptas y pagas en línea con tarjeta vía Mercado Pago (se confirma al instante): ${data.acceptanceUrl}\n\nEl pago inicial es de ${formatearCOP(calculo.pagoInicialTotal)} y tu mensualidad de ${formatearCOP(calculo.mensualTotal)} desde el mes siguiente. Con el pago confirmado, yo misma te acompaño con la puesta en marcha de tu cuenta. Cualquier duda me cuentas 😊`,
        }
      }

      if (name === "derivar_a_ejecutivo") {
        const i = (input || {}) as DerivarInput
        const nitInfo = i.nit
          ? nitValido(i.nit)
            ? `NIT ${normalizarNit(i.nit)} (válido)`
            : `NIT ${i.nit} (dígito de verificación NO cuadra — confirmar)`
          : ""
        const res = await createZohoLead({
          nombre: i.nombre,
          empresa: i.empresa,
          email: i.email,
          telefono: contact,
          contactoWA: contact,
          pais: "Colombia",
          ciudad: i.ciudad,
          trabajadores: i.trabajadores,
          necesidad: [i.resumen || "", nitInfo].filter(Boolean).join(" · "),
          // Fallback de cotización → Alejandro directo (paridad CL/Anderson);
          // el resto (callback, fuera de alcance, >50) sigue en la tómbola SDR.
          ownerId: i.motivo === "cotizacion_formal" ? EJECUTIVO_CO_ZOHO_ID : ownerCoPara(contact),
        })
        if (!res || (res as { ok?: boolean }).ok === false) {
          return {
            ok: false,
            error: "No se pudo registrar el lead. Igual confirma al cliente que el equipo lo contactará.",
            mensajeParaProspecto:
              "Listo, dejé tus datos registrados 😊 Una persona de nuestro equipo comercial en Colombia te contactará muy pronto para continuar.",
          }
        }
        return {
          ok: true,
          mensajeParaProspecto:
            "Listo, quedaste registrado 🎉 Una persona de nuestro equipo comercial en Colombia te contactará muy pronto para continuar con tu cotización.",
        }
      }

      // Soporte operativo: misma implementación chilena (agente Foundry). El
      // escalamiento humano reemplaza los canales chilenos por los de CO, y
      // las respuestas intermedias se sanean por si el agente cuela un
      // teléfono de soporte CHILENO en el texto (base de conocimiento CL).
      if (name === "consultar_agente_soporte") {
        const sanearCanalesChilenos = (texto: string): string =>
          texto
            .replace(/\+?\s*56\s*9[\s.\-]*\d{4}[\s.\-]*\d{4}/g, "soporte@geovictoria.com")
            .replace(/600[\s.\-]*914[\s.\-]*3819/g, "soporte@geovictoria.com")
        const r = await consultarAgenteSoporte(input as never)
        if (!r.ok) return r
        if (r.accion === "escalar_humano") {
          return {
            ...r,
            respuestaAgente: sanearCanalesChilenos(r.respuestaAgente || ""),
            mensajeParaProspecto: MENSAJE_ESCALAMIENTO_SOPORTE_CO,
          }
        }
        return { ...r, respuestaAgente: sanearCanalesChilenos(r.respuestaAgente || "") }
      }

      // Agenda CO (Cal.com): mismas implementaciones chilenas con el event
      // type de Colombia, timezone Bogotá y confirmaciones en tuteo cálido CO.
      if (name === "consultar_disponibilidad_horario") {
        if (!REUNIONES_CO_HABILITADAS) {
          return { ok: false, error: "La agenda de Colombia no está configurada. Usa derivar_a_ejecutivo (motivo pidio_persona) con la preferencia de horario en el resumen." }
        }
        const i = (input || {}) as { fechaPropuesta?: string }
        const disp = await checkSlotAvailability({
          slotIso: String(i.fechaPropuesta || ""),
          country: "Colombia",
          eventTypeId: CAL_EVENT_TYPE_ID_CO,
        })
        // Etiquetas legibles pre-calculadas en hora de Bogotá (bug 17-jul: el
        // modelo escribía mal el día de la semana y el cliente anotaba el día
        // equivocado). Aditivo: shape original intacto.
        if (disp.ok && disp.estado === "disponible_exacto") {
          return { ...disp, etiqueta: fechaLegibleCO(disp.slotIso) }
        }
        if (
          disp.ok &&
          (disp.estado === "alternativas_mismo_dia" || disp.estado === "alternativas_dias_cercanos")
        ) {
          return { ...disp, etiquetas: disp.alternativas.map((s) => fechaLegibleCO(s)) }
        }
        return disp
      }
      if (name === "agendar_reunion") {
        if (!REUNIONES_CO_HABILITADAS) {
          return { ok: false, error: "La agenda de Colombia no está configurada. Usa derivar_a_ejecutivo (motivo pidio_persona)." }
        }
        const r = await agendarReunion({
          ...(input as object),
          // Teléfono del canal si el modelo no lo pasó (igual que derivar_a_
          // ejecutivo): sin él, el Lead en Zoho queda sin Phone.
          telefono:
            ((input as { telefono?: string })?.telefono || "").trim() || contact,
          country: "Colombia",
          eventTypeId: CAL_EVENT_TYPE_ID_CO,
        } as never)
        if (!r.ok) return r
        const email = (input as { prospectEmail?: string })?.prospectEmail || "tu correo"
        return {
          ...r,
          // El agent-loop persiste la reunión con esta zona (recordatorios).
          timezone: TZ_CO,
          // Confirmación en tuteo cálido colombiano.
          mensajeParaProspecto:
            `Listo!! Tu reunión quedó agendada para el ${fechaLegibleCO(r.slotIso)} (hora de Colombia) 🎉 ` +
            `Te llegará la invitación con el link de la reunión a ${email}. Te puedo ayudar en algo más?`,
        }
      }
      if (name === "reagendar_reunion") {
        if (!REUNIONES_CO_HABILITADAS) {
          return { ok: false, error: "La agenda de Colombia no está configurada. Usa derivar_a_ejecutivo (motivo pidio_persona)." }
        }
        const r = await reagendarReunion({ ...(input as object), country: "Colombia" } as never)
        if (!r.ok) return r
        return {
          ...r,
          mensajeParaProspecto:
            `Listo!! Tu reunión quedó reagendada para el ${fechaLegibleCO(r.slotIso)} (hora de Colombia) 📅 ` +
            `Te llegará la nueva invitación por correo. Te puedo ayudar en algo más?`,
        }
      }

      // Señales (sin efectos externos aquí): el route CO las procesa al ver el
      // tool_call ok — cierra/pausa/programa el ciclo de seguimiento.
      if (name === "marcar_no_contactar") return marcarNoContactar(input as never)
      if (name === "programar_seguimiento") {
        const r = programarSeguimiento(input as never)
        if (!("ok" in r) || r.ok !== true) return r
        // Confirmación en tuteo cálido colombiano (feedback equipo CO 12-jul).
        return {
          ...r,
          mensajeParaProspecto:
            "Perfecto, lo dejamos así 😊 Te escribo cuando quedamos para retomar, sin presión. Si necesitas algo antes, aquí estoy 🙌",
        }
      }

      if (name === "reenviar_cotizacion_correo") {
        return await reenviarCotizacionCorreo(input as never)
      }

      return { ok: false, error: `Tool desconocida: ${name}` }
    } catch (err) {
      return { ok: false, error: String((err as Error)?.message || err) }
    }
  }
}
