/**
 * Tool: actualizar_cotizacion
 *
 * El cliente pide un CAMBIO a su cotización formal ya emitida (dotación,
 * agregar/quitar reloj o módulos) y Vicky lo ejecuta sola — lo que antes se
 * derivaba a Anderson. Reglas de oro:
 *   - El LINK de aceptación NO cambia: la página lee los datos en vivo, así
 *     que Vicky le dice al cliente "en el mismo link ya está actualizada".
 *   - El PDF se regenera (v2, v3, ...) y se reenvía al correo en segundo plano.
 *   - Recibe la CONFIGURACIÓN COMPLETA nueva (no el delta): mismos args de
 *     construcción que generar_link_cotizadora, mismo builder de ítems
 *     (construirItemsCotizacion) — cero drift de precios.
 *   - Los descuentos comiteados sobreviven: viven como % en la cotización y
 *     el checkout los aplica en runtime sobre los ítems nuevos.
 *   - NUNCA para descuentos (eso va por la escalera) ni sobre cotizaciones
 *     Aceptadas (el endpoint lo rechaza con COTIZACION_CERRADA).
 */

import {
  construirItemsCotizacion,
  getUFActualSafe,
} from "./generar-link-cotizadora"

const COTIZADORA_API_BASE = (
  process.env.COTIZADORA_API_BASE || "https://cotizacion.geovictoria.com"
).trim()
const VICKY_COTIZADORA_SECRET = (process.env.VICKY_COTIZADORA_SECRET || "").trim()
const IVA_RATE = 0.19

export const actualizarCotizacionSchema = {
  name: "actualizar_cotizacion",
  description:
    "Actualiza una cotización FORMAL ya emitida cuando el cliente pide un cambio de configuración (cantidad de trabajadores, agregar/quitar relojes, módulos o puntos de instalación). Pasa la CONFIGURACIÓN COMPLETA nueva (no solo el cambio): userCount, modulos, hardware y puntosInstalacion finales. El link de aceptación NO cambia (dile al cliente que en el mismo link ya está actualizada) y el PDF nuevo se reenvía solo a su correo. ANTES de llamarla, repite el cambio al cliente y espera su confirmación. NO la uses para descuentos (usa la escalera de descuento) ni para crear cotizaciones nuevas (usa generar_link_cotizadora). Si la cotización ya está ACEPTADA y el cliente quiere cambios, NO derives a ejecutivo: genera una cotización NUEVA con generar_link_cotizadora reutilizando los datos que ya tienes (el sistema deja la aceptada anterior como perdida por detrás). Copia su campo mensajeParaProspecto TAL CUAL.",
  input_schema: {
    type: "object" as const,
    properties: {
      quote_id: {
        type: "string" as const,
        description: "ID de la cotización formal vigente (el quoteId del contexto/puntero de esta conversación).",
        minLength: 1,
        maxLength: 80,
      },
      userCount: {
        type: "integer" as const,
        description: "Cantidad FINAL de trabajadores tras el cambio.",
        minimum: 1,
        maximum: 50,
      },
      modulos: {
        type: "array" as const, items: { type: "string" as const },
        description: "IDs de módulos FINALES (catálogo). Siempre incluir 'asistencia'.",
        minItems: 1,
      },
      hardware: {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: {
            id: { type: "string" as const },
            cantidad: { type: "integer" as const, minimum: 1 },
            modalidad: { type: "string" as const, enum: ["arriendo", "venta"] },
          },
          required: ["id", "cantidad"],
        },
        description: "Hardware FINAL tras el cambio (ej. relojes). Omitir si queda sin hardware.",
      },
      puntosInstalacion: {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: {
            ubicacion: { type: "string" as const },
            autoInstalada: { type: "boolean" as const },
          },
          required: ["ubicacion"],
        },
        description: "Puntos de instalación FINALES de los relojes (comuna/ciudad por reloj).",
      },
      resumen_cambio: {
        type: "string" as const,
        description: "El cambio pedido en una frase corta, para auditoría y para el mensaje (ej. 'se agregó un segundo reloj en arriendo').",
        minLength: 3,
        maxLength: 200,
      },
    },
    required: ["quote_id", "userCount", "modulos", "resumen_cambio"],
  },
}

export type ActualizarCotizacionInput = {
  /** SOLO editor interno (flujo confirmar-una-vez): false = no generar
   * versión/PDF en esta edición; la confirmación versiona una sola vez. */
  _regenerarPdf?: boolean
  /** SOLO canal ejecutivo: "RM"/"Región" a secas vale como ubicación de un
   * punto (tarifa resto con advertencia). Vicky con clientes NO lo pasa. */
  _zonaGenericaOk?: boolean
  /** SOLO canal ejecutivo/admin: la regeneración NO envía el correo al
   * cliente (Lalo 11-ago). Vicky con clientes no lo pasa. */
  _sinCorreoCliente?: boolean
  quote_id: string
  userCount: number
  modulos: string[]
  hardware?: Array<{ id: string; cantidad: number; modalidad?: "arriendo" | "venta" }>
  puntosInstalacion?: Array<{ ubicacion: string; autoInstalada?: boolean }>
  resumen_cambio: string
  /** Valor CLP de 1 UF a usar para los totales, en vez de la UF del día.
   * SOLO lo pasa el editor interno de vendedores (Vicky Cotizaciones); el
   * schema que ve Vicky con clientes NO lo expone — el cliente no negocia
   * el valor de la UF. */
  ufValor?: number
  /** Líneas MANUALES fuera del catálogo/tarifa (ej. "instalación por 2 UF",
   * un cargo especial, un ajuste). SOLO las pasa el editor interno de
   * vendedores — el schema de Vicky con clientes no las expone. montoUF es
   * NETO unitario; recurrente true = mensual, false/omitido = pago único. */
  itemsExtra?: Array<{
    nombre: string
    montoUF: number
    cantidad?: number
    recurrente?: boolean
    /** true = arriendo mensual de hardware: recurrente PERO excluido del
     * descuento del plan (réplica COT453, 11-ago — un reloj a precio
     * dictado no debe recibir además el % del plan). */
    arriendo?: boolean
    codigo?: string
  }>
  /** Override del precio unitario UF de ítems del catálogo (ej. "sube el
   * arriendo del reloj a 0.43 UF"). SOLO lo pasa el editor interno de
   * vendedores. El subtotal del ítem pasa a ser precio × cantidad. */
  preciosOverride?: Array<{
    id: string
    precioUnitUF: number
    /** Filtro opcional cuando el mismo id aparece en más de una modalidad. */
    modalidad?: string
  }>
}

export type ActualizarCotizacionResultado =
  | {
      ok: true
      version: number
      acceptanceUrl: string
      totalUF: number
      totalCLP: number
      mensajeParaProspecto: string
    }
  | { ok: false; error: string; cotizacionCerrada?: boolean }

export async function actualizarCotizacion(
  args: ActualizarCotizacionInput,
): Promise<ActualizarCotizacionResultado> {
  const quoteId = (args?.quote_id || "").trim()
  if (!quoteId) return { ok: false, error: "Falta quote_id (usa el de la cotización vigente de esta conversación)." }

  // Mismo builder que generar_link: catálogo, precios y validaciones idénticos.
  const construccion = construirItemsCotizacion({
    userCount: args.userCount,
    modulos: args.modulos,
    hardware: args.hardware,
    zonaGenericaOk: args._zonaGenericaOk === true,
    puntosInstalacion: (args.puntosInstalacion || []).map((p) => ({
      ubicacion: p.ubicacion,
      autoInstalada: p.autoInstalada === true,
    })),
  })
  if (!construccion.ok) return { ok: false, error: construccion.error }
  // Líneas manuales del editor de vendedores: viajan como ítems de servicio
  // con el monto tal cual lo pidió el vendedor (la cotizadora las persiste y
  // las pinta en el PDF igual que cualquier línea). Modalidad → Es_Recurrente:
  // "venta" = pago único, "por usuario" = recurrente mensual.
  const extras = (args.itemsExtra || [])
    .filter((e) => e && typeof e.nombre === "string" && e.nombre.trim() && Number.isFinite(Number(e.montoUF)))
    .map((e) => {
      const cantidad = Math.max(1, Math.round(Number(e.cantidad) || 1))
      const unit = Number(Number(e.montoUF).toFixed(3))
      return {
        // arriendo=true → HARDWARE: cae al bucket de equipos del PDF
        // ("Pago mensual", descripcion de equipo) y no al de servicios.
        tipo: (e.arriendo === true ? "hardware" : "servicio") as "hardware" | "servicio",
        id: (String(e.codigo || "ajuste_manual").toLowerCase().replace(/[^a-z0-9_]+/g, "_").slice(0, 40)) || "ajuste_manual",
        nombre: e.nombre.trim().slice(0, 120),
        modalidad: e.arriendo === true ? "arriendo" : e.recurrente === true ? "por usuario" : "venta",
        cantidad,
        precioUnitarioUF: unit,
        subtotalUF: Number((unit * cantidad).toFixed(3)),
      }
    })
  const items = [...construccion.items, ...extras]

  // Overrides de precio del editor de vendedores: pisan el precio unitario
  // del catálogo para el ítem indicado y recomputan su subtotal.
  for (const ov of args.preciosOverride || []) {
    const unit = Number(ov?.precioUnitUF)
    if (!ov?.id || !Number.isFinite(unit) || unit < 0) continue
    const filtroMod = String(ov.modalidad || "").toLowerCase().trim()
    for (const it of items) {
      if (it.id !== ov.id) continue
      if (filtroMod && !String(it.modalidad || "").toLowerCase().includes(filtroMod)) continue
      it.precioUnitarioUF = Number(unit.toFixed(3))
      it.subtotalUF = Number((it.precioUnitarioUF * (it.cantidad || 1)).toFixed(3))
    }
  }

  const subtotalUF = items.reduce((s, i) => s + i.subtotalUF, 0)
  const totalUF = subtotalUF * (1 + IVA_RATE)
  const ufValorOverride = Number(args.ufValor)
  const ufActual =
    Number.isFinite(ufValorOverride) && ufValorOverride > 0
      ? ufValorOverride
      : await getUFActualSafe()
  const totalCLP = Math.round(totalUF * ufActual)

  try {
    const response = await fetch(
      `${COTIZADORA_API_BASE}/api/quote-acceptance/actualizar-cotizacion`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(VICKY_COTIZADORA_SECRET ? { "x-vicky-secret": VICKY_COTIZADORA_SECRET } : {}),
        },
        body: JSON.stringify({
          quoteId,
          resumenCambio: args.resumen_cambio,
          // Flujo confirmar-una-vez del editor interno (Lalo 07-ago): el
          // editor pasa _regenerarPdf:false en cada cambio y la versión/PDF
          // se generan UNA vez con la confirmación. Vicky con clientes no
          // manda el flag → regeneración por edición, como siempre.
          ...((args as { _regenerarPdf?: boolean })._regenerarPdf === false ? { regenerarPdf: false } : {}),
          ...((args as { _sinCorreoCliente?: boolean })._sinCorreoCliente === true ? { sinCorreoCliente: true } : {}),
          cotizacion: {
            items,
            ufActual: Number(ufActual.toFixed(2)),
            totalUF: Number(totalUF.toFixed(3)),
            totalCLP,
          },
        }),
        cache: "no-store",
      },
    )
    const data = (await response.json().catch(() => ({}))) as {
      ok?: boolean
      version?: number
      acceptance_url?: string
      mensaje_para_prospecto?: string
      error?: string
      detail?: string
    }
    if (!response.ok || !data.ok) {
      const err = data.error || data.detail || `Cotizadora respondió ${response.status}`
      if (/COTIZACION_CERRADA/i.test(err)) {
        return {
          ok: false,
          cotizacionCerrada: true,
          error:
            "La cotización ya está aceptada y no se puede reabrir. NO derives a ejecutivo: genera AHORA una cotización NUEVA con generar_link_cotizadora usando la configuración nueva y los datos que YA tienes (empresa, RUT, email — no los re-preguntes; pregunta solo lo que falte). El sistema dejará la aceptada anterior como perdida automáticamente.",
        }
      }
      return { ok: false, error: err }
    }
    return {
      ok: true,
      version: Number(data.version || 0),
      acceptanceUrl: data.acceptance_url || "",
      totalUF: Number(totalUF.toFixed(3)),
      totalCLP,
      mensajeParaProspecto: data.mensaje_para_prospecto || "",
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `No se pudo contactar la cotizadora: ${msg.slice(0, 200)}` }
  }
}
