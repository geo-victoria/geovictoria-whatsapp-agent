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
 *   - responde HONESTO donde Perú no tiene la capacidad (agenda Cal, ficha
 *     PDF del reloj, certificación DT, escalera sobre formal, anualidad): la
 *     tool existe, dice qué hacer en su lugar y JAMÁS simula el efecto.
 *
 * Así el prompt no necesita saber qué país tiene qué: el país es la FICHA y
 * el motor, no una copia de las tools. CO y MX pasarán por el mismo molde.
 *
 * Imports estáticos solo a módulos PUROS (mismo criterio que pe/tools.ts,
 * para que tests/ficha-pe.test.ts cargue este archivo con node --test); todo
 * lo que trae "@/…" va por import dinámico.
 */
import { TOOL_SCHEMAS_PE, buildDispatchPE } from "./tools.ts"
import { tarifaVisitaLimaPE } from "./catalogo.ts"
import { marcarNoContactarSchema } from "../../tools/marcar-no-contactar.ts"
import { programarSeguimientoSchema } from "../../tools/programar-seguimiento.ts"

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
          "'lima' = Lima Metropolitana (incluido el Callao); cualquier otra ciudad del Perú = 'provincias'. Si lo omites, la tool lo deduce de la ubicación.",
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
      "Calcula el estimado mensual EN SOLES (montos netos, siempre presentados '+ IGV') para 1 a 50 personas y devuelve `mensajeParaProspecto` listo para copiar TAL CUAL — con reloj trae LAS DOS OPCIONES (reloj + app, y solo app) y la pregunta de cierre. Úsalo apenas tengas la dotación y el marcaje. NUNCA calcules ni enuncies precios tú: esta tool es la única fuente. En Lima el envío va sin costo y la visita técnica tiene tarifa por DISTRITO (pregúntalo); a provincia el envío corre por cuenta del cliente. `escalonDescuento` SOLO ante objeción de precio.",
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
      "Genera la COTIZACIÓN FORMAL de Perú: crea la cotización (PDF en soles, netos + IGV) y devuelve el link donde el cliente la revisa, la acepta y paga (tarjeta vía Mercado Pago o transferencia BBVA; el comprobante llega por este chat). Úsala cuando el cliente quiere avanzar tras ver el precio. REQUIERE empresa (razón social), contacto, contactoEmail (obligatorio en Perú: ahí llega la cotización), rutEmpresa = el RUC de 11 dígitos, userCount y la configuración (hardware/puntos si lleva reloj). Pasa el MISMO escalonDescuento que el cliente aceptó. Copia `mensajeParaProspecto` TAL CUAL; JAMÁS escribas un link de memoria.",
    input_schema: {
      type: "object" as const,
      properties: {
        empresa: { type: "string" as const, description: "Razón social." },
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
      required: ["empresa", "contacto", "rutEmpresa", "userCount"],
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
  {
    name: "reenviar_cotizacion_correo",
    description:
      "Reenvía la cotización formal por CORREO a quien el cliente designe (o al propio cliente si pide recibirla de nuevo). Devuelve ok:true solo si el correo salió: jamás digas 'te la envié' sin ese ok.",
    input_schema: {
      type: "object" as const,
      properties: {
        quote_id: { type: "string" as const, description: "Id de la cotización formal (lo tienes del turno en que se generó)." },
        destinatarioEmail: { type: "string" as const },
        destinatarioNombre: { type: "string" as const },
        esCorreoDelCliente: { type: "boolean" as const, description: "true si el destinatario es el propio cliente." },
      },
      required: ["quote_id", "destinatarioEmail"],
    },
  },
  {
    name: "enviar_cotizacion_whatsapp",
    description: "Manda el PDF de la cotización formal por ESTE mismo chat. Devuelve ok:true solo si salió.",
    input_schema: {
      type: "object" as const,
      properties: { quote_id: { type: "string" as const } },
      required: ["quote_id"],
    },
  },
  // ── Capacidades que Perú NO tiene: la tool existe y responde honesta ──
  {
    name: "consultar_disponibilidad_horario",
    description: "Perú NO tiene agenda en línea: esta tool te lo recuerda. Para una reunión usa derivar_a_soporte (motivo solicitud_explicita_persona) con el horario que propuso el cliente.",
    input_schema: { type: "object" as const, properties: { fechaHoraPropuesta: { type: "string" as const } }, required: [] },
  },
  {
    name: "agendar_reunion",
    description: "Perú NO tiene agenda en línea: esta tool te lo recuerda. La reunión la coordina la ejecutiva — usa derivar_a_soporte (motivo solicitud_explicita_persona) con el horario propuesto.",
    input_schema: { type: "object" as const, properties: { fechaHora: { type: "string" as const }, nombre: { type: "string" as const } }, required: [] },
  },
  {
    name: "reagendar_reunion",
    description: "Perú NO tiene agenda en línea: esta tool te lo recuerda. Usa derivar_a_soporte (motivo solicitud_explicita_persona) con el nuevo horario.",
    input_schema: { type: "object" as const, properties: { nuevaFechaHora: { type: "string" as const } }, required: [] },
  },
  {
    name: "enviar_certificacion",
    description: "En Perú NO existe un documento de certificación (SUNAFIL no certifica sistemas): esta tool te lo recuerda. Responde con el bloque legal, sin prometer papeles.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "enviar_ficha_reloj",
    description: "En Perú NO hay ficha PDF del reloj: esta tool te lo recuerda. Describe el reloj en texto (facial, huella, tarjeta, clave; WiFi o cable), sin marcas ni modelos.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "consultar_siguiente_descuento",
    description: "Sobre una formal YA emitida en Perú el escalón siguiente se aplica RE-EMITIENDO con generar_link_cotizadora (misma empresa y RUC, escalonDescuento + 1): esta tool te devuelve cuál corresponde.",
    input_schema: { type: "object" as const, properties: { quote_id: { type: "string" as const } }, required: [] },
  },
  {
    name: "aplicar_siguiente_descuento",
    description: "Igual que consultar_siguiente_descuento: en Perú se re-emite con generar_link_cotizadora y el escalón siguiente. Esta tool te lo indica.",
    input_schema: { type: "object" as const, properties: { quote_id: { type: "string" as const } }, required: [] },
  },
  {
    name: "actualizar_cotizacion",
    description: "En Perú una formal emitida NO se edita: se RE-EMITE con generar_link_cotizadora con la configuración nueva (misma empresa y RUC). Esta tool te lo recuerda.",
    input_schema: { type: "object" as const, properties: { quote_id: { type: "string" as const } }, required: [] },
  },
  {
    name: "anualizar_cotizacion",
    description: "Perú NO tiene pago anual todavía: esta tool te lo recuerda. Ofrece la mensualidad; si el cliente insiste, derivar_a_soporte (motivo fuera_de_scope).",
    input_schema: { type: "object" as const, properties: { quote_id: { type: "string" as const } }, required: [] },
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
export function zonaDeUbicacionPE(ubicacion: string): "lima" | "provincias" {
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

export function puntosPE(puntos?: PuntoIn[]): Array<{ ubicacion: string; zona: "lima" | "provincias"; autoInstalada: boolean }> {
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

  return async function dispatchPEUnificado(name: string, input: unknown): Promise<unknown> {
    const i = (input || {}) as Record<string, unknown>
    switch (name) {
      case "cotizar_referencial": {
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
        const pref = await leerPref()
        const esc = Number(i.escalonDescuento ?? pref?.escalon ?? 0)
        const mapped = {
          empresa: i.empresa,
          contacto: i.contacto,
          email: i.contactoEmail || i.email,
          ruc: i.rutEmpresa || i.ruc,
          ...aInputCotizarPE({
            userCount: Number(i.userCount || pref?.userCount || 0),
            hardware: (i.hardware as HardwareIn[]) || pref?.hardware,
            puntosInstalacion: (i.puntosInstalacion as PuntoIn[]) || pref?.puntosInstalacion,
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
      case "consultar_disponibilidad_horario":
      case "agendar_reunion":
      case "reagendar_reunion":
        return sinCapacidad(
          "no hay agenda en línea: la reunión la coordina la ejecutiva comercial",
          "Llama a derivar_a_soporte con motivo solicitud_explicita_persona poniendo en el contexto el día y hora que propuso el cliente, y dile que la ejecutiva le confirma el horario.",
        )
      case "enviar_certificacion":
        return sinCapacidad(
          "no existe un documento de certificación (SUNAFIL no certifica sistemas)",
          "Responde con la explicación del bloque legal: el sistema registra la asistencia con respaldo verificable y fiscalizable; sin prometer papeles.",
        )
      case "enviar_ficha_reloj":
        return sinCapacidad(
          "no hay ficha PDF del reloj",
          "Describe el reloj en texto: marcación facial, huella, tarjeta o clave; WiFi o cable de red; se conecta a la nube en minutos. Sin marcas ni modelos.",
        )
      case "consultar_siguiente_descuento":
      case "aplicar_siguiente_descuento": {
        const pref = await leerPref()
        const actual = pref?.escalon || 0
        if (actual >= 2) {
          return { ok: true, topeAlcanzado: true, escalonDescuento: 2, mensajeParaProspecto: "El 20 % en el plan por 6 meses ya es el máximo — no tengo margen para más, y prefiero decírtelo con franqueza." }
        }
        return sinCapacidad(
          "una cotización formal emitida no se edita en sitio",
          `El escalón siguiente es ${actual + 1} (${actual + 1 === 1 ? "10" : "20"} % en el plan por 6 meses): re-emite con generar_link_cotizadora (misma empresa, mismo RUC, escalonDescuento=${actual + 1}) y entrega el link nuevo.`,
        )
      }
      case "actualizar_cotizacion":
        return sinCapacidad(
          "una cotización formal emitida no se edita en sitio",
          "Re-emite con generar_link_cotizadora con la configuración nueva (misma empresa y RUC) y entrega el link nuevo.",
        )
      case "anualizar_cotizacion":
        return sinCapacidad("todavía no existe el pago anual", "Ofrece la mensualidad; si el cliente insiste en pagar el año, deriva con derivar_a_soporte motivo fuera_de_scope para que la ejecutiva lo evalúe.")
      default:
        return base(name, input)
    }
  }
}
