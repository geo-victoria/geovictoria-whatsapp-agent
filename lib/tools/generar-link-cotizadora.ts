/**
 * Tool: generar_link_cotizadora
 *
 * Crea la cotización en Zoho a través de la cotizadora (endpoint create-from-vicky)
 * y devuelve tanto pdfUrl como acceptanceUrl.
 *
 * Flujo:
 *   1. Valida inputs contra catálogo gobernable
 *   2. Calcula items + totales usando la misma lógica que cotizar_referencial
 *   3. POST a /api/quote-acceptance/create-from-vicky
 *   4. Devuelve pdfUrl + acceptanceUrl al loop de Vicky
 *
 * Scope: 1-50 trabajadores.
 */

import {
  getModuloDisponibleParaVicky,
  getHardwareDisponibleParaVicky,
  obtenerTierAplicable,
  validarRangoModulo,
} from "@/lib/catalogo"

const COTIZADORA_API_BASE =
  process.env.COTIZADORA_API_BASE || "https://cotizacion.geovictoria.com"
const VICKY_COTIZADORA_SECRET = process.env.VICKY_COTIZADORA_SECRET || ""
const SCOPE_MAX_USUARIOS = 50
const EJECUTIVO_DEFAULT = "Eddyluz Mujica"
const IVA_RATE = 0.19

// Sectores válidos (espejo del prompt y de la picklist de Zoho).
const SECTORES_VALIDOS = [
  "1. Agrícola",
  "2. Condominio",
  "3. Construcción",
  "4. Inmobilaria",
  "5. Consultoria",
  "6. Banca y Finanzas",
  "7. Educación",
  "8. Municipio",
  "9. Gobierno",
  "10. Mineria",
  "11. Naviera",
  "12. Outsourcing Seguridad",
  "12. Outsourcing General",
  "13. Outsourcing Retail",
  "14. Planta Productiva",
  "15. Logistica",
  "16. Retail Enterprise",
  "17. Retail SMB",
  "18. Salud",
  "19. Servicios",
  "20. Transporte",
  "21. Turismo, Hotelería y Gastronomía",
] as const

type SectorValido = typeof SECTORES_VALIDOS[number]

async function getUFActualSafe(): Promise<number> {
  try {
    const res = await fetch("https://mindicador.cl/api/uf", { cache: "no-store" })
    if (!res.ok) return 0
    const data = await res.json() as { serie?: Array<{ valor: number }> }
    return data?.serie?.[0]?.valor || 0
  } catch {
    return 0
  }
}

export const generarLinkCotizadoraSchema = {
  name: "generar_link_cotizadora",
  description:
    "Crea la cotización formal en Zoho CRM, genera el PDF de propuesta y envía el correo al cliente. Devuelve dos enlaces: pdfUrl (el PDF descargable) y acceptanceUrl (la página web para aceptar). Úsala SOLO después de haber presentado el preform de confirmación y que el prospecto haya confirmado explícitamente los datos. NO la uses antes de confirmar.",
  input_schema: {
    type: "object" as const,
    properties: {
      empresa: { type: "string" as const, description: "Razón social", minLength: 1 },
      contacto: { type: "string" as const, description: "Nombre del contacto", minLength: 1 },
      contactoEmail: { type: "string" as const, description: "Email del contacto", format: "email" },
      contactoTelefono: { type: "string" as const, description: "Teléfono con +código país" },
      rutEmpresa: { type: "string" as const, description: "RUT empresa o persona natural" },
      userCount: {
        type: "number" as const, minimum: 1, maximum: SCOPE_MAX_USUARIOS,
        description: "Cantidad de trabajadores (1-50)",
      },
      sectorEmpresa: {
        type: "string" as const,
        enum: SECTORES_VALIDOS as unknown as string[],
        description:
          "Rubro/sector de la empresa, deducido del nombre o preguntado al prospecto. Debe ser exactamente uno de los valores del enum (incluyendo el prefijo numérico). Si no es claro, usa '19. Servicios'.",
      },
      modulos: {
        type: "array" as const, items: { type: "string" as const },
        description: "IDs de módulos confirmados (deben estar en catálogo). Siempre incluir 'asistencia' como base.",
        minItems: 1,
      },
      hardware: {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: {
            id: { type: "string" as const },
            cantidad: { type: "number" as const, minimum: 1 },
            modalidad: { type: "string" as const, enum: ["arriendo", "venta"] },
          },
          required: ["id"],
        },
      },
    },
    required: ["empresa", "contacto", "contactoEmail", "rutEmpresa", "userCount", "sectorEmpresa", "modulos"],
  },
}

export type LinkCotizadoraInput = {
  empresa: string
  contacto: string
  contactoEmail: string
  contactoTelefono?: string
  rutEmpresa: string
  userCount: number
  sectorEmpresa: SectorValido | string
  modulos: string[]
  hardware?: Array<{ id: string; cantidad?: number; modalidad?: "arriendo" | "venta" }>
}

type ItemCotizacion = {
  tipo: "modulo" | "hardware"
  id: string
  nombre: string
  modalidad: string
  cantidad: number
  precioUnitarioUF: number
  subtotalUF: number
  tierAplicado?: string
}

export type LinkCotizadoraResultado =
  | {
      ok: true
      pdfUrl: string
      acceptanceUrl: string
      quoteId: string
      dealId: string
      ejecutivoAsignado: string
      totalUF: number
      totalCLP: number
      advertencias: string[]
    }
  | { ok: false; error: string }

export async function generarLinkCotizadora(
  args: LinkCotizadoraInput,
): Promise<LinkCotizadoraResultado> {
  const {
    empresa, contacto, contactoEmail, contactoTelefono,
    rutEmpresa, userCount, sectorEmpresa, modulos = [], hardware = [],
  } = args

  if (!empresa?.trim() || !contacto?.trim() || !contactoEmail?.trim() || !rutEmpresa?.trim()) {
    return { ok: false, error: "Faltan campos obligatorios: empresa, contacto, contactoEmail, rutEmpresa." }
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactoEmail)) {
    return { ok: false, error: `El email '${contactoEmail}' no tiene formato válido.` }
  }
  if (!Number.isFinite(userCount) || userCount < 1 || userCount > SCOPE_MAX_USUARIOS) {
    return { ok: false, error: `userCount=${userCount} fuera de rango 1-${SCOPE_MAX_USUARIOS}.` }
  }
  if (!Array.isArray(modulos) || modulos.length === 0) {
    return { ok: false, error: "modulos requerido (mínimo 1)" }
  }
  const sectorNormalizado: SectorValido =
    (SECTORES_VALIDOS as readonly string[]).includes(sectorEmpresa)
      ? (sectorEmpresa as SectorValido)
      : "19. Servicios"

  const items: ItemCotizacion[] = []
  const advertencias: string[] = []

  const modulosConBase = modulos.includes("asistencia") ? modulos : ["asistencia", ...modulos]
  for (const moduloId of modulosConBase) {
    const modulo = getModuloDisponibleParaVicky(moduloId)
    if (!modulo) {
      return { ok: false, error: `Módulo '${moduloId}' no está habilitado para Vicky.` }
    }
    const rangoError = validarRangoModulo(modulo, userCount)
    if (rangoError) { advertencias.push(rangoError); continue }
    const tier = obtenerTierAplicable(modulo, userCount)
    if (!tier) continue
    const cantidad = tier.modalidad === "fijo" ? 1 : userCount
    const subtotalUF = tier.modalidad === "fijo" ? tier.precioUF : userCount * tier.precioUF
    items.push({
      tipo: "modulo", id: modulo.id, nombre: modulo.nombre,
      modalidad: tier.modalidad === "fijo" ? "Fijo" : "Por usuario",
      cantidad,
      precioUnitarioUF: tier.precioUF,
      subtotalUF: Number(subtotalUF.toFixed(3)),
      tierAplicado: `${tier.minUsuarios}-${tier.maxUsuarios} usuarios`,
    })
  }

  for (const hw of hardware) {
    const dispositivo = getHardwareDisponibleParaVicky(hw.id)
    if (!dispositivo) return { ok: false, error: `Hardware '${hw.id}' no está habilitado para Vicky.` }
    const cantidad = hw.cantidad ?? dispositivo.cantidadSugerida
    const modalidadElegida: "arriendo" | "venta" = hw.modalidad ?? "arriendo"
    if (!dispositivo.modalidadesDisponibles.includes(modalidadElegida)) {
      return { ok: false, error: `${dispositivo.displayName} no disponible en modalidad '${modalidadElegida}'` }
    }
    const precioUnitario = modalidadElegida === "arriendo" ? dispositivo.arriendoUF : dispositivo.ventaUF
    if (precioUnitario === 0) return { ok: false, error: `${dispositivo.displayName} sin precio en modalidad '${modalidadElegida}'` }
    items.push({
      tipo: "hardware", id: dispositivo.id, nombre: dispositivo.displayName,
      modalidad: modalidadElegida === "arriendo" ? "Arriendo mensual" : "Venta única",
      cantidad,
      precioUnitarioUF: precioUnitario,
      subtotalUF: Number((cantidad * precioUnitario).toFixed(3)),
    })
  }

  if (items.length === 0) return { ok: false, error: "No hay items válidos para cotizar." }

  const subtotalUF = items.reduce((sum, i) => sum + i.subtotalUF, 0)
  const ivaUF = subtotalUF * IVA_RATE
  const totalUF = subtotalUF + ivaUF
  const ufActual = await getUFActualSafe()
  const totalCLP = Math.round(totalUF * ufActual)

  try {
    const response = await fetch(`${COTIZADORA_API_BASE}/api/quote-acceptance/create-from-vicky`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(VICKY_COTIZADORA_SECRET ? { "x-vicky-secret": VICKY_COTIZADORA_SECRET } : {}),
      },
      body: JSON.stringify({
        cliente: {
          empresa: empresa.trim(),
          contacto: contacto.trim(),
          contactoEmail: contactoEmail.trim().toLowerCase(),
          contactoTelefono: contactoTelefono?.trim() || "",
          rutEmpresa: rutEmpresa.trim(),
          userCount,
          sectorEmpresa: sectorNormalizado,
        },
        cotizacion: {
          items,
          subtotalUF: Number(subtotalUF.toFixed(3)),
          ivaUF: Number(ivaUF.toFixed(3)),
          totalUF: Number(totalUF.toFixed(3)),
          ufActual: Number(ufActual.toFixed(2)),
          totalCLP,
        },
      }),
      cache: "no-store",
    })

    if (!response.ok) {
      const errBody = await response.text().catch(() => "")
      return { ok: false, error: `Cotizadora respondió ${response.status}: ${errBody.slice(0, 200)}` }
    }

    const data = await response.json() as {
      ok: boolean
      pdfUrl?: string
      acceptanceUrl?: string
      quoteId?: string
      dealId?: string
      error?: string
      detail?: string
    }

    if (!data.ok || !data.pdfUrl || !data.acceptanceUrl) {
      return { ok: false, error: data.error || data.detail || "Respuesta inválida de la cotizadora" }
    }

    return {
      ok: true,
      pdfUrl: data.pdfUrl,
      acceptanceUrl: data.acceptanceUrl,
      quoteId: data.quoteId || "",
      dealId: data.dealId || "",
      ejecutivoAsignado: EJECUTIVO_DEFAULT,
      totalUF: Number(totalUF.toFixed(3)),
      totalCLP,
      advertencias,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `No se pudo contactar la cotizadora: ${msg.slice(0, 200)}` }
  }
}
