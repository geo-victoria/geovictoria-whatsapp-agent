/**
 * Tools de Vicky COLOMBIA (v1: cotización referencial + derivación).
 *
 * Set independiente del chileno — se inyecta a runAgentLoop vía el parámetro
 * `tools` del loop. Los precios SIEMPRE salen de acá (regla dura heredada de
 * Chile: el modelo copia mensajeParaProspecto, jamás calcula).
 *
 * v1 SIN cotización formal: cuando el prospecto acepta el estimado, se captura
 * NIT + datos y se deriva al equipo comercial CO (round-robin) que emite la
 * cotización formal. La formal online llega con el cotizador CO (fase 2b).
 */

import { cotizarCO, type PuntoInstalacionCO } from "./cotizar"
import { clasificarUbicacionCO } from "./geografia"
import { nitValido, normalizarNit } from "./nit"
import { createZohoLead } from "../../zoho-leads"

// Tómbola CO (SDRs observados en Zoho el 09-jul; emails por confirmar).
const SDR_CO_IDS = [
  "3525045000613817111", // Galindo
  "3525045000619732095", // Guerrero
  "3525045000639899035", // Quiroga Chia
]

// Reparto determinista sin estado: hash del teléfono → índice. Distribuye
// parejo con volumen y evita depender de un contador compartido para el v1.
function ownerCoPara(contact: string): string {
  let h = 0
  for (const ch of contact) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return SDR_CO_IDS[h % SDR_CO_IDS.length]
}

export const TOOL_SCHEMAS_CO = [
  {
    name: "cotizar_referencial",
    description:
      "Calcula la cotización referencial de Colombia (1 a 50 usuarios) en pesos colombianos. Devuelve un `mensajeParaProspecto` listo para copiar TAL CUAL al prospecto — con la mensualidad, el pago inicial (activación = primer mes + IVA, y equipos/envío/instalación si aplican) y las notas de IVA. NUNCA calcules ni enuncies precios tú: esta tool es la única fuente. Si la configuración lleva reloj, incluye `reloj` (modalidad y cantidad) y `puntosInstalacion` (uno por punto físico, con la ciudad/municipio tal como la dijo el cliente). En arriendo el envío y la instalación son GRATIS; en venta se cobran según zona (capital de departamento vs resto) — la tool clasifica la zona, tú solo transcribes la ubicación.",
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
          description: "Solo si la configuración lleva reloj control físico.",
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
] as const

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
          ownerId: ownerCoPara(contact),
        })
        if (!res || (res as { ok?: boolean }).ok === false) {
          return {
            ok: false,
            error: "No se pudo registrar el lead. Igual confirma al cliente que el equipo lo contactará.",
            mensajeParaProspecto:
              "Listo, dejé sus datos registrados. Una persona de nuestro equipo comercial en Colombia lo contactará muy pronto para continuar.",
          }
        }
        return {
          ok: true,
          mensajeParaProspecto:
            "Listo, quedó registrado. Una persona de nuestro equipo comercial en Colombia lo contactará muy pronto para continuar con su cotización.",
        }
      }

      return { ok: false, error: `Tool desconocida: ${name}` }
    } catch (err) {
      return { ok: false, error: String((err as Error)?.message || err) }
    }
  }
}
