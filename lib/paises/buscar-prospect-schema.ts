/**
 * Schema PURO de `buscar_prospect_en_zoho` parametrizado por el documento del
 * país (RUT/RUC/NIT). La implementación es la chilena (lib/tools/buscar-
 * prospect-en-zoho → zoho-search, que busca por RUT_Empresa, donde PE guarda
 * el RUC y CO el NIT). El archivo de la tool importa "@/lib/zoho-search", que
 * node --test no resuelve: por eso el schema vive acá, sin imports, para que
 * las tools unificadas sigan siendo puras.
 */
export function buscarProspectSchemaPais(documento: string, ayudaDocumento: string) {
  return {
    name: "buscar_prospect_en_zoho",
    description:
      `Busca en Zoho CRM si el prospect ya existe usando identificadores únicos (${documento} de la empresa, email, teléfono). Llamar cada vez que captures un nuevo identificador. Si encuentras match con confianza 'maxima' por ${documento}, es 100% la misma empresa: usa el ID sin preguntar. Si encuentras 'alta' por email o 'media' por teléfono, sugiere al prospect confirmar usando el nombre de la empresa encontrada (no muestres el ${documento} por privacidad). Si no hay match, procede a crear nuevo. Devuelve también Leads no convertidos.`,
    input_schema: {
      type: "object" as const,
      properties: {
        telefono: { type: "string" as const, description: "Teléfono con código país. Opcional. Al menos uno de los 3 identificadores es requerido." },
        email: { type: "string" as const, description: "Email del contacto. Opcional.", format: "email" },
        rutEmpresa: { type: "string" as const, description: `${documento} de la empresa (${ayudaDocumento}). Opcional. Es el identificador de mayor confianza.` },
      },
      required: [],
    },
  }
}
