/**
 * Tool: generar_link_cotizadora
 *
 * Crea la cotización en Zoho a través de la cotizadora (endpoint create-from-vicky)
 * y devuelve tanto pdfUrl como acceptanceUrl.
 *
 * Acepta IDs opcionales (accountId, contactId, leadId) cuando Vicky ya identificó
 * al prospect via buscar_prospect_en_zoho. En ese caso, el endpoint reusa esos IDs
 * en lugar de crear duplicados. Si pasa leadId, el endpoint convierte el Lead a
 * Account+Contact+Deal usando los datos nuevos (datos nuevos ganan).
 *
 * Scope: 1-50 trabajadores.
 *
 * Instalación de hardware:
 *   Cuando la cotización incluye hardware, requiere el array `puntosInstalacion`.
 *   La lógica es idéntica a `cotizar_referencial` y los items resultantes se
 *   envían al endpoint create-from-vicky como líneas con tipo "servicio".
 */

import {
  getModuloDisponibleParaVicky,
  getHardwareDisponibleParaVicky,
  getServiciosAplicablesConHardware,
  obtenerPrecioServicio,
  obtenerTierAplicable,
  validarRangoModulo,
} from "@/lib/catalogo"
import { clasificarUbicacion } from "@/lib/geografia"
import { getUFActual } from "@/lib/uf"
import { rutValido, formatearRut } from "@/lib/rut"

const COTIZADORA_API_BASE =
  process.env.COTIZADORA_API_BASE || "https://cotizacion.geovictoria.com"
const VICKY_COTIZADORA_SECRET = process.env.VICKY_COTIZADORA_SECRET || ""
const SCOPE_MAX_USUARIOS = 50
const EJECUTIVO_DEFAULT = "Anderson Díaz"
const IVA_RATE = 0.19

// Sectores válidos (espejo del prompt y de la picklist de Zoho).
const SECTORES_VALIDOS = [
  "1. Agrícola",
  "2. Condominio",
  "3. Construcción",
  "4. Inmobilaria",
  "5. Consultoria",
  "6. Banca y Finanzas",
  "7. Educación",
  "8. Municipio",
  "9. Gobierno",
  "10. Mineria",
  "11. Naviera",
  "12. Outsourcing Seguridad",
  "12. Outsourcing General",
  "13. Outsourcing Retail",
  "14. Planta Productiva",
  "15. Logistica",
  "16. Retail Enterprise",
  "17. Retail SMB",
  "18. Salud",
  "19. Servicios",
  "20. Transporte",
  "21. Turismo, Hotelería y Gastronomía",
] as const

type SectorValido = typeof SECTORES_VALIDOS[number]

// Se mantiene el nombre por compatibilidad con quien la importa, pero ahora
// delega en la fuente única con caché (lib/uf.ts): mismo valor en todo el flujo.
export async function getUFActualSafe(): Promise<number> {
  return getUFActual()
}

export const generarLinkCotizadoraSchema = {
  name: "generar_link_cotizadora",
  description:
    "Crea la cotización formal en Zoho CRM, genera el PDF de propuesta y envía el correo al cliente. Devuelve dos enlaces: pdfUrl (el PDF descargable) y acceptanceUrl (la página web para aceptar). Úsala SOLO después de haber presentado el preform de confirmación y que el prospect haya confirmado explícitamente los datos. NO la uses antes de confirmar. Si la cotización incluye hardware, requiere el array 'puntosInstalacion' (uno por punto físico donde se instalará un reloj). Normalmente NO necesitas pasar IDs de Zoho: el backend deduplica por RUT — si la empresa ya existe asocia la cotización a su cuenta, y si no la crea. EXCEPCIÓN (conversaciones que iniciaste tú, con bloque '[Datos del formulario web: ... zohoLeadId ...]'): pasa `leadId` = ese zohoLeadId para que el lead original se CONVIERTA en cuenta+contacto+deal con la cotización asociada, sin duplicados.",
  input_schema: {
    type: "object" as const,
    properties: {
      empresa: { type: "string" as const, description: "Razón social", minLength: 1 },
      contacto: { type: "string" as const, description: "Nombre del contacto", minLength: 1 },
      contactoEmail: { type: "string" as const, description: "Email del contacto", format: "email" },
      contactoTelefono: { type: "string" as const, description: "Teléfono con +código país" },
      rutEmpresa: { type: "string" as const, description: "RUT empresa o persona natural" },
      direccionEmpresa: {
        type: "string" as const,
        description: "Dirección (calle y número) de la empresa, para emitir la cotización. Pregúntala al prospecto.",
      },
      comunaEmpresa: {
        type: "string" as const,
        description: "Comuna de la empresa, para emitir la cotización.",
      },
      regionEmpresa: {
        type: "string" as const,
        description: "Región de la empresa, para emitir la cotización.",
      },
      userCount: {
        type: "number" as const, minimum: 1, maximum: SCOPE_MAX_USUARIOS,
        description: "Cantidad de trabajadores (1-50)",
      },
      sectorEmpresa: {
        type: "string" as const,
        enum: SECTORES_VALIDOS as unknown as string[],
        description:
          "OPCIONAL — el rubro NO es requisito para cotizar y NO debe pedirse al prospecto. Dedúcelo del nombre SOLO si es obvio y debe ser exactamente uno de los valores del enum. Si no es claro, OMÍTELO: el sistema usa '19. Servicios' automáticamente.",
      },
      modulos: {
        type: "array" as const, items: { type: "string" as const },
        description: "IDs de módulos confirmados (deben estar en catálogo). Siempre incluir 'asistencia' como base.",
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
            ubicacion: {
              type: "string" as const,
              description:
                "Ubicación del punto, tal como la entregó el prospecto (comuna, región, ordinal, etc.). La tool clasifica internamente RM vs regiones.",
            },
            autoInstalada: {
              type: "boolean" as const,
              description:
                "true si el prospecto instalará por su cuenta (sin cobro de instalación, con advertencias; el envío se cobra igual). false si la realiza GeoVictoria.",
            },
            modalidad: {
              type: "string" as const,
              enum: ["arriendo", "venta"],
              description:
                "Modalidad del reloj de ESTE punto: 'arriendo' o 'venta' (compra). Determina la tarifa de envío e instalación del punto. Si toda la cotización es de una sola modalidad, puedes omitirlo (se infiere del hardware); si hay relojes en arriendo Y compra en distintos puntos, es OBLIGATORIO indicarlo por punto.",
            },
          },
          required: ["ubicacion", "autoInstalada"],
        },
        description:
          "Lista de puntos físicos de instalación. OBLIGATORIO si la cotización incluye hardware. Una entrada por punto, no por reloj. El envío y la instalación se cobran por punto.",
      },
      accountId: {
        type: "string" as const,
        description:
          "Opcional. No es necesario pasarlo: el backend deduplica por RUT (si la empresa ya existe, asocia la cotización a su cuenta). Déjalo vacío.",
      },
      contactId: {
        type: "string" as const,
        description:
          "ID del Contact existente en Zoho. Solo pasarlo si el Contact pertenece a la misma Account que estás usando (o si vas a reasignarlo). Si lo pasas, el endpoint NO crea Contact nuevo.",
      },
      leadId: {
        type: "string" as const,
        description:
          "ID de un Lead no convertido en Zoho. Si lo pasas, el endpoint convierte el Lead a Account+Contact+Deal usando los datos nuevos que enviaste (datos nuevos ganan). NO pasar simultáneamente con accountId/contactId.",
      },
      escalonDescuento: {
        type: "number" as const,
        minimum: 0,
        description:
          "Descuento negociado en el preform. Si el cliente ACEPTÓ un descuento durante la negociación (consultar_descuento_referencial), pasá el `escalon_actual` que devolvió la consulta que el cliente aceptó: la cotización se generará YA con ese descuento (un solo PDF, con el precio acordado). Si no hubo descuento, omití este campo.",
      },
    },
    required: ["empresa", "contacto", "contactoEmail", "rutEmpresa", "userCount", "modulos"],
  },
}

export type PuntoInstalacionInput = {
  ubicacion: string
  autoInstalada: boolean
  /** Modalidad del reloj del punto. Si se omite, se infiere del hardware. */
  modalidad?: "arriendo" | "venta"
}

export type LinkCotizadoraInput = {
  empresa: string
  contacto: string
  contactoEmail: string
  contactoTelefono?: string
  rutEmpresa: string
  direccionEmpresa?: string
  comunaEmpresa?: string
  regionEmpresa?: string
  userCount: number
  sectorEmpresa: SectorValido | string
  modulos: string[]
  hardware?: Array<{ id: string; cantidad?: number; modalidad?: "arriendo" | "venta" }>
  puntosInstalacion?: PuntoInstalacionInput[]
  accountId?: string
  contactId?: string
  leadId?: string
  escalonDescuento?: number
  // IDs del Borrador negociado en el preform. Los inyecta el agent-loop desde
  // la persistencia por contacto (no los pasa el modelo). Si vienen, el endpoint
  // reusa ese Borrador y lo finaliza (PDF + correo + "Enviada") en vez de crear
  // una cotización nueva.
  _draftQuoteId?: string
  _draftDealId?: string
  _draftAccountId?: string
  _draftContactId?: string
}

type ItemCotizacion = {
  tipo: "modulo" | "hardware" | "servicio"
  id: string
  nombre: string
  modalidad: string
  cantidad: number
  precioUnitarioUF: number
  subtotalUF: number
  tierAplicado?: string
  // Solo para tipo "servicio" de instalación: indica si la tarifa aplicada
  // corresponde a Región Metropolitana o regiones. La cotizadora lo persiste
  // y lo usa para decidir descuentos de instalación.
  zonaTarifa?: "RM" | "regiones"
}

export type LinkCotizadoraResultado =
  | {
      ok: true
      pdfUrl: string
      acceptanceUrl: string
      quoteId: string
      dealId: string
      accountId: string
      contactId: string
      ejecutivoAsignado: string
      totalUF: number
      totalCLP: number
      advertencias: string[]
      reuse: {
        accountReused: boolean
        contactReused: boolean
        leadConverted: boolean
      }
    }
  | { ok: false; error: string }

// Consolida líneas idénticas (mismo tipo, id, nombre, modalidad, precio
// unitario y zona) en una sola fila, sumando cantidad y subtotal. Evita que,
// por ejemplo, 4 instalaciones idénticas (mismo punto) aparezcan como 4 filas
// repetidas en la cotización y el PDF. No altera totales.
function consolidarLineasIguales(items: ItemCotizacion[]): ItemCotizacion[] {
  const porClave = new Map<string, ItemCotizacion>()
  const orden: string[] = []
  for (const it of items) {
    const clave = [
      it.tipo,
      it.id,
      it.nombre,
      it.modalidad,
      it.precioUnitarioUF,
      it.zonaTarifa ?? "",
    ].join("||")
    const existente = porClave.get(clave)
    if (existente) {
      existente.cantidad += it.cantidad
      existente.subtotalUF = Number((existente.subtotalUF + it.subtotalUF).toFixed(3))
    } else {
      porClave.set(clave, { ...it })
      orden.push(clave)
    }
  }
  return orden.map((c) => porClave.get(c) as ItemCotizacion)
}

export type ConstruirItemsArgs = {
  userCount: number
  modulos: string[]
  hardware?: Array<{ id: string; cantidad?: number; modalidad?: "arriendo" | "venta" }>
  puntosInstalacion?: PuntoInstalacionInput[]
}

export type ConstruirItemsResult =
  | { ok: true; items: ItemCotizacion[]; advertencias: string[] }
  | { ok: false; error: string }

// Arma las líneas de la cotización (módulos + hardware + instalaciones) a partir
// de los parámetros. Lo usan tanto generar_link_cotizadora (para crear la
// cotización formal) como consultar_descuento_referencial (para previsualizar el
// descuento en el preform), de modo que el preview y la cotización final tengan
// ítems idénticos. Aplica la consolidación de líneas repetidas.
export function construirItemsCotizacion(args: ConstruirItemsArgs): ConstruirItemsResult {
  const { userCount, modulos = [], hardware = [], puntosInstalacion = [] } = args

  const items: ItemCotizacion[] = []
  const advertencias: string[] = []

  const modulosConBase = modulos.includes("asistencia") ? modulos : ["asistencia", ...modulos]
  for (const moduloId of modulosConBase) {
    const modulo = getModuloDisponibleParaVicky(moduloId)
    if (!modulo) {
      return { ok: false, error: `Módulo '${moduloId}' no está habilitado para Vicky.` }
    }
    const rangoError = validarRangoModulo(modulo, userCount)
    if (rangoError) { advertencias.push(rangoError); continue }
    const tier = obtenerTierAplicable(modulo, userCount)
    if (!tier) continue
    const cantidad = tier.modalidad === "fijo" ? 1 : userCount
    const subtotalUF = tier.modalidad === "fijo" ? tier.precioUF : userCount * tier.precioUF
    items.push({
      tipo: "modulo", id: modulo.id, nombre: modulo.nombre,
      modalidad: tier.modalidad === "fijo" ? "Fijo" : "Por usuario",
      cantidad,
      precioUnitarioUF: tier.precioUF,
      subtotalUF: Number(subtotalUF.toFixed(3)),
      tierAplicado: `${tier.minUsuarios}-${tier.maxUsuarios} usuarios`,
    })
  }

  let hayHardware = false
  for (const hw of hardware) {
    const dispositivo = getHardwareDisponibleParaVicky(hw.id)
    if (!dispositivo) return { ok: false, error: `Hardware '${hw.id}' no está habilitado para Vicky.` }
    const cantidad = hw.cantidad ?? dispositivo.cantidadSugerida
    const modalidadElegida: "arriendo" | "venta" = hw.modalidad ?? "arriendo"
    if (!dispositivo.modalidadesDisponibles.includes(modalidadElegida)) {
      return { ok: false, error: `${dispositivo.displayName} no disponible en modalidad '${modalidadElegida}'` }
    }
    const precioUnitario = modalidadElegida === "arriendo" ? dispositivo.arriendoUF : dispositivo.ventaUF
    if (precioUnitario === 0) return { ok: false, error: `${dispositivo.displayName} sin precio en modalidad '${modalidadElegida}'` }
    items.push({
      tipo: "hardware", id: dispositivo.id, nombre: dispositivo.displayName,
      modalidad: modalidadElegida === "arriendo" ? "Arriendo mensual" : "Venta única",
      cantidad,
      precioUnitarioUF: precioUnitario,
      subtotalUF: Number((cantidad * precioUnitario).toFixed(3)),
    })
    hayHardware = true
  }

  if (hayHardware) {
    if (puntosInstalacion.length === 0) {
      return {
        ok: false,
        error:
          "La cotización incluye hardware pero no se entregó 'puntosInstalacion'. " +
          "Pregunta al prospecto la comuna o región de cada punto antes de generar el link.",
      }
    }

    for (const punto of puntosInstalacion) {
      const c = clasificarUbicacion(punto.ubicacion)
      if (c.tipo === "no_clasificable") {
        return {
          ok: false,
          error:
            `No pude clasificar la ubicación '${punto.ubicacion}' (${c.razon}). ` +
            `Pregúntale al prospecto la comuna o región específica y vuelve a llamar la tool.`,
        }
      }
    }

    // Modalidad uniforme del hardware (para inferir la modalidad de cada punto
    // cuando la cotización es de una sola modalidad). Si hay arriendo Y venta a
    // la vez, cada punto debe traer su `modalidad` explícita.
    const modalidadesHw = new Set(
      hardware.map((hw) => (hw.modalidad ?? "arriendo") as "arriendo" | "venta"),
    )
    const modalidadUniforme: "arriendo" | "venta" | null =
      modalidadesHw.size === 1 ? [...modalidadesHw][0] : null

    const serviciosAplicables = getServiciosAplicablesConHardware()
    for (const punto of puntosInstalacion) {
      const clasificacion = clasificarUbicacion(punto.ubicacion)
      if (clasificacion.tipo === "no_clasificable") continue

      if (!clasificacion.reconocida) {
        advertencias.push(
          `Ubicación '${punto.ubicacion}' no reconocida en la lista oficial. ` +
          `Se aplicó tarifa de regiones por defecto. El ejecutivo confirmará al revisar la cotización.`,
        )
      }

      const modalidadPunto = punto.modalidad ?? modalidadUniforme
      if (!modalidadPunto) {
        return {
          ok: false,
          error:
            "La cotización tiene relojes en arriendo Y en compra, así que necesito la modalidad de cada punto. " +
            "Vuelve a llamar la tool indicando `modalidad` ('arriendo' o 'venta') en cada entrada de puntosInstalacion.",
        }
      }

      const esRM = clasificacion.tipo === "RM"
      for (const servicio of serviciosAplicables) {
        // Instalación auto-gestionada por el cliente: no se cobra (solo el envío
        // se mantiene). Se comunican las advertencias.
        if (punto.autoInstalada && servicio.omitirSiAutoInstalada) {
          for (const adv of servicio.advertenciasAutoInstalacion) {
            advertencias.push(`Auto-instalación en ${punto.ubicacion}: ${adv}`)
          }
          continue
        }
        const precioUF = obtenerPrecioServicio(servicio, esRM, modalidadPunto)
        // Servicio sin cobro para esta combinación (p. ej. envío arriendo RM = 0):
        // no se agrega línea.
        if (precioUF <= 0) continue
        items.push({
          tipo: "servicio",
          id: servicio.id,
          nombre: `${servicio.nombre} (${punto.ubicacion})`,
          modalidad: "Cobro único",
          cantidad: 1,
          precioUnitarioUF: precioUF,
          subtotalUF: Number(precioUF.toFixed(3)),
          zonaTarifa: esRM ? "RM" : "regiones",
        })
      }
    }
  }

  if (items.length === 0) return { ok: false, error: "No hay items válidos para cotizar." }

  // Consolidar líneas idénticas (p. ej. instalaciones repetidas del mismo punto).
  const itemsFinal = consolidarLineasIguales(items)
  return { ok: true, items: itemsFinal, advertencias }
}

export async function generarLinkCotizadora(
  args: LinkCotizadoraInput,
): Promise<LinkCotizadoraResultado> {
  const {
    empresa, contacto, contactoEmail, contactoTelefono,
    rutEmpresa, direccionEmpresa, comunaEmpresa, regionEmpresa,
    userCount, sectorEmpresa, modulos = [], hardware = [],
    puntosInstalacion = [],
    accountId, contactId, leadId, escalonDescuento,
    _draftQuoteId, _draftDealId, _draftAccountId, _draftContactId,
  } = args

  if (!empresa?.trim() || !contacto?.trim() || !contactoEmail?.trim() || !rutEmpresa?.trim()) {
    return { ok: false, error: "Faltan campos obligatorios: empresa, contacto, contactoEmail, rutEmpresa." }
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactoEmail)) {
    return { ok: false, error: `El email '${contactoEmail}' no tiene formato válido.` }
  }
  // Validación del RUT/RUN chileno (módulo 11). Si no pasa, NO generamos la
  // cotización: el modelo debe pedirle al cliente que confirme el RUT correcto.
  if (!rutValido(rutEmpresa)) {
    return {
      ok: false,
      error:
        `El RUT '${rutEmpresa}' no es válido (no pasa el dígito verificador). ` +
        "Pídele al cliente que te confirme su RUT (empresa o persona natural) con el dígito verificador correcto, y NO generes la cotización hasta tener uno válido. No es un error técnico.",
    }
  }
  if (!Number.isFinite(userCount) || userCount < 1 || userCount > SCOPE_MAX_USUARIOS) {
    return { ok: false, error: `userCount=${userCount} fuera de rango 1-${SCOPE_MAX_USUARIOS}.` }
  }
  if (!Array.isArray(modulos) || modulos.length === 0) {
    return { ok: false, error: "modulos requerido (mínimo 1)" }
  }
  // IDs efectivos: si existe un Borrador negociado (inyectado por el agent-loop),
  // sus IDs mandan y se reusan para FINALIZAR esa misma cotización en vez de
  // crear una nueva. El Lead, si lo hubo, ya se convirtió al crear el Borrador,
  // así que ignoramos leadId cuando hay Borrador.
  const draftExists = Boolean(_draftQuoteId?.trim() || _draftDealId?.trim())
  const effAccountId = _draftAccountId?.trim() || accountId?.trim() || undefined
  const effContactId = _draftContactId?.trim() || contactId?.trim() || undefined
  const effDealId = _draftDealId?.trim() || undefined
  const effQuoteId = _draftQuoteId?.trim() || undefined
  const effLeadId = draftExists ? undefined : leadId?.trim() || undefined

  // Validación: leadId no puede venir con accountId/contactId (salvo que haya
  // Borrador, donde leadId se descarta arriba).
  if (effLeadId && (effAccountId || effContactId)) {
    return {
      ok: false,
      error: "No pasar leadId junto con accountId/contactId. El leadId convierte el Lead a Account+Contact+Deal; ya no hay IDs previos que reusar.",
    }
  }

  const sectorNormalizado: SectorValido =
    (SECTORES_VALIDOS as readonly string[]).includes(sectorEmpresa)
      ? (sectorEmpresa as SectorValido)
      : "19. Servicios"

  // ── Calcular items (mismo builder que usa la negociación referencial) ──
  const construccion = construirItemsCotizacion({ userCount, modulos, hardware, puntosInstalacion })
  if (!construccion.ok) return { ok: false, error: construccion.error }
  const itemsFinal = construccion.items
  const advertencias = construccion.advertencias

  const subtotalUF = itemsFinal.reduce((sum, i) => sum + i.subtotalUF, 0)
  const ivaUF = subtotalUF * IVA_RATE
  const totalUF = subtotalUF + ivaUF
  const ufActual = await getUFActualSafe()
  const totalCLP = Math.round(totalUF * ufActual)

  // Cuerpo de la request (constante entre reintentos).
  const reqBody = JSON.stringify({
    cliente: {
      empresa: empresa.trim(),
      contacto: contacto.trim(),
      contactoEmail: contactoEmail.trim().toLowerCase(),
      contactoTelefono: contactoTelefono?.trim() || "",
      rutEmpresa: formatearRut(rutEmpresa),
      direccionEmpresa: direccionEmpresa?.trim() || "",
      comunaEmpresa: comunaEmpresa?.trim() || "",
      regionEmpresa: regionEmpresa?.trim() || "",
      userCount,
      sectorEmpresa: sectorNormalizado,
    },
    // IDs existentes (opcionales): si se pasan, el endpoint reusa o convierte.
    // Cuando hay Borrador negociado, también van dealId/quoteId para que el
    // endpoint finalice esa misma cotización (no cree una nueva).
    existing: {
      accountId: effAccountId,
      contactId: effContactId,
      dealId: effDealId,
      quoteId: effQuoteId,
      leadId: effLeadId,
    },
    // Descuento negociado en el preform (si el cliente aceptó uno): la
    // cotización nace ya con ese descuento, sin regenerar PDF después.
    escalonDescuento:
      typeof escalonDescuento === "number" && escalonDescuento > 0
        ? escalonDescuento
        : undefined,
    cotizacion: {
      items: itemsFinal,
      subtotalUF: Number(subtotalUF.toFixed(3)),
      ivaUF: Number(ivaUF.toFixed(3)),
      totalUF: Number(totalUF.toFixed(3)),
      ufActual: Number(ufActual.toFixed(2)),
      totalCLP,
    },
  })

  type CreateFromVickyResp = {
    ok: boolean
    pdfUrl?: string
    acceptanceUrl?: string
    quoteId?: string
    dealId?: string
    accountId?: string
    contactId?: string
    reuse?: { accountReused?: boolean; contactReused?: boolean; leadConverted?: boolean }
    error?: string
    detail?: string
  }

  // Reintento interno (silencioso): el create-from-vicky puede fallar de forma
  // transitoria (latencia de Zoho) o por inconsistencias de dedup que se
  // resuelven al reintentar (el endpoint termina creando registros consistentes
  // en un 2º intento). Reintentamos hasta MAX_INTENTOS para que el cliente NUNCA
  // vea el "tuve un problema" por una falla pasajera. El acceptanceUrl es lo
  // crítico; el pdfUrl puede venir vacío (se genera en segundo plano).
  const MAX_INTENTOS = 3
  let data: CreateFromVickyResp | null = null
  let lastError = "Respuesta inválida de la cotizadora"
  for (let intento = 1; intento <= MAX_INTENTOS; intento++) {
    try {
      const response = await fetch(`${COTIZADORA_API_BASE}/api/quote-acceptance/create-from-vicky`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(VICKY_COTIZADORA_SECRET ? { "x-vicky-secret": VICKY_COTIZADORA_SECRET } : {}),
        },
        body: reqBody,
        cache: "no-store",
      })
      if (!response.ok) {
        const errBody = await response.text().catch(() => "")
        lastError = `Cotizadora respondió ${response.status}: ${errBody.slice(0, 200)}`
      } else {
        const parsed = (await response.json()) as CreateFromVickyResp
        if (parsed.ok && parsed.acceptanceUrl) {
          data = parsed
          break
        }
        lastError = parsed.error || parsed.detail || "Respuesta inválida de la cotizadora"
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      lastError = `No se pudo contactar la cotizadora: ${msg.slice(0, 200)}`
    }
    if (intento < MAX_INTENTOS) {
      console.warn(
        `[generar_link_cotizadora] intento ${intento}/${MAX_INTENTOS} falló (${lastError.slice(0, 140)}); reintentando...`,
      )
      await new Promise((r) => setTimeout(r, 1200 * intento))
    }
  }

  if (!data || !data.acceptanceUrl) {
    return { ok: false, error: lastError }
  }

  return {
    ok: true,
    pdfUrl: data.pdfUrl || "",
    acceptanceUrl: data.acceptanceUrl,
    quoteId: data.quoteId || "",
    dealId: data.dealId || "",
    accountId: data.accountId || "",
    contactId: data.contactId || "",
    ejecutivoAsignado: EJECUTIVO_DEFAULT,
    totalUF: Number(totalUF.toFixed(3)),
    totalCLP,
    advertencias,
    reuse: {
      accountReused: data.reuse?.accountReused || false,
      contactReused: data.reuse?.contactReused || false,
      leadConverted: data.reuse?.leadConverted || false,
    },
  }
}
