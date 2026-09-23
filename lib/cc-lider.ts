/**
 * COPIA AL LÍDER COMERCIAL en los avisos de traspaso (lead o deal) — por país.
 *
 * Chile: Victoria Luna (env VICKY_TRASPASO_CC, regla 31-jul). Colombia (Lalo
 * 23-sep, "Victoria Luna allá es María Fernanda Cely Villamil"): la líder de
 * la ficha operativa CO. Perú y México: sin copia (nadie lo ha decidido; el
 * líder PE, Diego Bendezú, no quiso figurar en la operación diaria).
 * PURO: lo consumen crm-hitos, ptv-cron y notificar-lead-asignado.
 */
import { fichaOperativa, paisDeTelefonoOperativo } from "./paises/ficha-operativa"

export function ccLiderTraspaso(contact: string, territorio?: string): string[] {
  const t = String(territorio || "").toLowerCase()
  const pais = /chile/.test(t) ? "cl" : /colombia/.test(t) ? "co" : /per/.test(t) ? "pe" : /m[eé]xico/.test(t) ? "mx" : paisDeTelefonoOperativo(contact)
  if (pais === "cl") {
    const cc = (process.env.VICKY_TRASPASO_CC || fichaOperativa("cl").equipo.lider || "").trim()
    return cc ? [cc] : []
  }
  if (pais === "co") {
    const cc = (process.env.VICKY_TRASPASO_CC_CO || fichaOperativa("co").equipo.lider || "").trim()
    return cc ? [cc] : []
  }
  return []
}
