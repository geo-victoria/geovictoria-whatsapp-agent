/**
 * LA FICHA DEL PAÍS — lo único que cambia de un país a otro en el prompt.
 *
 * Nace del mapa del prompt de Chile (21-sep): 182 líneas locales en siete
 * variables. Cada campo se agrega cuando su variable se extrae del núcleo;
 * mientras no se use, es documentación de lo que viene.
 */
export type FichaPrompt = {
  pais: "cl" | "co" | "mx" | "pe"
  /** Documento tributario de la empresa (RUT, RUC, NIT, RFC). */
  documento: string
  /** Documento personal del administrador (RUT, DNI, cédula, CURP). */
  documentoAdmin: string
  /** Unidad de precio del catálogo (UF, S/, COP, MXN). */
  moneda: string
  /** Impuesto y su tasa (IVA 19, IGV 18…). */
  impuesto: string
  impuestoPct: number
  /** Unidad geográfica que se pregunta con reloj físico (comuna, distrito). */
  zona: string
  zonaTz: string
  gentilicio: string
}

export const FICHA_CL: FichaPrompt = {
  pais: "cl",
  documento: "RUT",
  documentoAdmin: "RUT",
  moneda: "UF",
  impuesto: "IVA",
  impuestoPct: 19,
  zona: "comuna",
  zonaTz: "America/Santiago",
  gentilicio: "chilena",
}
