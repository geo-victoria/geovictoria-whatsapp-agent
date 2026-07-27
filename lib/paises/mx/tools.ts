/**
 * Tools de Vicky MÉXICO — paridad con Vicky Chile/Colombia.
 *
 * Set independiente — se inyecta a runAgentLoop vía el parámetro `tools` del
 * loop. Los precios SIEMPRE salen de acá (regla dura heredada de Chile: el
 * modelo copia mensajeParaProspecto, jamás calcula).
 *
 * Capacidades: cotización referencial (con capacitación $600 SIEMPRE en el
 * desglose e IVA 16% en los totales), cotización FORMAL online (link de
 * aceptación + pago), derivación a ejecutivo (lead MX a nombre de Yahel
 * Segura — sin tómbola SDR en el v1), soporte operativo (mismo agente
 * Foundry de Chile, con escalamiento a canales MX), opt-out/perdido
 * (marcar_no_contactar), seguimiento consensuado (programar_seguimiento,
 * default America/Mexico_City) y reenvío de la formal por correo — las
 * señales las procesa el route. Pendiente de habilitación externa: agendar
 * reuniones (falta el event type Cal.com del equipo MX).
 */

import { cotizarMX, formatearMXN, type PuntoInstalacionMX } from "./cotizar"
import { clasificarUbicacionMX } from "./geografia"
import { rfcValido, normalizarRfc } from "./rfc"
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
const SECRET_COTIZADORA_MX = (
  process.env.VICKY_COTIZADORA_SECRET_MX ||
  process.env.VICKY_COTIZADORA_SECRET ||
  ""
).trim()

// Ejecutivo comercial MX (Yahel Segura) — v1 SIN tómbola SDR: TODOS los leads
// derivados quedan a su nombre (documento de tropicalización MX). Cuando el
// equipo MX defina SDRs para round-robin, agregar acá el reparto.
const EJECUTIVO_MX_ZOHO_ID = (process.env.ZOHO_EJECUTIVO_MX_ID || "3525045000308323003").trim()

// ── Reuniones MX (Cal.com) ──────────────────────────────────────────────────
// Event type 6101466 (Lalo, 27-jul): agendamiento SIN cotización — la llamada
// exploratoria del equipo MX (espejo del 3188650 chileno). Default en código
// con override por env, mismo patrón que CAL_EVENT_TYPE_ID en lib/calendar.
// El Lead queda a nombre del ejecutivo que Cal.com asigne en ese event type
// (hoy: Yahel). Vaciar CAL_EVENT_TYPE_ID_MX="" en Vercel apaga la agenda y
// vuelve al fallback de derivar_a_ejecutivo.
const CAL_EVENT_TYPE_ID_MX = (process.env.CAL_EVENT_TYPE_ID_MX ?? "6101466").trim()
export const REUNIONES_MX_HABILITADAS = Boolean(CAL_EVENT_TYPE_ID_MX)

const TZ_MX = "America/Mexico_City"

function fechaLegibleMX(slotIso: string): string {
  return new Date(slotIso).toLocaleString("es-MX", {
    timeZone: TZ_MX,
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
}

// Escalamiento de soporte MX: el mensaje chileno trae teléfonos de Chile; acá
// van los canales válidos para México (correo + horario). El soporte MX lo
// atienden Pablo Rodríguez y Miguel Guzmán; cuando el equipo confirme un
// WhatsApp/teléfono local de soporte, se agrega aquí.
const MENSAJE_ESCALAMIENTO_SOPORTE_MX =
  "Para esta consulta te recomiendo escribir directamente a nuestro equipo de soporte:\n" +
  "📧 Email: *soporte@geovictoria.com*\n" +
  "Atienden de lunes a viernes de 8:30 a 18:30 y te ayudarán enseguida 🙌"

// programar_seguimiento con la zona horaria de México como default (el resto
// del schema chileno aplica igual).
const programarSeguimientoSchemaMX = {
  name: "programar_seguimiento",
  description:
    "Úsala SOLO cuando el cliente da una señal EXPLÍCITA de que la decisión depende de otra persona o de otro factor y hay que esperar (ej. 'lo tengo que revisar con mi jefe', 'lo consulto con mi socio', 'espero la aprobación', 'escríbeme el lunes'), Y acordaron CUÁNDO retomar. ANTES de llamarla, pregúntale al cliente cuándo sería un buen momento para escribirle. Con esto se programa UN solo seguimiento a esa fecha y se apagan los recordatorios automáticos de esta conversación. NO la uses si el cliente solo quedó en silencio o se despidió sin dar un motivo de espera.",
  input_schema: {
    type: "object" as const,
    properties: {
      cuandoIso: {
        type: "string" as const,
        description:
          "Fecha y hora acordada para retomar, en formato ISO 8601 con zona horaria (ej. '2026-07-27T10:00:00-06:00'). Interpreta lo que dijo el cliente ('el lunes', 'en dos semanas') en SU zona horaria (default México/America/Mexico_City, UTC-6) y conviértelo a este formato. Debe ser una fecha futura.",
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

// Comprobante de transferencia MX (22-jul): mientras no exista MercadoPago
// México el pago inicial va por transferencia BANORTE; al recibir el
// comprobante la tool entrega el acceso al auto-onboarding y presenta a la
// ejecutiva. Espejo del schema chileno con montos en MXN.
const registrarComprobanteMXSchema = {
  name: "registrar_comprobante_transferencia",
  description:
    "Registra un comprobante de transferencia bancaria que el cliente envió por el chat (imagen o PDF descrito en el historial). Úsala SIEMPRE que el cliente mande un comprobante de pago de su cotización. Extrae del comprobante lo que se vea: monto transferido (MXN), banco y fecha. La tool asocia el comprobante a la cotización vigente, avisa al equipo y devuelve mensajeParaProspecto con la confirmación de recepción, el LINK del auto-onboarding y la presentación de la ejecutiva — copia el mensajeParaProspecto TAL CUAL, sin agregar ni quitar nada. El pago queda EN VERIFICACIÓN: nunca afirmes tú que el pago ya está confirmado.",
  input_schema: {
    type: "object" as const,
    properties: {
      montoDetectado: {
        type: "number" as const,
        description:
          "Monto en pesos mexicanos que muestra el comprobante (solo dígitos). Si la imagen no deja leer el monto, pasa 0.",
      },
      bancoOrigen: { type: "string" as const, description: "Banco emisor si se ve en el comprobante." },
      fechaDetectada: { type: "string" as const, description: "Fecha de la transferencia si se ve." },
      detalle: {
        type: "string" as const,
        description: "Resumen en una frase de lo que muestra el comprobante (destinatario, hora, clave de rastreo).",
      },
    },
    required: ["montoDetectado"],
  },
}

export const TOOL_SCHEMAS_MX = [
  registrarComprobanteMXSchema,
  {
    name: "cotizar_referencial",
    description:
      "Calcula la cotización referencial de México (1 a 50 usuarios) en pesos mexicanos. Devuelve un `mensajeParaProspecto` listo para copiar TAL CUAL al prospecto — con la mensualidad y el pago inicial (SIN activación — en México no se cobra el primer mes por adelantado; capacitación online $600 SIEMPRE cobrada; equipos/envío/instalación si aplican; los totales ya incluyen el IVA 16%). NUNCA calcules ni enuncies precios tú: esta tool es la única fuente. Si la configuración lleva reloj, incluye `reloj` (modalidad y cantidad) y `puntosInstalacion` (uno por punto físico, con la ciudad/alcaldía/municipio tal como la dijo el cliente). En renta el envío es GRATIS en todo México y la instalación es GRATIS en CDMX/Zona Metropolitana; en venta el envío tiene tarifa única nacional y la instalación profesional solo se cotiza en CDMX/Zona Metropolitana (fuera de esa zona la cotiza el ejecutivo aparte, o el cliente auto-instala gratis) — la tool clasifica la zona, tú solo transcribes la ubicación.",
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
          description: "Solo si la configuración lleva reloj checador físico.",
        },
        puntosInstalacion: {
          type: "array" as const,
          items: {
            type: "object" as const,
            properties: {
              ubicacion: {
                type: "string" as const,
                description:
                  "Ciudad/alcaldía/municipio tal como lo dijo el cliente (la tool clasifica CDMX-Zona Metropolitana vs resto).",
              },
              autoInstalada: {
                type: "boolean" as const,
                description: "true si el cliente instalará el reloj por su cuenta.",
              },
            },
            required: ["ubicacion", "autoInstalada"],
          },
          description:
            "Un punto por cada lugar físico con reloj. Obligatorio si hay reloj en VENTA; en renta pásalo si conoces las ubicaciones (sirve para confirmar la instalación incluida).",
        },
      },
      required: ["userCount"],
    },
  },
  {
    name: "generar_link_cotizadora",
    description:
      "Genera la COTIZACIÓN FORMAL de México en el sistema (registro en el CRM + PDF + link de aceptación online donde el cliente revisa, acepta y paga en línea). Úsala SOLO cuando el cliente ya vio el precio referencial, aceptó avanzar y te entregó los CUATRO datos: nombre completo, empresa, RFC (12 caracteres persona moral o 13 persona física, con o sin guiones o espacios) y correo. Pasa la MISMA configuración con que cotizaste (userCount, reloj, puntosInstalacion). Devuelve `mensajeParaProspecto` con el link — cópialo TAL CUAL. Si el RFC es inválido devuelve error: pídele al cliente confirmarlo y vuelve a llamar. UNA sola cotización formal por conversación.",
    input_schema: {
      type: "object" as const,
      properties: {
        empresa: { type: "string" as const, description: "Razón social de la empresa." },
        contacto: { type: "string" as const, description: "Nombre completo de la persona." },
        rfc: {
          type: "string" as const,
          description:
            "RFC de la empresa o persona (ej. CEC2005286R4). Acéptalo como lo dé el cliente: con o sin guiones o espacios, mayúsculas o minúsculas.",
        },
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
      required: ["empresa", "contacto", "rfc", "email", "userCount"],
    },
  },
  {
    name: "derivar_a_ejecutivo",
    description:
      "Registra al prospecto como lead en el CRM (territorio México) y lo deriva al equipo comercial de GeoVictoria México, que lo contactará para continuar (cotización formal, preguntas fuera de alcance, más de 50 usuarios, o solicitud explícita de hablar con una persona). Pasa TODO lo que sepas del prospecto. Si ya acordó una configuración y precios con la tool de cotización, inclúyelos en `resumen` para que el ejecutivo emita la cotización formal sin re-preguntar. Devuelve `mensajeParaProspecto` para confirmarle al cliente.",
    input_schema: {
      type: "object" as const,
      properties: {
        nombre: { type: "string" as const, description: "Nombre de la persona." },
        empresa: { type: "string" as const, description: "Nombre o razón social de la empresa." },
        email: { type: "string" as const, description: "Email del prospecto (si lo dio)." },
        rfc: { type: "string" as const, description: "RFC de la empresa (si lo dio)." },
        trabajadores: { type: "number" as const, description: "Cantidad de personas (si la dio)." },
        ciudad: { type: "string" as const, description: "Ciudad (si la dio)." },
        motivo: {
          type: "string" as const,
          enum: ["cotizacion_formal", "fuera_de_alcance", "mas_de_50", "pidio_persona", "otro"],
        },
        resumen: {
          type: "string" as const,
          description:
            "Resumen para el ejecutivo: necesidad, configuración acordada, precios cotizados, dolores mencionados (incluye si quedó instalación fuera de CDMX/Zona Metropolitana por cotizar).",
        },
      },
      required: ["nombre", "motivo", "resumen"],
    },
  },
  // Soporte operativo: mismo agente Foundry de Chile (conocimiento de la
  // plataforma, país-agnóstico); el escalamiento humano usa canales MX.
  consultarAgenteSoporteSchema,
  // Señales de ciclo de contacto (mismas de Chile; las procesa el route MX).
  marcarNoContactarSchema,
  programarSeguimientoSchemaMX,
  // Agenda de reuniones (solo si el event type MX de Cal.com está configurado).
  ...(REUNIONES_MX_HABILITADAS
    ? [
        {
          name: "consultar_disponibilidad_horario",
          description:
            "Verifica si una fecha y hora propuesta POR EL CLIENTE está disponible en el calendario del equipo comercial de México. Úsala cuando el cliente proponga un horario específico para una reunión (ej. 'el jueves a las 11'). Tú NUNCA propones horarios primero. Interpreta la propuesta en la zona horaria de Ciudad de México (America/Mexico_City, UTC-6). Si hay un slot a menos de 15 min de la propuesta, devuelve 'disponible_exacto' (pasa ese slotIso a agendar_reunion). Si no, devuelve alternativas del mismo día o de días cercanos: preséntaselas en prosa natural y espera a que elija.",
          input_schema: {
            type: "object" as const,
            properties: {
              fechaPropuesta: {
                type: "string" as const,
                description:
                  "Fecha y hora propuesta por el cliente, en ISO 8601 con timezone (ej. '2026-07-27T15:00:00-06:00'), interpretada en America/Mexico_City.",
              },
            },
            required: ["fechaPropuesta"],
          },
        },
        {
          name: "agendar_reunion",
          description:
            "Agenda una reunión con un ejecutivo del equipo comercial de México. Crea la reunión en el calendario, registra el lead en el CRM a nombre del ejecutivo asignado y crea el evento. Llamar SOLO cuando el cliente confirmó explícitamente un horario específico (idealmente tras consultar_disponibilidad_horario con 'disponible_exacto', usando el slotIso que devolvió). Antes de invocarla captura nombre completo, correo y empresa — son obligatorios.",
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
  // Lalo 20-jul heredada: no invadir por WhatsApp a quien no pidió contacto).
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
  rfc?: string
  trabajadores?: number
  ciudad?: string
  motivo?: string
  resumen?: string
}

// Clasifica los puntos que vienen del modelo con clasificarUbicacionMX.
// Acumula advertencias de ubicación no reconocida (fuera de CDMX/Zona
// Metropolitana → la instalación profesional queda para el ejecutivo).
function clasificarPuntosMX(
  entradas: Array<{ ubicacion?: string; autoInstalada?: boolean }>,
  advertencias?: string[],
): PuntoInstalacionMX[] {
  return entradas.map((p) => {
    const c = clasificarUbicacionMX(String(p?.ubicacion || ""))
    if (!c.reconocida && advertencias) {
      advertencias.push(
        `Ubicación '${p?.ubicacion}' no reconocida como CDMX/Zona Metropolitana: se trató como resto del país (instalación profesional a cotizar por el ejecutivo; el envío no cambia).`,
      )
    }
    return {
      ubicacion: String(p?.ubicacion || ""),
      zona: c.zona,
      autoInstalada: p?.autoInstalada === true,
    }
  })
}

export function buildDispatchMX(contact: string) {
  return async function dispatchToolMX(name: string, input: unknown): Promise<unknown> {
    try {
      if (name === "registrar_comprobante_transferencia") {
        const { registrarComprobanteTransferencia } = await import(
          "@/lib/tools/registrar-comprobante-transferencia"
        )
        return await registrarComprobanteTransferencia(
          contact,
          (input || {}) as Parameters<typeof registrarComprobanteTransferencia>[1],
          "mx",
        )
      }

      if (name === "cotizar_referencial") {
        const i = (input || {}) as CotizarInput
        const userCount = Number(i.userCount || 0)
        const advertencias: string[] = []
        let puntos: PuntoInstalacionMX[] = []
        if (i.reloj && i.reloj.modalidad === "venta") {
          const entradas = Array.isArray(i.puntosInstalacion) ? i.puntosInstalacion : []
          if (entradas.length === 0) {
            return {
              ok: false,
              error:
                "El reloj en VENTA requiere puntosInstalacion (ciudad y autoInstalada por punto). Pregunta la ubicación y si instalan ellos o GeoVictoria, y vuelve a llamar la tool.",
            }
          }
          puntos = clasificarPuntosMX(entradas, advertencias)
        } else if (i.reloj && i.reloj.modalidad === "arriendo") {
          // En renta los puntos son opcionales (todo va sin costo en zona
          // cubierta); si vienen, se clasifican para la nota de instalación
          // fuera de CDMX/Zona Metropolitana.
          const entradas = Array.isArray(i.puntosInstalacion) ? i.puntosInstalacion : []
          puntos = clasificarPuntosMX(entradas, advertencias)
        }
        const r = cotizarMX({
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
          rfc?: string
          email?: string
          userCount?: number
          reloj?: { modalidad?: "arriendo" | "venta"; cantidad?: number }
          puntosInstalacion?: Array<{ ubicacion?: string; autoInstalada?: boolean }>
        }
        if (!SECRET_COTIZADORA_MX) {
          return { ok: false, error: "Cotizadora MX no configurada (secreto faltante). Deriva al ejecutivo." }
        }
        if (!i.rfc || !rfcValido(i.rfc)) {
          return {
            ok: false,
            error: `El RFC '${i.rfc || ""}' no tiene un formato válido (12 caracteres persona moral o 13 persona física, ej. CEC2005286R4). Pídele al cliente confirmarlo — sirve con o sin guiones o espacios — y vuelve a llamar la tool.`,
          }
        }
        if (!i.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(i.email)) {
          return { ok: false, error: `El correo '${i.email || ""}' no tiene formato válido. Pídelo de nuevo.` }
        }
        // Misma clasificación de puntos que la referencial (venta exige puntos;
        // renta los acepta si vienen).
        let puntos: PuntoInstalacionMX[] = []
        if (i.reloj?.modalidad === "venta") {
          const entradas = Array.isArray(i.puntosInstalacion) ? i.puntosInstalacion : []
          if (entradas.length === 0) {
            return { ok: false, error: "El reloj en VENTA requiere puntosInstalacion. Pregunta ciudad y quién instala." }
          }
          puntos = clasificarPuntosMX(entradas)
        } else if (i.reloj?.modalidad === "arriendo") {
          puntos = clasificarPuntosMX(
            Array.isArray(i.puntosInstalacion) ? i.puntosInstalacion : [],
          )
        }
        const calculo = cotizarMX({
          userCount: Number(i.userCount || 0),
          reloj:
            i.reloj && i.reloj.modalidad && Number(i.reloj.cantidad) > 0
              ? { modalidad: i.reloj.modalidad, cantidad: Number(i.reloj.cantidad) }
              : undefined,
          puntos,
        })
        const res = await fetch(`${COTIZADORA_API_BASE}/api/quote-acceptance/create-from-vicky-mx`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-vicky-secret": SECRET_COTIZADORA_MX },
          body: JSON.stringify({
            empresa: i.empresa,
            contacto: i.contacto,
            contactoEmail: i.email,
            rfc: normalizarRfc(i.rfc),
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
          console.error(`[mx-tools] create-from-vicky-mx falló contact=${contact}:`, JSON.stringify(data).slice(0, 300))
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
          // La clave se llama totalCLP por herencia chilena: acá viaja el
          // total MXN del pago inicial.
          acceptanceUrl: data.acceptanceUrl,
          totalCLP: calculo.pagoInicialTotal,
          mensajeParaProspecto: `Listo!! Tu cotización formal quedó generada 🎉\n\nAquí la revisas y la aceptas en línea: ${data.acceptanceUrl}\n\nEl pago inicial es de ${formatearMXN(calculo.pagoInicialTotal)} MXN (IVA incluido) y tu mensualidad de ${formatearMXN(calculo.mensualTotal)} MXN (IVA incluido) desde el mes siguiente. El pago es por transferencia bancaria y se verifica en máximo 24 horas hábiles; con el pago confirmado, yo misma te acompaño con la puesta en marcha de tu cuenta. Cualquier duda me dices y con gusto la resolvemos 😊`,
        }
      }

      if (name === "derivar_a_ejecutivo") {
        const i = (input || {}) as DerivarInput
        const rfcInfo = i.rfc
          ? rfcValido(i.rfc)
            ? `RFC ${normalizarRfc(i.rfc)} (formato válido)`
            : `RFC ${i.rfc} (formato NO cuadra — confirmar)`
          : ""
        // Territorio México: lib/zoho-leads.ts hoy solo setea Territorio para
        // Chile/Colombia (TODO del perfil); el owner directo de Yahel asegura
        // que el lead no quede huérfano mientras tanto.
        const res = await createZohoLead({
          nombre: i.nombre,
          empresa: i.empresa,
          email: i.email,
          telefono: contact,
          contactoWA: contact,
          pais: "México",
          ciudad: i.ciudad,
          trabajadores: i.trabajadores,
          necesidad: [i.resumen || "", rfcInfo].filter(Boolean).join(" · "),
          // v1 MX sin tómbola SDR: TODOS los motivos quedan a nombre del
          // ejecutivo (Yahel Segura), que retoma con todo el contexto.
          ownerId: EJECUTIVO_MX_ZOHO_ID,
        })
        if (!res || (res as { success?: boolean }).success === false) {
          return {
            ok: false,
            error: "No se pudo registrar el lead. Igual confirma al cliente que el equipo lo contactará.",
            mensajeParaProspecto:
              "Listo, dejé tus datos registrados 😊 Una persona de nuestro equipo comercial en México te contactará muy pronto para continuar.",
          }
        }
        return {
          ok: true,
          mensajeParaProspecto:
            "Listo, quedaste registrado 🎉 Una persona de nuestro equipo comercial en México te contactará muy pronto para continuar con tu cotización.",
        }
      }

      // Soporte operativo: misma implementación chilena (agente Foundry). El
      // escalamiento humano reemplaza los canales chilenos por los de MX, y
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
            mensajeParaProspecto: MENSAJE_ESCALAMIENTO_SOPORTE_MX,
          }
        }
        return { ...r, respuestaAgente: sanearCanalesChilenos(r.respuestaAgente || "") }
      }

      // Agenda MX (Cal.com): mismas implementaciones chilenas con el event
      // type de México, timezone Ciudad de México y confirmaciones en tuteo
      // mexicano cálido.
      if (name === "consultar_disponibilidad_horario") {
        if (!REUNIONES_MX_HABILITADAS) {
          return { ok: false, error: "La agenda de México no está configurada. Usa derivar_a_ejecutivo (motivo pidio_persona) con la preferencia de horario en el resumen." }
        }
        const i = (input || {}) as { fechaPropuesta?: string }
        const disp = await checkSlotAvailability({
          slotIso: String(i.fechaPropuesta || ""),
          country: "México",
          eventTypeId: CAL_EVENT_TYPE_ID_MX,
        })
        // Etiquetas legibles pre-calculadas en hora de Ciudad de México (bug
        // 17-jul heredado: el modelo escribía mal el día de la semana y el
        // cliente anotaba el día equivocado). Aditivo: shape original intacto.
        if (disp.ok && disp.estado === "disponible_exacto") {
          return { ...disp, etiqueta: fechaLegibleMX(disp.slotIso) }
        }
        if (
          disp.ok &&
          (disp.estado === "alternativas_mismo_dia" || disp.estado === "alternativas_dias_cercanos")
        ) {
          return { ...disp, etiquetas: disp.alternativas.map((s) => fechaLegibleMX(s)) }
        }
        return disp
      }
      if (name === "agendar_reunion") {
        if (!REUNIONES_MX_HABILITADAS) {
          return { ok: false, error: "La agenda de México no está configurada. Usa derivar_a_ejecutivo (motivo pidio_persona)." }
        }
        const r = await agendarReunion({
          ...(input as object),
          // Teléfono del canal si el modelo no lo pasó (igual que derivar_a_
          // ejecutivo): sin él, el Lead en Zoho queda sin Phone.
          telefono:
            ((input as { telefono?: string })?.telefono || "").trim() || contact,
          country: "México",
          eventTypeId: CAL_EVENT_TYPE_ID_MX,
        } as never)
        if (!r.ok) return r
        const email = (input as { prospectEmail?: string })?.prospectEmail || "tu correo"
        return {
          ...r,
          // El agent-loop persiste la reunión con esta zona (recordatorios).
          timezone: TZ_MX,
          // Confirmación en tuteo mexicano cálido.
          mensajeParaProspecto:
            `Listo!! Tu reunión quedó agendada para el ${fechaLegibleMX(r.slotIso)} (hora de Ciudad de México) 🎉 ` +
            `Te llegará la invitación con el link de la reunión a ${email}. Te puedo ayudar en algo más?`,
        }
      }
      if (name === "reagendar_reunion") {
        if (!REUNIONES_MX_HABILITADAS) {
          return { ok: false, error: "La agenda de México no está configurada. Usa derivar_a_ejecutivo (motivo pidio_persona)." }
        }
        const r = await reagendarReunion({ ...(input as object), country: "México" } as never)
        if (!r.ok) return r
        return {
          ...r,
          mensajeParaProspecto:
            `Listo!! Tu reunión quedó reagendada para el ${fechaLegibleMX(r.slotIso)} (hora de Ciudad de México) 📅 ` +
            `Te llegará la nueva invitación por correo. Te puedo ayudar en algo más?`,
        }
      }

      // Señales (sin efectos externos aquí): el route MX las procesa al ver el
      // tool_call ok — cierra/pausa/programa el ciclo de seguimiento.
      if (name === "marcar_no_contactar") return marcarNoContactar(input as never)
      if (name === "programar_seguimiento") {
        const r = programarSeguimiento(input as never)
        if (!("ok" in r) || r.ok !== true) return r
        // Confirmación en tuteo mexicano cálido.
        return {
          ...r,
          mensajeParaProspecto:
            "Claro que sí, lo dejamos así 😊 Te escribo cuando quedamos para retomar, sin presión. Si necesitas algo antes, aquí estoy 🙌",
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
