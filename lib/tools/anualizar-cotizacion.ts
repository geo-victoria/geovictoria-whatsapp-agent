/**
 * Tool: anualizar_cotizacion (Lalo 01-sep, tras la primera anualidad de
 * Quilacanta armada a mano).
 *
 * Convierte la cotización formal VIGENTE a modalidad de PAGO ANUAL:
 * TODO lo recurrente (plan + arriendos de hardware) se cobra por adelantado
 * en un solo pago de 12 meses, al MISMO precio (12 × la mensualidad — sin
 * premio ni castigo). Reglas de negocio dictadas por Lalo:
 *   1. Todo lo recurrente se anualiza (plan Y arriendos).
 *   2. SOLO si el cliente lo pide — jamás proactiva.
 *   3. Mismo precio; si el cliente objeta el monto, la respuesta es la
 *      ESCALERA normal de descuento (negociar ANTES de anualizar: el plan
 *      anual hereda el % comiteado y su vigencia en meses).
 *   4. Presentación: UNA sola fila "Plan anual" PRIMERA; las líneas
 *      recurrentes quedan en $0 y MARCADAS `oculto` para que ni el PDF ni
 *      la página de aceptación las pinten (los datos no se pierden: siguen
 *      en el subform para el downstream).
 *
 * Determinismo: los montos salen del SUBFORM REAL de la cotización en Zoho
 * (no se reconstruye la configuración — cero drift), y el descuento vigente
 * se lee de Descuento_Recurrente_Pct + su vigencia (Descuento_Meses o
 * vic_kv descuento_meses_<id>, default 6 meses; 0 = indefinido = 12).
 */

import { getUFActualSafe } from "./generar-link-cotizadora"

const COTIZADORA_API_BASE = (
  process.env.COTIZADORA_API_BASE || "https://cotizacion.geovictoria.com"
).trim()
const VICKY_COTIZADORA_SECRET = process.env.VICKY_COTIZADORA_SECRET || ""
const IVA_RATE = 0.19
const MESES_DCTO_DEFAULT = 6

export const anualizarCotizacionSchema = {
  name: "anualizar_cotizacion",
  description:
    "Convierte la cotización formal vigente a PAGO ANUAL: los 12 meses de todo lo recurrente (plan y arriendos) se cobran por adelantado en un solo pago, al mismo precio (12 × la mensualidad). Úsala SOLO cuando el cliente PIDE pagar anual ('¿puedo pagar el año de una vez?', 'la comunidad quiere pago anual') — JAMÁS la ofrezcas tú. Requiere que exista cotización formal (pasa el quote_id vigente de esta conversación). Si el cliente encuentra caro el monto anual o pide rebaja, NO inventes descuentos: negocia por la escalera normal (consultar/aplicar_siguiente_descuento) ANTES de anualizar — el plan anual hereda el descuento comiteado y su vigencia. La cotización queda con una sola línea 'Plan anual' (las mensualidades se muestran en $0 internamente, ocultas). Comunica al cliente copiando el mensajeParaProspecto. Para volver a modalidad mensual: actualizar_cotizacion con la configuración de siempre.",
  input_schema: {
    type: "object" as const,
    properties: {
      quote_id: {
        type: "string" as const,
        description: "ID de la cotización formal vigente (el quoteId que devolvió generar_link_cotizadora en esta conversación).",
        minLength: 1,
        maxLength: 80,
      },
    },
    required: ["quote_id"],
  },
}

export type AnualizarCotizacionInput = {
  quote_id: string
  /** Canal admin: regenerar sin correo al cliente (revisión previa de Lalo). */
  _sinCorreoCliente?: boolean
}

export type AnualizarCotizacionResultado =
  | {
      ok: true
      version: number
      acceptanceUrl: string
      anualNetoUF: number
      totalConIvaCLP: number
      mensajeParaProspecto: string
    }
  | { ok: false; error: string; cotizacionCerrada?: boolean }

type FilaSubform = {
  id?: string
  Codigo_Item?: string | null
  Nombre_Item?: string | null
  Modalidad?: string | null
  Cantidad?: number | null
  Precio_Unitario_UF?: number | null
  Subtotal_UF?: number | null
  Es_Recurrente?: boolean | null
  Descuento_Pct?: number | null
  Zona_Tarifa?: string | null
}

/** Inversa del mapModalidadToZoho del cotizador (misma tabla que usa
 * regenerate-pdf al reconstruir items desde el subform). */
function modalidadDesdeZoho(m: string): string {
  switch (m) {
    case "Recurrente":
    case "Por usuario":
      return "Por usuario"
    case "Único":
      return "Fijo"
    case "Arriendo":
      return "Arriendo mensual"
    case "Venta":
      return "Venta única"
    default:
      return "Cobro único"
  }
}

/** CÁLCULO PURO del plan anual (exportado para tests):
 * plan con descuento pct los primeros `meses` (cap 12) + plan pleno el resto;
 * arriendos siempre plenos ×12 (la escalera jamás descuenta arriendos). */
export function calcularAnualUF(planMensualUF: number, arriendoMensualUF: number, pct: number, meses: number): number {
  const m = Math.max(0, Math.min(12, meses))
  const factor = (m * (1 - pct / 100) + (12 - m))
  return Number((planMensualUF * factor + arriendoMensualUF * 12).toFixed(3))
}

export async function anualizarCotizacion(
  args: AnualizarCotizacionInput,
): Promise<AnualizarCotizacionResultado> {
  const quoteId = String(args?.quote_id || "").trim()
  if (!quoteId) return { ok: false, error: "Falta quote_id (usa el de la cotización vigente de esta conversación)." }

  // ── 1. Leer la cotización REAL desde Zoho ──
  let filas: FilaSubform[] = []
  let pct = 0
  let estado = ""
  let mesesVigencia = MESES_DCTO_DEFAULT
  try {
    const { getZohoAccessToken } = await import("@/lib/zoho-token")
    const token = await getZohoAccessToken()
    const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
    const r = await fetch(`${api}/crm/v3/Cotizaciones_GeoVictoria/${quoteId}`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      cache: "no-store",
    })
    if (r.status !== 200) return { ok: false, error: `No encontré la cotización ${quoteId} en el CRM.` }
    const q = ((await r.json().catch(() => ({}))) as {
      data?: Array<Record<string, unknown>>
    }).data?.[0]
    if (!q) return { ok: false, error: `No encontré la cotización ${quoteId} en el CRM.` }
    estado = String(q.Estado_Cotizacion || "")
    pct = Number(q.Descuento_Recurrente_Pct || 0)
    filas = (Array.isArray(q.Detalle_Items_Cotizacion) ? q.Detalle_Items_Cotizacion : []) as FilaSubform[]
    // Vigencia del descuento: campo del CRM si existe; si no, vic_kv del
    // puente descuento_meses; default 6. 0 = indefinido → cubre los 12.
    const campoMeses = (process.env.QUOTE_DISCOUNT_MESES_FIELD || "Descuento_Meses").trim()
    const mesesCrm = Number(q[campoMeses])
    let meses = Number.isFinite(mesesCrm) && mesesCrm >= 0 ? mesesCrm : NaN
    if (!Number.isFinite(meses)) {
      try {
        const { getKvValue } = await import("@/lib/supabase-persistence-v3")
        const kv = Number((await getKvValue(`descuento_meses_${quoteId}`).catch(() => null)) || NaN)
        if (Number.isFinite(kv) && kv >= 0) meses = kv
      } catch { /* default abajo */ }
    }
    if (!Number.isFinite(meses)) meses = MESES_DCTO_DEFAULT
    if (meses === 0) meses = 12
    mesesVigencia = meses
  } catch (e) {
    return { ok: false, error: `No pude leer la cotización: ${e instanceof Error ? e.message.slice(0, 150) : "error"}` }
  }

  if (/acept|pagad/i.test(estado)) {
    return {
      ok: false,
      cotizacionCerrada: true,
      error: "La cotización ya está aceptada/pagada y no se puede modificar. Genera una cotización NUEVA con generar_link_cotizadora y anualiza esa.",
    }
  }
  if (filas.length === 0) return { ok: false, error: "La cotización no tiene ítems en el CRM." }
  if (filas.some((f) => String(f.Codigo_Item || "") === "plan_anual")) {
    return { ok: false, error: "Esta cotización YA está en modalidad anual. Si el cliente quiere volver a mensual, usa actualizar_cotizacion con la configuración normal." }
  }

  // ── 2. Separar recurrentes (a anualizar) de los pagos únicos (intactos) ──
  const meses = mesesVigencia
  let planMensualUF = 0
  let arriendoMensualUF = 0
  let personas = 0
  for (const f of filas) {
    if (f.Es_Recurrente !== true) continue
    const sub = Number(f.Subtotal_UF || 0)
    if (String(f.Modalidad || "") === "Arriendo") arriendoMensualUF += sub
    else {
      planMensualUF += sub
      if (String(f.Codigo_Item || "") === "asistencia") personas = Number(f.Cantidad || 0)
    }
  }
  if (planMensualUF + arriendoMensualUF <= 0) {
    return { ok: false, error: "La cotización no tiene componentes recurrentes que anualizar." }
  }

  const anualUF = calcularAnualUF(planMensualUF, arriendoMensualUF, pct, meses)

  // ── 3. Rearmar items: plan anual PRIMERO, recurrentes ocultos en $0,
  //       pagos únicos tal cual estaban ──
  const detalleDcto = pct > 0 ? ` (incluye tu ${pct}% de descuento por ${meses === 12 ? "los 12 meses" : `${meses} meses`})` : ""
  const items: Array<Record<string, unknown>> = [
    {
      tipo: "servicio",
      id: "plan_anual",
      nombre: `Plan anual — 12 meses anticipados${personas > 0 ? ` (${personas} personas)` : ""}`,
      modalidad: "venta",
      cantidad: 1,
      precioUnitarioUF: anualUF,
      subtotalUF: anualUF,
      descripcion: `Los 12 meses del servicio pagados por adelantado${arriendoMensualUF > 0 ? " (plan y arriendo de equipos incluidos)" : ""}${detalleDcto}. Sin mensualidades durante la vigencia anual.`,
    },
  ]
  for (const f of filas) {
    const esRecurrente = f.Es_Recurrente === true
    const item: Record<string, unknown> = {
      tipo: String(f.Modalidad || "") === "Arriendo" || String(f.Modalidad || "") === "Venta" ? "hardware" : String(f.Codigo_Item || "").startsWith("instalacion") || String(f.Codigo_Item || "").startsWith("envio") ? "servicio" : "modulo",
      id: String(f.Codigo_Item || "item"),
      nombre: String(f.Nombre_Item || ""),
      modalidad: modalidadDesdeZoho(String(f.Modalidad || "")),
      cantidad: Number(f.Cantidad || 1),
      precioUnitarioUF: esRecurrente ? 0 : Number(f.Precio_Unitario_UF || 0),
      subtotalUF: esRecurrente ? 0 : Number(f.Subtotal_UF || 0),
    }
    if (esRecurrente) item.oculto = true
    if (Number(f.Descuento_Pct) > 0) item.descuentoPct = Number(f.Descuento_Pct)
    if (f.Zona_Tarifa) item.zonaTarifa = String(f.Zona_Tarifa).toLowerCase() === "rm" ? "rm" : "regiones"
    items.push(item)
  }

  const subtotalUF = items.reduce((s, i) => s + Number(i.subtotalUF || 0), 0)
  const totalUF = subtotalUF * (1 + IVA_RATE)
  const ufActual = await getUFActualSafe()
  const totalCLP = Math.round(totalUF * ufActual)

  // ── 4. Actualizar por el riel de siempre ──
  try {
    const response = await fetch(`${COTIZADORA_API_BASE}/api/quote-acceptance/actualizar-cotizacion`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(VICKY_COTIZADORA_SECRET ? { "x-vicky-secret": VICKY_COTIZADORA_SECRET } : {}),
      },
      body: JSON.stringify({
        quoteId,
        ...(args._sinCorreoCliente === true ? { sinCorreoCliente: true } : {}),
        resumenCambio: "Pago anual habilitado: 12 meses de todo lo recurrente anticipados en un solo pago",
        cotizacion: {
          items,
          ufActual: Number(ufActual.toFixed(2)),
          totalUF: Number(totalUF.toFixed(3)),
          totalCLP,
        },
      }),
      cache: "no-store",
    })
    const data = (await response.json().catch(() => ({}))) as {
      ok?: boolean
      version?: number
      acceptance_url?: string
      error?: string
      detail?: string
    }
    if (!response.ok || !data.ok) {
      const err = data.error || data.detail || `Cotizadora respondió ${response.status}`
      if (/COTIZACION_CERRADA/i.test(err)) {
        return { ok: false, cotizacionCerrada: true, error: "La cotización ya está aceptada y no se puede reabrir. Genera una nueva con generar_link_cotizadora y anualiza esa." }
      }
      return { ok: false, error: err }
    }
    const url = data.acceptance_url || ""
    const totalFmt = `$${totalCLP.toLocaleString("es-CL")}`
    return {
      ok: true,
      version: Number(data.version || 0),
      acceptanceUrl: url,
      anualNetoUF: anualUF,
      totalConIvaCLP: totalCLP,
      mensajeParaProspecto:
        `¡Listo! 🎉 Tu cotización quedó en modalidad de PAGO ANUAL: los 12 meses del servicio` +
        `${arriendoMensualUF > 0 ? " (plan y arriendo de equipos)" : ""} en un solo pago de ${totalFmt} IVA incluido` +
        `${detalleDcto}. Sin mensualidades durante el año.\n` +
        `${url ? `Aquí la revisas, aceptas y pagas: ${url}\n` : ""}` +
        `El PDF actualizado va en camino a tu correo.`,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `No se pudo contactar la cotizadora: ${msg.slice(0, 200)}` }
  }
}
