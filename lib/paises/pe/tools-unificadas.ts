/**
 * TOOLS ÚNICAS — Perú (21-sep, orden de Lalo: "una sola tool por herramienta
 * para todos los países, no se replican").
 *
 * El prompt NÚCLEO (lib/prompt-nucleo/texto.ts) nombra las tools con los
 * nombres chilenos: cotizar_referencial, consultar_descuento_referencial,
 * generar_link_cotizadora, derivar_a_soporte, registrar_solicitud_callback,
 * agendar_reunion, … Para que Perú consuma ese mismo prompt SIN reescribirlo,
 * este archivo expone EXACTAMENTE esos nombres y esas formas de entrada, y
 * por debajo:
 *   - traduce al motor peruano donde la capacidad existe (buildDispatchPE:
 *     cotizarPE en soles, create-from-vicky-pe, lead a la ejecutiva, Foundry,
 *     comprobante, opt-out, seguimiento);
 *   - delega a la implementación chilena donde es país-neutra (reenvío por
 *     correo, PDF por WhatsApp);
 *   - EDITA EN SITIO como Chile (actualizar_cotizacion, consultar/aplicar_
 *     siguiente_descuento): usa las MISMAS tools chilenas contra el MISMO
 *     endpoint del cotizador, que desde el 21-sep conoce el país de la
 *     cotización (token) y edita con el perfil peruano (soles, PDF PE, escalera
 *     10 → 20 en el plan). Perú solo aporta los ítems de su motor (cotizarPE).
 *     Caso Lalo 21-sep: "en Chile eso no pasa, ¿por qué acá?" — ya no pasa.
 *   - agenda = las MISMAS tools chilenas (consultar/agendar/reagendar) sobre
 *     el evento de Cal de Mónica (7084664; Lalo 21-sep "igualemos a Chile"),
 *     con zona America/Lima y confirmación en hora de Perú.
 *   - responde HONESTO donde Perú no tiene la capacidad (certificación,
 *     anualidad): la tool existe, dice qué hacer en su lugar y JAMÁS simula
 *     el efecto.
 *
 * Así el prompt no necesita saber qué país tiene qué: el país es la FICHA y
 * el motor, no una copia de las tools. CO y MX pasarán por el mismo molde.
 *
 * Imports estáticos solo a módulos PUROS (mismo criterio que pe/tools.ts,
 * para que tests/ficha-pe.test.ts cargue este archivo con node --test); todo
 * lo que trae "@/…" va por import dinámico.
 */
import { TOOL_SCHEMAS_PE, buildDispatchPE } from "./tools.ts"
import { clasificarUbicacionPE, tarifaVisitaLimaPE } from "./catalogo.ts"
import { marcarNoContactarSchema } from "../../tools/marcar-no-contactar.ts"
import { programarSeguimientoSchema } from "../../tools/programar-seguimiento.ts"
import { reenviarCotizacionCorreoSchema } from "../../tools/reenviar-cotizacion-correo.ts"
import { buscarProspectSchemaPais } from "../buscar-prospect-schema.ts"

type Schema = { name: string; description: string; input_schema: Record<string, unknown> }

function schemaPE(name: string): Schema {
  const s = (TOOL_SCHEMAS_PE as unknown as Schema[]).find((t) => t.name === name)
  if (!s) throw new Error(`tools-unificadas PE: falta el schema base '${name}'`)
  return s
}

const HARDWARE_PE = {
  type: "array" as const,
  items: {
    type: "object" as const,
    properties: {
      id: { type: "string" as const, description: "ID del reloj del catálogo de Perú: 'reloj_pe'." },
      cantidad: { type: "number" as const, minimum: 1, maximum: 50, description: "Unidades. Default 1." },
      modalidad: {
        type: "string" as const,
        enum: ["arriendo", "venta"],
        description:
          "POR DEFECTO 'arriendo'. 'venta' ÚNICAMENTE si el cliente pidió COMPRAR el reloj con esas palabras.",
      },
    },
    required: ["id"],
  },
  description: "Solo si la configuración lleva reloj de control físico. Si no lo mencionó, dejar vacío.",
}

const PUNTOS_PE = {
  type: "array" as const,
  items: {
    type: "object" as const,
    properties: {
      ubicacion: { type: "string" as const, description: "Ciudad o distrito tal como lo dijo el cliente." },
      zona: {
        type: "string" as const,
        enum: ["lima", "provincias"],
        description:
          "'lima' = Lima Metropolitana (incluido el Callao); 'intermedia' = Región Lima fuera de la capital e Ica; cualquier otra ciudad del Perú = 'provincias'. Si lo omites, la tool lo deduce de la ubicación.",
      },
      autoInstalada: {
        type: "boolean" as const,
        description: "true por defecto (el cliente instala; es un reloj de mesa/pared). false SOLO si pidió visita técnica.",
      },
    },
    required: ["ubicacion"],
  },
  description: "Un punto por cada lugar físico con reloj. Con reloj en VENTA es obligatorio.",
}

const ESCALON = {
  type: "number" as const,
  enum: [0, 1, 2],
  description:
    "Escalón de descuento del PLAN (1 = 10 %, 2 = 20 %, por 6 meses) SOLO como respuesta a una objeción de precio tras mostrar la lista. 0 u omitido = sin descuento. Nunca proactivo.",
}

const TZ_PE = "America/Lima"

function fechaLegiblePE(slotIso: string): string {
  return new Date(slotIso).toLocaleString("es-PE", {
    timeZone: TZ_PE,
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
}

/** Evento de Cal por defecto para Perú: Mónica Mendoza (Lalo 21-sep). */
export const EVENTO_AGENDA_PE_DEFAULT = "7084664"

/**
 * Event type de Cal.com de la agenda peruana: vic_kv `cal_evento_pe` (cambio
 * sin deploy cuando el host pase de Lalo a Mónica o cambie el evento) → env
 * `CAL_EVENT_TYPE_ID_PE` → 7084664. Nunca vacío: sin esto la tool chilena
 * caería al round-robin de Chile.
 */
export async function eventoAgendaPE(): Promise<string> {
  try {
    const { getKvValue } = await import("../../supabase-persistence-v3.ts")
    const kv = String((await getKvValue("cal_evento_pe")) || "").trim()
    if (/^\d{3,}$/.test(kv)) return kv
  } catch {
    /* kv caído → env/default */
  }
  const env = (process.env.CAL_EVENT_TYPE_ID_PE || "").trim()
  return /^\d{3,}$/.test(env) ? env : EVENTO_AGENDA_PE_DEFAULT
}

/** Respuesta honesta de una capacidad que Perú no tiene (la tool existe, no simula). */
function sinCapacidad(que: string, enSuLugar: string) {
  return {
    ok: false as const,
    sinCapacidadEnPais: "pe",
    error: `En Perú ${que}. ${enSuLugar} No afirmes al cliente que esto se hizo.`,
  }
}

/**
 * Los 20 nombres del núcleo. Los que tienen motor real llevan su schema
 * completo; los que no, un schema mínimo (la descripción ya dice qué hacer en
 * su lugar, así el modelo no los llama a ciegas).
 */
export const TOOL_SCHEMAS_PE_UNIFICADAS: Schema[] = [
  {
    name: "cotizar_referencial",
    description:
      "Calcula el estimado mensual EN SOLES (montos netos, siempre presentados '+ IGV') para 1 a 50 personas y devuelve `mensajeParaProspecto` listo para copiar TAL CUAL — con reloj trae LAS DOS OPCIONES (reloj + app, y solo app) y la pregunta de cierre. Úsalo apenas tengas la dotación y el marcaje. NUNCA calcules ni enuncies precios tú: esta tool es la única fuente. En Lima el envío va incluido y la instalación técnica va incluida en arriendo (en venta tiene precio cerrado); a provincia envío e instalación tienen precio cerrado (envío incluido en el arriendo; en venta línea única; la tool lo calcula). La auto-instalación es gratis siempre. `escalonDescuento` SOLO ante objeción de precio.",
    input_schema: {
      type: "object" as const,
      properties: {
        userCount: { type: "number" as const, minimum: 1, maximum: 50, description: "Personas que marcarán asistencia (1-50)." },
        modulos: {
          type: "array" as const,
          items: { type: "string" as const },
          description: "IDs de módulos. En Perú siempre ['asistencia'] (opcional: se asume).",
        },
        hardware: HARDWARE_PE,
        puntosInstalacion: PUNTOS_PE,
        escalonDescuento: ESCALON,
      },
      required: ["userCount"],
    },
  },
  {
    name: "consultar_descuento_referencial",
    description:
      "La escalera de descuento sobre el ÚLTIMO estimado (10 % → 20 % sobre el plan, 6 meses). Llámala cuando el cliente objeta el precio del estimado: avanza UN escalón y devuelve `mensajeParaProspecto` con el precio rebajado (cópialo tal cual) y `topeAlcanzado=true` cuando ya diste el 20 % (ahí no hay más rebaja y lo dices con franqueza). NUNCA calcules tú el porcentaje. Si no hubo estimado previo en esta conversación, pasa la configuración (userCount, hardware, puntosInstalacion).",
    input_schema: {
      type: "object" as const,
      properties: {
        userCount: { type: "number" as const, minimum: 1, maximum: 50 },
        modulos: { type: "array" as const, items: { type: "string" as const } },
        hardware: HARDWARE_PE,
        puntosInstalacion: PUNTOS_PE,
        escalonActual: { type: "number" as const, enum: [0, 1, 2], description: "Escalón ya ofrecido, si lo sabes." },
      },
      required: [],
    },
  },
  {
    name: "generar_link_cotizadora",
    description:
      "Genera la COTIZACIÓN FORMAL de Perú: crea la cotización (PDF en soles, netos + IGV) y devuelve el link donde el cliente la revisa, la acepta y paga (tarjeta vía Mercado Pago o transferencia BBVA; el comprobante llega por este chat). Úsala cuando el cliente quiere avanzar tras ver el precio. REQUIERE contacto y rutEmpresa = el RUC de 11 dígitos (la razón social sale sola del RUC vía padrón SUNAT: pásala solo si el cliente la dijo, jamás la preguntes); contactoEmail es OPCIONAL, userCount y la configuración (hardware/puntos si lleva reloj). Pasa el MISMO escalonDescuento que el cliente aceptó. Copia `mensajeParaProspecto` TAL CUAL; JAMÁS escribas un link de memoria.",
    input_schema: {
      type: "object" as const,
      properties: {
        empresa: { type: "string" as const, description: "Razón social, SOLO si el cliente la mencionó; si no, se resuelve desde el RUC (padrón SUNAT)." },
        contacto: { type: "string" as const, description: "Nombre de la persona de contacto." },
        contactoEmail: { type: "string" as const, description: "Correo del contacto (obligatorio)." },
        contactoTelefono: { type: "string" as const, description: "Se completa solo con el WhatsApp del cliente; no lo pidas." },
        rutEmpresa: { type: "string" as const, description: "RUC de la empresa (11 dígitos)." },
        userCount: { type: "number" as const, minimum: 1, maximum: 50 },
        modulos: { type: "array" as const, items: { type: "string" as const } },
        hardware: HARDWARE_PE,
        puntosInstalacion: PUNTOS_PE,
        escalonDescuento: ESCALON,
      },
      // Mismo contrato que Chile (Lalo 03-ago / 21-sep): el correo es OPCIONAL —
      // con RUC + razón social basta para emitir; sin correo la entrega va por el chat.
      required: ["contacto", "rutEmpresa", "userCount"],
    },
  },
  schemaPE("consultar_agente_soporte"),
  {
    name: "registrar_solicitud_callback",
    description:
      "El cliente pide que lo LLAMEN: queda registrado en el CRM (territorio Perú) para que la ejecutiva comercial lo contacte. Pasa lo que el cliente dijo (necesidad, personas, horario preferido); NO inventes campos.",
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
  schemaPE("registrar_comprobante_transferencia"),
  {
    name: "derivar_a_soporte",
    description:
      "Registra al prospecto como lead en el CRM (territorio Perú) y lo deja en manos de la ejecutiva comercial, que lo contacta. Motivos: fuera_de_rango_trabajadores (más personas de las que cotizas), solicitud_explicita_persona (pide hablar con una persona o una reunión — pon en contexto el día/hora que propuso), callback, fuera_de_scope, cliente_existente_problema, tool_fallo, transferir_soporte_operativo, agendar_reunion. El RUC NUNCA es requisito. `contexto` = necesidad, configuración y precios cotizados (y el descuento ofrecido, si hubo). Devuelve `mensajeParaProspecto`.",
    input_schema: {
      type: "object" as const,
      properties: {
        motivo: {
          type: "string" as const,
          enum: [
            "fuera_de_rango_trabajadores",
            "cliente_existente_problema",
            "solicitud_explicita_persona",
            "tool_fallo",
            "fuera_de_scope",
            "agendar_reunion",
            "callback",
            "transferir_soporte_operativo",
          ],
        },
        contexto: { type: "string" as const, description: "Resumen para la ejecutiva." },
        nombre: { type: "string" as const },
        rutEmpresa: { type: "string" as const, description: "RUC, si lo dio." },
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
  // La MISMA descripción que Chile: la versión corta perdió el uso (b) —
  // "cuando el cliente entrega SU correo después de emitida la formal, esta
  // tool es la ÚNICA forma de que la cotización llegue a un correo" — y sin
  // esa frase el modelo dijo "ya te la envié" sin llamarla (Lalo, línea +51,
  // 22-sep).
  reenviarCotizacionCorreoSchema as unknown as Schema,
  {
    name: "enviar_cotizacion_whatsapp",
    description: "Manda el PDF de la cotización formal por ESTE mismo chat. Devuelve ok:true solo si salió.",
    input_schema: {
      type: "object" as const,
      properties: { quote_id: { type: "string" as const } },
      required: ["quote_id"],
    },
  },
  // ── Agenda (Lalo 21-sep: "igualemos a Chile; agenda de Mónica =
  // event type 7084664"): las MISMAS tools chilenas, con el evento peruano ──
  {
    name: "consultar_disponibilidad_horario",
    description:
      "Verifica si una fecha y hora propuesta POR EL CLIENTE está disponible en la agenda de la ejecutiva comercial de Perú. Úsala cuando el cliente proponga un horario específico para una reunión (ej. 'el jueves a las 11'). Tú NUNCA propones horarios primero. Interpreta la propuesta en la hora de Perú (America/Lima, UTC-5) usando el HOY del inicio del prompt. Si hay un slot a menos de 15 min de la propuesta devuelve 'disponible_exacto' (pasa ese slotIso a agendar_reunion); si no, devuelve alternativas del mismo día o de días cercanos: preséntaselas en prosa natural y espera a que elija. Para nombrar cada opción usa la 'etiqueta'/'etiquetas' que devuelve la tool TAL CUAL — NUNCA calcules tú el día de la semana.",
    input_schema: {
      type: "object" as const,
      properties: {
        fechaPropuesta: { type: "string" as const, description: "Fecha y hora propuesta por el cliente en ISO 8601 con zona (ej. '2026-09-25T15:00:00-05:00'), interpretada en hora de Perú." },
      },
      required: ["fechaPropuesta"],
    },
  },
  {
    name: "agendar_reunion",
    description:
      "Agenda la reunión con la ejecutiva comercial de Perú: crea la reunión en su calendario, registra el lead en el CRM (territorio Perú) y crea el evento. Llamar SOLO cuando el cliente confirmó explícitamente un horario (idealmente tras consultar_disponibilidad_horario con 'disponible_exacto', usando ese slotIso). Antes captura nombre completo, correo y empresa. Devuelve `mensajeParaProspecto` con la confirmación: cópialo tal cual.",
    input_schema: {
      type: "object" as const,
      properties: {
        slotIso: { type: "string" as const, description: "Slot ISO 8601 confirmado por el cliente (el slotIso de consultar_disponibilidad_horario si hubo match exacto)." },
        prospectName: { type: "string" as const },
        prospectEmail: { type: "string" as const },
        empresa: { type: "string" as const },
        telefono: { type: "string" as const },
        trabajadores: { type: "string" as const },
        necesidad: { type: "string" as const },
        cargo: { type: "string" as const },
        invitadosExtra: { type: "array" as const, items: { type: "string" as const }, description: "Correos ADICIONALES del lado del cliente que deben recibir la invitación (solo los que dio explícitamente, máx 5)." },
      },
      required: ["slotIso", "prospectName", "prospectEmail"],
    },
  },
  {
    name: "reagendar_reunion",
    description:
      "Reagenda la reunión que el cliente YA tiene a un nuevo horario confirmado, manteniendo a la misma ejecutiva. Úsala cuando un cliente con reunión existente pide cambiarla de día/hora; verifica antes con consultar_disponibilidad_horario. NO uses agendar_reunion para reagendar (crearía otra reunión). Ubica sola la reunión vigente del cliente.",
    input_schema: {
      type: "object" as const,
      properties: { newSlotIso: { type: "string" as const, description: "Nuevo slot ISO 8601 confirmado por el cliente." } },
      required: ["newSlotIso"],
    },
  },
  // ── Capacidades que Perú NO tiene: la tool existe y responde honesta ──
  {
    name: "enviar_certificacion",
    description: "En Perú NO existe un documento de certificación (SUNAFIL no certifica sistemas): esta tool te lo recuerda. Responde con el bloque legal, sin prometer papeles.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "enviar_ficha_reloj",
    description:
      "Entrega la ficha técnica (PDF) del reloj de control de asistencia: el equipo de Perú es el mismo modelo que en Chile y la ficha es técnica (sin precios ni país). Úsala cuando el cliente pide características, ficha o detalles del equipo. Devuelve `mensajeParaProspecto` con el link: cópialo TAL CUAL en el mismo turno.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  buscarProspectSchemaPais("RUC", "11 dígitos"),
  {
    name: "consultar_siguiente_descuento",
    description:
      "Con una cotización FORMAL ya emitida: dice qué escalón de descuento corresponde ofrecer ahora (10 % → 20 % sobre el plan, 6 meses) SIN aplicarlo y devuelve el precio recalculado en `mensajeParaProspecto` (cópialo TAL CUAL; en soles netos + IGV). Úsala cuando el cliente objeta el precio de la formal; nunca proactiva. Si el cliente acepta, llama aplicar_siguiente_descuento. Con `topeAlcanzado=true` es el último escalón.",
    input_schema: {
      type: "object" as const,
      properties: { quote_id: { type: "string" as const, description: "Id de la cotización formal (si lo omites, se usa la vigente de esta conversación)." } },
      required: [],
    },
  },
  {
    name: "aplicar_siguiente_descuento",
    description:
      "Aplica el escalón siguiente de descuento (10 % → 20 % sobre el plan, 6 meses) a la cotización FORMAL vigente de esta conversación: la MISMA cotización se actualiza (mismo número, nueva versión del PDF) y devuelve el link en `mensajeParaProspecto` — cópialo TAL CUAL. Pasa `pct_ofrecido` con el % que ya le comunicaste. Solo ante objeción de precio y nunca dos escalones en un mismo turno. Con `topeAlcanzado=true` no hay más rebaja: dilo con franqueza.",
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
      "Cambia la cotización FORMAL vigente de esta conversación (más o menos personas, agregar o quitar el reloj, cambiar modalidad o puntos). La MISMA cotización se actualiza en sitio: el link NO cambia (en el mismo link ya aparece al día), el descuento ya ofrecido se conserva y el PDF nuevo va a su correo. Copia `mensajeParaProspecto` TAL CUAL; no vuelvas a mostrar opciones ni recalcules nada. Pasa SOLO lo que cambia; lo demás se conserva de la formal. Llámala EN EL MISMO TURNO en que el cliente pide el cambio: jamás anuncies 'te la actualizo' sin llamarla.",
    input_schema: {
      type: "object" as const,
      properties: {
        quote_id: { type: "string" as const, description: "Id de la cotización formal (si lo omites, se usa la vigente)." },
        userCount: { type: "number" as const, minimum: 1, maximum: 50, description: "Dotación nueva, solo si cambia." },
        modulos: { type: "array" as const, items: { type: "string" as const } },
        hardware: HARDWARE_PE,
        puntosInstalacion: PUNTOS_PE,
        resumen_cambio: { type: "string" as const, description: "Qué pidió cambiar el cliente, en una frase." },
      },
      required: [],
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

// ── Traducción de las formas chilenas a las del motor peruano ──────────────
type HardwareIn = { id?: string; cantidad?: number; modalidad?: string }
type PuntoIn = { ubicacion?: string; zona?: string; autoInstalada?: boolean; modalidad?: string }
type CotizarIn = {
  userCount?: number
  hardware?: HardwareIn[]
  puntosInstalacion?: PuntoIn[]
  escalonDescuento?: number
  escalonActual?: number
}

/** Zona PE deducida de la ubicación cuando el modelo no la declaró. */
export function zonaDeUbicacionPE(ubicacion: string): "lima" | "intermedia" | "provincias" {
  const c = clasificarUbicacionPE(ubicacion || "")
  if (c.tipo === "lima" || c.tipo === "intermedia" || c.tipo === "provincias") return c.tipo
  const u = (ubicacion || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
  if (/\b(lima|callao)\b/.test(u)) return "lima"
  return tarifaVisitaLimaPE(ubicacion || "").reconocido ? "lima" : "provincias"
}

/** hardware[] (forma chilena) → reloj {modalidad, cantidad} (forma peruana). */
export function relojDeHardwarePE(hardware?: HardwareIn[]): { modalidad: "arriendo" | "venta"; cantidad: number } | undefined {
  const lista = Array.isArray(hardware) ? hardware.filter((h) => h && typeof h === "object") : []
  if (lista.length === 0) return undefined
  const cantidad = lista.reduce((a, h) => a + Math.max(1, Math.round(Number(h.cantidad) || 1)), 0)
  const modalidad = lista.some((h) => h.modalidad === "venta") ? "venta" : "arriendo"
  return { modalidad, cantidad }
}

/**
 * Guarda de UBICACIÓN (22-sep, caso Rodrigo "reloj para casa matriz" → precio
 * sin preguntar dónde). Es la misma guarda que Chile aplica en código
 * (`clasificarUbicacion` → no_clasificable → la tool pide la comuna): con
 * reloj, cada punto debe ser una ciudad o distrito reconocible; si no, la
 * tool se niega y guía a PREGUNTAR, jamás asume provincia por descarte.
 * Devuelve el texto del error o null si todo clasifica.
 */
export function errorUbicacionPE(hardware?: HardwareIn[], puntos?: PuntoIn[]): string | null {
  if (!relojDeHardwarePE(hardware)) return null
  const lista = (Array.isArray(puntos) ? puntos : []).filter((p) => p && typeof p === "object")
  if (lista.length === 0) {
    return (
      "La cotización incluye reloj pero no se entregó 'puntosInstalacion'. " +
      "Por cada punto donde irá un reloj pasa { ubicacion, zona, autoInstalada }. " +
      "Si el cliente aún no dijo dónde, pregúntale en qué distrito (Lima) o ciudad estará el reloj antes de cotizar."
    )
  }
  for (const p of lista) {
    const c = clasificarUbicacionPE(String(p.ubicacion || ""), p.zona)
    if (c.tipo === "no_clasificable") {
      return (
        `No pude clasificar la ubicación '${p.ubicacion || ""}' (${c.razon}). ` +
        "Pregúntale al cliente en qué distrito (si es Lima) o en qué ciudad estará el reloj y vuelve a llamar la tool. " +
        "No asumas la ubicación por contexto."
      )
    }
  }
  return null
}

export function puntosPE(puntos?: PuntoIn[]): Array<{ ubicacion: string; zona: "lima" | "intermedia" | "provincias"; autoInstalada: boolean }> {
  return (Array.isArray(puntos) ? puntos : [])
    .filter((p) => p && typeof p === "object")
    .map((p) => ({
      ubicacion: String(p.ubicacion || ""),
      zona: p.zona === "lima" || p.zona === "provincias" ? p.zona : zonaDeUbicacionPE(String(p.ubicacion || "")),
      // Perú: reloj de mesa/pared que instala el cliente salvo que pida visita.
      autoInstalada: p.autoInstalada === false ? false : true,
    }))
}

/** Forma chilena de cotizar → input de la tool base PE. */
export function aInputCotizarPE(i: CotizarIn) {
  const reloj = relojDeHardwarePE(i.hardware)
  const out: Record<string, unknown> = { userCount: Number(i.userCount || 0) }
  if (reloj) out.reloj = reloj
  const puntos = puntosPE(i.puntosInstalacion)
  if (puntos.length > 0) out.puntosInstalacion = puntos
  const esc = Number(i.escalonDescuento || 0)
  if (esc > 0) out.escalonDescuento = Math.min(2, esc)
  return out
}

const MOTIVO_PE: Record<string, string> = {
  fuera_de_rango_trabajadores: "mas_de_50",
  solicitud_explicita_persona: "pidio_persona",
  agendar_reunion: "pidio_persona",
  callback: "callback",
  tool_fallo: "cotizacion_formal",
  fuera_de_scope: "fuera_de_alcance",
  cliente_existente_problema: "otro",
  transferir_soporte_operativo: "otro",
}


type FormalPE = {
  quoteId: string
  numero: string
  estado: string
  empresa: string
  contacto: string
  email: string
  ruc: string
  escalon: number
  telefono: string
}

/**
 * Lee la cotización FORMAL sobre la que se negocia: la que pasó el modelo o,
 * si no, la vigente del contacto (puntero). Devuelve los datos que la
 * re-emisión necesita (empresa/contacto/email/RUC/escalón) leídos de Zoho —
 * nunca de la memoria del modelo — y se niega si ya está Pagada.
 */
export async function leerFormalPE(contact: string, quoteId?: string): Promise<FormalPE | { error: string }> {
  let qid = String(quoteId || "").trim()
  if (!qid) {
    try {
      const { getQuotePointer } = await import("../../supabase-persistence-v3.ts")
      const p = await getQuotePointer(contact)
      qid = p?.quoteId || ""
    } catch {
      /* sin puntero */
    }
  }
  if (!qid) return { error: "No hay una cotización formal vigente en esta conversación: emítela primero con generar_link_cotizadora." }
  try {
    const { fetchZoho } = await import("../../zoho-token.ts")
    const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
    const mod = (process.env.ZOHO_QUOTE_MODULE || "Cotizaciones_GeoVictoria").trim()
    const campos = "Name,Estado_Cotizacion,Email_Contacto,RUT_Cliente,Cuenta_Asociada,Contacto_Asociado,Escalon_Descuento,Tel_fono_Contacto"
    const res = await fetchZoho(`${api}/crm/v8/${mod}/${qid}?fields=${campos}`)
    if (res.status !== 200) return { error: `No pude leer la cotización ${qid} en el CRM (HTTP ${res.status}).` }
    const data = (await res.json().catch(() => ({}))) as { data?: Array<Record<string, unknown>> }
    const q = data.data?.[0]
    if (!q) return { error: `La cotización ${qid} no existe en el CRM.` }
    const estado = String(q.Estado_Cotizacion || "")
    if (/pagad/i.test(estado)) return { error: "Esa cotización ya está PAGADA: no se modifica. Si el cliente quiere cambios, la ejecutiva los coordina (derivar_a_soporte)." }
    const nombre = String(q.Name || "")
    const empresaDeNombre = nombre.replace(/^Cotizaci[oó]n\s+/i, "").replace(/\s+-\s+\d{4}-\d{2}-\d{2}$/, "").trim()
    const cuenta = (q.Cuenta_Asociada as { name?: string } | null)?.name || ""
    const contactoZ = (q.Contacto_Asociado as { name?: string } | null)?.name || ""
    const tel = String(q.Tel_fono_Contacto || "").replace(/\D/g, "")
    if (tel && contact && !tel.endsWith(contact.slice(-9))) {
      return { error: "Esa cotización no es de este contacto." }
    }
    const numero = (nombre.match(/COT-?\d+/i) || [])[0] || ""
    return {
      quoteId: qid,
      numero,
      estado,
      empresa: empresaDeNombre || cuenta,
      contacto: contactoZ,
      email: String(q.Email_Contacto || ""),
      ruc: String(q.RUT_Cliente || "").replace(/\D/g, ""),
      escalon: Math.max(0, Math.min(2, Number(q.Escalon_Descuento || 0) || 0)),
      telefono: tel,
    }
  } catch (e) {
    return { error: `No pude leer la cotización en el CRM: ${e instanceof Error ? e.message : String(e)}` }
  }
}

type PrefPE = { userCount: number; hardware?: HardwareIn[]; puntosInstalacion?: PuntoIn[]; escalon: number }

/**
 * Despachador con los nombres del núcleo. Envuelve a buildDispatchPE (el
 * motor real) y agrega la memoria del ÚLTIMO estimado por contacto en vic_kv
 * `pe_pref_<contact>` para que consultar_descuento_referencial funcione sin
 * argumentos, igual que en Chile.
 */
export function buildDispatchPEUnificado(contact: string) {
  const base = buildDispatchPE(contact)
  const kvKey = `pe_pref_${contact}`

  async function leerPref(): Promise<PrefPE | null> {
    try {
      const { getKvValue } = await import("../../supabase-persistence-v3.ts")
      const raw = await getKvValue(kvKey)
      return raw ? (JSON.parse(raw) as PrefPE) : null
    } catch {
      return null
    }
  }
  async function guardarPref(p: PrefPE): Promise<void> {
    try {
      const { setKvValue } = await import("../../supabase-persistence-v3.ts")
      await setKvValue(kvKey, JSON.stringify(p))
    } catch {
      /* la memoria del estimado es best-effort */
    }
  }

  /**
   * EDICIÓN EN SITIO = LA TOOL CHILENA (21-sep). Perú solo resuelve la formal
   * vigente (puntero + guarda Pagada) y, para cambios de configuración, arma
   * los ítems con su motor (cotizarPE, soles al dólar SUNAT del día). El
   * endpoint reconoce el país por el token y edita con el perfil peruano.
   */
  async function itemsPE(cfg: CotizarIn): Promise<unknown[]> {
    const { cotizarPE } = await import("./cotizar.ts")
    const { tipoCambioSunat } = await import("./tc-sunat.ts")
    const tc = await tipoCambioSunat()
    const reloj = relojDeHardwarePE(cfg.hardware)
    const calculo = cotizarPE({
      userCount: Number(cfg.userCount || 0),
      reloj,
      puntos: reloj ? puntosPE(cfg.puntosInstalacion) : [],
      // Los ítems van a precio de LISTA: el % comiteado ya vive en la cotización.
      escalonDescuento: 0,
      tipoCambio: tc.venta,
    })
    return calculo.itemsCotizador as unknown[]
  }

  return async function dispatchPEUnificado(name: string, input: unknown): Promise<unknown> {
    const i = (input || {}) as Record<string, unknown>
    switch (name) {
      case "cotizar_referencial": {
        const errUb = errorUbicacionPE(i.hardware as HardwareIn[] | undefined, i.puntosInstalacion as PuntoIn[] | undefined)
        if (errUb) return { ok: false, error: errUb }
        const r = await base("cotizar_referencial", aInputCotizarPE(i as CotizarIn))
        if ((r as { ok?: boolean })?.ok) {
          await guardarPref({
            userCount: Number(i.userCount || 0),
            hardware: i.hardware as HardwareIn[] | undefined,
            puntosInstalacion: i.puntosInstalacion as PuntoIn[] | undefined,
            escalon: Math.min(2, Number(i.escalonDescuento || 0)),
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
        {
          const errUb = errorUbicacionPE(cfg.hardware, cfg.puntosInstalacion)
          if (errUb) return { ok: false, error: errUb }
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
        const r = (await base("cotizar_referencial", aInputCotizarPE({ ...cfg, escalonDescuento: escalon }))) as Record<string, unknown>
        if (r?.ok) {
          await guardarPref({ userCount: cfg.userCount, hardware: cfg.hardware, puntosInstalacion: cfg.puntosInstalacion, escalon })
          return { ...r, escalonDescuento: escalon, topeAlcanzado: escalon >= 2 }
        }
        return r
      }
      case "generar_link_cotizadora": {
        // LA CONFIGURACIÓN DE LA FORMAL ES LA QUE MANDA EL MODELO, JAMÁS LA
        // MEMORIA (caso Rodrigo 22-sep, COT ALICORP: eligió "la 2" = solo app y
        // la formal salió con reloj). `pe_pref_` guarda el ÚLTIMO estimado, y
        // con el doble valor ese estimado SIEMPRE trae el reloj — la opción
        // "solo app" es la misma llamada sin hardware. Rellenar hardware/puntos
        // desde ahí convertía "el modelo no pasó reloj" en "cotiza con reloj",
        // por detrás del candado chileno de agent-loop (evidenciaEleccionReloj
        // + comuna dicha por el cliente), que juzga el input ANTES del adaptador.
        // Igual que Chile: sin hardware en el input = sin hardware. La memoria
        // solo sostiene la dotación y el escalón (la negociación no retrocede).
        const pref = await leerPref()
        const esc = Number(i.escalonDescuento ?? pref?.escalon ?? 0)
        const hardware = i.hardware as HardwareIn[] | undefined
        const puntos = hardware?.length ? (i.puntosInstalacion as PuntoIn[] | undefined) : undefined
        {
          const errUb = errorUbicacionPE(hardware, puntos)
          if (errUb) return { ok: false, error: errUb }
        }
        const mapped = {
          empresa: i.empresa,
          contacto: i.contacto,
          email: i.contactoEmail || i.email,
          ruc: i.rutEmpresa || i.ruc,
          ...aInputCotizarPE({
            userCount: Number(i.userCount || pref?.userCount || 0),
            hardware,
            puntosInstalacion: puntos,
            escalonDescuento: esc,
          }),
        }
        return base("generar_link_cotizadora", mapped)
      }
      case "derivar_a_soporte": {
        const motivo = MOTIVO_PE[String(i.motivo || "")] || "otro"
        return base("derivar_a_ejecutivo", {
          nombre: String(i.nombre || "Prospecto WhatsApp"),
          empresa: i.empresa,
          email: i.email,
          ruc: i.rutEmpresa,
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
          motivo: "callback",
          resumen: `[callback] ${partes.join(" · ") || "Pidió que lo llamen."}`,
        })
      }
      case "consultar_agente_soporte":
      case "registrar_comprobante_transferencia":
      case "marcar_no_contactar":
      case "programar_seguimiento":
        return base(name, input)
      case "reenviar_cotizacion_correo": {
        const { reenviarCotizacionCorreo } = await import("../../tools/reenviar-cotizacion-correo.ts")
        return reenviarCotizacionCorreo(input as never)
      }
      case "enviar_cotizacion_whatsapp": {
        const { enviarCotizacionWhatsapp } = await import("../../tools/enviar-cotizacion-whatsapp.ts")
        return enviarCotizacionWhatsapp({ ...(i as object), _contact: contact } as never)
      }
      // ── Agenda = las tools chilenas con el evento de Cal de Perú ──
      // El agent-loop inyecta `eventTypeId` cuando el dueño del deal/lead
      // tiene evento propio (Mónica y las SDR PE están en el mapa de
      // eventos-seguimiento); si no viene, cae al evento de Mónica por
      // defecto (kv `cal_evento_pe` → env CAL_EVENT_TYPE_ID_PE → 7084664).
      // Jamás al round-robin chileno: un peruano no puede caer en la agenda
      // de Chile.
      case "consultar_disponibilidad_horario": {
        const { consultarDisponibilidadHorario } = await import("../../tools/consultar-disponibilidad-horario.ts")
        const iA = i as { fechaPropuesta?: string; eventTypeId?: string }
        return consultarDisponibilidadHorario({
          fechaPropuesta: String(iA.fechaPropuesta || ""),
          country: "Perú",
          eventTypeId: (iA.eventTypeId || "").trim() || (await eventoAgendaPE()),
        })
      }
      case "agendar_reunion": {
        const { agendarReunion } = await import("../../tools/agendar-reunion.ts")
        const iA = i as { telefono?: string; eventTypeId?: string; prospectEmail?: string }
        const r = await agendarReunion({
          ...(i as object),
          // Teléfono del canal si el modelo no lo pasó: sin él el Lead queda sin Phone.
          telefono: (iA.telefono || "").trim() || contact,
          country: "Perú",
          eventTypeId: (iA.eventTypeId || "").trim() || (await eventoAgendaPE()),
        } as never)
        if (!r.ok) return r
        const email = iA.prospectEmail || "tu correo"
        return {
          ...r,
          // El agent-loop persiste la reunión con esta zona (recordatorios).
          timezone: TZ_PE,
          mensajeParaProspecto:
            `Listo!! Tu reunión quedó agendada para el ${fechaLegiblePE(r.slotIso)} (hora de Perú)${r.atiende ? `, con ${r.atiende.nombre}` : ""} 🎉 ` +
            `Te llegará la invitación con el link de la reunión a ${email}.` +
            (r.atiende?.email ? ` Si necesitas algo antes, le escribes a 📧 ${r.atiende.email}${r.atiende.whatsapp ? ` o al 📱 ${r.atiende.whatsapp}` : ""}.` : "") +
            ` Te puedo ayudar en algo más?`,
        }
      }
      case "reagendar_reunion": {
        const { reagendarReunion } = await import("../../tools/reagendar-reunion.ts")
        const r = await reagendarReunion({ ...(i as object), country: "Perú", _contact: contact } as never)
        if (!r.ok) return r
        return {
          ...r,
          mensajeParaProspecto:
            `Listo!! Tu reunión quedó reagendada para el ${fechaLegiblePE(r.slotIso)} (hora de Perú) 📅 ` +
            `Te llegará la nueva invitación por correo. Te puedo ayudar en algo más?`,
        }
      }
      case "enviar_certificacion":
        return sinCapacidad(
          "no existe un documento de certificación (SUNAFIL no certifica sistemas)",
          "Responde con la explicación del bloque legal: el sistema registra la asistencia con respaldo verificable y fiscalizable; sin prometer papeles.",
        )
      case "enviar_ficha_reloj": {
        // Mismo equipo que Chile (SenseFace 2A / artículo 304 [PER]) y la ficha
        // es técnica, sin precios ni país: la tool chilena es la única.
        const { enviarFichaReloj } = await import("../../tools/enviar-ficha-reloj.ts")
        return enviarFichaReloj()
      }
      case "buscar_prospect_en_zoho": {
        // Misma búsqueda que Chile: el RUC vive en RUT_Empresa (create-from-vicky-pe).
        const { buscarProspectEnZoho } = await import("../../tools/buscar-prospect-en-zoho.ts")
        return buscarProspectEnZoho(input as never)
      }
      case "consultar_siguiente_descuento": {
        const f = await leerFormalPE(contact, i.quote_id as string | undefined)
        if ("error" in f) return { ok: false, error: f.error }
        const { consultarSiguienteDescuento } = await import("../../tools/consultar-siguiente-descuento.ts")
        const r = await consultarSiguienteDescuento({ quote_id: f.quoteId })
        return { ...r, quoteId: f.quoteId }
      }
      case "aplicar_siguiente_descuento": {
        const f = await leerFormalPE(contact, i.quote_id as string | undefined)
        if ("error" in f) return { ok: false, error: f.error }
        const { aplicarSiguienteDescuento } = await import("../../tools/aplicar-siguiente-descuento.ts")
        const r = await aplicarSiguienteDescuento({ quote_id: f.quoteId, pct_ofrecido: Number(i.pct_ofrecido) || undefined })
        if (r.ok) {
          // La memoria del estimado sigue al % comiteado (10 → 1, 20 → 2).
          const pref = await leerPref()
          const escalon = r.ultimoEscalon?.pct >= 20 ? 2 : r.ultimoEscalon?.pct >= 10 ? 1 : pref?.escalon || 0
          if (pref) await guardarPref({ ...pref, escalon })
        }
        return { ...r, quoteId: f.quoteId }
      }
      case "actualizar_cotizacion": {
        const f = await leerFormalPE(contact, i.quote_id as string | undefined)
        if ("error" in f) return { ok: false, error: f.error }
        const pref = await leerPref()
        const cfg: CotizarIn = {
          userCount: Number(i.userCount || pref?.userCount || 0),
          hardware: (i.hardware as HardwareIn[] | undefined) ?? pref?.hardware,
          puntosInstalacion: (i.puntosInstalacion as PuntoIn[] | undefined) ?? pref?.puntosInstalacion,
        }
        if (!cfg.userCount) {
          return { ok: false, error: "No sé con qué dotación se emitió esa cotización: pásame userCount (y hardware/puntos si lleva reloj) en la llamada." }
        }
        {
          const errUb = errorUbicacionPE(cfg.hardware, cfg.puntosInstalacion)
          if (errUb) return { ok: false, error: errUb }
        }
        const { actualizarCotizacion } = await import("../../tools/actualizar-cotizacion.ts")
        const r = await actualizarCotizacion({
          quote_id: f.quoteId,
          userCount: cfg.userCount,
          modulos: ["asistencia"],
          resumen_cambio: String(i.resumen_cambio || "cambio de configuración").slice(0, 200),
          _itemsPais: { pais: "pe", items: await itemsPE(cfg) },
        })
        if (r.ok) {
          await guardarPref({ userCount: cfg.userCount, hardware: cfg.hardware, puntosInstalacion: cfg.puntosInstalacion, escalon: Math.max(f.escalon, pref?.escalon || 0) })
        }
        return { ...r, quoteId: f.quoteId }
      }
      case "anualizar_cotizacion": {
        // Anualidad = Chile (Lalo 21-sep): la MISMA edición en sitio con los
        // montos reales del subform en la moneda del país.
        const { anualizarCotizacionPais } = await import("../anualizar-pais.ts")
        return anualizarCotizacionPais(contact, "pe", i.quote_id as string | undefined)
      }
      default:
        return base(name, input)
    }
  }
}
