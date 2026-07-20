/**
 * Transiciones de etapa de DEALS por blueprint (pedido Lalo 20-jul):
 *   - Cotización PAGADA        → deal a "6. Listo para Cierre"
 *   - Auto-onboarding COMPLETO → deal a "Implementando"
 *
 * Los deals del org viven en un BLUEPRINT: el update directo de Stage devuelve
 * RECORD_IN_BLUEPRINT, así que se ejecuta la TRANSICIÓN cuyo destino calza con
 * el objetivo (mismo patrón que updateZohoLeadStatus en zoho-leads).
 *
 * Reglas de seguridad:
 *   - FORWARD-ONLY: nunca retrocede — si el deal ya está en el objetivo o más
 *     adelante (Implementando/Facturando/Ganado), no se toca.
 *   - Deals en estados terminales o gestionados a mano (Cierre Perdido,
 *     Congelado) JAMÁS se tocan.
 *   - Si el objetivo es "Implementando" pero el blueprint solo ofrece el paso
 *     intermedio ("6. Listo para Cierre"), se avanza ese paso — la siguiente
 *     corrida del cron completa el viaje.
 */

import { getZohoAccessToken } from "./zoho-token"

const ZOHO_API_DOMAIN = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()

// Orden del pipeline para el candado forward-only. El índice se resuelve por
// inclusión normalizada (los nombres reales llevan prefijos "4.", "6.", etc.).
function indiceEtapa(stage: string): number {
  const s = (stage || "").toLowerCase()
  if (s.includes("perdido") || s.includes("congelado")) return -1 // intocable
  if (s.includes("facturando") || s.includes("ganado")) return 8
  if (s.includes("implement")) return 7
  if (s.includes("listo para cierre")) return 6
  if (s.includes("piloto")) return 5
  if (s.includes("propuesta")) return 4
  if (s.includes("reuni")) return 3
  return 2 // etapas tempranas (SQL, contactado, etc.)
}

export type ResultadoTransicion = {
  dealId: string
  desde?: string
  resultado: "avanzado" | "ya_estaba" | "intocable" | "sin_transicion" | "error"
  detalle?: string
}

export async function transicionarDealHacia(
  dealId: string,
  objetivo: "listo para cierre" | "implementando",
): Promise<ResultadoTransicion> {
  const targetIdx = objetivo === "implementando" ? 7 : 6
  try {
    const accessToken = await getZohoAccessToken()
    const headers = {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      "Content-Type": "application/json",
    }

    // 1. Etapa actual → candado forward-only.
    const recRes = await fetch(`${ZOHO_API_DOMAIN}/crm/v3/Deals/${dealId}?fields=Stage`, {
      headers,
      cache: "no-store",
    })
    if (!recRes.ok) return { dealId, resultado: "error", detalle: `GET deal ${recRes.status}` }
    const rec = (await recRes.json().catch(() => ({}))) as { data?: Array<{ Stage?: string }> }
    const stageActual = String(rec?.data?.[0]?.Stage || "")
    const idxActual = indiceEtapa(stageActual)
    if (idxActual === -1) return { dealId, desde: stageActual, resultado: "intocable" }
    if (idxActual >= targetIdx) return { dealId, desde: stageActual, resultado: "ya_estaba" }

    // 2. Transiciones disponibles del blueprint.
    const bpRes = await fetch(`${ZOHO_API_DOMAIN}/crm/v2/Deals/${dealId}/actions/blueprint`, {
      headers,
      cache: "no-store",
    })
    if (!bpRes.ok) return { dealId, desde: stageActual, resultado: "error", detalle: `blueprint GET ${bpRes.status}` }
    const bp = (await bpRes.json().catch(() => ({}))) as {
      blueprint?: {
        transitions?: Array<{ id: string; name?: string; next_field_value?: string }>
      }
    }
    const transitions = bp?.blueprint?.transitions || []
    const buscar = (needle: string) =>
      transitions.find((t) => {
        const destino = (t.next_field_value || "").toLowerCase()
        const nombre = (t.name || "").toLowerCase()
        return destino.includes(needle) || nombre.includes(needle)
      })
    // Directa al objetivo; si el objetivo es Implementando y no está disponible
    // aún, avanza el hito intermedio (Listo para Cierre) — forward-only igual.
    const match =
      buscar(objetivo) || (objetivo === "implementando" ? buscar("listo para cierre") : undefined)
    if (!match) {
      return {
        dealId,
        desde: stageActual,
        resultado: "sin_transicion",
        detalle: transitions.map((t) => t.next_field_value || t.name).join(", ").slice(0, 150),
      }
    }

    // 3. Ejecutar.
    const exec = await fetch(`${ZOHO_API_DOMAIN}/crm/v2/Deals/${dealId}/actions/blueprint`, {
      method: "PUT",
      headers,
      cache: "no-store",
      body: JSON.stringify({ blueprint: [{ transition_id: match.id, data: {} }] }),
    })
    const execData = (await exec.json().catch(() => ({}))) as { code?: string; message?: string }
    if (!exec.ok || (execData?.code && execData.code !== "SUCCESS")) {
      return {
        dealId,
        desde: stageActual,
        resultado: "error",
        detalle: `${execData?.code || exec.status}: ${String(execData?.message || "").slice(0, 120)}`,
      }
    }
    return {
      dealId,
      desde: stageActual,
      resultado: "avanzado",
      detalle: `→ ${match.next_field_value || match.name}`,
    }
  } catch (e) {
    return { dealId, resultado: "error", detalle: e instanceof Error ? e.message.slice(0, 150) : "excepción" }
  }
}
