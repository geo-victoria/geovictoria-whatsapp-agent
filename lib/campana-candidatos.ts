/**
 * CANDIDATOS de la próxima campaña de re-encantamiento (Lalo 27-ago: "la
 * pestaña no solo muestra los impactados, también los candidatos; el listado
 * se debe poder actualizar y filtrar por ejecutivo comercial").
 *
 * Universo candidato: cotizaciones formales CL en estado Enviada o Aceptada
 * (no pagadas), una por contacto (la más reciente). A ese universo se le
 * aplica el FILTRO ESTÁNDAR (lib/campana-filtro.ts): 48 horas hábiles sin
 * actividad del cliente ni gestión de ejecutivo, sin clientes facturando,
 * tope de 2 campañas, sin internos.
 *
 * El cálculo es CARO (espejo + notas de deals en Zoho), así que corre bajo
 * demanda (botón "Actualizar" de la pestaña) y la foto queda en vic_kv
 * `campana_candidatos` — la pestaña siempre pinta la última foto.
 */

import { getKvValue, setKvValue } from "./supabase-persistence-v3"
import { filtrarPadronCampana } from "./campana-filtro"

const ZOHO_API = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
const QUOTE_MODULE = (process.env.ZOHO_QUOTE_MODULE || "Cotizaciones_GeoVictoria").trim()
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim()
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()

export type CandidatoCampana = {
  contact: string
  empresa: string
  cot: string
  estado: string
  fechaCot: string
  /** Ejecutivo a cargo: vendedor del traspaso activo, o dueño de la
   * cotización; los dueños robot se muestran como "Vicky". */
  ejecutivo: string
  motivoExclusion?: string
}

export type FotoCandidatos = { generadoAt: string; aptos: CandidatoCampana[]; excluidos: CandidatoCampana[] }

export const KV_CANDIDATOS = "campana_candidatos"

export async function leerFotoCandidatos(): Promise<FotoCandidatos | null> {
  try {
    const crudo = await getKvValue(KV_CANDIDATOS)
    return crudo ? (JSON.parse(crudo) as FotoCandidatos) : null
  } catch {
    return null
  }
}

async function cotizacionesNoPagadasCL(H: Record<string, string>): Promise<
  Array<{ tel: string; empresa: string; cot: string; estado: string; fecha: string; owner: string; ownerEmail: string }>
> {
  const filas: Array<{ tel: string; empresa: string; cot: string; estado: string; fecha: string; owner: string; ownerEmail: string }> = []
  for (const estado of ["Enviada", "Aceptada"]) {
    for (let page = 1; page <= 6; page++) {
      const r = await fetch(
        `${ZOHO_API}/crm/v3/${QUOTE_MODULE}/search?criteria=${encodeURIComponent(`(Estado_Cotizacion:equals:${estado})`)}&fields=Numero_Cotizacion,Name,Tel_fono_Contacto,Owner,Fecha_Cotizacion,Cuenta_Asociada&per_page=200&page=${page}`,
        { headers: H, cache: "no-store" },
      )
      if (!r.ok || r.status === 204) break
      const cuerpo = (await r.json().catch(() => null)) as {
        data?: Array<{
          Numero_Cotizacion?: string
          Name?: string
          Tel_fono_Contacto?: string
          Fecha_Cotizacion?: string
          Owner?: { name?: string; email?: string } | null
          Cuenta_Asociada?: { name?: string } | null
        }>
        info?: { more_records?: boolean }
      } | null
      for (const q of cuerpo?.data || []) {
        const tel = String(q.Tel_fono_Contacto || "").replace(/\D/g, "")
        if (!/^56\d{8,10}$/.test(tel)) continue
        filas.push({
          tel,
          empresa: String(q.Cuenta_Asociada?.name || q.Name || "").replace(/^Cotización\s+/, "").replace(/\s+-\s+\d{4}-\d{2}-\d{2}$/, ""),
          cot: String(q.Numero_Cotizacion || ""),
          estado,
          fecha: String(q.Fecha_Cotizacion || ""),
          owner: String(q.Owner?.name || ""),
          ownerEmail: String(q.Owner?.email || "").toLowerCase(),
        })
      }
      if (!cuerpo?.info?.more_records) break
    }
  }
  return filas
}

/** Recalcula la foto de candidatos y la persiste. Devuelve la foto nueva. */
export async function recalcularCandidatosCampana(): Promise<FotoCandidatos> {
  const { getZohoAccessToken } = await import("./zoho-token")
  const token = await getZohoAccessToken()
  const H = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }

  const cotis = await cotizacionesNoPagadasCL(H)
  // Una candidatura por contacto: manda la cotización MÁS RECIENTE.
  const porTel = new Map<string, (typeof cotis)[number]>()
  for (const c of cotis) {
    const previa = porTel.get(c.tel)
    if (!previa || c.fecha > previa.fecha) porTel.set(c.tel, c)
  }

  // Ejecutivo a cargo: el vendedor del traspaso ACTIVO pisa al dueño de la
  // cotización (es quien de verdad tiene la conversación); dueño robot = Vicky.
  const vendedorDe = new Map<string, string>()
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/vic_ptv?estado=eq.activo&select=contact,vendedor_nombre,vendedor_email&limit=5000`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      cache: "no-store",
    })
    for (const f of ((await r.json().catch(() => [])) as Array<{ contact: string; vendedor_nombre?: string; vendedor_email?: string }>) || []) {
      const nombre = (f.vendedor_nombre || "").trim() || (f.vendedor_email || "").split("@")[0]
      if (nombre) vendedorDe.set(f.contact.replace(/\D/g, ""), nombre)
    }
  } catch { /* sin ptv: queda el dueño de la cotización */ }

  const candidatoDe = (tel: string): CandidatoCampana => {
    const c = porTel.get(tel)
    const duenoCot = c && c.ownerEmail && !/vicky@|info@geovictoria/.test(c.ownerEmail) ? c.owner : "Vicky"
    return {
      contact: tel,
      empresa: c?.empresa || "",
      cot: c?.cot || "",
      estado: c?.estado || "",
      fechaCot: c?.fecha || "",
      ejecutivo: vendedorDe.get(tel) || duenoCot,
    }
  }

  const { aptos, excluidos } = await filtrarPadronCampana([...porTel.keys()])
  const foto: FotoCandidatos = {
    generadoAt: new Date().toISOString(),
    aptos: aptos.map(candidatoDe).sort((a, b) => (a.fechaCot < b.fechaCot ? 1 : -1)),
    excluidos: excluidos.map((e) => ({ ...candidatoDe(e.contact), motivoExclusion: e.motivo })),
  }
  await setKvValue(KV_CANDIDATOS, JSON.stringify(foto))
  return foto
}
