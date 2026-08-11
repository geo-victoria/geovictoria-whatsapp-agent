/**
 * Tools de Vicky PERÚ (Fase 1b) — paridad de patrón con Vicky CO/MX.
 *
 * Set independiente — se inyecta a runAgentLoop vía el parámetro `tools` del
 * loop. Los precios SIEMPRE salen de acá (regla dura heredada de Chile: el
 * modelo copia mensajeParaProspecto, jamás calcula).
 *
 * Capacidades Fase 1b: cotización referencial (IGV 18% incluido en totales;
 * descuento ÚNICO 20% x 4 primeras facturas SOLO como cierre, vía
 * conDescuentoCierre), derivación a la ejecutiva única de Perú (Mónica
 * Mendoza — sin tómbola ni SDRs), opt-out/perdido (marcar_no_contactar) y
 * seguimiento consensuado (programar_seguimiento, default America/Lima) —
 * las señales las procesa el route.
 *
 * FASE 2 (11-ago): generar_link_cotizadora YA EXISTE — cotización formal por
 * create-from-vicky-pe (PEN + IGV 18%, RUC, PDF, aceptación web y pago con
 * MercadoPago Perú). La derivación sigue disponible como respaldo.
 *
 * FUERA a propósito (no exponer):
 *   - agendar_reunion / consultar_disponibilidad: sin event type de Cal.com
 *     del equipo PE — las reuniones se coordinan con la ejecutiva (derivar).
 *   - consultar_agente_soporte: la base de conocimiento y los canales de
 *     escalamiento son chilenos; en PE el soporte se deriva a la ejecutiva.
 *
 * IMPORTABLE POR TESTS PUROS (node --test --experimental-strip-types): los
 * imports top-level son solo módulos sin dependencias transitivas
 * (cotizar/catalogo/rut/señales); Zoho y alerta interna van por import
 * dinámico dentro del dispatch — mismo truco que lib/crm-hitos.ts.
 */

import { cotizarPE, formatearPEN, type PuntoInstalacionPE, type ZonaPE } from "./cotizar.ts"
import { CORREO_SSTT_PE } from "./catalogo.ts"
import { rucValido, formatearRuc } from "../../rut.ts"
import {
  marcarNoContactar,
  marcarNoContactarSchema,
} from "../../tools/marcar-no-contactar.ts"
import { programarSeguimiento } from "../../tools/programar-seguimiento.ts"

// Ejecutiva comercial PE (Mónica Mendoza) — ÚNICA dueña de todos los leads
// derivados (excel de tropicalización: Perú sin tómbola ni SDRs). Override por
// env para el día en que el equipo PE crezca.
const EJECUTIVA_PE_ZOHO_ID = (process.env.ZOHO_EJECUTIVO_PE_ID || "3525045000323383015").trim()

// Cotizadora (Fase 2): endpoint formal PE + secreto (dedicado con fallback al
// compartido — mismo esquema que CO).
const COTIZADORA_API_BASE = (
  process.env.COTIZADORA_API_BASE || "https://cotizacion.geovictoria.com"
).trim()
const SECRET_COTIZADORA_PE = (
  process.env.VICKY_COTIZADORA_SECRET_PE ||
  process.env.VICKY_COTIZADORA_SECRET ||
  ""
).trim()

// programar_seguimiento con la zona horaria de Perú como default (el resto
// del schema chileno aplica igual).
const programarSeguimientoSchemaPE = {
  name: "programar_seguimiento",
  description:
    "Úsala SOLO cuando el cliente da una señal EXPLÍCITA de que la decisión depende de otra persona o de otro factor y hay que esperar (ej. 'lo tengo que revisar con mi jefe', 'lo consulto con mi socio', 'espero la aprobación', 'escríbeme el lunes'), Y acordaron CUÁNDO retomar. ANTES de llamarla, pregúntale al cliente cuándo sería un buen momento para escribirle. Con esto queda registrado UN solo seguimiento a esa fecha. NO la uses si el cliente solo quedó en silencio o se despidió sin dar un motivo de espera.",
  input_schema: {
    type: "object" as const,
    properties: {
      cuandoIso: {
        type: "string" as const,
        description:
          "Fecha y hora acordada para retomar, en formato ISO 8601 con zona horaria (ej. '2026-08-10T10:00:00-05:00'). Interpreta lo que dijo el cliente ('el lunes', 'en dos semanas') en SU zona horaria (default Perú/America/Lima, UTC-5) y conviértelo a este formato. Debe ser una fecha futura.",
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

export const TOOL_SCHEMAS_PE = [
  {
    name: "cotizar_referencial",
    description:
      "Calcula la cotización referencial de Perú (1 a 50 usuarios) en soles. Devuelve un `mensajeParaProspecto` listo para copiar TAL CUAL al prospecto — con la mensualidad y el pago inicial (primer mes por adelantado + reloj en compra si aplica; los totales ya incluyen el IGV 18%). NUNCA calcules ni enuncies precios tú: esta tool es la única fuente. Si la configuración lleva reloj, incluye `reloj` (modalidad y cantidad; arriendo por defecto — venta SOLO si el cliente pidió comprar) y `puntosInstalacion` (uno por punto físico, con la ciudad tal como la dijo el cliente y su zona: 'lima' = Lima Metropolitana incluido el Callao, 'provincias' = cualquier otra ciudad del Perú). En Lima Metropolitana el envío va sin costo y la instalación con visita técnica tiene tarifario POR DISTRITO (algunos sin costo, otros con tarifa US$ + IGV que servicio técnico factura aparte) — por eso en Lima la `ubicacion` debe ser el DISTRITO (pregúntalo); a provincia el envío corre por cuenta del cliente y la instalación se coordina aparte con servicio técnico. La tool arma esas notas con los montos exactos, tú solo transcribes la ubicación. `conDescuentoCierre=true` SOLO cuando ofreciste el 20% de las 4 primeras facturas como CIERRE (cliente trabado por precio) y quieres mostrarle el monto exacto — jamás en la primera cotización.",
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
          description:
            "Solo si la configuración lleva reloj de control físico. Modalidad 'venta' ÚNICAMENTE si el cliente pidió comprar explícitamente.",
        },
        puntosInstalacion: {
          type: "array" as const,
          items: {
            type: "object" as const,
            properties: {
              ubicacion: {
                type: "string" as const,
                description: "Ciudad/distrito tal como lo dijo el cliente.",
              },
              zona: {
                type: "string" as const,
                enum: ["lima", "provincias"],
                description:
                  "'lima' solo si el punto está en Lima Metropolitana (incluido el Callao); cualquier otra ciudad del Perú es 'provincias'. Ante la duda, pregúntale al cliente.",
              },
              autoInstalada: {
                type: "boolean" as const,
                description: "true si el cliente instalará el reloj por su cuenta.",
              },
            },
            required: ["ubicacion", "zona", "autoInstalada"],
          },
          description:
            "Un punto por cada lugar físico con reloj. Obligatorio si hay reloj en VENTA; en arriendo pásalo si conoces las ubicaciones (sirve para las notas de envío/instalación fuera de Lima).",
        },
        conDescuentoCierre: {
          type: "boolean" as const,
          description:
            "true SOLO al aplicar el 20% de descuento en las 4 primeras facturas como herramienta de CIERRE (el cliente ya vio el precio de lista y duda por precio). Nunca en la primera cotización ni proactivo.",
        },
      },
      required: ["userCount"],
    },
  },
  {
    name: "generar_link_cotizadora",
    description:
      "Genera la COTIZACIÓN FORMAL de Perú: crea la cotización en el sistema (PDF en soles con IGV 18%) y devuelve el link donde el cliente la revisa, la acepta y paga en línea con tarjeta vía Mercado Pago. Úsala cuando el cliente quiere avanzar tras ver el precio referencial. REQUIERE: empresa (razón social), nombre del contacto, email, RUC válido (11 dígitos) y la configuración (userCount; reloj y puntos si lleva). `conDescuentoCierre=true` SOLO si el cliente aceptó el 20% de las 4 primeras facturas como cierre — el pago inicial sale con ese descuento aplicado. Copia `mensajeParaProspecto` TAL CUAL (trae el link y los montos exactos); JAMÁS escribas un link de memoria.",
    input_schema: {
      type: "object" as const,
      properties: {
        empresa: { type: "string" as const, description: "Razón social o nombre de la empresa." },
        contacto: { type: "string" as const, description: "Nombre completo de la persona de contacto." },
        email: { type: "string" as const, description: "Email del contacto (ahí llega la cotización)." },
        ruc: { type: "string" as const, description: "RUC de la empresa (11 dígitos)." },
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
              zona: { type: "string" as const, enum: ["lima", "provincias"] },
              autoInstalada: { type: "boolean" as const },
            },
            required: ["ubicacion", "zona", "autoInstalada"],
          },
        },
        conDescuentoCierre: {
          type: "boolean" as const,
          description: "true SOLO si el cliente aceptó el 20% de cierre en las 4 primeras facturas.",
        },
      },
      required: ["empresa", "contacto", "email", "ruc", "userCount"],
    },
  },
  {
    name: "derivar_a_ejecutivo",
    description:
      "Registra al prospecto como lead en el CRM (territorio Perú) y lo deja en manos de nuestra ejecutiva comercial de GeoVictoria Perú, que lo contactará para continuar (callback pedido, más de 50 usuarios, preguntas fuera de alcance, solicitud explícita de hablar con una persona, o si generar_link_cotizadora falló). Pasa TODO lo que sepas del prospecto; si ya acordó una configuración y precios con cotizar_referencial, inclúyelos en `resumen` (con el RUC si lo dio y si aceptó el 20% de cierre) para que la ejecutiva formalice sin re-preguntar. Devuelve `mensajeParaProspecto` para confirmarle al cliente.",
    input_schema: {
      type: "object" as const,
      properties: {
        nombre: { type: "string" as const, description: "Nombre de la persona." },
        empresa: { type: "string" as const, description: "Nombre o razón social de la empresa." },
        email: { type: "string" as const, description: "Email del prospecto (si lo dio)." },
        ruc: {
          type: "string" as const,
          description: "RUC de la empresa (11 dígitos), si lo dio. Pásalo tal como lo escribió.",
        },
        trabajadores: { type: "number" as const, description: "Cantidad de personas (si la dio)." },
        ciudad: { type: "string" as const, description: "Ciudad (si la dio)." },
        motivo: {
          type: "string" as const,
          enum: ["cotizacion_formal", "callback", "fuera_de_alcance", "mas_de_50", "pidio_persona", "otro"],
        },
        resumen: {
          type: "string" as const,
          description:
            "Resumen para la ejecutiva: necesidad, configuración acordada, precios cotizados (y si aceptó el 20% de las 4 primeras facturas), zonas de instalación, dolores mencionados.",
        },
      },
      required: ["nombre", "motivo", "resumen"],
    },
  },
  // Señales de ciclo de contacto (mismas de Chile; las procesa el route PE).
  marcarNoContactarSchema,
  programarSeguimientoSchemaPE,
]

type CotizarInputPE = {
  userCount?: number
  reloj?: { modalidad?: "arriendo" | "venta"; cantidad?: number }
  puntosInstalacion?: Array<{ ubicacion?: string; zona?: string; autoInstalada?: boolean }>
  conDescuentoCierre?: boolean
}

type DerivarInputPE = {
  nombre?: string
  empresa?: string
  email?: string
  ruc?: string
  trabajadores?: number
  ciudad?: string
  motivo?: string
  resumen?: string
}

// Normaliza los puntos que vienen del modelo. Perú no tiene clasificador de
// geografía propio (Fase 1b): la zona la declara el MODELO con la regla del
// prompt ('lima' = Lima Metropolitana incluido el Callao); cualquier valor
// raro cae a "provincias" — el tratamiento conservador (notas de envío e
// instalación aparte) nunca promete de más.
function normalizarPuntosPE(
  entradas: Array<{ ubicacion?: string; zona?: string; autoInstalada?: boolean }>,
): PuntoInstalacionPE[] {
  return entradas.map((p) => ({
    ubicacion: String(p?.ubicacion || ""),
    zona: (p?.zona === "lima" ? "lima" : "provincias") as ZonaPE,
    autoInstalada: p?.autoInstalada === true,
  }))
}

export function buildDispatchPE(contact: string) {
  return async function dispatchToolPE(name: string, input: unknown): Promise<unknown> {
    try {
      if (name === "cotizar_referencial") {
        const i = (input || {}) as CotizarInputPE
        const userCount = Number(i.userCount || 0)
        let puntos: PuntoInstalacionPE[] = []
        if (i.reloj && i.reloj.modalidad === "venta") {
          const entradas = Array.isArray(i.puntosInstalacion) ? i.puntosInstalacion : []
          if (entradas.length === 0) {
            return {
              ok: false,
              error:
                "El reloj en VENTA requiere puntosInstalacion (ciudad, zona lima/provincias y autoInstalada por punto). Pregunta la ubicación y si instalan ellos o GeoVictoria, y vuelve a llamar la tool.",
            }
          }
          puntos = normalizarPuntosPE(entradas)
        } else if (i.reloj && i.reloj.modalidad === "arriendo") {
          // En arriendo los puntos son opcionales; si vienen, arman las notas
          // de envío/instalación fuera de Lima.
          puntos = normalizarPuntosPE(Array.isArray(i.puntosInstalacion) ? i.puntosInstalacion : [])
        }
        const r = cotizarPE({
          userCount,
          reloj:
            i.reloj && i.reloj.modalidad && Number(i.reloj.cantidad) > 0
              ? { modalidad: i.reloj.modalidad, cantidad: Number(i.reloj.cantidad) }
              : undefined,
          puntos,
          conDescuentoCierre: i.conDescuentoCierre === true,
        })
        // Punto fuera de Lima con instalación pedida → aviso interno al
        // servicio técnico PE. No hay helper de correo directo reutilizable
        // (todos los envíos del repo son Zoho send_mail SOBRE un registro, y
        // acá aún no existe ninguno), así que va por avisarEquipoInterno
        // (durable en vic_v3_inbox + push) con la instrucción explícita de
        // reenviar a ssttperu@. Best-effort: JAMÁS bloquea la cotización.
        if (r.avisoSsttPeru) {
          const detalle = puntos
            .filter((p) => p.zona === "provincias" && !p.autoInstalada)
            .map((p) => p.ubicacion || "(ciudad sin especificar)")
            .join(", ")
          try {
            const { avisarEquipoInterno } = await import("../../alerta-interna.ts")
            await avisarEquipoInterno(
              `🇵🇪 SERVICIO TÉCNICO PERÚ — reenviar a ${CORREO_SSTT_PE}: el prospecto +${contact} cotizó reloj con instalación FUERA de Lima Metropolitana (${detalle}). ` +
                `La instalación se cotiza aparte: contactarlo para coordinarla. Config: ${userCount} usuarios, reloj ${i.reloj?.modalidad} x${i.reloj?.cantidad}.`,
            ).catch(() => {})
          } catch {
            // El aviso interno nunca puede tumbar la cotización.
          }
        }
        return { ok: true, mensajeParaProspecto: r.mensajeParaProspecto }
      }

      if (name === "generar_link_cotizadora") {
        const i = (input || {}) as CotizarInputPE & {
          empresa?: string
          contacto?: string
          email?: string
          ruc?: string
        }
        if (!i.ruc || !rucValido(i.ruc)) {
          return {
            ok: false,
            error: `El RUC '${i.ruc || ""}' no es válido (11 dígitos con dígito verificador SUNAT). Pídele al cliente confirmarlo y vuelve a llamar la tool.`,
          }
        }
        if (!i.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(i.email)) {
          return { ok: false, error: `El correo '${i.email || ""}' no tiene formato válido. Pídelo de nuevo.` }
        }
        // Misma regla que la referencial: reloj en VENTA exige puntos.
        let puntos: PuntoInstalacionPE[] = []
        if (i.reloj?.modalidad === "venta") {
          const entradas = Array.isArray(i.puntosInstalacion) ? i.puntosInstalacion : []
          if (entradas.length === 0) {
            return { ok: false, error: "El reloj en VENTA requiere puntosInstalacion (ciudad, zona y autoInstalada). Pregúntalos y vuelve a llamar la tool." }
          }
          puntos = normalizarPuntosPE(entradas)
        } else if (i.reloj?.modalidad === "arriendo") {
          puntos = normalizarPuntosPE(Array.isArray(i.puntosInstalacion) ? i.puntosInstalacion : [])
        }
        // El secreto se chequea DESPUÉS de validar inputs: los errores de
        // datos le llegan precisos al modelo aunque falte la config.
        if (!SECRET_COTIZADORA_PE) {
          return { ok: false, error: "Cotizadora PE no configurada (secreto faltante). Usa derivar_a_ejecutivo (motivo cotizacion_formal)." }
        }
        const conDescuento = i.conDescuentoCierre === true
        const calculo = cotizarPE({
          userCount: Number(i.userCount || 0),
          reloj:
            i.reloj && i.reloj.modalidad && Number(i.reloj.cantidad) > 0
              ? { modalidad: i.reloj.modalidad, cantidad: Number(i.reloj.cantidad) }
              : undefined,
          puntos,
          conDescuentoCierre: conDescuento,
        })
        // ACTIVACIÓN explícita = primer mes por adelantado con la MISMA
        // matemática del motor (incluye el 20% de cierre si aplica): el
        // endpoint respeta la fila del agente; su fallback es a precio de
        // lista. primerMes = pagoInicialNeto − pagos únicos de catálogo.
        const r2 = (v: number) => Math.round(v * 100) / 100
        const ventaNeto = calculo.itemsCotizador
          .filter((it) => !it.esRecurrente)
          .reduce((a, it) => a + it.subtotalPEN, 0)
        const primerMesNeto = r2(calculo.pagoInicialNeto - ventaNeto)
        const items = [
          ...calculo.itemsCotizador,
          {
            tipo: "activacion",
            id: "activacion",
            nombre: "Activación",
            descripcion: conDescuento
              ? "Habilitación del servicio: primer mes del plan por adelantado, con el 20% de descuento de tus 4 primeras facturas."
              : undefined,
            modalidad: "Cobro único",
            cantidad: 1,
            precioUnitarioPEN: primerMesNeto,
            subtotalPEN: primerMesNeto,
            esRecurrente: false,
            afectoIgv: true,
          },
        ]
        const res = await fetch(`${COTIZADORA_API_BASE}/api/quote-acceptance/create-from-vicky-pe`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-vicky-secret": SECRET_COTIZADORA_PE },
          body: JSON.stringify({
            empresa: i.empresa,
            contacto: i.contacto,
            contactoEmail: i.email,
            ruc: formatearRuc(i.ruc),
            contactoTelefono: `+${contact}`,
            userCount: Number(i.userCount || 0),
            items,
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
          console.error(`[pe-tools] create-from-vicky-pe falló contact=${contact}:`, JSON.stringify(data).slice(0, 300))
          return {
            ok: false,
            error: `No se pudo generar la cotización formal (${data.error || res.status}). NO insistas: usa derivar_a_ejecutivo (motivo cotizacion_formal) con toda la configuración en el resumen.`,
          }
        }
        // Aviso a servicio técnico si hay instalación fuera de Lima (mismo
        // criterio que la referencial). Best-effort.
        if (calculo.avisoSsttPeru) {
          try {
            const { avisarEquipoInterno } = await import("../../alerta-interna.ts")
            await avisarEquipoInterno(
              `🇵🇪 SERVICIO TÉCNICO PERÚ — reenviar a ${CORREO_SSTT_PE}: cotización FORMAL con instalación fuera de Lima para +${contact} (${i.empresa}). Coordinar instalación aparte.`,
            ).catch(() => {})
          } catch { /* jamás bloquea */ }
        }
        return {
          ok: true,
          quoteId: data.quoteId,
          // El agent-loop persiste estos campos en el puntero durable de la
          // cotización (anti-amnesia: retomar la formal en turnos futuros).
          acceptanceUrl: data.acceptanceUrl,
          totalCLP: calculo.pagoInicialTotal,
          mensajeParaProspecto: `Listo!! Tu cotización formal quedó generada 🎉\n\nAquí la revisas, la aceptas y pagas en línea con tarjeta vía Mercado Pago (se confirma al instante): ${data.acceptanceUrl}\n\nEl pago inicial es de ${formatearPEN(calculo.pagoInicialTotal)} (incluye tu primer mes por adelantado${conDescuento ? ", ya con el 20% de descuento" : ""}) y tu mensualidad de ${formatearPEN(conDescuento ? calculo.mensualTotalConDescuento : calculo.mensualTotal)}${conDescuento ? ` las primeras 4 facturas (luego ${formatearPEN(calculo.mensualTotal)})` : ""} desde el mes siguiente. También te la enviamos en PDF a tu correo. Con el pago confirmado, seguimos con la puesta en marcha de tu cuenta 😊`,
        }
      }

      if (name === "derivar_a_ejecutivo") {
        const i = (input || {}) as DerivarInputPE
        // El RUC jamás bloquea la derivación: si vino, se valida y se anota el
        // veredicto para la ejecutiva; si no vino o no cuadra, el lead va igual.
        const rucInfo = i.ruc
          ? rucValido(i.ruc)
            ? `RUC ${formatearRuc(i.ruc)} (válido)`
            : `RUC ${i.ruc} (dígito verificador NO cuadra — confirmar)`
          : ""
        // Import dinámico: mantiene este módulo importable por los tests puros.
        const { createZohoLead } = await import("../../zoho-leads.ts")
        const res = await createZohoLead({
          nombre: i.nombre,
          empresa: i.empresa,
          email: i.email,
          telefono: contact,
          contactoWA: contact,
          pais: "Perú",
          ciudad: i.ciudad,
          trabajadores: i.trabajadores,
          necesidad: [i.resumen || "", rucInfo].filter(Boolean).join(" · "),
          // Perú sin tómbola ni SDRs: TODOS los motivos quedan a nombre de la
          // ejecutiva única (Mónica Mendoza), que retoma con todo el contexto.
          ownerId: EJECUTIVA_PE_ZOHO_ID,
        })
        if (!res || (res as { success?: boolean }).success === false) {
          return {
            ok: false,
            error: "No se pudo registrar el lead. Igual confirma al cliente que el equipo lo contactará.",
            mensajeParaProspecto:
              "Listo, dejé tus datos registrados 😊 Nuestra ejecutiva comercial en Perú te contactará muy pronto para continuar.",
          }
        }
        return {
          ok: true,
          mensajeParaProspecto:
            "Listo, quedaste registrado 🎉 Nuestra ejecutiva comercial en Perú te contactará muy pronto para finalizar tu cotización y resolver cualquier duda.",
        }
      }

      // Señales (sin efectos externos aquí): el route PE las procesa al ver el
      // tool_call ok — cierra el ciclo o registra el seguimiento acordado.
      if (name === "marcar_no_contactar") return marcarNoContactar(input as never)
      if (name === "programar_seguimiento") {
        const r = programarSeguimiento(input as never)
        if (!("ok" in r) || r.ok !== true) return r
        // Confirmación en peruano neutro cordial. OJO honestidad: en Fase 1b
        // el seguimiento PE lo retoma el EQUIPO (aviso interno desde el
        // route), no un push automático — por eso "retomamos", no "te escribo
        // puntual a esa hora".
        return {
          ...r,
          mensajeParaProspecto:
            "Claro que sí, lo dejamos así 😊 Retomamos ese día con calma — y si necesitas algo antes, me escribes por aquí 🙌",
        }
      }

      return { ok: false, error: `Tool desconocida: ${name}` }
    } catch (err) {
      return { ok: false, error: String((err as Error)?.message || err) }
    }
  }
}
