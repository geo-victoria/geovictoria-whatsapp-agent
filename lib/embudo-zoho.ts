/**
 * EMBUDO DE CONVERSIÓN PARA LA MEDICIÓN DE CAMPAÑAS (David García 24-sep).
 * Google Ads recibe las conversiones desde los cambios de estado de Zoho:
 *   1. el lead pasa por "4. Calificado" ANTES de convertirse;
 *   2. el deal NACE en "1. Trato Creado" y después avanza a su etapa.
 * Gemelo del módulo del cotizador (api/_shared/embudo-zoho.js): las dos puertas
 * que convierten leads (hitos de la conversación y emisión de la cotización)
 * siguen la misma secuencia. Best-effort: jamás bloquea una conversión.
 * Kill switch: env VICKY_EMBUDO_CAMPANAS=off.
 */
import { getZohoAccessToken } from "./zoho-token"

export const ETAPA_TRATO_CREADO = "1. Trato Creado"
const STATUS_CALIFICADO = "4. Calificado"
const API = () => (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()

export function embudoActivo(): boolean {
  return (process.env.VICKY_EMBUDO_CAMPANAS || "").trim().toLowerCase() !== "off"
}

export function numeroEtapa(stage: string | undefined | null): number | null {
  const m = /^\s*(\d+)\s*\./.exec(String(stage || ""))
  return m ? Number(m[1]) : null
}

function normal(s: string | undefined | null): string {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

type Transicion = {
  id: string
  next_field_value?: string
  data?: Record<string, unknown>
  fields?: Array<{ api_name?: string; data_type?: string }>
}

async function headers() {
  return { Authorization: `Zoho-oauthtoken ${await getZohoAccessToken()}`, "Content-Type": "application/json" }
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return ((await res.json().catch(() => ({}))) || {}) as Record<string, unknown>
}

/** Deja el lead en "4. Calificado" justo antes del convert (transición del blueprint o PUT fuera de proceso). */
export async function calificarLeadAntesDeConvertir(leadId: string): Promise<boolean> {
  if (!leadId || !embudoActivo()) return false
  try {
    const h = await headers()
    const g = await fetch(`${API()}/crm/v3/Leads/${leadId}?fields=Lead_Status`, { headers: h, cache: "no-store" })
    const actual = String(((await json(g)).data as Array<{ Lead_Status?: string }> | undefined)?.[0]?.Lead_Status || "")
    if (/^\s*4\./.test(actual)) return true
    const bp = await fetch(`${API()}/crm/v2/Leads/${leadId}/actions/blueprint`, { headers: h, cache: "no-store" })
    const bpJson = (await json(bp)) as { blueprint?: { transitions?: Transicion[] } }
    const t = (bpJson.blueprint?.transitions || []).find((x) => /^\s*4\./.test(String(x.next_field_value || "")))
    if (t) {
      const data: Record<string, unknown> = { ...(t.data || {}) }
      if ((t.fields || []).some((f) => f.api_name === "Tombola") && !data.Tombola) data.Tombola = "Mantener propietario"
      const exec = await fetch(`${API()}/crm/v2/Leads/${leadId}/actions/blueprint`, {
        method: "PUT",
        headers: h,
        cache: "no-store",
        body: JSON.stringify({ blueprint: [{ transition_id: t.id, data }] }),
      })
      const ej = await json(exec)
      console.warn(`[embudo] lead ${leadId}: ${actual} → 4. Calificado por blueprint (${exec.status} ${String(ej.code || ej.message || "")})`)
      if (exec.ok && !/partial/i.test(String(ej.message || ""))) return true
    }
    const put = await fetch(`${API()}/crm/v3/Leads`, {
      method: "PUT",
      headers: h,
      cache: "no-store",
      body: JSON.stringify({
        data: [{ id: leadId, Lead_Status: STATUS_CALIFICADO }],
        trigger: ["blueprint"],
        skip_feature_execution: [{ name: "assignment_rules" }],
      }),
    })
    const fila = ((await json(put)).data as Array<{ code?: string }> | undefined)?.[0]
    console.warn(`[embudo] lead ${leadId}: ${actual} → 4. Calificado por PUT (${put.status} ${fila?.code || ""})`)
    return fila?.code === "SUCCESS"
  } catch (e) {
    console.warn(`[embudo] lead ${leadId}: no se pudo calificar — ${String((e as Error)?.message || e).slice(0, 200)}`)
    return false
  }
}

/** Avanza un deal recién nacido en "1. Trato Creado" hasta `objetivo` por el blueprint (forward-only). */
export async function avanzarDealDesdeTratoCreado(
  dealId: string,
  objetivo: string,
  valores: Record<string, unknown> = {},
): Promise<boolean> {
  const objNum = numeroEtapa(objetivo)
  if (!dealId || objNum === null || objNum <= 1) return true
  try {
    const h = await headers()
    for (let salto = 0; salto < 4; salto++) {
      const g = await fetch(`${API()}/crm/v3/Deals/${dealId}?fields=Stage`, { headers: h, cache: "no-store" })
      const stage = String(((await json(g)).data as Array<{ Stage?: string }> | undefined)?.[0]?.Stage || "")
      const n = numeroEtapa(stage)
      if (normal(stage) === normal(objetivo) || (n !== null && n >= objNum)) return true
      const bp = await fetch(`${API()}/crm/v2/Deals/${dealId}/actions/blueprint`, { headers: h, cache: "no-store" })
      const bpJson = (await json(bp)) as { code?: string; blueprint?: { transitions?: Transicion[] } }
      if (bpJson.code === "RECORD_NOT_IN_PROCESS" || !bp.ok) {
        const put = await fetch(`${API()}/crm/v3/Deals`, {
          method: "PUT",
          headers: h,
          cache: "no-store",
          body: JSON.stringify({
            data: [{ id: dealId, Stage: objetivo }],
            trigger: ["blueprint"],
            skip_feature_execution: [{ name: "assignment_rules" }],
          }),
        })
        const fila = ((await json(put)).data as Array<{ code?: string }> | undefined)?.[0]
        console.warn(`[embudo] deal ${dealId}: ${stage} → ${objetivo} por PUT (${fila?.code || put.status})`)
        return fila?.code === "SUCCESS"
      }
      const cands = (bpJson.blueprint?.transitions || []).filter((t) => {
        const m = numeroEtapa(t.next_field_value)
        return m !== null && m > (n ?? 0) && m <= objNum
      })
      if (!cands.length) {
        console.warn(`[embudo] deal ${dealId}: sin transición de ${stage} hacia ${objetivo}`)
        return false
      }
      const t =
        cands.find((x) => normal(x.next_field_value) === normal(objetivo)) ||
        cands.sort((a, b) => (numeroEtapa(b.next_field_value) || 0) - (numeroEtapa(a.next_field_value) || 0))[0]
      const data: Record<string, unknown> = { ...(t.data || {}) }
      for (const f of t.fields || []) {
        const api = f.api_name || ""
        if (!api) continue
        const vacio = data[api] === undefined || data[api] === null || data[api] === ""
        if (vacio && valores[api] !== undefined && valores[api] !== null && valores[api] !== "") data[api] = valores[api]
        if (f.data_type === "multiselectpicklist" && typeof data[api] === "string") {
          data[api] = String(data[api]).split(";").map((v) => v.trim()).filter(Boolean)
        }
      }
      const exec = await fetch(`${API()}/crm/v2/Deals/${dealId}/actions/blueprint`, {
        method: "PUT",
        headers: h,
        cache: "no-store",
        body: JSON.stringify({ blueprint: [{ transition_id: t.id, data }] }),
      })
      const ej = await json(exec)
      console.warn(`[embudo] deal ${dealId}: ${stage} → ${t.next_field_value} (${exec.status} ${String(ej.code || "")} ${String(ej.message || "").slice(0, 80)})`)
      if (!exec.ok) return false
    }
    return false
  } catch (e) {
    console.warn(`[embudo] deal ${dealId}: no se pudo avanzar a ${objetivo} — ${String((e as Error)?.message || e).slice(0, 200)}`)
    return false
  }
}
