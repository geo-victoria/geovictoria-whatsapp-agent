/**
 * CONCILIADOR DE ESTADO Y DUEÑO (29-ago, idea de Lalo tras el saneamiento).
 *
 * EL PROBLEMA QUE RESUELVE: el traspaso y el loop guardan una FOTO del momento
 * —quién era el dueño, si había precio, si estaba pagado— y esa foto no se
 * refresca nunca. El caso avanza y el registro queda viejo. De ahí salieron
 * tres defectos distintos del saneamiento de agosto:
 *
 *   1. Pagos por COMPROBANTE que no cierran el loop. Medido: de 5 pagos por
 *      transferencia, ninguno lo cerró; dos se salvaron porque el traspaso ya
 *      lo había cerrado y uno (Mater Misericordiae, $77.001) recibió cuatro
 *      toques comerciales en los diez días siguientes al pago.
 *   2. Cotizaciones formales en manos de SDR. Cuando el caso se califica
 *      DESPUÉS del traspaso nadie lo devuelve: de los 41 entregados a
 *      calificación en agosto, ocho volvieron a conversar y los ocho llegaron
 *      a formal — y ahí se quedaron (Green Energy, Condominio Retiro, Javiera).
 *   3. Filas de traspaso con un vendedor que ya no es el dueño en Zoho, lo que
 *      hace que el candado de silencio y el chequeo de 9h apunten a la persona
 *      equivocada.
 *
 * REGLA DE ORO (Lalo, misma sesión): esto no puede romper nada. Por eso:
 *   · corre en un cron, JAMÁS en el camino de la conversación;
 *   · nace en modo SOMBRA — con el gate apagado solo reporta lo que haría;
 *   · cada acción es independiente y best-effort: si una falla, las otras siguen;
 *   · candado por caso para no repetir trabajo ni bombardear a nadie;
 *   · si una consulta no responde, se omite el caso y se reintenta al tick
 *     siguiente. Nunca degrada lo que hay hoy.
 *
 * ALEYDIS (definición de Lalo 29-ago): se trata como SDR para la escalada de
 * la cotización formal, pero conserva su rol comercial en la VENTA AUTÓNOMA
 * post-pago. No chocan: la escalada corre en la emisión, la venta autónoma
 * después del pago — y este conciliador nunca toca un caso ya pagado.
 */

import { getZohoAccessToken } from "./zoho-token"

const SDR_POR_DEFECTO = "aaraque@geovictoria.com,asepulveda@geovictoria.com"

/** Roster que NO debe quedarse con una cotización formal (override por env). */
export function esSdr(email: string | null | undefined): boolean {
  const limpio = (email || "").trim().toLowerCase()
  if (!limpio) return false
  return (process.env.VICKY_TM_ROSTER_CALIFICACION_EMAILS || SDR_POR_DEFECTO)
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .includes(limpio)
}

export type Desajuste =
  | { tipo: "loop_no_cerrado_con_pago"; contact: string; detalle: string }
  | { tipo: "formal_con_sdr"; contact: string; dealId: string; dueno: string; detalle: string }
  | { tipo: "traspaso_desactualizado"; contact: string; ptvId: string; de: string; a: string }

export type EstadoZohoCaso = {
  estadoCotizacion: string
  dealId: string
  duenoDealEmail: string
  duenoDealId: string
  quoteId: string
}

/**
 * Lee de Zoho el estado real de la cotización y el dueño de su trato.
 * Devuelve null si algo no responde — el llamador omite el caso y reintenta.
 */
export async function estadoRealDelCaso(quoteId: string): Promise<EstadoZohoCaso | null> {
  if (!quoteId) return null
  try {
    const token = await getZohoAccessToken()
    const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
    const H = { Authorization: `Zoho-oauthtoken ${token}` }
    const q = await fetch(
      `${api}/crm/v3/Cotizaciones_GeoVictoria/${quoteId}?fields=Estado_Cotizacion,Deal_Asociado`,
      { headers: H, cache: "no-store" },
    )
    if (q.status !== 200) return null
    const fila = ((await q.json().catch(() => ({}))) as {
      data?: Array<{ Estado_Cotizacion?: string; Deal_Asociado?: { id?: string } }>
    }).data?.[0]
    const dealId = String(fila?.Deal_Asociado?.id || "")
    let duenoDealEmail = ""
    let duenoDealId = ""
    if (dealId) {
      const d = await fetch(`${api}/crm/v3/Deals/${dealId}?fields=Owner`, { headers: H, cache: "no-store" })
      if (d.status === 200) {
        const owner = ((await d.json().catch(() => ({}))) as {
          data?: Array<{ Owner?: { id?: string; email?: string } }>
        }).data?.[0]?.Owner
        duenoDealEmail = String(owner?.email || "")
        duenoDealId = String(owner?.id || "")
      }
    }
    return {
      estadoCotizacion: String(fila?.Estado_Cotizacion || ""),
      dealId,
      duenoDealEmail,
      duenoDealId,
      quoteId,
    }
  } catch {
    return null
  }
}

/** Un caso PAGADO nunca se toca: su dueño lo decide la venta autónoma. */
export function estaPagada(estado: string): boolean {
  return /pagad/i.test(estado || "")
}

/** La cotización ya salió al cliente (formal viva, todavía sin pagar). */
export function esFormalViva(estado: string): boolean {
  return /enviada|aceptada|pendiente/i.test(estado || "") && !estaPagada(estado)
}
