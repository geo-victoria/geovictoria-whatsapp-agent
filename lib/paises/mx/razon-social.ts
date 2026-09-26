/**
 * ¿La "razón social" que el modelo mandó a la emisión NO es una razón social?
 * En México no hay padrón que la resuelva desde el RFC, así que el modelo la
 * rellena cuando el cliente no la dio. Casos reales:
 *   - batería 24-sep: salió "XAXX010101000" (el RFC completo);
 *   - batería 26-sep: salió "GEO" (las letras iniciales del RFC GEO150101AB1).
 * Módulo PURO.
 */
export function razonSocialInvalidaMX(empresa: unknown, rfc: unknown, contacto: unknown): boolean {
  const compacto = (v: unknown) => String(v || "").replace(/[\s.\-_,]/g, "").toUpperCase()
  const e = compacto(empresa)
  const r = compacto(rfc)
  if (e.length < 2) return true
  if (/^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/.test(e)) return true // tiene forma de RFC
  if (r && (e === r || r.includes(e))) return true // el RFC o un pedazo de él
  // PERSONA FÍSICA (RFC de 13 caracteres, Lalo 26-sep): factura a su nombre,
  // así que el nombre del contacto SÍ es su razón social.
  const fisica = r.length === 13
  if (!fisica && compacto(contacto) && e === compacto(contacto)) return true // el nombre de la persona
  return false
}
