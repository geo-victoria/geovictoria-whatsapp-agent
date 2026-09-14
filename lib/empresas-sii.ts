/**
 * FICHA SII POR RUT (Lalo 10-ago: "el cliente dio el RUT en la conversación —
 * la base del SII tiene que llenar todo lo que viene después").
 *
 * Tres tablas locales cargadas del padrón público del SII:
 *   - vic_empresas_cl            (razón social, subtipo, inicio/término de giro)
 *   - vic_empresas_cl_domicilio  (dirección vigente de casa matriz, comuna, región)
 *   - vic_empresas_cl_giro       (actividad económica más reciente + cuántas tiene)
 *
 * REGLA ABSOLUTA (Lalo 10-ago, tercera iteración): NADA de esto toca la
 * conversación. Ni bloque en el prompt, ni confirmaciones, ni menciones —
 * Vicky no sabe que el padrón existe. El ÚNICO consumidor es el formulario
 * de facturación de la página de aceptación (vía vic-sii-ficha): se
 * prellena o no se prellena, y eso es todo. Fail-open: sin base, el
 * formulario queda como siempre (vacío) y nadie lo nota.
 */

import { rutValido } from "./rut"
import { repararMojibake } from "./mojibake"

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()

const H = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }

export type FichaSii = {
  rut: string
  razonSocial: string
  inicioGiro: string | null
  terminoGiro: string | null
  vigente: boolean
  direccion?: string
  comuna?: string
  region?: string
  giro?: string
  nActividades?: number
}

/** Primer RUT VÁLIDO (dígito verificador correcto) en un texto. Exige guión o
 * puntos — un número pelado de 8-9 dígitos es indistinguible de un teléfono. */
export function rutEnTexto(texto: string): string | null {
  const re = /\b(\d{1,3}(?:\.\d{3}){2}|\d{7,8})\s*-\s*(\d|[kK])\b/g
  for (const m of (texto || "").matchAll(re)) {
    const candidato = `${m[1].replace(/\./g, "")}-${m[2]}`
    if (rutValido(candidato)) return candidato.toUpperCase()
  }
  return null
}

async function una<T>(path: string): Promise<T | null> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: H, cache: "no-store" })
  if (!r.ok) return null
  const rows = (await r.json().catch(() => [])) as T[]
  return rows[0] || null
}

export async function fichaEmpresaSii(rutConDv: string): Promise<FichaSii | null> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null
  const num = rutConDv.split("-")[0]
  if (!/^\d{6,9}$/.test(num)) return null
  try {
    const [base, dom, giro] = await Promise.all([
      una<{ razon_social: string; inicio_giro: string | null; termino_giro: string | null }>(
        `vic_empresas_cl?rut=eq.${num}&select=razon_social,inicio_giro,termino_giro&limit=1`,
      ),
      una<{ direccion: string; comuna: string; region: string }>(
        `vic_empresas_cl_domicilio?rut=eq.${num}&select=direccion,comuna,region&limit=1`,
      ),
      una<{ giro: string; n_actividades: number }>(
        `vic_empresas_cl_giro?rut=eq.${num}&select=giro,n_actividades&limit=1`,
      ),
    ])
    if (!base) return null
    // REPARACIÓN EN LA LECTURA (14-sep, caso COTEL / NDV-31863): el padrón
    // guarda "TECNOLOGÍA" como "TECNOLOGÃA" (UTF-8 leído como Latin-1 y
    // vuelto a codificar). Como de aquí sale la razón social que la emisión
    // escribe en la cuenta, la cotización y el espejo de Creator, el nombre
    // roto llegaba hasta el generador de PDF de la nota de venta y lo colgaba.
    // Se repara al leer para no tocar 3,3M de filas; la función es pura y
    // deja intacto lo que ya viene bien.
    return {
      rut: rutConDv,
      razonSocial: repararMojibake(base.razon_social),
      inicioGiro: base.inicio_giro,
      terminoGiro: base.termino_giro,
      vigente: Boolean(base.inicio_giro) && !base.termino_giro,
      direccion: dom?.direccion ? repararMojibake(dom.direccion) : undefined,
      comuna: dom?.comuna ? repararMojibake(dom.comuna) : undefined,
      region: dom?.region ? repararMojibake(dom.region) : undefined,
      giro: giro?.giro ? repararMojibake(giro.giro) : undefined,
      nActividades: giro?.n_actividades || undefined,
    }
  } catch {
    return null
  }
}

