/**
 * FICHA SII POR RUT (Lalo 10-ago: "el cliente dio el RUT en la conversación —
 * la base del SII tiene que llenar todo lo que viene después").
 *
 * Tres tablas locales cargadas del padrón público del SII:
 *   - vic_empresas_cl            (razón social, subtipo, inicio/término de giro)
 *   - vic_empresas_cl_domicilio  (dirección vigente de casa matriz, comuna, región)
 *   - vic_empresas_cl_giro       (actividad económica más reciente + cuántas tiene)
 *
 * El webhook CL detecta un RUT en lo que el cliente ha escrito, arma la ficha
 * y se la inyecta al modelo como DATOS PRELLENADOS: razón social, giro,
 * dirección y comuna dejan de preguntarse — se confirman. El teléfono y el
 * correo de facturación no existen en el SII: siguen saliendo del chat.
 *
 * Todo best-effort: si la base no responde, el bloque va vacío y la
 * conversación sigue exactamente como antes (fail-open, principio del repo).
 */

import { rutValido } from "./rut"

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
    return {
      rut: rutConDv,
      razonSocial: base.razon_social,
      inicioGiro: base.inicio_giro,
      terminoGiro: base.termino_giro,
      vigente: Boolean(base.inicio_giro) && !base.termino_giro,
      direccion: dom?.direccion || undefined,
      comuna: dom?.comuna || undefined,
      region: dom?.region || undefined,
      giro: giro?.giro || undefined,
      nActividades: giro?.n_actividades || undefined,
    }
  } catch {
    return null
  }
}

/** Bloque para el prompt: los datos oficiales como PRELLENADO con órdenes de
 * uso. Vacío solo si no se pudo ni consultar. */
export function formatBloqueSii(ficha: FichaSii | null, rutDetectado: string): string {
  if (!ficha) {
    return (
      `\n\nRUT DETECTADO ${rutDetectado} — no aparece en el padrón de EMPRESAS del SII. ` +
      `Probablemente es un RUT de persona natural (empresa unipersonal): continúa NORMAL con lo que el cliente entregue. ` +
      `Si te calza más un typo, confírmalo casual y EN EL MISMO mensaje en que sigues avanzando ("te dejo la cotización al RUT ${rutDetectado}, ¿está ok?") — ` +
      `esta verificación es INFORMATIVA: jamás detengas ni condiciones la cotización por ella.`
    )
  }
  const partes = [
    `Razón social oficial: ${ficha.razonSocial}`,
    ficha.giro ? `Giro: ${ficha.giro}${(ficha.nActividades || 1) > 1 ? ` (+${(ficha.nActividades || 1) - 1} actividades más)` : ""}` : "",
    ficha.direccion ? `Dirección casa matriz: ${ficha.direccion}` : "",
    ficha.comuna ? `Comuna: ${ficha.comuna} (${ficha.region || ""})` : "",
    ficha.inicioGiro ? `Inicio de actividades: ${ficha.inicioGiro}` : "",
  ].filter(Boolean)
  let bloque =
    `\n\nDATOS OFICIALES SII para el RUT ${ficha.rut} (PRELLENADOS — úsalos, NO se los preguntes al cliente):\n- ` +
    partes.join("\n- ") +
    `\nUso: la cotización formal va con esta razón social y este RUT (si el cliente usa un nombre de fantasía distinto, ` +
    `menciónalo tú: "te la dejo a nombre de ${ficha.razonSocial}, ¿cierto?"). La comuna sirve para envío/instalación de reloj — ` +
    `asume la de casa matriz y pregunta SOLO si el despacho va a otra dirección. El teléfono y correo de facturación NO están acá: esos sí se piden.`
  if (ficha.terminoGiro) {
    bloque +=
      `\nDATO (no bloqueante): este RUT registra término de giro (${ficha.terminoGiro}) ante el SII. Menciónalo con tacto ` +
      `("veo que ese RUT figura con término de giro — ¿facturamos a ese mismo o usas otro?") y sigue con el que el cliente ` +
      `confirme. La validación del SII es INFORMATIVA: nunca frena ni condiciona la emisión.`
  }
  return bloque
}
