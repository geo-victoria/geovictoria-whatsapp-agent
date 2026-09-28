/**
 * TOOLS ÚNICAS — Perú (21-sep; 27-sep: implementación = la de Chile).
 *
 * El prompt NÚCLEO nombra las tools con los nombres chilenos y Perú expone
 * EXACTAMENTE esos nombres y formas de entrada. Por debajo:
 *   - las tools GLOBALES (soporte, comprobante, agenda, seguimiento, opt-out,
 *     reenvío/PDF, ficha, búsqueda, descuento y edición sobre la formal,
 *     derivación y callback) corren en lib/paises/tools-globales.ts: la
 *     implementación chilena de lib/tools/* con los DATOS de Perú (ficha
 *     operativa, evento de Cal de Mónica, ítems del motor peruano). Este
 *     archivo no las atiende — tests/tools-globales.test.ts lo vigila;
 *   - lo propio que queda: el motor de precios (cotizar_referencial /
 *     consultar_descuento_referencial = motor único de Chile con datos de
 *     Perú, memoria `pe_pref_`), la emisión contra create-from-vicky-pe y la
 *     anualidad (lib/paises/anualizar-pais.ts) — declarado como deuda en el
 *     candado — y la respuesta honesta de enviar_certificacion.
 *
 * Imports estáticos solo a módulos PUROS (tests/ficha-pe.test.ts carga este
 * archivo con node --test); todo lo que trae "@/…" va por import dinámico.
 */
import { TOOL_SCHEMAS_PE, buildDispatchPE } from "./tools.ts"
import { clasificarUbicacionPE, tarifaVisitaLimaPE } from "./catalogo.ts"
import { marcarNoContactarSchema } from "../../tools/marcar-no-contactar.ts"
import { programarSeguimientoSchemaPais } from "../../tools/programar-seguimiento.ts"
import { derivarASoporteSchemaPais } from "../../tools/derivar-a-soporte.ts"
import { despacharToolGlobal, esToolGlobal, guardarPrefPais, leerPrefPais, type ConfigFormal, type PrefPais } from "../tools-globales.ts"
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
        escalonActual: { type: "number" as const, enum: [0, 1, 2], description: "Cuántos escalones ya ofreciste en ESTA negociación: 0 en la primera objeción. El servidor lleva la cuenta y avanza UN escalón por llamada." },
      },
      required: [],
    },
  },
  {
    name: "generar_link_cotizadora",
    description:
      "Genera la COTIZACIÓN FORMAL de Perú: crea la cotización (PDF en soles, netos + IGV) y devuelve el link donde el cliente la revisa, la acepta y paga (tarjeta vía Mercado Pago o transferencia BBVA; el comprobante llega por este chat). Úsala cuando el cliente quiere avanzar tras ver el precio. REQUIERE contacto y rutEmpresa = el RUC de 11 dígitos o, si el cliente no tiene RUC o prefiere boleta, su DNI de 8 dígitos (se valida contra RENIEC; NO existe el «DNI de 11 dígitos»). La razón social sale sola del documento (padrón SUNAT; con DNI, el nombre de RENIEC): pásala solo si el cliente la dijo, jamás la preguntes; contactoEmail es OPCIONAL, userCount y la configuración (hardware/puntos si lleva reloj). Pasa el MISMO escalonDescuento que el cliente aceptó. Copia `mensajeParaProspecto` TAL CUAL; JAMÁS escribas un link de memoria.",
    input_schema: {
      type: "object" as const,
      properties: {
        empresa: { type: "string" as const, description: "Razón social, SOLO si el cliente la mencionó; si no, se resuelve desde el RUC (padrón SUNAT)." },
        contacto: { type: "string" as const, description: "Nombre de la persona de contacto." },
        contactoEmail: { type: "string" as const, description: "Correo del contacto (obligatorio)." },
        contactoTelefono: { type: "string" as const, description: "Se completa solo con el WhatsApp del cliente; no lo pidas." },
        rutEmpresa: { type: "string" as const, description: "RUC (11 dígitos) o, si no tiene RUC o prefiere boleta, DNI (8 dígitos)." },
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
  derivarASoporteSchemaPais("pe") as unknown as Schema,
  marcarNoContactarSchema as unknown as Schema,
  programarSeguimientoSchemaPais("pe") as unknown as Schema,
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
      "Entrega la ficha técnica (PDF) del reloj de control (SenseFace 2A). SOLO REACTIVA: cuando el cliente pide información, especificaciones o la ficha ('¿qué reloj es?', '¿tiene huella?', '¿me mandas la ficha?'). Responde con la ficha canónica y llama esta tool en el MISMO turno. Nunca para el precio. Sin parámetros. Copia su mensajeParaProspecto TAL CUAL, sin tocar el link.",
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


/**
 * Despachador con los nombres del núcleo. Las tools GLOBALES (soporte,
 * comprobante, agenda, seguimiento, descuento y edición sobre la formal,
 * derivación y callback…) corren en lib/paises/tools-globales.ts: la
 * implementación chilena con los datos de Perú. Acá queda solo lo del país:
 * el motor de precios (cotizar_referencial / consultar_descuento_referencial
 * con la memoria `pe_pref_<contact>`), la emisión contra create-from-vicky-pe
 * y la anualidad (lib/paises/anualizar-pais.ts).
 */
export function buildDispatchPEUnificado(contact: string) {
  const base = buildDispatchPE(contact)
  const leerPref = () => leerPrefPais("pe", contact) as Promise<(PrefPais & { hardware?: HardwareIn[]; puntosInstalacion?: PuntoIn[] }) | null>
  const guardarPref = (p: PrefPais) => guardarPrefPais("pe", contact, p)

  /** Ítems de la formal con el motor peruano (soles al dólar SUNAT del día, a LISTA). */
  async function itemsFormal(cfg: ConfigFormal): Promise<{ ok: true; items: unknown[] } | { ok: false; error: string }> {
    const hw = cfg.hardware as HardwareIn[] | undefined
    const pts = cfg.puntosInstalacion as PuntoIn[] | undefined
    const errUb = errorUbicacionPE(hw, pts)
    if (errUb) return { ok: false, error: errUb }
    const { cotizarPE } = await import("./cotizar.ts")
    const { tipoCambioSunat } = await import("./tc-sunat.ts")
    const tc = await tipoCambioSunat()
    const reloj = relojDeHardwarePE(hw)
    const calculo = cotizarPE({
      userCount: Number(cfg.userCount || 0),
      reloj,
      puntos: reloj ? puntosPE(pts) : [],
      // Los ítems van a precio de LISTA: el % comiteado ya vive en la cotización.
      escalonDescuento: 0,
      tipoCambio: tc.venta,
    })
    return { ok: true, items: calculo.itemsCotizador as unknown[] }
  }

  const ctx = { pais: "pe" as const, contact, eventoAgenda: eventoAgendaPE, itemsFormal }

  return async function dispatchPEUnificado(name: string, input: unknown): Promise<unknown> {
    if (esToolGlobal(name)) return despacharToolGlobal(ctx, name, input)
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
        const r = (await base("cotizar_referencial", aInputCotizarPE({ ...cfg, escalonDescuento: escalon }))) as Record<string, unknown>
        if (r?.ok) {
          await guardarPref({ userCount: cfg.userCount, hardware: cfg.hardware, puntosInstalacion: cfg.puntosInstalacion, escalon })
          return { ...r, escalonDescuento: escalon, escalonActual: escalon, topeAlcanzado: escalon >= 2 }
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
      case "enviar_certificacion":
        return sinCapacidad(
          "no existe un documento de certificación (SUNAFIL no certifica sistemas)",
          "Responde con la explicación del bloque legal: el sistema registra la asistencia con respaldo verificable y fiscalizable; sin prometer papeles.",
        )
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
