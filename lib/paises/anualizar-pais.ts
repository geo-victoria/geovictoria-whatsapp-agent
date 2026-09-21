/**
 * anualizar_cotizacion para PERÚ y COLOMBIA = la regla chilena (Lalo 21-sep:
 * "anualidad: sí ofrezcamos, igualemos a Chile"), sobre la MISMA tool
 * chilena de edición en sitio (actualizar_cotizacion con `_itemsPais`): el
 * cotizador reconoce el país por el token y reescribe la cotización con el
 * perfil del país. Acá solo se leen los montos REALES del subform (en la
 * moneda del país), se calcula el año y se arman los ítems:
 *   - "Plan anual — 12 meses anticipados" (y "Arriendo/Alquiler anual del
 *     equipo" aparte cuando hay equipo: en CO el equipo lleva IVA y el plan no).
 *   - Las filas recurrentes quedan en 0 y MARCADAS `oculto` (ni PDF ni
 *     aceptación las pintan; el downstream conserva la configuración).
 *   - La fila de Activación (CO siempre; PE legado) se retira: el año ya
 *     incluye el primer mes.
 *   - Los pagos únicos (equipo en venta, envío, instalación) quedan tal cual.
 * Determinista: nada se reconstruye desde el catálogo. Sin proactividad: la
 * tool existe para cuando el cliente la pide.
 */
import { calcularAnualPais, type FilaRecurrente } from "./anualizar-calculo.ts"

type Pais = "pe" | "co"

type FilaZoho = {
  Codigo_Item?: string | null
  Nombre_Item?: string | null
  Descripcion_Item?: string | null
  Modalidad?: string | null
  Cantidad?: number | null
  Precio_Unitario_UF?: number | null
  Subtotal_UF?: number | null
  Es_Recurrente?: boolean | null
  Afecto_IVA?: boolean | null
  Descuento_Pct?: number | null
  Metadata_Item_JSON?: string | null
}

const MESES_DCTO_DEFAULT = 6

function modalidadVicky(z: string): string {
  const m = String(z || "").toLowerCase()
  if (m === "arriendo") return "Arriendo mensual"
  if (m === "venta") return "Venta única"
  if (m === "único" || m === "unico") return "Fijo"
  return "Por usuario"
}

function esActivacion(f: FilaZoho): boolean {
  return /activaci/.test(String(f.Codigo_Item || "").toLowerCase()) || /activaci/.test(String(f.Nombre_Item || "").toLowerCase())
}

function fmt(pais: Pais, n: number): string {
  if (pais === "pe") {
    const r = Math.round(n * 100) / 100
    return "S/" + (Number.isInteger(r) ? r.toLocaleString("es-PE") : r.toFixed(2))
  }
  return "$" + Math.round(n).toLocaleString("es-CO") + " COP"
}

export async function anualizarCotizacionPais(
  contact: string,
  pais: Pais,
  quoteId?: string,
): Promise<{ ok: true; version: number; acceptanceUrl: string; mensajeParaProspecto: string; quoteId: string } | { ok: false; error: string; cotizacionCerrada?: boolean }> {
  let qid = String(quoteId || "").trim()
  if (!qid) {
    try {
      const { getQuotePointer } = await import("../supabase-persistence-v3.ts")
      qid = (await getQuotePointer(contact))?.quoteId || ""
    } catch {
      /* sin puntero */
    }
  }
  if (!qid) return { ok: false, error: "No hay una cotización formal vigente en esta conversación: emítela primero con generar_link_cotizadora." }

  // ── 1. Leer la cotización real ──
  let q: Record<string, unknown>
  try {
    const { fetchZoho } = await import("../zoho-token.ts")
    const api = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").trim()
    const mod = (process.env.ZOHO_QUOTE_MODULE || "Cotizaciones_GeoVictoria").trim()
    const res = await fetchZoho(`${api}/crm/v3/${mod}/${qid}`)
    if (res.status !== 200) return { ok: false, error: `No encontré la cotización ${qid} en el CRM.` }
    const data = (await res.json().catch(() => ({}))) as { data?: Array<Record<string, unknown>> }
    if (!data.data?.[0]) return { ok: false, error: `No encontré la cotización ${qid} en el CRM.` }
    q = data.data[0]
  } catch (e) {
    return { ok: false, error: `No pude leer la cotización: ${e instanceof Error ? e.message.slice(0, 150) : "error"}` }
  }
  const estado = String(q.Estado_Cotizacion || "")
  if (/acept|pagad/i.test(estado)) {
    return { ok: false, cotizacionCerrada: true, error: "La cotización ya está aceptada/pagada y no se puede modificar. Genera una cotización NUEVA con generar_link_cotizadora y anualiza esa." }
  }
  const filas = (Array.isArray(q.Detalle_Items_Cotizacion) ? q.Detalle_Items_Cotizacion : []) as FilaZoho[]
  if (!filas.length) return { ok: false, error: "La cotización no tiene ítems en el CRM." }
  if (filas.some((f) => String(f.Codigo_Item || "") === "plan_anual")) {
    return { ok: false, error: "Esta cotización YA está en modalidad anual. Si el cliente quiere volver a mensual, usa actualizar_cotizacion con la configuración normal." }
  }
  const pct = Number(q.Descuento_Recurrente_Pct || 0)
  const campoMeses = (process.env.QUOTE_DISCOUNT_MESES_FIELD || "Descuento_Meses").trim()
  let meses = Number(q[campoMeses])
  if (!Number.isFinite(meses) || meses < 0) {
    try {
      const { getKvValue } = await import("../supabase-persistence-v3.ts")
      const kv = Number((await getKvValue(`descuento_meses_${qid}`).catch(() => null)) || NaN)
      meses = Number.isFinite(kv) && kv >= 0 ? kv : MESES_DCTO_DEFAULT
    } catch {
      meses = MESES_DCTO_DEFAULT
    }
  }

  // ── 2. Calcular el año sobre las filas recurrentes (ocultas y Activación fuera) ──
  const recurrentes: FilaRecurrente[] = filas
    .filter((f) => f.Es_Recurrente === true && !esOculta(f))
    .map((f) => ({
      codigo: String(f.Codigo_Item || ""),
      nombre: String(f.Nombre_Item || ""),
      subtotal: Number(f.Subtotal_UF || 0),
      modalidad: String(f.Modalidad || ""),
      esRecurrente: true,
    }))
  const dec: 0 | 2 = pais === "pe" ? 2 : 0
  const a = calcularAnualPais(recurrentes, pct, meses, dec)
  if (a.planAnual + a.arriendoAnual <= 0) return { ok: false, error: "La cotización no tiene componentes recurrentes que anualizar." }

  // Dotación para el nombre (solo si el plan viaja por usuario).
  const filaPlan = filas.find((f) => f.Es_Recurrente === true && String(f.Codigo_Item || "").toLowerCase().startsWith("plan"))
  const personas = filaPlan && String(filaPlan.Modalidad || "") === "Recurrente" ? Number(filaPlan.Cantidad || 0) : 0

  // ── 3. Ítems en la forma del país ──
  const pu = pais === "pe" ? "precioUnitarioPEN" : "precioUnitarioCOP"
  const st = pais === "pe" ? "subtotalPEN" : "subtotalCOP"
  const afecto = pais === "pe" ? "afectoIgv" : "afectoIva"
  const equipo = pais === "co" ? "alquiler del equipo biométrico" : "arriendo del reloj"
  const detalleDcto = a.pct > 0 ? ` (incluye tu ${a.pct}% de descuento por ${a.meses === 12 ? "los 12 meses" : `${a.meses} meses`})` : ""
  const items: Array<Record<string, unknown>> = []
  if (a.planAnual > 0) {
    items.push({
      tipo: "servicio",
      id: "plan_anual",
      nombre: `Plan anual — 12 meses anticipados${personas > 0 ? ` (${personas} personas)` : ""}`,
      descripcion: `Los 12 meses del plan pagados por adelantado${detalleDcto}. Sin mensualidades del plan durante el año.`,
      modalidad: "Cobro único",
      cantidad: 1,
      [pu]: a.planAnual,
      [st]: a.planAnual,
      esRecurrente: false,
      // PE: todo afecto a IGV. CO: el plan es precio final (sin IVA).
      [afecto]: pais === "pe",
    })
  }
  if (a.arriendoAnual > 0) {
    items.push({
      tipo: "hardware",
      id: "arriendo_anual",
      nombre: `${pais === "co" ? "Alquiler" : "Arriendo"} anual del equipo — 12 meses anticipados`,
      descripcion: `Los 12 meses del ${equipo} pagados por adelantado, al mismo valor mensual.`,
      modalidad: "Cobro único",
      cantidad: 1,
      [pu]: a.arriendoAnual,
      [st]: a.arriendoAnual,
      esRecurrente: false,
      // El equipo lleva impuesto en los dos países.
      [afecto]: true,
    })
  }
  for (const f of filas) {
    if (esActivacion(f)) continue // el año ya incluye el primer mes
    const esRec = f.Es_Recurrente === true
    const item: Record<string, unknown> = {
      tipo: /arriendo|venta/i.test(String(f.Modalidad || "")) ? "hardware" : esRec ? "plan" : "servicio",
      id: String(f.Codigo_Item || "item"),
      nombre: String(f.Nombre_Item || ""),
      descripcion: String(f.Descripcion_Item || ""),
      modalidad: modalidadVicky(String(f.Modalidad || "")),
      cantidad: Number(f.Cantidad || 1),
      [pu]: esRec ? 0 : Number(f.Precio_Unitario_UF || 0),
      [st]: esRec ? 0 : Number(f.Subtotal_UF || 0),
      esRecurrente: esRec,
      [afecto]: f.Afecto_IVA === true,
    }
    if (esRec) item.oculto = true
    if (Number(f.Descuento_Pct) > 0) item.descuentoPct = Number(f.Descuento_Pct)
    items.push(item)
  }

  // ── 4. La MISMA tool chilena de edición en sitio ──
  const { actualizarCotizacion } = await import("../tools/actualizar-cotizacion.ts")
  const r = await actualizarCotizacion({
    quote_id: qid,
    userCount: personas || 1,
    modulos: ["asistencia"],
    resumen_cambio: "Pago anual habilitado: 12 meses de todo lo recurrente anticipados en un solo pago",
    _itemsPais: { pais, items },
  })
  if (!r.ok) {
    const err = String((r as { error?: string }).error || "")
    if (/COTIZACION_CERRADA/i.test(err)) return { ok: false, cotizacionCerrada: true, error: "La cotización ya está aceptada y no se puede reabrir. Genera una nueva y anualiza esa." }
    return { ok: false, error: err || "No se pudo anualizar la cotización." }
  }
  const total = a.planAnual + a.arriendoAnual
  const imp = pais === "pe" ? " + IGV" : a.arriendoAnual > 0 ? " (el equipo lleva IVA, ya indicado en la cotización)" : ""
  const url = String((r as { acceptanceUrl?: string }).acceptanceUrl || "")
  return {
    ok: true,
    quoteId: qid,
    version: Number((r as { version?: number }).version || 0),
    acceptanceUrl: url,
    mensajeParaProspecto:
      `Listo! 🎉 Tu cotización quedó en modalidad de PAGO ANUAL: los 12 meses del servicio` +
      `${a.arriendoAnual > 0 ? ` (plan y ${equipo})` : ""} en un solo pago de ${fmt(pais, total)}${imp}${detalleDcto}. Sin mensualidades durante el año.\n` +
      `${url ? `Aquí la revisas, aceptas y pagas: ${url}\n` : ""}` +
      `El PDF actualizado va en camino a tu correo.`,
  }
}

function esOculta(f: FilaZoho): boolean {
  try {
    return JSON.parse(String(f.Metadata_Item_JSON || "null"))?.oculto === true
  } catch {
    return false
  }
}
