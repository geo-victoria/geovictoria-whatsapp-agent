/**
 * Tool: buscar_prospect_en_zoho
 *
 * Identifica al prospect durante la conversación a partir de identificadores únicos
 * (teléfono, email, RUT empresa). Consulta directamente Zoho CRM usando el helper
 * local `searchProspectByIdentifiers` (que reusa el OAuth token cacheado).
 *
 * Jerarquía de confianza:
 *   - RUT empresa → confianza máxima (es 100% la misma entidad)
 *   - Email → confianza alta (sugerir confirmación al prospect)
 *   - Teléfono → confianza media (puede ser teléfono compartido o reciclado)
 *
 * Filtra Leads ya convertidos.
 *
 * Vicky decide qué hacer con los matches (preguntar al prospect, usar IDs, etc.).
 */

import {
  searchProspectByIdentifiers,
  type ProspectMatch,
} from "@/lib/zoho-search"

export const buscarProspectEnZohoSchema = {
  name: "buscar_prospect_en_zoho",
  description:
    "Busca en Zoho CRM si el prospect ya existe usando identificadores únicos (RUT empresa, email, teléfono). Llamar cada vez que captures un nuevo identificador. Si encuentras match con confianza 'maxima' por RUT empresa, es 100% la misma empresa: usa el ID sin preguntar. Si encuentras 'alta' por email o 'media' por teléfono, sugiere al prospect confirmar usando el nombre de la empresa encontrada (no muestres el RUT por privacidad). Si no hay match, procede a crear nuevo. Devuelve también Leads no convertidos.",
  input_schema: {
    type: "object" as const,
    properties: {
      telefono: {
        type: "string" as const,
        description:
          "Teléfono con código país (ej. +56944668823). Opcional. Al menos uno de los 3 identificadores es requerido.",
      },
      email: {
        type: "string" as const,
        description:
          "Email del contacto. Opcional. Al menos uno de los 3 identificadores es requerido.",
        format: "email",
      },
      rutEmpresa: {
        type: "string" as const,
        description:
          "RUT de la empresa (formato chileno: 76.345.821-K o 76345821K, se normaliza internamente). Opcional. Es el identificador de mayor confianza.",
      },
    },
    required: [],
  },
}

export type BuscarProspectInput = {
  telefono?: string
  email?: string
  rutEmpresa?: string
}

export type BuscarProspectResultado =
  | {
      ok: true
      matches: ProspectMatch[]
      resumen: string
    }
  | { ok: false; error: string }

export async function buscarProspectEnZoho(
  args: BuscarProspectInput,
): Promise<BuscarProspectResultado> {
  const telefono = args.telefono?.trim() || ""
  const email = args.email?.trim() || ""
  const rutEmpresa = args.rutEmpresa?.trim() || ""

  if (!telefono && !email && !rutEmpresa) {
    return {
      ok: false,
      error: "Se requiere al menos un identificador (telefono, email o rutEmpresa).",
    }
  }

  try {
    const result = await searchProspectByIdentifiers({ telefono, email, rutEmpresa })
    return result
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      error: `Error al buscar en Zoho: ${msg.slice(0, 200)}`,
    }
  }
}
