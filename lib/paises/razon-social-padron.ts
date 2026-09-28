/**
 * RAZÓN SOCIAL DESDE EL PADRÓN PÚBLICO del país, por documento (28-sep, paso
 * 4): SII por RUT (CL) · SUNAT por RUC (PE) · RUES por NIT (CO) · México no
 * tiene padrón (`documento.padron` vacío → ""). Antes solo Chile la resolvía
 * en el traspaso y en la conversión del lead (`territorio === "Chile"` →
 * fichaEmpresaSii); la emisión ya usaba SUNAT y RUES, así que la regla es
 * global y acá queda escrita una vez. Regla SII del 10-ago intacta: el padrón
 * NO toca la conversación — solo rellena registros del CRM.
 *
 * Best-effort: cualquier fallo devuelve "" y el llamador sigue con su
 * placeholder. Con red (importa los tres clientes bajo demanda).
 */
import { fichaOperativa } from "./ficha-operativa"

const CONSULTA_POR_PADRON: Record<string, (documento: string) => Promise<string>> = {
  SII: async (d) => {
    const { fichaEmpresaSii } = await import("../empresas-sii")
    return (await fichaEmpresaSii(d.trim().toUpperCase().replace(/\./g, "")))?.razonSocial || ""
  },
  SUNAT: async (d) => {
    const { fichaRucSunat } = await import("./pe/sunat-ruc")
    return (await fichaRucSunat(d))?.razonSocial || ""
  },
  RUES: async (d) => {
    const { fichaNitRues } = await import("./co/rues-nit")
    return (await fichaNitRues(d))?.razonSocial || ""
  },
}

/** Razón social del padrón del país para el documento dado; "" si el país no tiene padrón o no aparece. */
export async function razonSocialPorPadron(pais: string | null | undefined, documento: string | null | undefined): Promise<string> {
  const doc = String(documento || "").trim()
  if (!doc) return ""
  const consulta = CONSULTA_POR_PADRON[fichaOperativa(pais).documento.padron]
  if (!consulta) return ""
  try {
    return (await consulta(doc)).trim()
  } catch {
    return ""
  }
}
