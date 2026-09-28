/**
 * CONTENIDO REAL DE LA COTIZACIÓN VIGENTE EN EL PROMPT (28-sep, caso Irene /
 * APPLICATION CALL GROUP, Perú).
 *
 * Irene preguntó cuánto costaba la instalación en su cotización en venta y
 * Vicky le respondió dos veces algo inventado: primero "el pago único incluye
 * el equipo + la instalación técnica, está desglosado en tu cotización" y
 * después "no viene desglosado, puedo coordinar que un ejecutivo te lo
 * detalle". La cotización tenía SOLO el plan (S/82,50) y el reloj (S/305): no
 * había ninguna línea de instalación. El modelo no veía las líneas —el
 * contexto de la cotización existente trae el total y el link— y rellenó.
 *
 * Esto le da al turno las líneas EXACTAS que el cliente ve en su página de
 * aceptación (la misma sesión que pinta la página, así que no hay dos
 * verdades), para los cuatro países. Si la lectura falla o tarda, el turno
 * sigue sin el bloque: jamás frena la conversación.
 */

import { contextoDesdeToken } from "./cotizacion-chat"
import { bloqueContenido } from "./contenido-cotizacion-puro"

const COTIZADOR_BASE = (process.env.VICKY_COTIZADOR_BASE || "https://cotizacion.geovictoria.com").trim()
const TIMEOUT_MS = 4000

/** El token de aceptación a partir del link guardado (largo o /q/ corto). */
async function tokenDesdeUrl(url: string): Promise<string> {
  if (!url) return ""
  const m = url.match(/[?&]token=([^&#]+)/)
  if (m) return decodeURIComponent(m[1])
  if (/\/q\//.test(url)) {
    try {
      const abs = url.startsWith("http") ? url : `${COTIZADOR_BASE}${url.startsWith("/") ? "" : "/"}${url}`
      const r = await fetch(abs, { redirect: "manual", cache: "no-store" })
      const loc = r.headers.get("location") || ""
      const m2 = loc.match(/[?&]token=([^&#]+)/)
      if (m2) return decodeURIComponent(m2[1])
    } catch {
      /* sin token no hay bloque */
    }
  }
  return ""
}

/** Lee la sesión de aceptación y arma el bloque. Best-effort con tope de tiempo. */
export async function contenidoCotizacionParaPrompt(acceptanceUrl: string | undefined, pais: string): Promise<string> {
  if (!acceptanceUrl) return ""
  const trabajo = (async () => {
    const token = await tokenDesdeUrl(acceptanceUrl)
    if (!token) return ""
    const ctx = await contextoDesdeToken(token)
    if (!ctx?.items?.length) return ""
    return bloqueContenido(ctx.items, (ctx.pais || pais || "cl").toLowerCase())
  })().catch(() => "")
  const tope = new Promise<string>((res) => setTimeout(() => res(""), TIMEOUT_MS))
  return Promise.race([trabajo, tope])
}
