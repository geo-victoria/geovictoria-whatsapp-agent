/**
 * Tool: generar_link_cotizadora
 *
 * Genera un enlace a la cotizadora con datos del prospecto pre-cargados.
 * El prospecto abre el link, ve sus datos llenos, ajusta lo que necesite
 * y descarga el PDF.
 *
 * Valida contra el catálogo. Si Vicky intenta meter en el link un módulo
 * o hardware que no está habilitado, la tool rechaza.
 *
 * Scope: 1-50 trabajadores (alineado con cotizar_referencial).
 */

import {
  getModuloDisponibleParaVicky,
  getHardwareDisponibleParaVicky,
} from "@/lib/catalogo"

const COTIZADORA_BASE_URL = "https://cotizacion.geovictoria.com"
const SCOPE_MAX_USUARIOS = 50

// Default según decisión de Eduardo
const EJECUTIVO_DEFAULT = "Eddyluz Mujica"

export const generarLinkCotizadoraSchema = {
  name: "generar_link_cotizadora",
  description:
    "Genera un enlace personalizado a la cotizadora con los datos del prospecto pre-cargados. Úsala SOLO después de haber presentado el preform de confirmación y que el prospecto haya confirmado explícitamente los datos. NO la uses antes de confirmar.",
  input_schema: {
    type: "object" as const,
    properties: {
      empresa: {
        type: "string" as const,
        description: "Razón social de la empresa.",
        minLength: 1,
      },
      contacto: {
        type: "string" as const,
        description: "Nombre del contacto.",
        minLength: 1,
      },
      contactoEmail: {
        type: "string" as const,
        description: "Email del contacto.",
        format: "email",
      },
      contactoTelefono: {
        type: "string" as const,
        description: "Teléfono del contacto, con código país (+56...).",
      },
      rutEmpresa: {
        type: "string" as const,
        description:
          "RUT de la empresa o RUT de persona natural si el prospecto no tiene empresa formal. Acepta ambos formatos.",
      },
      userCount: {
        type: "number" as const,
        description: "Cantidad de trabajadores (1-50 inclusive).",
        minimum: 1,
        maximum: SCOPE_MAX_USUARIOS,
      },
      modulos: {
        type: "array" as const,
        items: { type: "string" as const },
        description:
          "IDs de módulos confirmados por el prospecto (deben estar en el catálogo habilitado).",
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
        description: "Hardware confirmado (opcional).",
      },
    },
    required: ["empresa", "contacto", "contactoEmail", "rutEmpresa", "userCount"],
  },
}

export type LinkCotizadoraInput = {
  empresa: string
  contacto: string
  contactoEmail: string
  contactoTelefono?: string
  rutEmpresa: string
  userCount: number
  modulos?: string[]
  hardware?: Array<{ id: string; cantidad?: number; modalidad?: "arriendo" | "venta" }>
}

export type LinkCotizadoraResultado =
  | {
      ok: true
      url: string
      ejecutivoAsignado: string
      itemsIncluidos: { modulos: string[]; hardware: string[] }
    }
  | { ok: false; error: string }

/**
 * Codifica un objeto JSON a base64url. Inversa de decodePrefillPayload del
 * index.html de la cotizadora.
 */
function toBase64Url(json: unknown): string {
  const jsonStr = JSON.stringify(json)
  const utf8Bytes = new TextEncoder().encode(jsonStr)
  let binary = ""
  for (let i = 0; i < utf8Bytes.length; i++) {
    binary += String.fromCharCode(utf8Bytes[i])
  }
  const base64 = btoa(binary)
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function generarLinkCotizadora(args: LinkCotizadoraInput): LinkCotizadoraResultado {
  const {
    empresa,
    contacto,
    contactoEmail,
    contactoTelefono,
    rutEmpresa,
    userCount,
    modulos = [],
    hardware = [],
  } = args

  // ── Validaciones básicas ──
  if (!empresa?.trim() || !contacto?.trim() || !contactoEmail?.trim() || !rutEmpresa?.trim()) {
    return {
      ok: false,
      error: "Faltan campos obligatorios: empresa, contacto, contactoEmail, rutEmpresa.",
    }
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactoEmail)) {
    return { ok: false, error: `El email '${contactoEmail}' no tiene formato válido.` }
  }
  if (!Number.isFinite(userCount) || userCount < 1 || userCount > SCOPE_MAX_USUARIOS) {
    return { ok: false, error: `userCount=${userCount} fuera de rango 1-${SCOPE_MAX_USUARIOS}.` }
  }

  // ── Validar que los módulos solicitados estén habilitados ──
  const modulosValidados: string[] = []
  for (const moduloId of modulos) {
    const m = getModuloDisponibleParaVicky(moduloId)
    if (!m) {
      return {
        ok: false,
        error: `Módulo '${moduloId}' no está habilitado en el catálogo para Vicky. No se puede incluir en el link.`,
      }
    }
    modulosValidados.push(m.id)
  }

  // ── Validar hardware solicitado ──
  const hardwareValidado: string[] = []
  for (const hw of hardware) {
    const dispositivo = getHardwareDisponibleParaVicky(hw.id)
    if (!dispositivo) {
      return {
        ok: false,
        error: `Hardware '${hw.id}' no está habilitado en el catálogo para Vicky. No se puede incluir en el link.`,
      }
    }
    hardwareValidado.push(dispositivo.id)
  }

  // ── Construir prefill ──
  const prefill = {
    empresa: empresa.trim(),
    contacto: contacto.trim(),
    contactoEmail: contactoEmail.trim().toLowerCase(),
    contactoTelefono: contactoTelefono?.trim() || "",
    rutEmpresa: rutEmpresa.trim(),
    ejecutivo: EJECUTIVO_DEFAULT,
    userCount: String(userCount),
    source: "vicky_whatsapp_v3",
    selectedModulos: modulosValidados,
    selectedHardware: hardware.map((h) => ({
      id: h.id,
      cantidad: h.cantidad ?? 1,
      modalidad: h.modalidad ?? "arriendo",
    })),
  }

  const encoded = toBase64Url(prefill)
  const url = `${COTIZADORA_BASE_URL}/?prefill=${encoded}`

  return {
    ok: true,
    url,
    ejecutivoAsignado: EJECUTIVO_DEFAULT,
    itemsIncluidos: {
      modulos: modulosValidados,
      hardware: hardwareValidado,
    },
  }
}
