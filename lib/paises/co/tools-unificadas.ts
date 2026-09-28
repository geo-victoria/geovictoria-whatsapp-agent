/**
 * TOOLS ÚNICAS — Colombia (21-sep; 27-sep: implementación = la de Chile).
 *
 * Expone los nombres del núcleo. Las tools GLOBALES corren en
 * lib/paises/tools-globales.ts (la implementación chilena de lib/tools/* con
 * los datos de Colombia: ficha operativa, eventos de Cal de las ejecutivas,
 * ítems del motor colombiano). Acá queda solo lo propio: motor de precios
 * (motor único con datos de CO, memoria `co_pref_`), emisión contra
 * create-from-vicky-co, anualidad (lib/paises/anualizar-pais.ts) y la
 * respuesta honesta de enviar_certificacion. tests/tools-globales.test.ts
 * vigila que este archivo no vuelva a atender una tool global.
 *
 * Imports estáticos solo a módulos que los tests puros cargan.
 */
import { marcarNoContactarSchema } from "../../tools/marcar-no-contactar.ts"
import { programarSeguimientoSchemaPais } from "../../tools/programar-seguimiento.ts"
import { derivarASoporteSchemaPais } from "../../tools/derivar-a-soporte.ts"
import { despacharToolGlobal, esToolGlobal, guardarPrefPais, leerPrefPais, type ConfigFormal, type PrefPais } from "../tools-globales.ts"
import { reenviarCotizacionCorreoSchema } from "../../tools/reenviar-cotizacion-correo.ts"
import { buscarProspectSchemaPais } from "../buscar-prospect-schema.ts"

import { agendaCoActiva, eventoAgendaCO } from "./agenda.ts"

// Agenda en línea de Colombia (23-sep): activa salvo env VICKY_AGENDA_CO=off.
const REUNIONES_CO_HABILITADAS = agendaCoActiva()


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
      ubicacion: { type: "string" as const, description: "Ciudad o municipio tal como lo dijo el cliente (la tool clasifica la zona: Bogotá y alrededores / Cundinamarca-Boyacá-Tolima-Meta / resto del país)." },
      autoInstalada: { type: "boolean" as const, description: "true por defecto (el cliente instala). false SOLO si pidió visita técnica." },
    },
    required: ["ubicacion"],
  },
  description: "Un punto por cada lugar físico con equipo. Obligatorio siempre que la configuración lleve equipo (alquiler o venta): de la ciudad dependen el despacho y la instalación.",
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
      "Calcula un estimado mensual referencial en pesos colombianos (COP) para una empresa de 1 a 50 trabajadores, según los módulos de software y el hardware de marcaje que el prospecto haya elegido. Úsalo cuando ya tengas userCount confirmado y al menos un módulo o hardware definido. Si la cotización incluye hardware, también requiere el array 'puntosInstalacion' (uno por punto físico donde se instalará un equipo biométrico). Si el prospecto tiene más de 50 trabajadores, NO uses esta tool — deriva con derivar_a_soporte. Devuelve `mensajeParaProspecto` listo para copiar TAL CUAL: es la única fuente de precios (el plan con precio final; el equipo biométrico con su IVA ya adentro). NUNCA calcules ni enuncies precios tú. escalonDescuento (1 = 10 %, 2 = 20 % sobre el plan, 6 meses) SOLO ante una objeción de precio, nunca de entrada.",
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
        escalonActual: { type: "number" as const, enum: [0, 1, 2], description: "Cuántos escalones ya ofreciste en ESTA negociación: 0 en la primera objeción. El servidor lleva la cuenta y avanza UN escalón por llamada." },
      },
      required: [],
    },
  },
  {
    name: "generar_link_cotizadora",
    description:
      "Crea la cotización formal en Zoho CRM, genera el PDF de propuesta y, SI hay correo, se lo envía al cliente. `contactoEmail` es OPCIONAL (Lalo 31-ago): con el NIT basta para emitir — sin correo la entrega corre por este mismo WhatsApp (tu mensaje con el link + el PDF que adjunta el sistema) y el correo se lo pide el formulario de facturación al aceptar. Devuelve dos enlaces: pdfUrl (el PDF descargable) y acceptanceUrl (la página web para aceptar). Úsala apenas el cliente entregue el NIT tras mostrar el precio (con o sin correo): esa entrega ES la confirmación implícita (política 24-jul) — no hagas preguntas de confirmación adicionales. NO la uses si el cliente está rechazando ni antes de que haya visto un precio. Si la cotización incluye hardware, requiere el array 'puntosInstalacion' (uno por punto físico donde se instalará un equipo biométrico). Normalmente NO necesitas pasar IDs de Zoho: el backend deduplica por NIT — si la empresa ya existe asocia la cotización a su cuenta, y si no la crea. En Colombia: NIT con dígito de verificación (ej. 900.123.456-7) en `rutEmpresa`, la RAZÓN SOCIAL sale sola del NIT (padrón RUES de Confecámaras) — pásala en `empresa` solo si el cliente la dijo, jamás la preguntes; PDF y link en COP con pago por tarjeta (Mercado Pago) o transferencia a Bancolombia. Pasa el MISMO escalonDescuento que el cliente aceptó. Copia `mensajeParaProspecto` TAL CUAL; JAMÁS escribas un link de memoria.",
    input_schema: {
      type: "object" as const,
      properties: {
        empresa: { type: "string" as const, description: "Razón social, SOLO si el cliente la mencionó; si no, se resuelve desde el NIT (padrón RUES de Confecámaras)." },
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
      required: ["contacto", "rutEmpresa", "userCount"],
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
  derivarASoporteSchemaPais("co") as unknown as Schema,
  marcarNoContactarSchema as unknown as Schema,
  programarSeguimientoSchemaPais("co") as unknown as Schema,
  // La MISMA descripción que Chile (ver el comentario en pe/tools-unificadas).
  reenviarCotizacionCorreoSchema as unknown as Schema,
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
    description: "Entrega la ficha técnica (PDF) del equipo biométrico (SenseFace 2A). SOLO REACTIVA: cuando el cliente pide información, especificaciones o la ficha ('¿qué equipo es?', '¿tiene huella?', '¿me mandas la ficha?'). Responde con la ficha canónica y llama esta tool en el MISMO turno. Nunca para el precio. Sin parámetros. Copia su mensajeParaProspecto TAL CUAL, sin tocar el link.",
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

export function relojDeHardwareCO(hardware?: HardwareIn[]): { modalidad: "arriendo" | "venta"; cantidad: number } | undefined {
  const lista = Array.isArray(hardware) ? hardware.filter((h) => h && typeof h === "object") : []
  if (lista.length === 0) return undefined
  const cantidad = lista.reduce((a, h) => a + Math.max(1, Math.round(Number(h.cantidad) || 1)), 0)
  const modalidad = lista.some((h) => h.modalidad === "venta") ? "venta" : "arriendo"
  return { modalidad, cantidad }
}

/** Forma chilena de cotizar → input de la tool base CO (puntos con equipo, en ambas modalidades). */
export function aInputCotizarCO(i: CotizarIn) {
  const reloj = relojDeHardwareCO(i.hardware)
  const out: Record<string, unknown> = { userCount: Number(i.userCount || 0) }
  if (reloj) out.reloj = reloj
  const puntos = (Array.isArray(i.puntosInstalacion) ? i.puntosInstalacion : [])
    .filter((p) => p && typeof p === "object")
    .map((p) => ({ ubicacion: String(p.ubicacion || ""), autoInstalada: p.autoInstalada === false ? false : true }))
  if (reloj && puntos.length > 0) out.puntosInstalacion = puntos
  return out
}

export function buildDispatchCOUnificado(contact: string) {
  // Import dinámico: el motor CO trae Zoho/Cal/Foundry (no puro).
  let basePromise: Promise<(name: string, input: unknown) => Promise<unknown>> | null = null
  const base = (name: string, input: unknown) => {
    basePromise ??= import("./tools").then((m) => m.buildDispatchCO(contact))
    return basePromise.then((fn) => fn(name, input))
  }
  const leerPref = () => leerPrefPais("co", contact) as Promise<(PrefPais & { hardware?: HardwareIn[]; puntosInstalacion?: PuntoIn[] }) | null>
  const guardarPref = (p: PrefPais) => guardarPrefPais("co", contact, p)

  /** Ítems de la formal con el motor del país (a LISTA: el % vive en la cotización). */
  async function itemsFormal(cfg: ConfigFormal): Promise<{ ok: true; items: unknown[] } | { ok: false; error: string }> {
    const { cotizarCO } = await import("./cotizar")
    const { clasificarUbicacionCO } = await import("./geografia")
    const c = aInputCotizarCO(cfg as CotizarIn) as { userCount: number; reloj?: { modalidad: "arriendo" | "venta"; cantidad: number }; puntosInstalacion?: Array<{ ubicacion: string; autoInstalada: boolean }> }
    const calculo = cotizarCO({
      userCount: Number(cfg.userCount || 0),
      reloj: c.reloj,
      puntos: (c.puntosInstalacion || []).map((p) => ({ ubicacion: p.ubicacion, zona: clasificarUbicacionCO(p.ubicacion).zona, autoInstalada: p.autoInstalada })),
    })
    return { ok: true, items: calculo.itemsCotizador as unknown[] }
  }

  const ctx = { pais: "co" as const, contact, eventoAgenda: async () => (agendaCoActiva() ? await eventoAgendaCO() : ""), itemsFormal }

  return async function dispatchCOUnificado(name: string, input: unknown): Promise<unknown> {
    // Las tools GLOBALES corren en lib/paises/tools-globales.ts (la
    // implementación chilena con los datos del país). Acá: el motor de
    // precios, la emisión contra create-from-vicky-co y la anualidad.
    if (esToolGlobal(name)) return despacharToolGlobal(ctx, name, input)
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
        const r = (await base("cotizar_referencial", { ...aInputCotizarCO(cfg), escalonDescuento: escalon })) as Record<string, unknown>
        if (r?.ok) {
          await guardarPref({ userCount: cfg.userCount, hardware: cfg.hardware, puntosInstalacion: cfg.puntosInstalacion, escalon })
          return { ...r, escalonDescuento: escalon, escalonActual: escalon, topeAlcanzado: escalon >= 2 }
        }
        return r
      }
      case "generar_link_cotizadora": {
        // La configuración de la formal = la del MODELO, nunca la memoria
        // `co_pref_` (mismo defecto que PE, caso Rodrigo 22-sep: el último
        // estimado siempre trae el equipo y "solo app" es la llamada sin
        // hardware). Sin hardware en el input = sin hardware, como en Chile.
        const pref = await leerPref()
        const esc = Math.min(2, Math.max(0, Number(i.escalonDescuento ?? pref?.escalon ?? 0)))
        const hardware = i.hardware as HardwareIn[] | undefined
        return base("generar_link_cotizadora", {
          empresa: i.empresa,
          contacto: i.contacto,
          email: i.contactoEmail || i.email,
          nit: i.rutEmpresa || i.nit,
          ...aInputCotizarCO({
            userCount: Number(i.userCount || pref?.userCount || 0),
            hardware,
            puntosInstalacion: hardware?.length ? (i.puntosInstalacion as PuntoIn[] | undefined) : undefined,
          } as CotizarIn),
          escalonDescuento: esc,
        })
      }
      case "enviar_certificacion":
        return sinCapacidad("no existe un documento de certificación (el Ministerio del Trabajo no certifica sistemas)", "Responde con el bloque legal: registro ordenado y trazable; sin prometer papeles.")
      case "anualizar_cotizacion": {
        // Anualidad = Chile (Lalo 21-sep): la MISMA edición en sitio con los
        // montos reales del subform en la moneda del país.
        const { anualizarCotizacionPais } = await import("../anualizar-pais.ts")
        return anualizarCotizacionPais(contact, "co", i.quote_id as string | undefined)
      }
      default:
        return base(name, input)
    }
  }
}
