/**
 * TOOLS ÚNICAS — Colombia (21-sep, mismo molde que lib/paises/pe/tools-unificadas.ts:
 * "una sola tool por herramienta para todos los países, no se replican").
 *
 * Expone los 20 nombres del núcleo. Por debajo: motor real donde existe
 * (buildDispatchCO: cotizarCO en COP, create-from-vicky-co, lead a
 * Galindo/Gordillo, Foundry, opt-out, seguimiento, agenda Cal si está
 * configurada; reenvío y PDF delegados a la impl chilena), traducción de
 * formas (hardware[] → reloj, contactoEmail → email, rutEmpresa → nit,
 * motivos CL → CO) y respuesta HONESTA donde Colombia no tiene la capacidad
 * (descuentos, transferencia, certificación, ficha PDF, edición/anualidad).
 *
 * Imports estáticos solo a módulos que los tests puros cargan (co/tools.ts
 * trae "../../zoho-leads" relativo, igual que ya lo hace el prompt CO).
 */
import { marcarNoContactarSchema } from "../../tools/marcar-no-contactar.ts"
import { programarSeguimientoSchema } from "../../tools/programar-seguimiento.ts"

// Mismo criterio que co/tools.ts (REUNIONES_CO_HABILITADAS), calculado acá
// para no importar ese módulo en el top-level (su cadena no es pura).
const REUNIONES_CO_HABILITADAS = Boolean((process.env.CAL_EVENT_TYPE_ID_CO || "").trim())

type Schema = { name: string; description: string; input_schema: Record<string, unknown> }

// Schema LOCAL del soporte (copia país-neutra del chileno, igual que en PE):
// importar la tool en el top-level rompería la pureza para los tests.
const SOPORTE_SCHEMA: Schema = {
  name: "consultar_agente_soporte",
  description:
    "Consulta al agente IA especializado en soporte operativo de la plataforma GeoVictoria. Úsala SOLO cuando quien escribe YA ES USUARIO de la plataforma y tiene una duda o problema funcional (recuperar acceso, credenciales, configurar usuarios, generar reportes, problemas técnicos, errores de la app). NO la uses para consultas comerciales (precios, productos, condiciones), callback ni reuniones. El agente puede preguntar el rol del usuario (administrador o colaborador) antes de responder — si lo hace, comunica la pregunta al prospecto literal y espera la respuesta para volver a invocar la tool. Si la conversación continúa con el mismo tema, vuelve a invocarla pasando previousResponseId para mantener contexto. Devuelve uno de tres estados: 'continuar' (pega la respuesta y sigue disponible), 'escalar_humano' (pega mensajeParaProspecto con el canal de soporte), 'cerrar' (pega la respuesta y despide).",
  input_schema: {
    type: "object" as const,
    properties: {
      mensajeProspecto: { type: "string" as const, description: "El mensaje del usuario con su duda o problema, tal cual lo escribió." },
      previousResponseId: { type: "string" as const, description: "Id de la respuesta anterior del agente de soporte, para continuar el mismo hilo." },
    },
    required: ["mensajeProspecto"],
  },
}

const AGENDA_CO_SCHEMAS: Schema[] = [
  {
    name: "consultar_disponibilidad_horario",
    description:
      "Verifica si una fecha y hora propuesta POR EL CLIENTE está disponible en el calendario del equipo comercial de Colombia. Úsala cuando el cliente proponga un horario específico para una reunión. Tú NUNCA propones horarios primero. Interpreta la propuesta en la zona horaria de Colombia (America/Bogota, UTC-5). Si hay un slot a menos de 15 min de la propuesta, devuelve 'disponible_exacto' (pasa ese slotIso a agendar_reunion). Si no, devuelve alternativas: preséntaselas en prosa natural y espera a que elija.",
    input_schema: {
      type: "object" as const,
      properties: { fechaPropuesta: { type: "string" as const, description: "ISO 8601 con timezone, interpretada en America/Bogota." } },
      required: ["fechaPropuesta"],
    },
  },
  {
    name: "agendar_reunion",
    description:
      "Agenda una reunión con un ejecutivo del equipo comercial de Colombia (calendario + lead en el CRM + evento). Llamar SOLO cuando el cliente confirmó explícitamente un horario (idealmente tras consultar_disponibilidad_horario con 'disponible_exacto', usando ese slotIso). Antes captura nombre completo, correo y empresa.",
    input_schema: {
      type: "object" as const,
      properties: {
        slotIso: { type: "string" as const },
        prospectName: { type: "string" as const },
        prospectEmail: { type: "string" as const },
        empresa: { type: "string" as const },
        telefono: { type: "string" as const },
        trabajadores: { type: "string" as const },
        necesidad: { type: "string" as const },
        cargo: { type: "string" as const },
      },
      required: ["slotIso", "prospectName", "prospectEmail"],
    },
  },
  {
    name: "reagendar_reunion",
    description: "Reagenda la reunión que el cliente YA tiene a un nuevo horario confirmado. NO uses agendar_reunion para reagendar.",
    input_schema: { type: "object" as const, properties: { newSlotIso: { type: "string" as const } }, required: ["newSlotIso"] },
  },
]

const HARDWARE_CO = {
  type: "array" as const,
  items: {
    type: "object" as const,
    properties: {
      id: { type: "string" as const, description: "ID del equipo del catálogo de Colombia: 'reloj_co'." },
      cantidad: { type: "number" as const, minimum: 1, maximum: 50, description: "Unidades. Default 1." },
      modalidad: {
        type: "string" as const,
        enum: ["arriendo", "venta"],
        description: "POR DEFECTO 'arriendo' (alquiler). 'venta' ÚNICAMENTE si el cliente pidió COMPRAR con esas palabras.",
      },
    },
    required: ["id"],
  },
  description: "Solo si la configuración lleva equipo biométrico. Si no lo mencionó, dejar vacío.",
}
const PUNTOS_CO = {
  type: "array" as const,
  items: {
    type: "object" as const,
    properties: {
      ubicacion: { type: "string" as const, description: "Ciudad o municipio tal como lo dijo el cliente (la tool clasifica capital/resto)." },
      autoInstalada: { type: "boolean" as const, description: "true por defecto (el cliente instala). false SOLO si pidió visita técnica." },
    },
    required: ["ubicacion"],
  },
  description: "Un punto por cada lugar físico con equipo. Obligatorio SOLO con equipo en VENTA (en alquiler envío e instalación son gratis y no se pide ubicación).",
}

function sinCapacidad(que: string, enSuLugar: string) {
  return { ok: false as const, sinCapacidadEnPais: "co", error: `En Colombia ${que}. ${enSuLugar} No afirmes al cliente que esto se hizo.` }
}

const AGENDA_STUB = (): Schema[] => [
  {
    name: "consultar_disponibilidad_horario",
    description: "Colombia NO tiene agenda en línea hoy: esta tool te lo recuerda. Para una reunión usa derivar_a_soporte (motivo solicitud_explicita_persona) con el horario que propuso el cliente.",
    input_schema: { type: "object" as const, properties: { fechaPropuesta: { type: "string" as const } }, required: [] },
  },
  {
    name: "agendar_reunion",
    description: "Colombia NO tiene agenda en línea hoy: esta tool te lo recuerda. La reunión la coordina el ejecutivo — usa derivar_a_soporte (motivo solicitud_explicita_persona) con el horario propuesto.",
    input_schema: { type: "object" as const, properties: { slotIso: { type: "string" as const }, prospectName: { type: "string" as const } }, required: [] },
  },
  {
    name: "reagendar_reunion",
    description: "Colombia NO tiene agenda en línea hoy: esta tool te lo recuerda. Usa derivar_a_soporte (motivo solicitud_explicita_persona) con el nuevo horario.",
    input_schema: { type: "object" as const, properties: { newSlotIso: { type: "string" as const } }, required: [] },
  },
]

export const TOOL_SCHEMAS_CO_UNIFICADAS: Schema[] = [
  {
    name: "cotizar_referencial",
    description:
      "Calcula el estimado mensual EN PESOS COLOMBIANOS para 1 a 50 personas y devuelve `mensajeParaProspecto` listo para copiar TAL CUAL (el plan con precio final; el equipo biométrico con su IVA 19 % ya indicado). Úsalo apenas tengas la dotación y el marcaje. NUNCA calcules ni enuncies precios tú. En ALQUILER envío e instalación son gratis (no pidas ciudad); en COMPRA pasa puntosInstalacion. No existe descuento en Colombia.",
    input_schema: {
      type: "object" as const,
      properties: {
        userCount: { type: "number" as const, minimum: 1, maximum: 50, description: "Personas que marcarán asistencia (1-50)." },
        modulos: { type: "array" as const, items: { type: "string" as const }, description: "IDs de módulos. En Colombia siempre ['asistencia'] (opcional: se asume)." },
        hardware: HARDWARE_CO,
        puntosInstalacion: PUNTOS_CO,
      },
      required: ["userCount"],
    },
  },
  {
    name: "consultar_descuento_referencial",
    description: "En Colombia NO hay escalera de descuento: esta tool te lo confirma. Ante la objeción de precio destaca lo incluido (capacitación de regalo, envío + instalación gratis en alquiler, sin permanencia) y ofrece la opción sin equipo; si sigue trabado, deriva. JAMÁS inventes un porcentaje.",
    input_schema: { type: "object" as const, properties: { userCount: { type: "number" as const } }, required: [] },
  },
  {
    name: "generar_link_cotizadora",
    description:
      "Genera la COTIZACIÓN FORMAL de Colombia (CRM + PDF en COP + link donde el cliente la revisa, acepta y paga con tarjeta vía Mercado Pago). Úsala cuando el cliente quiere avanzar tras ver el precio. REQUIERE empresa (razón social), contacto, contactoEmail (obligatorio), rutEmpresa = el NIT con dígito de verificación (ej. 900.123.456-7), userCount y la configuración (hardware/puntos si lleva equipo en compra). Copia `mensajeParaProspecto` TAL CUAL; JAMÁS escribas un link de memoria. Si el NIT no valida, pide SOLO la corrección.",
    input_schema: {
      type: "object" as const,
      properties: {
        empresa: { type: "string" as const, description: "Razón social." },
        contacto: { type: "string" as const, description: "Nombre completo de la persona de contacto." },
        contactoEmail: { type: "string" as const, description: "Correo del contacto (obligatorio)." },
        contactoTelefono: { type: "string" as const, description: "Se completa solo con el WhatsApp del cliente; no lo pidas." },
        rutEmpresa: { type: "string" as const, description: "NIT con dígito de verificación." },
        userCount: { type: "number" as const, minimum: 1, maximum: 50 },
        modulos: { type: "array" as const, items: { type: "string" as const } },
        hardware: HARDWARE_CO,
        puntosInstalacion: PUNTOS_CO,
      },
      required: ["empresa", "contacto", "contactoEmail", "rutEmpresa", "userCount"],
    },
  },
  SOPORTE_SCHEMA,
  {
    name: "registrar_solicitud_callback",
    description: "El cliente pide que lo LLAMEN: queda registrado en el CRM (territorio Colombia) para que el equipo comercial lo contacte. Pasa lo que el cliente dijo (necesidad, personas, horario preferido); NO inventes campos.",
    input_schema: {
      type: "object" as const,
      properties: {
        nombre: { type: "string" as const },
        empresa: { type: "string" as const },
        telefono: { type: "string" as const, description: "Se completa solo con el WhatsApp del cliente." },
        email: { type: "string" as const },
        necesidad: { type: "string" as const },
        trabajadores: { type: "number" as const },
        cargo: { type: "string" as const },
        ciudad: { type: "string" as const },
        preferenciaHorario: { type: "string" as const, description: "Día/hora que propuso, tal cual." },
      },
      required: ["nombre"],
    },
  },
  {
    name: "registrar_comprobante_transferencia",
    description: "En Colombia el pago es SOLO con tarjeta vía Mercado Pago y se confirma solo: esta tool te lo recuerda. Si el cliente manda un comprobante de transferencia, deriva al ejecutivo (motivo otro) con el detalle; no confirmes pagos tú.",
    input_schema: { type: "object" as const, properties: { montoDetectado: { type: "number" as const } }, required: [] },
  },
  {
    name: "derivar_a_soporte",
    description:
      "Registra al prospecto como lead en el CRM (territorio Colombia) y lo deja en manos del equipo comercial de Colombia, que lo contacta. Motivos: fuera_de_rango_trabajadores (más personas de las que cotizas), solicitud_explicita_persona (pide hablar con una persona o una reunión — pon en contexto el día/hora que propuso), callback, fuera_de_scope, cliente_existente_problema, tool_fallo, transferir_soporte_operativo, agendar_reunion. El NIT NUNCA es requisito. `contexto` = necesidad, configuración y precios cotizados. Devuelve `mensajeParaProspecto`.",
    input_schema: {
      type: "object" as const,
      properties: {
        motivo: {
          type: "string" as const,
          enum: ["fuera_de_rango_trabajadores", "cliente_existente_problema", "solicitud_explicita_persona", "tool_fallo", "fuera_de_scope", "agendar_reunion", "callback", "transferir_soporte_operativo"],
        },
        contexto: { type: "string" as const, description: "Resumen para el ejecutivo." },
        nombre: { type: "string" as const },
        rutEmpresa: { type: "string" as const, description: "NIT, si lo dio." },
        email: { type: "string" as const },
        empresa: { type: "string" as const },
        trabajadores: { type: "number" as const },
        ciudad: { type: "string" as const },
      },
      required: ["motivo", "contexto"],
    },
  },
  marcarNoContactarSchema as unknown as Schema,
  programarSeguimientoSchema as unknown as Schema,
  {
    name: "reenviar_cotizacion_correo",
    description: "Reenvía la cotización formal por CORREO a quien el cliente designe (o al propio cliente). Devuelve ok:true solo si el correo salió: jamás digas 'te la envié' sin ese ok.",
    input_schema: {
      type: "object" as const,
      properties: {
        quote_id: { type: "string" as const },
        destinatarioEmail: { type: "string" as const },
        destinatarioNombre: { type: "string" as const },
        esCorreoDelCliente: { type: "boolean" as const },
      },
      required: ["quote_id", "destinatarioEmail"],
    },
  },
  {
    name: "enviar_cotizacion_whatsapp",
    description: "Manda el PDF de la cotización formal por ESTE mismo chat. Devuelve ok:true solo si salió.",
    input_schema: { type: "object" as const, properties: { quote_id: { type: "string" as const } }, required: ["quote_id"] },
  },
  ...(REUNIONES_CO_HABILITADAS ? AGENDA_CO_SCHEMAS : AGENDA_STUB()),
  {
    name: "enviar_certificacion",
    description: "En Colombia NO existe un documento de certificación (el Ministerio del Trabajo no certifica sistemas): esta tool te lo recuerda. Responde con el bloque legal, sin prometer papeles.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "enviar_ficha_reloj",
    description: "En Colombia NO hay ficha PDF del equipo biométrico: esta tool te lo recuerda. Descríbelo en texto (facial, huella, tarjeta, clave o QR; WiFi o cable), sin marcas ni modelos.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "consultar_siguiente_descuento",
    description: "En Colombia NO hay descuentos, ni antes ni después de la formal: esta tool te lo recuerda.",
    input_schema: { type: "object" as const, properties: { quote_id: { type: "string" as const } }, required: [] },
  },
  {
    name: "aplicar_siguiente_descuento",
    description: "En Colombia NO hay descuentos, ni antes ni después de la formal: esta tool te lo recuerda.",
    input_schema: { type: "object" as const, properties: { quote_id: { type: "string" as const } }, required: [] },
  },
  {
    name: "actualizar_cotizacion",
    description: "En Colombia una formal emitida NO se edita: se RE-EMITE con generar_link_cotizadora con la configuración nueva (misma empresa y NIT). Esta tool te lo recuerda.",
    input_schema: { type: "object" as const, properties: { quote_id: { type: "string" as const } }, required: [] },
  },
  {
    name: "anualizar_cotizacion",
    description: "Colombia NO tiene pago anual todavía: esta tool te lo recuerda. Ofrece la mensualidad; si insiste, derivar_a_soporte (motivo fuera_de_scope).",
    input_schema: { type: "object" as const, properties: { quote_id: { type: "string" as const } }, required: [] },
  },
]

type HardwareIn = { id?: string; cantidad?: number; modalidad?: string }
type PuntoIn = { ubicacion?: string; autoInstalada?: boolean }
type CotizarIn = { userCount?: number; hardware?: HardwareIn[]; puntosInstalacion?: PuntoIn[] }

export function relojDeHardwareCO(hardware?: HardwareIn[]): { modalidad: "arriendo" | "venta"; cantidad: number } | undefined {
  const lista = Array.isArray(hardware) ? hardware.filter((h) => h && typeof h === "object") : []
  if (lista.length === 0) return undefined
  const cantidad = lista.reduce((a, h) => a + Math.max(1, Math.round(Number(h.cantidad) || 1)), 0)
  const modalidad = lista.some((h) => h.modalidad === "venta") ? "venta" : "arriendo"
  return { modalidad, cantidad }
}

/** Forma chilena de cotizar → input de la tool base CO (puntos solo con equipo en venta). */
export function aInputCotizarCO(i: CotizarIn) {
  const reloj = relojDeHardwareCO(i.hardware)
  const out: Record<string, unknown> = { userCount: Number(i.userCount || 0) }
  if (reloj) out.reloj = reloj
  const puntos = (Array.isArray(i.puntosInstalacion) ? i.puntosInstalacion : [])
    .filter((p) => p && typeof p === "object")
    .map((p) => ({ ubicacion: String(p.ubicacion || ""), autoInstalada: p.autoInstalada === false ? false : true }))
  if (reloj?.modalidad === "venta" && puntos.length > 0) out.puntosInstalacion = puntos
  return out
}

const MOTIVO_CO: Record<string, string> = {
  fuera_de_rango_trabajadores: "mas_de_50",
  solicitud_explicita_persona: "pidio_persona",
  agendar_reunion: "pidio_persona",
  callback: "pidio_persona",
  tool_fallo: "cotizacion_formal",
  fuera_de_scope: "fuera_de_alcance",
  cliente_existente_problema: "otro",
  transferir_soporte_operativo: "otro",
}

export function buildDispatchCOUnificado(contact: string) {
  // Import dinámico: el motor CO trae Zoho/Cal/Foundry (no puro).
  let basePromise: Promise<(name: string, input: unknown) => Promise<unknown>> | null = null
  const base = (name: string, input: unknown) => {
    basePromise ??= import("./tools").then((m) => m.buildDispatchCO(contact))
    return basePromise.then((fn) => fn(name, input))
  }
  return async function dispatchCOUnificado(name: string, input: unknown): Promise<unknown> {
    const i = (input || {}) as Record<string, unknown>
    switch (name) {
      case "cotizar_referencial":
        return base("cotizar_referencial", aInputCotizarCO(i as CotizarIn))
      case "consultar_descuento_referencial":
      case "consultar_siguiente_descuento":
      case "aplicar_siguiente_descuento":
        return {
          ok: true,
          topeAlcanzado: true,
          sinDescuentoEnPais: "co",
          mensajeParaProspecto:
            "En Colombia no manejo descuentos sobre el plan — lo que sí va incluido sin costo: la capacitación online (valorada en $95.000), y en alquiler el envío y la instalación del equipo. Y sin cláusula de permanencia. Si lo que pesa es el equipo, te cotizo solo con la app, que va gratis en el plan 😊",
        }
      case "generar_link_cotizadora":
        return base("generar_link_cotizadora", {
          empresa: i.empresa,
          contacto: i.contacto,
          email: i.contactoEmail || i.email,
          nit: i.rutEmpresa || i.nit,
          ...aInputCotizarCO(i as CotizarIn),
        })
      case "derivar_a_soporte": {
        const motivo = MOTIVO_CO[String(i.motivo || "")] || "otro"
        return base("derivar_a_ejecutivo", {
          nombre: String(i.nombre || "Prospecto WhatsApp"),
          empresa: i.empresa,
          email: i.email,
          nit: i.rutEmpresa,
          trabajadores: i.trabajadores,
          ciudad: i.ciudad,
          motivo,
          resumen: `[${String(i.motivo || "")}] ${String(i.contexto || "")}`.trim(),
        })
      }
      case "registrar_solicitud_callback": {
        const partes = [
          i.necesidad ? `Necesidad: ${i.necesidad}` : "",
          i.preferenciaHorario ? `Prefiere que lo llamen: ${i.preferenciaHorario}` : "",
          i.cargo ? `Cargo: ${i.cargo}` : "",
        ].filter(Boolean)
        return base("derivar_a_ejecutivo", {
          nombre: String(i.nombre || "Prospecto WhatsApp"),
          empresa: i.empresa,
          email: i.email,
          trabajadores: i.trabajadores,
          ciudad: i.ciudad,
          motivo: "pidio_persona",
          resumen: `[callback] ${partes.join(" · ") || "Pidió que lo llamen."}`,
        })
      }
      case "consultar_agente_soporte":
      case "marcar_no_contactar":
      case "programar_seguimiento":
      case "reenviar_cotizacion_correo":
      case "consultar_disponibilidad_horario":
      case "agendar_reunion":
      case "reagendar_reunion":
        // La base ya responde honesta cuando la agenda CO no está configurada.
        return base(name, input)
      case "enviar_cotizacion_whatsapp": {
        const { enviarCotizacionWhatsapp } = await import("../../tools/enviar-cotizacion-whatsapp.ts")
        return enviarCotizacionWhatsapp({ ...(i as object), _contact: contact } as never)
      }
      case "registrar_comprobante_transferencia":
        return sinCapacidad(
          "el pago es solo con tarjeta vía Mercado Pago y se confirma solo (no hay transferencia)",
          "Si el cliente mandó un comprobante de transferencia, llama derivar_a_soporte (motivo tool_fallo) con el detalle para que el ejecutivo lo revise; no confirmes el pago tú.",
        )
      case "enviar_certificacion":
        return sinCapacidad("no existe un documento de certificación (el Ministerio del Trabajo no certifica sistemas)", "Responde con el bloque legal: registro ordenado y trazable; sin prometer papeles.")
      case "enviar_ficha_reloj":
        return sinCapacidad("no hay ficha PDF del equipo biométrico", "Descríbelo en texto: rostro, huella, tarjeta, clave o QR; WiFi o cable de red; se conecta a la nube en minutos. Sin marcas ni modelos.")
      case "actualizar_cotizacion":
        return sinCapacidad("una cotización formal emitida no se edita en sitio", "Re-emite con generar_link_cotizadora con la configuración nueva (misma empresa y NIT) y entrega el link nuevo.")
      case "anualizar_cotizacion":
        return sinCapacidad("todavía no existe el pago anual", "Ofrece la mensualidad; si el cliente insiste en pagar el año, deriva con derivar_a_soporte motivo fuera_de_scope.")
      default:
        return base(name, input)
    }
  }
}
