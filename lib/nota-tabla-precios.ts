/**
 * Nota de auditoría con la TABLA DE PRECIOS que se le ofreció al cliente.
 *
 * Orden de Lalo (14-ago-2026): toda cotización debe dejar registrada la lista
 * vigente al momento de emitirla. La lista de Asistencia cambió cinco veces
 * entre mayo y agosto, así que revisar una cotización antigua con la tabla de
 * hoy lleva a conclusiones equivocadas (el levantamiento retroactivo de ese
 * día tuvo que reconstruirla del historial de git, commit a commit).
 *
 * La tabla se arma desde el CATÁLOGO VIVO — no de una copia — para que la nota
 * no pueda mentir: si mañana cambian los tramos, la nota de la cotización
 * siguiente sale con los tramos nuevos sin que nadie tenga que acordarse de
 * actualizar nada. Los tramos sobre 50 usuarios (fuera del rango de Vicky) se
 * completan con el catálogo del canal ejecutivo, que sí los tiene.
 *
 * Best-effort puro: nunca lanza y jamás bloquea la emisión.
 */

import { CATALOGO_MODULOS } from "./catalogo/modulos"
import { TRAMOS_ASISTENCIA as TRAMOS_EJECUTIVO } from "./cotizadora-ejecutivos/catalogo"
import { getZohoAccessToken } from "./zoho-token"

const ZOHO_API_DOMAIN = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
const QUOTE_MODULE = (process.env.ZOHO_QUOTE_MODULE || "Cotizaciones_GeoVictoria").trim()
const TITULO = "📋 Tabla de precios vigente al emitir esta cotización"
/** Tope del rango de Vicky: sobre esto manda la lista del canal ejecutivo. */
const TOPE_VICKY = 50

const uf = (n: number) => String(n).replace(".", ",")

/** Texto de la nota, construido desde los catálogos vivos. */
export function cuerpoNotaTablaPrecios(fecha = new Date()): string {
  const asistencia = CATALOGO_MODULOS.find((m) => m.id === "asistencia")
  const propios = (asistencia?.tiers || [])
    .filter((t) => t.minUsuarios <= TOPE_VICKY)
    .map((t) => {
      const rango = t.minUsuarios === t.maxUsuarios ? `${t.minUsuarios}` : `${t.minUsuarios}-${t.maxUsuarios}`
      const precio =
        t.modalidad === "fijo" ? `${uf(t.precioUF)} UF fijo` : `${uf(t.precioUF)} UF por usuario`
      return `  · ${rango} trabajadores: ${precio}`
    })
  const ejecutivo = TRAMOS_EJECUTIVO.filter((t) => t.min > TOPE_VICKY).map(
    (t) =>
      `  · ${t.min.toLocaleString("es-CL")}-${t.max.toLocaleString("es-CL")} trabajadores: ${uf(t.uf)} UF por usuario`,
  )
  const enRangoEjecutivo = TRAMOS_EJECUTIVO.filter((t) => t.min <= TOPE_VICKY)
    .map((t) => `${t.min}-${t.max}: ${uf(t.uf)}`)
    .join(" · ")
  return [
    `Tabla de precios de CONTROL DE ASISTENCIA vigente el día en que se emitió esta cotización (${fecha.toLocaleDateString("es-CL", { timeZone: "America/Santiago" })}).`,
    "",
    "LISTA APLICADA — canal Vicky (WhatsApp):",
    ...propios,
    "",
    "TRAMOS SOBRE 50 TRABAJADORES — fuera del rango de Vicky, se completan con la calculadora del canal ejecutivo:",
    ...ejecutivo,
    "",
    "Notas: valores netos en UF, sin IVA (19%) ni descuentos. El precio en pesos de esta cotización quedó congelado con la UF del día de emisión.",
    `En el rango 1-50 el canal ejecutivo usa su propia lista, más alta (${enRangoEjecutivo} UF): son dos listas oficiales por canal.`,
    "",
    "Registro generado automáticamente al emitir, desde el catálogo vigente en ese momento.",
  ].join("\n")
}

/**
 * Cuelga la nota de la cotización recién creada. POST al SUB-RECURSO
 * /{modulo}/{id}/Notes: el formato global (POST /Notes con Parent_Id) falla
 * SIEMPRE en silencio en módulos custom — cicatriz del 25-jul con las notas
 * de comprobante, repetida el 14-ago con el backfill de precios.
 */
export async function anotarTablaPrecios(quoteId: string): Promise<boolean> {
  if (!quoteId) return false
  try {
    const token = await getZohoAccessToken()
    const res = await fetch(
      `${ZOHO_API_DOMAIN}/crm/v3/${encodeURIComponent(QUOTE_MODULE)}/${encodeURIComponent(quoteId)}/Notes`,
      {
        method: "POST",
        headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          data: [{ Note_Title: TITULO, Note_Content: cuerpoNotaTablaPrecios() }],
        }),
        cache: "no-store",
      },
    )
    if (!res.ok) {
      const detalle = await res.text().catch(() => "")
      console.warn(`[nota-precios] quote=${quoteId} Zoho ${res.status}: ${detalle.slice(0, 200)}`)
      return false
    }
    console.log(`[nota-precios] tabla anotada en quote=${quoteId}`)
    return true
  } catch (e) {
    console.warn("[nota-precios] excepción:", e instanceof Error ? e.message : e)
    return false
  }
}
