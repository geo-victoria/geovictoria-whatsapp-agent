/**
 * Tool: consultar_descuento_referencial
 *
 * NEGOCIACIÓN EN EL PREFORM (read-only). Cuando el prospecto objeta el precio
 * en el preform (la primera vez que ve precios, ANTES de generar la cotización
 * formal), esta tool consulta al servidor qué descuento se puede ofrecer y
 * devuelve el PRECIO RECALCULADO para comunicarlo en la conversación. NO genera
 * ninguna cotización ni PDF.
 *
 * Flujo:
 *   1. El prospecto objeta el precio del preform → Vicky llama esta tool con los
 *      mismos parámetros de la cotización (userCount, modulos, hardware,
 *      puntosInstalacion) y escalonActual=0, y ofrece el descuento + precio
 *      copiando `mensajeParaProspecto`.
 *   2. Si insiste en más rebaja → Vicky vuelve a llamarla pasando el
 *      `escalonActual` que devolvió la consulta anterior (avanza un escalón).
 *   3. Cuando ACEPTA → Vicky llama generar_link_cotizadora pasando
 *      `escalonDescuento` = el `escalonActual` devuelto por la consulta aceptada.
 *      La cotización formal se genera UNA sola vez, ya con el descuento.
 *
 * SEGURIDAD (anti-alucinación): NO recibe porcentajes; el servidor decide el
 * escalón y calcula el precio. Vicky solo comunica el `mensajeParaProspecto`.
 */

import {
  construirItemsCotizacion,
  getUFActualSafe,
  type ConstruirItemsArgs,
} from "./generar-link-cotizadora"

const COTIZADORA_API_BASE =
  process.env.COTIZADORA_API_BASE || "https://cotizacion.geovictoria.com"
const VICKY_COTIZADORA_SECRET = process.env.VICKY_COTIZADORA_SECRET || ""
const SCOPE_MAX_USUARIOS = 50
const IVA_RATE = 0.19

type ItemConstruido = { subtotalUF: number }

/**
 * Crea o actualiza la cotización Borrador en Zoho con el escalón negociado
 * (sin PDF ni correo) llamando a create-from-vicky en modo `draft`. Best-effort:
 * si falta identidad o la cotizadora falla, devuelve null y la negociación sigue
 * normal (el escalón igual se persiste en Supabase desde el agent-loop).
 *
 * Reusa el Borrador en curso si el agent-loop inyectó sus IDs (_draft*), de modo
 * que toda la negociación de un cliente viva en UNA sola cotización Borrador.
 */
async function crearOActualizarBorrador(
  args: ConsultarDescuentoReferencialInput,
  items: ItemConstruido[],
  ufActual: number,
  escalonDescuento: number,
): Promise<DraftCotizacionIds | null> {
  const empresa = args.empresa?.trim()
  const contacto = args.contacto?.trim()
  const contactoEmail = args.contactoEmail?.trim()
  const rutEmpresa = args.rutEmpresa?.trim()
  // Sin identidad mínima no podemos registrar el Borrador en Zoho.
  if (!empresa || !contacto || !contactoEmail || !rutEmpresa) return null

  const subtotalUF = items.reduce((sum, i) => sum + Number(i.subtotalUF || 0), 0)
  const ivaUF = subtotalUF * IVA_RATE
  const totalUF = subtotalUF + ivaUF
  const totalCLP = ufActual > 0 ? Math.round(totalUF * ufActual) : 0

  // IDs existentes: preferimos los del Borrador en curso (inyectados por el
  // agent-loop); si no hay, usamos los que el modelo trajo de buscar_prospect.
  // Una vez que hay Borrador (account/deal), ya no pasamos leadId: el Lead, si
  // lo hubo, se convirtió al crear el Borrador.
  const accountId = args._draftAccountId || args.accountId?.trim() || undefined
  const contactId = args._draftContactId || args.contactId?.trim() || undefined
  const dealId = args._draftDealId || undefined
  const quoteId = args._draftQuoteId || undefined
  const yaHayBorrador = Boolean(quoteId || dealId || accountId)
  const leadId = yaHayBorrador ? undefined : args.leadId?.trim() || undefined

  try {
    const response = await fetch(
      `${COTIZADORA_API_BASE}/api/quote-acceptance/create-from-vicky`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(VICKY_COTIZADORA_SECRET ? { "x-vicky-secret": VICKY_COTIZADORA_SECRET } : {}),
        },
        body: JSON.stringify({
          draft: true,
          cliente: {
            empresa,
            contacto,
            contactoEmail: contactoEmail.toLowerCase(),
            contactoTelefono: args.contactoTelefono?.trim() || "",
            rutEmpresa,
            userCount: args.userCount,
            sectorEmpresa: args.sectorEmpresa?.trim() || "19. Servicios",
          },
          existing: { accountId, contactId, dealId, quoteId, leadId },
          escalonDescuento,
          cotizacion: {
            items,
            subtotalUF: Number(subtotalUF.toFixed(3)),
            ivaUF: Number(ivaUF.toFixed(3)),
            totalUF: Number(totalUF.toFixed(3)),
            ufActual: Number(ufActual.toFixed(2)),
            totalCLP,
          },
        }),
        cache: "no-store",
      },
    )
    if (!response.ok) {
      const errBody = await response.text().catch(() => "")
      console.warn(
        `[consultar_descuento_referencial] Borrador no creado (${response.status}): ${errBody.slice(0, 200)}`,
      )
      return null
    }
    const data = (await response.json()) as {
      ok?: boolean
      quoteId?: string
      dealId?: string
      accountId?: string
      contactId?: string
    }
    if (!data.ok || !data.quoteId) return null
    return {
      quoteId: data.quoteId,
      dealId: data.dealId || "",
      accountId: data.accountId || "",
      contactId: data.contactId || "",
    }
  } catch (err) {
    console.warn("[consultar_descuento_referencial] excepción creando Borrador:", err)
    return null
  }
}

export const consultarDescuentoReferencialSchema = {
  name: "consultar_descuento_referencial",
  description:
    "Negociación de descuento EN EL PREFORM, antes de generar la cotización formal. Úsala cuando el prospecto objeta el precio del preform o pide rebaja. Devuelve el siguiente descuento y el precio recalculado (pago inicial y mensual) para ofrecerlo EN LA CONVERSACIÓN. NO genera PDF ni envía correo. Pasá los MISMOS parámetros de la opción que el cliente eligió (userCount, modulos, hardware, puntosInstalacion) más `escalonActual` (0 la primera vez). Es 100% READ-ONLY: NO crea ni toca ningún registro en Zoho (ni Borrador). El escalón y la opción se trackean solo internamente; la cotización formal se crea UNA sola vez con generar_link_cotizadora al aceptar. NO recibe porcentaje: el servidor decide el escalón (plan mensual 10 → 20%; la instalación y el envío no tienen descuento). Copiá el `mensajeParaProspecto` TAL CUAL. Si el prospecto insiste en más rebaja, volvé a llamarla pasando el `escalonActual` que devolvió la consulta anterior. Cuando el prospecto ACEPTE, llamá generar_link_cotizadora con `escalonDescuento` = el `escalonActual` que devolvió la consulta aceptada (así la cotización nace con ese descuento). Si `topeAlcanzado=true`, es el último escalón posible.",
  input_schema: {
    type: "object" as const,
    properties: {
      userCount: {
        type: "number" as const,
        minimum: 1,
        maximum: SCOPE_MAX_USUARIOS,
        description: "Cantidad de trabajadores (1-50), igual que en el preform.",
      },
      modulos: {
        type: "array" as const,
        items: { type: "string" as const },
        description: "IDs de módulos confirmados. Siempre incluir 'asistencia'.",
        minItems: 1,
      },
      hardware: {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: {
            id: { type: "string" as const },
            cantidad: { type: "number" as const, minimum: 1 },
            modalidad: { type: "string" as const, enum: ["arriendo", "venta"] },
          },
          required: ["id"],
        },
      },
      puntosInstalacion: {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: {
            ubicacion: { type: "string" as const },
            autoInstalada: { type: "boolean" as const },
            modalidad: {
              type: "string" as const,
              enum: ["arriendo", "venta"],
              description:
                "Modalidad del reloj del punto. Si se omite se infiere del hardware; obligatorio por punto si la cotización mezcla arriendo y compra.",
            },
          },
          required: ["ubicacion", "autoInstalada"],
        },
        description: "Puntos de instalación (igual que el preform). Obligatorio si hay hardware. Envío e instalación se cobran por punto.",
      },
      escalonActual: {
        type: "number" as const,
        minimum: 0,
        description:
          "Cuántos escalones ya ofreciste en esta negociación. 0 la primera vez. En las siguientes, pasa el `escalonActual` que devolvió la consulta anterior. Cada llamada avanza UN solo escalón: el descuento se gana de tramo en tramo, no se salta al % que pida el cliente.",
      },
      // ── Identidad del preform (opcional) ──
      // Con estos datos la negociación crea/actualiza la cotización Borrador en
      // Zoho. Son los MISMOS que pasarás luego a generar_link_cotizadora.
      empresa: {
        type: "string" as const,
        description: "Razón social, igual que en el preform. Necesario para registrar el Borrador en Zoho.",
      },
      contacto: {
        type: "string" as const,
        description: "Nombre del contacto, igual que en el preform.",
      },
      contactoEmail: {
        type: "string" as const,
        format: "email",
        description: "Email del contacto, igual que en el preform.",
      },
      contactoTelefono: {
        type: "string" as const,
        description: "Teléfono con +código país.",
      },
      rutEmpresa: {
        type: "string" as const,
        description: "RUT empresa o persona natural, igual que en el preform.",
      },
      sectorEmpresa: {
        type: "string" as const,
        description: "Rubro/sector de la empresa (uno de los valores del preform). Si no es claro, '19. Servicios'.",
      },
      accountId: {
        type: "string" as const,
        description: "Opcional. No es necesario pasarlo: el backend deduplica por RUT. Déjalo vacío.",
      },
      contactId: {
        type: "string" as const,
        description: "ID del Contact existente en Zoho, si corresponde a la misma Account.",
      },
      leadId: {
        type: "string" as const,
        description: "ID de un Lead no convertido en Zoho. NO pasar junto con accountId/contactId.",
      },
    },
    required: ["userCount", "modulos"],
  },
}

export type ConsultarDescuentoReferencialInput = ConstruirItemsArgs & {
  escalonActual?: number
  // Identidad del preform (opcional): habilita crear/actualizar el Borrador.
  empresa?: string
  contacto?: string
  contactoEmail?: string
  contactoTelefono?: string
  rutEmpresa?: string
  sectorEmpresa?: string
  accountId?: string
  contactId?: string
  leadId?: string
  // IDs del Borrador en curso. Los inyecta el agent-loop desde la persistencia
  // por contacto (no los pasa el modelo) para reusar el MISMO Borrador entre
  // turnos en lugar de crear uno nuevo en cada actualización del escalón.
  _draftQuoteId?: string
  _draftDealId?: string
  _draftAccountId?: string
  _draftContactId?: string
}

// IDs del Borrador creado/actualizado en Zoho durante la negociación. El
// agent-loop los persiste por contacto para reusarlos en el siguiente turno y,
// al aceptar, en generar_link_cotizadora.
export type DraftCotizacionIds = {
  quoteId: string
  dealId: string
  accountId: string
  contactId: string
}

export type ConsultarDescuentoReferencialResultado =
  | {
      ok: true
      escalon: { tipo: string; pct: number; condicionDiscursiva: string | null }
      preview: { pagoInicialClp: number; mensualClp: number }
      escalonActual: number
      topeAlcanzado: boolean
      mensajeParaProspecto: string
      /** Configuración sobre la que se calculó (etiqueta determinista). */
      opcionCalculada?: string
      // Presente solo si se pudo registrar/actualizar el Borrador en Zoho.
      draft?: DraftCotizacionIds
    }
  | {
      ok: false
      error: string
      topeAlcanzado?: boolean
    }

export async function consultarDescuentoReferencial(
  args: ConsultarDescuentoReferencialInput,
): Promise<ConsultarDescuentoReferencialResultado> {
  // Armar los ítems con el MISMO builder que usa generar_link_cotizadora.
  let construccion = construirItemsCotizacion({
    userCount: args.userCount,
    modulos: args.modulos,
    hardware: args.hardware,
    puntosInstalacion: args.puntosInstalacion,
  })
  if (!construccion.ok) {
    // Fallback robusto: la causa típica es que el modelo no pasó
    // `puntosInstalacion` al negociar (con hardware, el builder exige los puntos).
    // En vez de devolver ok:false en silencio —lo que hacía que el modelo
    // reintentara en loop hasta el fallback— negociamos sobre el PLAN (módulos)
    // para no trabar la conversación. La cotización formal final SÍ exige los
    // puntos completos (generar_link_cotizadora no usa este fallback).
    console.warn(
      `[consultar_descuento_referencial] build falló (${construccion.error}); ` +
        `args={userCount:${args.userCount}, modulos:${JSON.stringify(args.modulos)}, ` +
        `hardware:${JSON.stringify(args.hardware)}, puntos:${JSON.stringify(args.puntosInstalacion)}}. ` +
        `Reintentando solo con módulos (negociación del plan).`,
    )
    construccion = construirItemsCotizacion({
      userCount: args.userCount,
      modulos: args.modulos,
    })
    if (!construccion.ok) {
      return {
        ok: false,
        error:
          `No pude armar los ítems para calcular el descuento (${construccion.error}). ` +
          "NO reintentes esta tool con los mismos datos: continúa ofreciendo avanzar con la cotización " +
          "formal o que un ejecutivo revise el precio. No menciones un error técnico al cliente.",
      }
    }
  }

  const ufActual = await getUFActualSafe()
  const escalonActual = Math.max(0, Number(args.escalonActual || 0))

  try {
    const response = await fetch(
      `${COTIZADORA_API_BASE}/api/quote-acceptance/consultar-descuento-referencial`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(VICKY_COTIZADORA_SECRET
            ? { "x-vicky-secret": VICKY_COTIZADORA_SECRET }
            : {}),
        },
        body: JSON.stringify({
          cotizacion: { items: construccion.items, ufActual },
          escalonActual,
        }),
        cache: "no-store",
      },
    )

    if (!response.ok) {
      const errBody = await response.text().catch(() => "")
      console.error(
        `[consultar_descuento_referencial] cotizadora respondió ${response.status}:`,
        errBody.slice(0, 200),
      )
      return {
        ok: false,
        error:
          `La cotizadora no pudo calcular el descuento ahora (HTTP ${response.status}). ` +
          "NO reintentes esta tool ni inventes un porcentaje. Sigue la conversación con naturalidad: " +
          "ofrece avanzar con la cotización formal al precio actual, o que un ejecutivo revise el precio. " +
          "No le hables al cliente de un error técnico.",
      }
    }

    const data = (await response.json()) as {
      ok?: boolean
      escalon?: { tipo?: string; pct?: number; condicion_discursiva?: string | null }
      preview?: { pago_inicial_clp?: number; mensual_clp?: number }
      escalon_actual?: number
      tope_alcanzado?: boolean
      mensaje_para_prospecto?: string
      error?: string
    }

    if (data.ok === false) {
      return {
        ok: false,
        error: data.error || "No se pudo consultar el descuento.",
        topeAlcanzado: Boolean(data.tope_alcanzado),
      }
    }

    if (
      !data.escalon ||
      typeof data.escalon.pct !== "number" ||
      typeof data.escalon.tipo !== "string" ||
      typeof data.mensaje_para_prospecto !== "string"
    ) {
      return {
        ok: false,
        error:
          "La cotizadora devolvió una respuesta incompleta. NO reintentes esta tool ni inventes un " +
          "porcentaje: ofrece avanzar con la cotización formal o que un ejecutivo revise el precio.",
      }
    }

    const escalonActualFinal = Number(data.escalon_actual || escalonActual + 1)

    // NOTA: la negociación es 100% read-only. NO se crea ni actualiza ningún
    // Borrador en Zoho durante la negociación (esa creación prematura, con
    // identidad placeholder antes de tener los datos reales, era la causa raíz
    // del bug "Pendiente"). El escalón y la opción se trackean solo en Supabase
    // (pref_escalon/pref_params), y la cotización formal se crea UNA sola vez
    // con generar_link_cotizadora al aceptar.

    // ETIQUETA DE LA OPCIÓN (31-ago, prueba de Rodrigo): el primer 10% se
    // calculó sobre la opción reloj+app cuando el cliente había elegido la de
    // solo app — y el mensaje no decía sobre QUÉ opción era, así que el error
    // quedó invisible hasta que el cliente reclamó. El mensaje ahora nombra
    // la configuración de forma DETERMINISTA desde los args reales: si el
    // modelo pasó la opción equivocada, se nota al tiro (y el modelo mismo
    // puede corregir antes de responder).
    const { getHardwareById } = await import("../catalogo")
    const partesOpcion = [
      `App móvil para ${args.userCount} personas`,
      ...(args.hardware || []).map((h) => {
        const nombre = getHardwareById(h.id)?.displayName || h.id
        const mod = (h.modalidad || "arriendo") === "venta" ? "en compra" : "en arriendo"
        return `${nombre} ${mod}${(h.cantidad || 1) > 1 ? ` ×${h.cantidad}` : ""}`
      }),
    ]
    const etiquetaOpcion = `(Este valor es para la opción: ${partesOpcion.join(" + ")}.)`

    return {
      ok: true,
      escalon: {
        tipo: data.escalon.tipo,
        pct: data.escalon.pct,
        condicionDiscursiva: data.escalon.condicion_discursiva ?? null,
      },
      preview: {
        pagoInicialClp: Number(data.preview?.pago_inicial_clp || 0),
        mensualClp: Number(data.preview?.mensual_clp || 0),
      },
      escalonActual: escalonActualFinal,
      topeAlcanzado: Boolean(data.tope_alcanzado),
      mensajeParaProspecto: `${data.mensaje_para_prospecto}\n${etiquetaOpcion}`,
      opcionCalculada: partesOpcion.join(" + "),
    }
  } catch (err) {
    console.error("[consultar_descuento_referencial] excepción:", err)
    return {
      ok: false,
      error:
        "No se pudo consultar el descuento en este momento. NO reintentes esta tool ni inventes un " +
        "porcentaje: sigue la conversación ofreciendo avanzar con la cotización formal al precio " +
        "actual, o que un ejecutivo revise el precio. No menciones un error técnico al cliente.",
    }
  }
}
