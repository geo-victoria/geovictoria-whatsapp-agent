/**
 * Nombre del DEAL que crea Vicky, por territorio (PURO, sin imports).
 *
 * Perú (Mónica vía Lalo, 29-sep): finanzas rechaza registros sin el RUC a la
 * vista, así que el trato se llama `RUC - RAZÓN SOCIAL - lo que sigue`
 * ("20543160891 - CONSTRUCTORA UNIMET S.A.C. - Control de Asistencia").
 * Chile y el resto conservan `RAZÓN (Control de Asistencia)`.
 *
 * Idempotente: si la razón social ya trae el RUC adelante (la cuenta suele
 * nacer "RUC - RAZÓN"), no lo duplica; y un sufijo entre paréntesis heredado
 * se normaliza a " - sufijo".
 */
export function nombreDealVicky(
  territorio: string,
  razon: string,
  opts: { documento?: string | null; sufijo?: string } = {},
): string {
  const sufijo = (opts.sufijo || "Control de Asistencia").trim()
  const base = (razon || "").replace(/\s+/g, " ").trim() || "Prospecto WhatsApp"
  if (!/per[uú]/i.test(territorio || "")) return `${base} (${sufijo})`
  const doc = (opts.documento || "").replace(/\D/g, "")
  const enNombre = base.match(/^(\d{11})\s*[-–|]?\s*(.*)$/)
  const ruc = doc.length === 11 ? doc : enNombre ? enNombre[1] : ""
  let resto = enNombre ? enNombre[2] : base
  resto = resto.replace(/\s*\(\s*[^()]*\)\s*$/, "").replace(/\s*[-–|]\s*$/, "").trim() || base
  return ruc ? `${ruc} - ${resto} - ${sufijo}` : `${resto} - ${sufijo}`
}
