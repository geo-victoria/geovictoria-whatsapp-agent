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
 * (certificación, ficha PDF, anualidad). Descuentos = Chile
 * desde el 21-sep (escalera 10 → 20 % sobre el plan, memoria `co_pref_`).
 *
 * Imports estáticos solo a módulos que los tests puros cargan (co/tools.ts
 * trae "../../zoho-leads" relativo, igual que ya lo hace el prompt CO).
 */
import { marcarNoContactarSchema } from "../../tools/marcar-no-contactar.ts"
import { programarSeguimientoSchema } from "../../tools/programar-seguimiento.ts"
import { buscarProspectSchemaPais } from "../buscar-prospect-schema.ts"

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
      "Calcula el estimado mensual EN PESOS COLOMBIANOS para 1 a 50 personas y devuelve `mensajeParaProspecto` listo para copiar TAL CUAL (el plan con precio final; el equipo biométrico con su IVA 19 % ya indicado). Úsalo apenas tengas la dotación y el marcaje. NUNCA calcules ni enuncies precios tú. En ALQUILER envío e instalación son gratis (no pidas ciudad); en COMPRA pasa puntosInstalacion. escalonDescuento (1 = 10 %, 2 = 20 % sobre el plan, 6 meses) SOLO ante una objeción de precio, nunca de entrada.",
    input_schema: {
      type: "object" as const,
      properties: {
        userCount: { type: "number" as const, minimum: 1, maximum: 50, description: "Personas que marcarán asistencia (1-50)." },
        modulos: { type: "array" as const, items: { type: "string" as const }, description: "IDs de módulos. En Colombia siempre ['asistencia'] (opcional: se asume)." },
        hardware: HARDWARE_CO,
        puntosInstalacion: PUNTOS_CO,
        escalonDescuento: { type: "number" as const, enum: [0, 1, 2], description: "Escalón de descuento del plan ya ofrecido (0 sin descuento · 1 = 10 % · 2 = 20 %, por 6 meses). Solo tras una objeción de precio." },
      },
      required: ["userCount"],
    },
  },
  {
    name: "consultar_descuento_referencial",
    description:
      "La escalera de descuento sobre el ÚLTIMO estimado (10 % → 20 % sobre el plan, 6 meses; el alquiler del equipo no baja). Llámala cuando el cliente objeta el precio del estimado: avanza UN escalón y devuelve `mensajeParaProspecto` con el precio rebajado (cópialo tal cual) y `topeAlcanzado=true` cuando ya diste el 20 % (ahí no hay más rebaja y lo dices con franqueza). NUNCA calcules tú el porcentaje. Si no hubo estimado previo en esta conversación, pasa la configuración (userCount, hardware, puntosInstalacion).",
    input_schema: {
      type: "object" as const,
      properties: {
        userCount: { type: "number" as const, minimum: 1, maximum: 50 },
        modulos: { type: "array" as const, items: { type: "string" as const } },
        hardware: HARDWARE_CO,
        puntosInstalacion: PUNTOS_CO,
        escalonActual: { type: "number" as const, enum: [0, 1, 2], description: "Escalón ya ofrecido, si lo sabes." },
      },
      required: [],
    },
  },
  {
    name: "generar_link_cotizadora",
    description:
      "Genera la COTIZACIÓN FORMAL de Colombia (CRM + PDF en COP + link donde el cliente la revisa, acepta y paga con tarjeta vía Mercado Pago). Úsala cuando el cliente quiere avanzar tras ver el precio. Pasa el MISMO escalonDescuento que el cliente aceptó (o se usa el último ofrecido). REQUIERE empresa (razón social), contacto, contactoEmail (obligatorio), rutEmpresa = el NIT con dígito de verificación (ej. 900.123.456-7), userCount y la configuración (hardware/puntos si lleva equipo en compra). Copia `mensajeParaProspecto` TAL CUAL; JAMÁS escribas un link de memoria. Si el NIT no valida, pide SOLO la corrección.",
    input_schema: {
      type: "object" as const,
      properties: {
        empresa: { type: "string" as const, description: "Razón social." },
        contacto: { type: "string" as const, description: "Nombre completo de la persona de contacto." },
        contactoEmail: { type: "string" as const, description: "Correo del contacto (opcional: sin correo la entrega va por este chat)." },
        contactoTelefono: { type: "string" as const, description: "Se completa solo con el WhatsApp del cliente; no lo pidas." },
        rutEmpresa: { type: "string" as const, description: "NIT con dígito de verificación." },
        userCount: { type: "number" as const, minimum: 1, maximum: 50 },
        modulos: { type: "array" as const, items: { type: "string" as const } },
        hardware: HARDWARE_CO,
        puntosInstalacion: PUNTOS_CO,
        escalonDescuento: { type: "number" as const, enum: [0, 1, 2], description: "El MISMO escalón que el cliente aceptó en el estimado (si lo omites se usa el último ofrecido en esta conversación): la formal nace con ese % en el plan por 6 meses." },
      },
      // Mismo contrato que Chile (Lalo 03-ago / 21-sep): el correo es OPCIONAL.
      required: ["empresa", "contacto", "rutEmpresa", "userCount"],
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
    description:
      "Registra un comprobante de transferencia bancaria (Bancolombia, cuenta de ahorros de GEOVICTORIA COLOMBIA SAS) que el cliente envió por el chat (imagen o PDF descrito en el historial). Úsala SIEMPRE que el cliente mande un comprobante de pago de su cotización. Extrae lo que se vea: monto en pesos colombianos, banco emisor y fecha. La tool lo asocia a la cotización vigente, avisa al equipo y devuelve `mensajeParaProspecto` (con el acceso al onboarding si el comprobante era legible): cópialo TAL CUAL. montoDetectado solo si lo LEÍSTE (si no, 0; nunca lo deduzcas del precio). Nunca afirmes tú que el pago quedó confirmado: se confirma la recepción, no el dinero.",
    input_schema: {
      type: "object" as const,
      properties: {
        montoDetectado: { type: "number" as const, description: "Monto transferido en COP tal como se lee en el comprobante; 0 si no se lee." },
        bancoOrigen: { type: "string" as const, description: "Banco emisor si se ve en el comprobante." },
        fechaDetectada: { type: "string" as const, description: "Fecha de la transferencia si se ve." },
        detalle: { type: "string" as const, description: "Resumen en una frase de lo que muestra el comprobante (destinatario, hora, nro de operación)." },
        pagoDeclarado: { type: "boolean" as const, description: "true si el cliente DECLARA que pagó sin adjuntar comprobante." },
      },
      required: [],
    },
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
  buscarProspectSchemaPais("NIT", "con o sin dígito de verificación"),
  {
    name: "consultar_siguiente_descuento",
    description:
      "Con una cotización FORMAL ya emitida: dice qué escalón de descuento corresponde ofrecer ahora (10 % → 20 % sobre el plan, 6 meses) SIN aplicarlo y devuelve el precio recalculado en `mensajeParaProspecto` (cópialo TAL CUAL; en pesos colombianos, precios finales). Úsala cuando el cliente objeta el precio de la formal; nunca proactiva. Si el cliente acepta, llama aplicar_siguiente_descuento. Con `topeAlcanzado=true` es el último escalón.",
    input_schema: {
      type: "object" as const,
      properties: { quote_id: { type: "string" as const, description: "Id de la cotización formal (si lo omites, se usa la vigente de esta conversación)." } },
      required: [],
    },
  },
  {
    name: "aplicar_siguiente_descuento",
    description:
      "Aplica el escalón siguiente de descuento (10 % → 20 % sobre el plan, 6 meses) a la cotización FORMAL vigente de esta conversación: la MISMA cotización se actualiza (mismo número, nueva versión del PDF, mismo link) y devuelve el link en `mensajeParaProspecto` — cópialo TAL CUAL. Pasa `pct_ofrecido` con el % que ya le comunicaste. Solo ante objeción de precio y nunca dos escalones en un mismo turno. Con `topeAlcanzado=true` no hay más rebaja: dilo con franqueza.",
    input_schema: {
      type: "object" as const,
      properties: {
        quote_id: { type: "string" as const, description: "Id de la cotización formal (si lo omites, se usa la vigente)." },
        pct_ofrecido: { type: "number" as const, minimum: 0, maximum: 40, description: "Porcentaje EXACTO sobre el plan que ya le ofreciste (el que devolvió consultar_siguiente_descuento). No lo inventes." },
      },
      required: [],
    },
  },
  {
    name: "actualizar_cotizacion",
    description:
      "Cambia la cotización FORMAL vigente de esta conversación (más o menos personas, agregar o quitar el equipo, cambiar modalidad o puntos). La MISMA cotización se actualiza en sitio: el link NO cambia (en el mismo link ya aparece al día) y el PDF nuevo va a su correo. Pasa la configuración COMPLETA nueva (userCount siempre; hardware y puntosInstalacion si lleva equipo). Copia `mensajeParaProspecto` TAL CUAL. Llámala EN EL MISMO TURNO en que el cliente pide el cambio: jamás anuncies 'te la actualizo' sin llamarla.",
    input_schema: {
      type: "object" as const,
      properties: {
        quote_id: { type: "string" as const, description: "Id de la cotización formal (si lo omites, se usa la vigente)." },
        userCount: { type: "number" as const, minimum: 1, maximum: 50, description: "Dotación FINAL tras el cambio." },
        modulos: { type: "array" as const, items: { type: "string" as const } },
        hardware: HARDWARE_CO,
        puntosInstalacion: PUNTOS_CO,
        resumen_cambio: { type: "string" as const, description: "Qué pidió cambiar el cliente, en una frase." },
      },
      required: ["userCount"],
    },
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

type PrefCO = { userCount: number; hardware?: HardwareIn[]; puntosInstalacion?: PuntoIn[]; escalon: number }

/**
 * Cotización FORMAL vigente de la conversación (puntero) con la guarda de
 * Pagada — la misma que Perú, sin leer campos peruanos.
 */
async function formalVigenteCO(contact: string, quoteId?: string): Promise<{ quoteId: string } | { error: string }> {
  let qid = String(quoteId || "").trim()
  if (!qid) {
    try {
      const { getQuotePointer } = await import("../../supabase-persistence-v3.ts")
      qid = (await getQuotePointer(contact))?.quoteId || ""
    } catch {
      /* sin puntero */
    }
  }
  if (!qid) return { error: "No hay una cotización formal vigente en esta conversación: emítela primero con generar_link_cotizadora." }
  try {
    const { fetchZoho } = await import("../../zoho-token.ts")
    const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
    const mod = (process.env.ZOHO_QUOTE_MODULE || "Cotizaciones_GeoVictoria").trim()
    const res = await fetchZoho(`${api}/crm/v8/${mod}/${qid}?fields=Estado_Cotizacion`)
    if (res.status === 200) {
      const data = (await res.json().catch(() => ({}))) as { data?: Array<Record<string, unknown>> }
      const estado = String(data.data?.[0]?.Estado_Cotizacion || "")
      if (/pagad/i.test(estado)) return { error: "Esa cotización ya está PAGADA: no se modifica. Si el cliente quiere cambios, el ejecutivo los coordina (derivar_a_soporte)." }
    }
  } catch {
    /* sin lectura: la tool chilena vuelve a validar */
  }
  return { quoteId: qid }
}

export function buildDispatchCOUnificado(contact: string) {
  // Import dinámico: el motor CO trae Zoho/Cal/Foundry (no puro).
  let basePromise: Promise<(name: string, input: unknown) => Promise<unknown>> | null = null
  const base = (name: string, input: unknown) => {
    basePromise ??= import("./tools").then((m) => m.buildDispatchCO(contact))
    return basePromise.then((fn) => fn(name, input))
  }
  // Memoria del ÚLTIMO estimado (vic_kv `co_pref_<contact>`) para que
  // consultar_descuento_referencial funcione sin argumentos, igual que en
  // Chile y Perú (Lalo 21-sep: "descuento en Colombia igual que en Chile").
  const kvKey = `co_pref_${contact}`
  async function leerPref(): Promise<PrefCO | null> {
    try {
      const { getKvValue } = await import("../../supabase-persistence-v3.ts")
      const raw = await getKvValue(kvKey)
      return raw ? (JSON.parse(raw) as PrefCO) : null
    } catch {
      return null
    }
  }
  async function guardarPref(p: PrefCO): Promise<void> {
    try {
      const { setKvValue } = await import("../../supabase-persistence-v3.ts")
      await setKvValue(kvKey, JSON.stringify(p))
    } catch {
      /* la memoria del estimado es best-effort */
    }
  }
  return async function dispatchCOUnificado(name: string, input: unknown): Promise<unknown> {
    const i = (input || {}) as Record<string, unknown>
    switch (name) {
      case "cotizar_referencial": {
        const esc = Math.min(2, Math.max(0, Number(i.escalonDescuento || 0)))
        const r = await base("cotizar_referencial", { ...aInputCotizarCO(i as CotizarIn), escalonDescuento: esc })
        if ((r as { ok?: boolean })?.ok) {
          await guardarPref({
            userCount: Number(i.userCount || 0),
            hardware: i.hardware as HardwareIn[] | undefined,
            puntosInstalacion: i.puntosInstalacion as PuntoIn[] | undefined,
            escalon: esc,
          })
        }
        return r
      }
      case "consultar_descuento_referencial": {
        const pref = await leerPref()
        const cfg: CotizarIn = {
          userCount: Number(i.userCount || pref?.userCount || 0),
          hardware: (i.hardware as HardwareIn[]) || pref?.hardware,
          puntosInstalacion: (i.puntosInstalacion as PuntoIn[]) || pref?.puntosInstalacion,
        }
        if (!cfg.userCount) {
          return { ok: false, error: "No hay un estimado previo en esta conversación: llama primero a cotizar_referencial con la dotación y el marcaje." }
        }
        const actual = Math.max(Number(i.escalonActual || 0), pref?.escalon || 0)
        if (actual >= 2) {
          return {
            ok: true,
            topeAlcanzado: true,
            escalonDescuento: 2,
            mensajeParaProspecto:
              "Ese 20 % en el plan por 6 meses ya es el máximo que puedo aplicar — no tengo margen para más, y prefiero decírtelo con franqueza. Con ese valor te dejo la cotización lista cuando quieras avanzar.",
          }
        }
        const escalon = actual + 1
        const r = (await base("cotizar_referencial", { ...aInputCotizarCO(cfg), escalonDescuento: escalon })) as Record<string, unknown>
        if (r?.ok) {
          await guardarPref({ userCount: cfg.userCount, hardware: cfg.hardware, puntosInstalacion: cfg.puntosInstalacion, escalon })
          return { ...r, escalonDescuento: escalon, topeAlcanzado: escalon >= 2 }
        }
        return r
      }
      case "consultar_siguiente_descuento": {
        const f = await formalVigenteCO(contact, i.quote_id as string | undefined)
        if ("error" in f) return { ok: false, error: f.error }
        const { consultarSiguienteDescuento } = await import("../../tools/consultar-siguiente-descuento.ts")
        const r = await consultarSiguienteDescuento({ quote_id: f.quoteId })
        return { ...r, quoteId: f.quoteId }
      }
      case "aplicar_siguiente_descuento": {
        const f = await formalVigenteCO(contact, i.quote_id as string | undefined)
        if ("error" in f) return { ok: false, error: f.error }
        const { aplicarSiguienteDescuento } = await import("../../tools/aplicar-siguiente-descuento.ts")
        const r = await aplicarSiguienteDescuento({ quote_id: f.quoteId, pct_ofrecido: Number(i.pct_ofrecido) || undefined })
        if (r.ok) {
          const pref = await leerPref()
          const escalon = r.ultimoEscalon?.pct >= 20 ? 2 : r.ultimoEscalon?.pct >= 10 ? 1 : pref?.escalon || 0
          if (pref) await guardarPref({ ...pref, escalon })
        }
        return { ...r, quoteId: f.quoteId }
      }
      case "generar_link_cotizadora": {
        const pref = await leerPref()
        const esc = Math.min(2, Math.max(0, Number(i.escalonDescuento ?? pref?.escalon ?? 0)))
        return base("generar_link_cotizadora", {
          empresa: i.empresa,
          contacto: i.contacto,
          email: i.contactoEmail || i.email,
          nit: i.rutEmpresa || i.nit,
          ...aInputCotizarCO({
            userCount: Number(i.userCount || pref?.userCount || 0),
            hardware: (i.hardware as HardwareIn[]) || pref?.hardware,
            puntosInstalacion: (i.puntosInstalacion as PuntoIn[]) || pref?.puntosInstalacion,
          } as CotizarIn),
          escalonDescuento: esc,
        })
      }
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
      case "registrar_comprobante_transferencia": {
        // Transferencia Bancolombia habilitada el 21-sep: la MISMA tool
        // chilena con el país (montos en COP, correo de cobranza al dueño CO).
        const { registrarComprobanteTransferencia } = await import("../../tools/registrar-comprobante-transferencia.ts")
        return registrarComprobanteTransferencia(contact, i as never, "co")
      }
      case "enviar_certificacion":
        return sinCapacidad("no existe un documento de certificación (el Ministerio del Trabajo no certifica sistemas)", "Responde con el bloque legal: registro ordenado y trazable; sin prometer papeles.")
      case "buscar_prospect_en_zoho": {
        // Misma búsqueda que Chile: el NIT vive en RUT_Empresa (create-from-vicky-co).
        const { buscarProspectEnZoho } = await import("../../tools/buscar-prospect-en-zoho.ts")
        return buscarProspectEnZoho(input as never)
      }
      case "enviar_ficha_reloj":
        return sinCapacidad("no hay ficha PDF del equipo biométrico", "Descríbelo en texto: rostro, huella, tarjeta, clave o QR; WiFi o cable de red; se conecta a la nube en minutos. Sin marcas ni modelos.")
      case "actualizar_cotizacion": {
        // EDICIÓN EN SITIO = LA TOOL CHILENA (21-sep): Colombia solo arma los
        // ítems con su motor (cotizarCO, COP) y el endpoint edita la MISMA
        // cotización con el perfil colombiano (PDF CO, fila de Activación).
        let quoteId = String(i.quote_id || "").trim()
        if (!quoteId) {
          try {
            const { getQuotePointer } = await import("../../supabase-persistence-v3.ts")
            quoteId = (await getQuotePointer(contact))?.quoteId || ""
          } catch { /* sin puntero */ }
        }
        if (!quoteId) return { ok: false, error: "No hay una cotización formal vigente en esta conversación: emítela primero con generar_link_cotizadora." }
        const userCount = Number(i.userCount || 0)
        if (!userCount) return { ok: false, error: "Pásame la configuración COMPLETA nueva (userCount, y hardware/puntos si lleva equipo)." }
        const { cotizarCO } = await import("./cotizar")
        const { clasificarUbicacionCO } = await import("./geografia")
        const cfg = aInputCotizarCO(i as CotizarIn) as { userCount: number; reloj?: { modalidad: "arriendo" | "venta"; cantidad: number }; puntosInstalacion?: Array<{ ubicacion: string; autoInstalada: boolean }> }
        const calculo = cotizarCO({
          userCount,
          reloj: cfg.reloj,
          puntos: (cfg.puntosInstalacion || []).map((p) => ({ ubicacion: p.ubicacion, zona: clasificarUbicacionCO(p.ubicacion).zona, autoInstalada: p.autoInstalada })),
        })
        const { actualizarCotizacion } = await import("../../tools/actualizar-cotizacion.ts")
        const r = await actualizarCotizacion({
          quote_id: quoteId,
          userCount,
          modulos: ["asistencia"],
          resumen_cambio: String(i.resumen_cambio || "cambio de configuración").slice(0, 200),
          _itemsPais: { pais: "co", items: calculo.itemsCotizador as unknown[] },
        })
        return { ...r, quoteId }
      }
      case "anualizar_cotizacion":
        return sinCapacidad("todavía no existe el pago anual", "Ofrece la mensualidad; si el cliente insiste en pagar el año, deriva con derivar_a_soporte motivo fuera_de_scope.")
      default:
        return base(name, input)
    }
  }
}
