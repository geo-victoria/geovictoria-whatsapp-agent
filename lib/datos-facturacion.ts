/**
 * DATOS DE FACTURACIÓN del cliente — UN solo lugar (24-sep).
 *
 * Antes se capturaban en dos sitios y se descartaban en los dos: la pantalla
 * EMPRESA del flow del alta los dejaba en `onboarding_flow_extras_<contact>`
 * (solo los leía la sesión del wizard) y el pop-up de aceptación los mandaba
 * al cotizador, que los tiraba porque el módulo de cotizaciones no tiene esos
 * campos. Resultado: finanzas rechazaba las solicitudes por "faltan giro,
 * dirección y comuna" cuando el cliente ya los había escrito.
 *
 * Regla: lo que el cliente declara más reciente gana, y un valor nunca se pisa
 * con vacío. Fuentes: aceptacion (pop-up), flow (pantalla EMPRESA), chat,
 * padron (SUNAT/RUES/SII), manual.
 */
import { getKvValue, setKvValue } from "./supabase-persistence-v3"

export {
  claveDatosFacturacion,
  fusionarDatosFacturacion,
  type DatosFacturacion,
} from "./datos-facturacion-puro"
import { fusionarDatosFacturacion, claveDatosFacturacion, CAMPOS_FACTURACION as CAMPOS, type DatosFacturacion } from "./datos-facturacion-puro"

const limpio = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim()

export async function leerDatosFacturacion(contact: string): Promise<DatosFacturacion | null> {
  const c = String(contact || "").replace(/\D/g, "")
  if (!c) return null
  let base: DatosFacturacion | null = null
  try {
    const raw = await getKvValue(claveDatosFacturacion(c))
    if (raw) base = JSON.parse(raw) as DatosFacturacion
  } catch {
    base = null
  }
  // Compatibilidad: lo que el flow dejó antes del 24-sep en la llave vieja.
  try {
    const raw = await getKvValue(`onboarding_flow_extras_${c}`)
    if (raw) {
      const e = JSON.parse(raw) as { giro?: string; direccion?: string; comuna?: string }
      const faltan: Partial<DatosFacturacion> = {}
      if (!limpio(base?.giro) && limpio(e.giro)) faltan.giro = e.giro
      if (!limpio(base?.direccion) && limpio(e.direccion)) faltan.direccion = e.direccion
      if (!limpio(base?.comuna) && limpio(e.comuna)) faltan.comuna = e.comuna
      if (Object.keys(faltan).length) base = fusionarDatosFacturacion(base, faltan, "flow")
    }
  } catch {
    /* sin extras */
  }
  return base
}

export async function guardarDatosFacturacion(contact: string, nuevo: Partial<DatosFacturacion>, fuente: string): Promise<DatosFacturacion | null> {
  const c = String(contact || "").replace(/\D/g, "")
  if (!c) return null
  if (!CAMPOS.some((k) => limpio(nuevo[k]))) return leerDatosFacturacion(c)
  const base = await leerDatosFacturacion(c)
  const out = fusionarDatosFacturacion(base, nuevo, fuente)
  await setKvValue(claveDatosFacturacion(c), JSON.stringify(out)).catch(() => {})
  return out
}
