/**
 * Parte PURA de los datos de facturación (sin imports): tipo, campos y fusión.
 * lib/datos-facturacion.ts le pone la persistencia encima.
 */
export type DatosFacturacion = {
  razonSocial?: string
  documento?: string
  giro?: string
  direccion?: string
  comuna?: string
  ciudad?: string
  telefono?: string
  correo?: string
  contactoNombre?: string
  /** Última fuente por campo (para saber de dónde salió cada dato). */
  fuentes?: Record<string, string>
  actualizadoAt?: string
}

export const claveDatosFacturacion = (contact: string) => `datos_facturacion_${String(contact || "").replace(/\D/g, "")}`

export const CAMPOS_FACTURACION: Array<keyof Omit<DatosFacturacion, "fuentes" | "actualizadoAt">> = [
  "razonSocial", "documento", "giro", "direccion", "comuna", "ciudad", "telefono", "correo", "contactoNombre",
]

const limpio = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim()

/** Fusión pura: `nuevo` gana donde trae valor; jamás pisa con vacío. */
export function fusionarDatosFacturacion(base: DatosFacturacion | null, nuevo: Partial<DatosFacturacion>, fuente: string): DatosFacturacion {
  const out: DatosFacturacion = { ...(base || {}), fuentes: { ...(base?.fuentes || {}) } }
  for (const k of CAMPOS_FACTURACION) {
    const v = limpio(nuevo[k])
    if (!v) continue
    out[k] = v
    out.fuentes![k] = fuente
  }
  out.actualizadoAt = new Date().toISOString()
  return out
}

