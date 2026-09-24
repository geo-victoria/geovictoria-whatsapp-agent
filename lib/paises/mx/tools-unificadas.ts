/**
 * TOOLS ÚNICAS — México (24-sep, mismo molde que Perú y Colombia: "una sola
 * tool por herramienta para todos los países, no se replican").
 *
 * Expone los nombres del núcleo. Por debajo: motor real de México
 * (buildDispatchMX: cotizarMX en MXN, create-from-vicky-mx, lead al equipo MX,
 * Foundry, comprobante BANORTE, agenda Cal si está configurada), traducción de
 * formas (hardware[] → reloj, contactoEmail → email, rutEmpresa → rfc, motivos
 * CL → MX) y respuesta HONESTA donde México no tiene la capacidad
 * (certificación, ficha PDF). Descuentos = Chile desde el 24-sep (escalera
 * 10 → 20 % sobre el plan, memoria `mx_pref_`).
 */
import { marcarNoContactarSchema } from "../../tools/marcar-no-contactar.ts"
import { programarSeguimientoSchema } from "../../tools/programar-seguimiento.ts"
import { reenviarCotizacionCorreoSchema } from "../../tools/reenviar-cotizacion-correo.ts"
import { buscarProspectSchemaPais } from "../buscar-prospect-schema.ts"
import { fichaOperativa } from "../ficha-operativa.ts"

const TZ_MX_FICHA = fichaOperativa("mx").tz

// Agenda en línea de México: el evento de Cal del equipo MX (env CAL_EVENT_TYPE_ID_MX; vacío = apagada).
const CAL_EVENT_TYPE_ID_MX = (process.env.CAL_EVENT_TYPE_ID_MX ?? "6101466").trim()
const REUNIONES_MX_HABILITADAS = Boolean(CAL_EVENT_TYPE_ID_MX)
const TZ_MX = TZ_MX_FICHA

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

const AGENDA_MX_SCHEMAS: Schema[] = [
  {
    name: "consultar_disponibilidad_horario",
    description:
      "Verifica si una fecha y hora propuesta POR EL CLIENTE está disponible en el calendario del equipo comercial de México. Úsala cuando el cliente proponga un horario específico para una reunión. Tú NUNCA propones horarios primero. Interpreta la propuesta en la zona horaria de Colombia (${TZ_MX_FICHA}, UTC-6). Si hay un slot a menos de 15 min de la propuesta, devuelve 'disponible_exacto' (pasa ese slotIso a agendar_reunion). Si no, devuelve alternativas: preséntaselas en prosa natural y espera a que elija.",
    input_schema: {
      type: "object" as const,
      properties: { fechaPropuesta: { type: "string" as const, description: `ISO 8601 con timezone, interpretada en ${TZ_MX_FICHA}.` } },
      required: ["fechaPropuesta"],
    },
  },
  {
    name: "agendar_reunion",
    description:
      "Agenda una reunión con un ejecutivo del equipo comercial de México (calendario + lead en el CRM + evento). Llamar SOLO cuando el cliente confirmó explícitamente un horario (idealmente tras consultar_disponibilidad_horario con 'disponible_exacto', usando ese slotIso). Antes captura nombre completo, correo y empresa.",
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

const HARDWARE_MX = {
  type: "array" as const,
  items: {
    type: "object" as const,
    properties: {
      id: { type: "string" as const, description: "ID del equipo del catálogo de México: 'reloj_mx'." },
      cantidad: { type: "number" as const, minimum: 1, maximum: 50, description: "Unidades. Default 1." },
      modalidad: {
        type: "string" as const,
        enum: ["arriendo", "venta"],
        description: "POR DEFECTO 'arriendo' (renta). 'venta' ÚNICAMENTE si el cliente pidió COMPRAR con esas palabras.",
      },
    },
    required: ["id"],
  },
  description: "Solo si la configuración lleva reloj checador. Si no lo mencionó, dejar vacío.",
}
const PUNTOS_MX = {
  type: "array" as const,
  items: {
    type: "object" as const,
    properties: {
      ubicacion: { type: "string" as const, description: "Ciudad, alcaldía o municipio tal como lo dijo el cliente (la tool clasifica la zona: CDMX y Zona Metropolitana / estados cercanos / resto del país)." },
      autoInstalada: { type: "boolean" as const, description: "true por defecto (el cliente instala). false SOLO si pidió visita técnica." },
    },
    required: ["ubicacion"],
  },
  description: "Un punto por cada lugar físico con reloj. Obligatorio siempre que la configuración lleve reloj (renta o venta): de la ciudad dependen el envío y la instalación.",
}

function sinCapacidad(que: string, enSuLugar: string) {
  return { ok: false as const, sinCapacidadEnPais: "mx", error: `En México ${que}. ${enSuLugar} No afirmes al cliente que esto se hizo.` }
}

const AGENDA_STUB = (): Schema[] => [
  {
    name: "consultar_disponibilidad_horario",
    description: "México NO tiene agenda en línea hoy: esta tool te lo recuerda. Para una reunión usa derivar_a_soporte (motivo solicitud_explicita_persona) con el horario que propuso el cliente.",
    input_schema: { type: "object" as const, properties: { fechaPropuesta: { type: "string" as const } }, required: [] },
  },
  {
    name: "agendar_reunion",
    description: "México NO tiene agenda en línea hoy: esta tool te lo recuerda. La reunión la coordina el ejecutivo — usa derivar_a_soporte (motivo solicitud_explicita_persona) con el horario propuesto.",
    input_schema: { type: "object" as const, properties: { slotIso: { type: "string" as const }, prospectName: { type: "string" as const } }, required: [] },
  },
  {
    name: "reagendar_reunion",
    description: "México NO tiene agenda en línea hoy: esta tool te lo recuerda. Usa derivar_a_soporte (motivo solicitud_explicita_persona) con el nuevo horario.",
    input_schema: { type: "object" as const, properties: { newSlotIso: { type: "string" as const } }, required: [] },
  },
]

export const TOOL_SCHEMAS_MX_UNIFICADAS: Schema[] = [
  {
    name: "cotizar_referencial",
    description:
      "Calcula un estimado mensual referencial en pesos mexicanos (MXN) para una empresa de 1 a 50 trabajadores, según los módulos de software y el hardware de marcaje que el prospecto haya elegido. Úsalo cuando ya tengas userCount confirmado y al menos un módulo o hardware definido. Si la cotización incluye hardware, también requiere el array 'puntosInstalacion' (uno por punto físico donde se instalará un reloj checador). Si el prospecto tiene más de 50 trabajadores, NO uses esta tool — deriva con derivar_a_soporte. Devuelve `mensajeParaProspecto` listo para copiar TAL CUAL: es la única fuente de precios (montos NETOS '+ IVA': en México todo lleva IVA 16 %). NUNCA calcules ni enuncies precios tú. escalonDescuento (1 = 10 %, 2 = 20 % sobre el plan, 6 meses) SOLO ante una objeción de precio, nunca de entrada.",
    input_schema: {
      type: "object" as const,
      properties: {
        userCount: { type: "number" as const, minimum: 1, maximum: 50, description: "Personas que marcarán asistencia (1-50)." },
        modulos: { type: "array" as const, items: { type: "string" as const }, description: "IDs de módulos. En México siempre ['asistencia'] (opcional: se asume)." },
        hardware: HARDWARE_MX,
        puntosInstalacion: PUNTOS_MX,
        escalonDescuento: { type: "number" as const, enum: [0, 1, 2], description: "Escalón de descuento del plan ya ofrecido (0 sin descuento · 1 = 10 % · 2 = 20 %, por 6 meses). Solo tras una objeción de precio." },
      },
      required: ["userCount"],
    },
  },
  {
    name: "consultar_descuento_referencial",
    description:
      "La escalera de descuento sobre el ÚLTIMO estimado (10 % → 20 % sobre el plan, 6 meses; la renta del reloj no baja). Llámala cuando el cliente objeta el precio del estimado: avanza UN escalón y devuelve `mensajeParaProspecto` con el precio rebajado (cópialo tal cual) y `topeAlcanzado=true` cuando ya diste el 20 % (ahí no hay más rebaja y lo dices con franqueza). NUNCA calcules tú el porcentaje. Si no hubo estimado previo en esta conversación, pasa la configuración (userCount, hardware, puntosInstalacion).",
    input_schema: {
      type: "object" as const,
      properties: {
        userCount: { type: "number" as const, minimum: 1, maximum: 50 },
        modulos: { type: "array" as const, items: { type: "string" as const } },
        hardware: HARDWARE_MX,
        puntosInstalacion: PUNTOS_MX,
        escalonActual: { type: "number" as const, enum: [0, 1, 2], description: "Cuántos escalones ya ofreciste en ESTA negociación: 0 en la primera objeción. El servidor lleva la cuenta y avanza UN escalón por llamada." },
      },
      required: [],
    },
  },
  {
    name: "generar_link_cotizadora",
    description:
      "Crea la cotización formal en Zoho CRM, genera el PDF de propuesta y, SI hay correo, se lo envía al cliente. `contactoEmail` es OPCIONAL: con el RFC y la razón social basta para emitir — sin correo la entrega corre por este mismo WhatsApp (tu mensaje con el link + el PDF que adjunta el sistema). Devuelve el link de aceptación. Úsala apenas el cliente entregue el RFC y la razón social tras mostrar el precio (con o sin correo): esa entrega ES la confirmación implícita — no hagas preguntas de confirmación adicionales. NO la uses si el cliente está rechazando ni antes de que haya visto un precio. Si la cotización incluye reloj, requiere el array 'puntosInstalacion' (uno por punto físico). En México: RFC en `rutEmpresa` (como venga: con o sin guiones o espacios) y la RAZÓN SOCIAL en `empresa` (en México no se resuelve sola desde el RFC: pídela al cierre junto con el RFC); PDF y link en MXN, pago por transferencia a BANORTE (o tarjeta cuando la página la ofrezca). Pasa el MISMO escalonDescuento que el cliente aceptó. Copia `mensajeParaProspecto` TAL CUAL; JAMÁS escribas un link de memoria.",
    input_schema: {
      type: "object" as const,
      properties: {
        empresa: { type: "string" as const, description: "Razón social de la empresa (en México se pide al cierre junto con el RFC)." },
        contacto: { type: "string" as const, description: "Nombre completo de la persona de contacto." },
        contactoEmail: { type: "string" as const, description: "Correo del contacto (opcional: sin correo la entrega va por este chat)." },
        contactoTelefono: { type: "string" as const, description: "Se completa solo con el WhatsApp del cliente; no lo pidas." },
        rutEmpresa: { type: "string" as const, description: "RFC de la empresa o persona, como lo dio el cliente." },
        userCount: { type: "number" as const, minimum: 1, maximum: 50 },
        modulos: { type: "array" as const, items: { type: "string" as const } },
        hardware: HARDWARE_MX,
        puntosInstalacion: PUNTOS_MX,
        escalonDescuento: { type: "number" as const, enum: [0, 1, 2], description: "El MISMO escalón que el cliente aceptó en el estimado (si lo omites se usa el último ofrecido en esta conversación): la formal nace con ese % en el plan por 6 meses." },
      },
      // Mismo contrato que Chile (Lalo 03-ago / 21-sep): el correo es OPCIONAL.
      required: ["empresa", "contacto", "rutEmpresa", "userCount"],
    },
  },
  SOPORTE_SCHEMA,
  {
    name: "registrar_solicitud_callback",
    description: "El cliente pide que lo LLAMEN: queda registrado en el CRM (territorio México) para que el equipo comercial lo contacte. Pasa lo que el cliente dijo (necesidad, personas, horario preferido); NO inventes campos.",
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
      "Registra un comprobante de transferencia bancaria (BANORTE, cuenta de CHECADOR, S.A. de C.V.) que el cliente envió por el chat (imagen o PDF descrito en el historial). Úsala SIEMPRE que el cliente mande un comprobante de pago de su cotización. Extrae lo que se vea: monto en pesos mexicanos, banco emisor y fecha. La tool lo asocia a la cotización vigente, avisa al equipo y devuelve `mensajeParaProspecto` (con el acceso al onboarding si el comprobante era legible): cópialo TAL CUAL. montoDetectado solo si lo LEÍSTE (si no, 0; nunca lo deduzcas del precio). Nunca afirmes tú que el pago quedó confirmado: se confirma la recepción, no el dinero.",
    input_schema: {
      type: "object" as const,
      properties: {
        montoDetectado: { type: "number" as const, description: "Monto transferido en MXN tal como se lee en el comprobante; 0 si no se lee." },
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
      "Registra al prospecto como lead en el CRM (territorio México) y lo deja en manos del equipo comercial de México, que lo contacta. Motivos: fuera_de_rango_trabajadores (más personas de las que cotizas), solicitud_explicita_persona (pide hablar con una persona o una reunión — pon en contexto el día/hora que propuso), callback, fuera_de_scope, cliente_existente_problema, tool_fallo, transferir_soporte_operativo, agendar_reunion. El RFC NUNCA es requisito. `contexto` = necesidad, configuración y precios cotizados. Devuelve `mensajeParaProspecto`.",
    input_schema: {
      type: "object" as const,
      properties: {
        motivo: {
          type: "string" as const,
          enum: ["fuera_de_rango_trabajadores", "cliente_existente_problema", "solicitud_explicita_persona", "tool_fallo", "fuera_de_scope", "agendar_reunion", "callback", "transferir_soporte_operativo"],
        },
        contexto: { type: "string" as const, description: "Resumen para el ejecutivo." },
        nombre: { type: "string" as const },
        rutEmpresa: { type: "string" as const, description: "RFC, si lo dio." },
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
  // La MISMA descripción que Chile (ver el comentario en pe/tools-unificadas).
  reenviarCotizacionCorreoSchema as unknown as Schema,
  {
    name: "enviar_cotizacion_whatsapp",
    description: "Manda el PDF de la cotización formal por ESTE mismo chat. Devuelve ok:true solo si salió.",
    input_schema: { type: "object" as const, properties: { quote_id: { type: "string" as const } }, required: ["quote_id"] },
  },
  ...(REUNIONES_MX_HABILITADAS ? AGENDA_MX_SCHEMAS : AGENDA_STUB()),
  {
    name: "enviar_certificacion",
    description: "En México NO existe un documento de certificación (la STPS no certifica sistemas): esta tool te lo recuerda. Responde con el bloque legal, sin prometer papeles.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "enviar_ficha_reloj",
    description: "En México NO hay ficha PDF del reloj checador: esta tool te lo recuerda. Descríbelo en texto (rostro, huella, tarjeta o clave; WiFi o cable), sin marcas ni modelos.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  buscarProspectSchemaPais("RFC", "con o sin guiones o espacios"),
  {
    name: "consultar_siguiente_descuento",
    description:
      "Con una cotización FORMAL ya emitida: dice qué escalón de descuento corresponde ofrecer ahora (10 % → 20 % sobre el plan, 6 meses) SIN aplicarlo y devuelve el precio recalculado en `mensajeParaProspecto` (cópialo TAL CUAL; en pesos mexicanos, neto + IVA). Úsala cuando el cliente objeta el precio de la formal; nunca proactiva. Si el cliente acepta, llama aplicar_siguiente_descuento. Con `topeAlcanzado=true` es el último escalón.",
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
      "Cambia la cotización FORMAL vigente de esta conversación (más o menos personas, agregar o quitar el reloj, cambiar modalidad o puntos). La MISMA cotización se actualiza en sitio: el link NO cambia (en el mismo link ya aparece al día) y el PDF nuevo va a su correo. Pasa la configuración COMPLETA nueva (userCount siempre; hardware y puntosInstalacion si lleva equipo). Copia `mensajeParaProspecto` TAL CUAL. Llámala EN EL MISMO TURNO en que el cliente pide el cambio: jamás anuncies 'te la actualizo' sin llamarla.",
    input_schema: {
      type: "object" as const,
      properties: {
        quote_id: { type: "string" as const, description: "Id de la cotización formal (si lo omites, se usa la vigente)." },
        userCount: { type: "number" as const, minimum: 1, maximum: 50, description: "Dotación FINAL tras el cambio." },
        modulos: { type: "array" as const, items: { type: "string" as const } },
        hardware: HARDWARE_MX,
        puntosInstalacion: PUNTOS_MX,
        resumen_cambio: { type: "string" as const, description: "Qué pidió cambiar el cliente, en una frase." },
      },
      required: ["userCount"],
    },
  },
  {
    name: "anualizar_cotizacion",
    description:
      "Convierte la cotización formal vigente a PAGO ANUAL: los 12 meses de todo lo recurrente (plan y arriendo) se cobran por adelantado en un solo pago, al mismo precio (12 × la mensualidad; el descuento comiteado del plan se aplica los meses de su vigencia). SOLO si el cliente lo pide — jamás proactiva. Si objeta el monto, primero la escalera de descuento y después anualizas. La MISMA cotización se actualiza (mismo link, PDF nuevo). Copia `mensajeParaProspecto` tal cual.",
    input_schema: {
      type: "object" as const,
      properties: { quote_id: { type: "string" as const, description: "Id de la cotización formal (si lo omites, se usa la vigente de esta conversación)." } },
      required: [],
    },
  },
]

type HardwareIn = { id?: string; cantidad?: number; modalidad?: string }
type PuntoIn = { ubicacion?: string; autoInstalada?: boolean }
type CotizarIn = { userCount?: number; hardware?: HardwareIn[]; puntosInstalacion?: PuntoIn[] }

export function relojDeHardwareMX(hardware?: HardwareIn[]): { modalidad: "arriendo" | "venta"; cantidad: number } | undefined {
  const lista = Array.isArray(hardware) ? hardware.filter((h) => h && typeof h === "object") : []
  if (lista.length === 0) return undefined
  const cantidad = lista.reduce((a, h) => a + Math.max(1, Math.round(Number(h.cantidad) || 1)), 0)
  const modalidad = lista.some((h) => h.modalidad === "venta") ? "venta" : "arriendo"
  return { modalidad, cantidad }
}

/** Forma chilena de cotizar → input de la tool base MX (puntos con reloj, en ambas modalidades). */
export function aInputCotizarMX(i: CotizarIn) {
  const reloj = relojDeHardwareMX(i.hardware)
  const out: Record<string, unknown> = { userCount: Number(i.userCount || 0) }
  if (reloj) out.reloj = reloj
  const puntos = (Array.isArray(i.puntosInstalacion) ? i.puntosInstalacion : [])
    .filter((p) => p && typeof p === "object")
    .map((p) => ({ ubicacion: String(p.ubicacion || ""), autoInstalada: p.autoInstalada === false ? false : true }))
  if (reloj && puntos.length > 0) out.puntosInstalacion = puntos
  return out
}

const MOTIVO_MX: Record<string, string> = {
  fuera_de_rango_trabajadores: "mas_de_50",
  solicitud_explicita_persona: "pidio_persona",
  agendar_reunion: "pidio_persona",
  callback: "pidio_persona",
  tool_fallo: "cotizacion_formal",
  fuera_de_scope: "fuera_de_alcance",
  cliente_existente_problema: "otro",
  transferir_soporte_operativo: "otro",
}

type PrefMX = { userCount: number; hardware?: HardwareIn[]; puntosInstalacion?: PuntoIn[]; escalon: number }

/**
 * Cotización FORMAL vigente de la conversación (puntero) con la guarda de
 * Pagada — la misma que Perú, sin leer campos peruanos.
 */
async function formalVigenteMX(contact: string, quoteId?: string): Promise<{ quoteId: string } | { error: string }> {
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

export function buildDispatchMXUnificado(contact: string) {
  // Import dinámico: el motor MX trae Zoho/Cal/Foundry (no puro).
  let basePromise: Promise<(name: string, input: unknown) => Promise<unknown>> | null = null
  const base = (name: string, input: unknown) => {
    basePromise ??= import("./tools").then((m) => m.buildDispatchMX(contact))
    return basePromise.then((fn) => fn(name, input))
  }
  // Memoria del ÚLTIMO estimado (vic_kv `co_pref_<contact>`) para que
  // consultar_descuento_referencial funcione sin argumentos, igual que en
  // Chile, Perú y Colombia (Lalo 24-sep: "descuento igualemos con Chile").
  const kvKey = `mx_pref_${contact}`
  async function leerPref(): Promise<PrefMX | null> {
    try {
      const { getKvValue } = await import("../../supabase-persistence-v3.ts")
      const raw = await getKvValue(kvKey)
      return raw ? (JSON.parse(raw) as PrefMX) : null
    } catch {
      return null
    }
  }
  async function guardarPref(p: PrefMX): Promise<void> {
    try {
      const { setKvValue } = await import("../../supabase-persistence-v3.ts")
      await setKvValue(kvKey, JSON.stringify(p))
    } catch {
      /* la memoria del estimado es best-effort */
    }
  }
  return async function dispatchMXUnificado(name: string, input: unknown): Promise<unknown> {
    const i = (input || {}) as Record<string, unknown>
    switch (name) {
      case "cotizar_referencial": {
        const esc = Math.min(2, Math.max(0, Number(i.escalonDescuento || 0)))
        const r = await base("cotizar_referencial", { ...aInputCotizarMX(i as CotizarIn), escalonDescuento: esc })
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
        // La MEMORIA del estimado manda (Chile, Capa 3): el escalón del modelo
        // solo cuenta cuando no hay estimado guardado — si el modelo pasa
        // escalonActual=1 en la PRIMERA objeción, la escalera saltaba al 20 %
        // (batería CO 23-sep). Un escalón por objeción, siempre desde lo ofrecido.
        const actual = pref ? Math.max(0, Math.min(2, pref.escalon || 0)) : Math.max(0, Math.min(2, Number(i.escalonActual || 0)))
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
        const r = (await base("cotizar_referencial", { ...aInputCotizarMX(cfg), escalonDescuento: escalon })) as Record<string, unknown>
        if (r?.ok) {
          await guardarPref({ userCount: cfg.userCount, hardware: cfg.hardware, puntosInstalacion: cfg.puntosInstalacion, escalon })
          return { ...r, escalonDescuento: escalon, escalonActual: escalon, topeAlcanzado: escalon >= 2 }
        }
        return r
      }
      case "consultar_siguiente_descuento": {
        const f = await formalVigenteMX(contact, i.quote_id as string | undefined)
        if ("error" in f) return { ok: false, error: f.error }
        const { consultarSiguienteDescuento } = await import("../../tools/consultar-siguiente-descuento.ts")
        const r = await consultarSiguienteDescuento({ quote_id: f.quoteId })
        return { ...r, quoteId: f.quoteId }
      }
      case "aplicar_siguiente_descuento": {
        const f = await formalVigenteMX(contact, i.quote_id as string | undefined)
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
        // La configuración de la formal = la del MODELO, nunca la memoria
        // `mx_pref_` (mismo defecto que PE, caso Rodrigo 22-sep: el último
        // estimado siempre trae el equipo y "solo app" es la llamada sin
        // hardware). Sin hardware en el input = sin hardware, como en Chile.
        const pref = await leerPref()
        const esc = Math.min(2, Math.max(0, Number(i.escalonDescuento ?? pref?.escalon ?? 0)))
        const hardware = i.hardware as HardwareIn[] | undefined
        // México no tiene padrón que resuelva la razón social desde el RFC.
        if (!String(i.empresa || "").trim()) {
          return { ok: false, error: "Falta la RAZÓN SOCIAL: en México no se resuelve desde el RFC. Pídesela al cliente en una frase corta (junto con el RFC si también falta) y vuelve a llamar la tool." }
        }
        return base("generar_link_cotizadora", {
          empresa: i.empresa,
          contacto: i.contacto,
          email: i.contactoEmail || i.email,
          rfc: i.rutEmpresa || i.rfc,
          ...aInputCotizarMX({
            userCount: Number(i.userCount || pref?.userCount || 0),
            hardware,
            puntosInstalacion: hardware?.length ? (i.puntosInstalacion as PuntoIn[] | undefined) : undefined,
          } as CotizarIn),
          escalonDescuento: esc,
        })
      }
      case "derivar_a_soporte": {
        const motivo = MOTIVO_MX[String(i.motivo || "")] || "otro"
        return base("derivar_a_ejecutivo", {
          nombre: String(i.nombre || "Prospecto WhatsApp"),
          empresa: i.empresa,
          email: i.email,
          rfc: i.rutEmpresa,
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
        return base(name, input)
      // ── Agenda = las tools chilenas con el evento de Cal del equipo MX ──
      // El agent-loop inyecta `eventTypeId` cuando el dueño del deal/lead
      // tiene evento propio; si no viene, el evento MX por defecto. Jamás al
      // round-robin chileno.
      case "consultar_disponibilidad_horario": {
        if (!REUNIONES_MX_HABILITADAS) return base(name, input)
        const { consultarDisponibilidadHorario } = await import("../../tools/consultar-disponibilidad-horario.ts")
        const iA = i as { fechaPropuesta?: string; eventTypeId?: string }
        return consultarDisponibilidadHorario({
          fechaPropuesta: String(iA.fechaPropuesta || ""),
          country: "México",
          eventTypeId: (iA.eventTypeId || "").trim() || CAL_EVENT_TYPE_ID_MX,
        })
      }
      case "agendar_reunion": {
        if (!REUNIONES_MX_HABILITADAS) return base(name, input)
        const { agendarReunion } = await import("../../tools/agendar-reunion.ts")
        const iA = i as { telefono?: string; eventTypeId?: string; prospectEmail?: string }
        const r = await agendarReunion({
          ...(i as object),
          telefono: (iA.telefono || "").trim() || contact,
          country: "México",
          eventTypeId: (iA.eventTypeId || "").trim() || CAL_EVENT_TYPE_ID_MX,
        } as never)
        if (!r.ok) return r
        const email = iA.prospectEmail || "tu correo"
        return {
          ...r,
          timezone: TZ_MX,
          mensajeParaProspecto:
            `Listo!! Tu reunión quedó agendada para el ${fechaLegibleMX(r.slotIso)} (hora del centro de México)${r.atiende ? `, con ${r.atiende.nombre}` : ""} 🎉 ` +
            `Te llegará la invitación con el link de la reunión a ${email}.` +
            (r.atiende?.email ? ` Si necesitas algo antes, le escribes a 📧 ${r.atiende.email}${r.atiende.whatsapp ? ` o al 📱 ${r.atiende.whatsapp}` : ""}.` : "") +
            ` Te puedo ayudar en algo más?`,
        }
      }
      case "reagendar_reunion": {
        if (!REUNIONES_MX_HABILITADAS) return base(name, input)
        const { reagendarReunion } = await import("../../tools/reagendar-reunion.ts")
        const r = await reagendarReunion({ ...(i as object), country: "México", _contact: contact } as never)
        if (!r.ok) return r
        return {
          ...r,
          mensajeParaProspecto:
            `Listo!! Tu reunión quedó reagendada para el ${fechaLegibleMX(r.slotIso)} (hora del centro de México) 📅 ` +
            `Te llegará la nueva invitación por correo. Te puedo ayudar en algo más?`,
        }
      }
      case "enviar_cotizacion_whatsapp": {
        const { enviarCotizacionWhatsapp } = await import("../../tools/enviar-cotizacion-whatsapp.ts")
        return enviarCotizacionWhatsapp({ ...(i as object), _contact: contact } as never)
      }
      case "registrar_comprobante_transferencia": {
        // Transferencia BANORTE: la MISMA tool chilena con el país (montos en MXN).
        const { registrarComprobanteTransferencia } = await import("../../tools/registrar-comprobante-transferencia.ts")
        return registrarComprobanteTransferencia(contact, i as never, "mx")
      }
      case "enviar_certificacion":
        return sinCapacidad("no existe un documento de certificación (la STPS no certifica sistemas)", "Responde con el bloque legal: registro ordenado y trazable; sin prometer papeles.")
      case "buscar_prospect_en_zoho": {
        // Misma búsqueda que Chile: el RFC vive en RUT_Empresa (create-from-vicky-mx).
        const { buscarProspectEnZoho } = await import("../../tools/buscar-prospect-en-zoho.ts")
        return buscarProspectEnZoho(input as never)
      }
      case "enviar_ficha_reloj":
        return sinCapacidad("no hay ficha PDF del reloj checador", "Descríbelo en texto: rostro, huella, tarjeta o clave; WiFi o cable de red; se conecta a la nube en minutos. Sin marcas ni modelos.")
      case "actualizar_cotizacion": {
        // EDICIÓN EN SITIO = LA TOOL CHILENA: México solo arma los ítems con su
        // motor (cotizarMX, MXN) y el endpoint edita la MISMA cotización con
        // el perfil mexicano (PDF MX). Ítems a LISTA: el % vive en la cotización.
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
        const { cotizarMX } = await import("./cotizar")
        const { clasificarUbicacionMX } = await import("./geografia")
        const cfg = aInputCotizarMX(i as CotizarIn) as { userCount: number; reloj?: { modalidad: "arriendo" | "venta"; cantidad: number }; puntosInstalacion?: Array<{ ubicacion: string; autoInstalada: boolean }> }
        const calculo = cotizarMX({
          userCount,
          reloj: cfg.reloj,
          puntos: (cfg.puntosInstalacion || []).map((p) => ({ ubicacion: p.ubicacion, zona: clasificarUbicacionMX(p.ubicacion).zona, autoInstalada: p.autoInstalada })),
        })
        const { actualizarCotizacion } = await import("../../tools/actualizar-cotizacion.ts")
        const r = await actualizarCotizacion({
          quote_id: quoteId,
          userCount,
          modulos: ["asistencia"],
          resumen_cambio: String(i.resumen_cambio || "cambio de configuración").slice(0, 200),
          _itemsPais: { pais: "mx", items: calculo.itemsCotizador as unknown[] },
        })
        return { ...r, quoteId }
      }
      case "anualizar_cotizacion":
        // La anualidad aún no está habilitada en México (sin decisión de Lalo).
        return sinCapacidad("el pago anual aún no está habilitado", "Si el cliente lo pide, dile que lo reviso con el ejecutivo y sigue con el pago mensual; o deriva con derivar_a_soporte (motivo solicitud_explicita_persona).")
      default:
        return base(name, input)
    }
  }
}
