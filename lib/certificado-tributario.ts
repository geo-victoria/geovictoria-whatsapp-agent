/**
 * Certificado tributario en un adjunto → datos de facturación (24-sep).
 *
 * Caso HSEQTECH PREVENSA: el cliente mandó por WhatsApp el PDF del e-RUT del
 * SII (razón social, RUT, actividad económica, dirección) y la Solicitud de
 * Facturación igual salió con giro/dirección/comuna "por confirmar" porque la
 * empresa tenía 14 días de inicio de actividades y no estaba en el padrón. El
 * dato estaba en el chat, transcrito por la visión, y nadie lo leía.
 *
 * PURO (sin red): reconoce la transcripción de un certificado tributario
 * (SII e-RUT/CL · Ficha RUC SUNAT/PE · RUT DIAN o RUES/CO · Constancia de
 * Situación Fiscal SAT/MX) y extrae lo que la facturación necesita. Solo
 * devuelve lo que el documento DICE: si no trae comuna, no la inventa.
 * Alcance: global (4 países).
 */
export type DatosCertificado = {
  documento?: string
  razonSocial?: string
  giro?: string
  direccion?: string
  comuna?: string
  ciudad?: string
  tipo: "sii" | "sunat" | "dian" | "sat"
}

const TIPOS: Array<[DatosCertificado["tipo"], RegExp]> = [
  ["sii", /rol\s+[uú]nico\s+tributario|servicio\s+de\s+impuestos\s+internos|\bsii\.cl\b|\be-?rut\b|c[eé]dula\s+rut/i],
  ["sunat", /\bsunat\b|ficha\s+ruc|registro\s+[uú]nico\s+de\s+contribuyentes/i],
  ["dian", /\bdian\b|registro\s+[uú]nico\s+tributario|c[aá]mara\s+de\s+comercio|\brues\b/i],
  ["sat", /constancia\s+de\s+situaci[oó]n\s+fiscal|\bsat\b.*\brfc\b|\brfc\b.*\bsat\b/i],
]

const limpio = (v: unknown) =>
  String(v ?? "")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim()

/** Valor de una línea "Etiqueta: valor" (markdown de la visión o texto plano). */
function campo(texto: string, etiquetas: RegExp): string {
  const re = new RegExp(`(?:^|\\n)\\s*(?:[-*•]\\s*)?(?:\\*\\*)?(?:n[uú]mero\\s+de\\s+|n[°º.]?\\s*(?:de\\s+)?|nro\\.?\\s+(?:de\\s+)?)?(?:${etiquetas.source})(?:\\*\\*)?\\s*[:：]\\s*(?:\\*\\*)?([^\\n]+)`, "i")
  const m = texto.match(re)
  return m ? limpio(m[1]).replace(/^\*+|\*+$/g, "").trim() : ""
}

export function parsearCertificadoTributario(descripcion: string): DatosCertificado | null {
  const t = String(descripcion || "")
  if (t.length < 40) return null
  const tipo = TIPOS.find(([, re]) => re.test(t))?.[0]
  if (!tipo) return null

  const razonSocial = campo(t, /empresa|raz[oó]n\s+social|nombre\s+o\s+raz[oó]n\s+social|contribuyente|denominaci[oó]n/)
  let documento = campo(t, /rut(?!\s+usuario)(?!\s*\/)|ruc|nit|rfc|n[uú]mero\s+de\s+documento/)
  documento = limpio(documento).replace(/[^\dkK.-]/g, "").replace(/\.$/, "")
  const giro = campo(t, /actividad(?:es)?\s+econ[oó]mica(?:s)?(?:\s+principal)?|giro|actividad\s+principal|objeto\s+social/)
  let direccion = campo(t, /direcci[oó]n(?:\s+fiscal)?|domicilio(?:\s+fiscal)?/)
  let comuna = campo(t, /comuna|distrito|municipio|delegaci[oó]n|alcald[ií]a/)
  const ciudad = campo(t, /ciudad|provincia|departamento|regi[oó]n/)

  // El e-RUT del SII imprime "Null" donde el campo (block/depto) viene vacío y
  // pega la comuna al final de la línea: "Cochrane 639 Of 54 Null Valparaíso".
  if (direccion) {
    const partes = direccion.split(/\s+null\s+/i)
    if (partes.length >= 2) {
      direccion = limpio(partes.slice(0, -1).join(" "))
      if (!comuna) comuna = limpio(partes[partes.length - 1])
    }
    direccion = direccion.replace(/\bnull\b/gi, "").replace(/\s+/g, " ").trim()
  }

  const out: DatosCertificado = { tipo }
  if (razonSocial && !/^rut\b/i.test(razonSocial)) out.razonSocial = razonSocial
  if (documento && documento.replace(/\D/g, "").length >= 7) out.documento = documento
  if (giro) out.giro = giro
  if (direccion) out.direccion = direccion
  if (comuna) out.comuna = comuna
  if (ciudad) out.ciudad = ciudad
  // Sin giro ni dirección no aporta nada a facturación: no es un certificado útil.
  if (!out.giro && !out.direccion) return null
  return out
}
