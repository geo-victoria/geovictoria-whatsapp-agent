/**
 * Solicitud de Facturación (módulo Zoho `Solicitud_Adm_y_Finanzas`) — armado
 * PURO del registro, igual en los cuatro países (24-sep, orden de Lalo: "que
 * nosotros creemos esos registros automáticamente… sin brecha con las que se
 * reciben correctamente tanto en administración y finanzas como en SST" y
 * "todo lo que hacemos hay que pensarlo globalmente").
 *
 * EL MOTIVO QUE LEVANTÓ ANDERSON (finanzas, 23-sep): "Faltan datos
 * tributarios: razón social, giro, dirección y comuna (no están en solicitud,
 * cuenta CRM ni NDV)". Finanzas mira TRES lugares. Este payload deja los datos
 * en el primero de dos formas a la vez: como CAMPOS (Rut_empresa, Giro,
 * Direcci_n, Comuna, Ciudad, Telefono_Contacto, Contacto_facturaci_n,
 * Correo_facturaci_n — obligatorios en los layouts de PE/CO/MX, opcionales en
 * Chile) y en la DESCRIPCIÓN con el bloque que el equipo chileno escribe a mano
 * (golden SF10268/SF10305, aceptadas a la primera). La cuenta CRM la completa
 * el módulo con red (lib/solicitud-facturacion).
 *
 * Sin imports: cargable por node --test.
 */

export type DatosSolicitudFacturacion = {
  pais: "cl" | "pe" | "co" | "mx"
  paisNombre: string
  layoutId: string
  nombrePlantilla: string
  area: string
  /** Razón social (la del padrón si existe; si no, lo que dijo el cliente). */
  empresa: string
  /** RUT / RUC / NIT / RFC con su formato canónico. */
  documento: string
  documentoEtiqueta: string
  giro?: string
  direccion?: string
  comuna?: string
  ciudad?: string
  telefono?: string
  contactoNombre?: string
  correo?: string
  cuentaId?: string
  referenciaNdvId?: string
  urlPdfNdv?: string
  /** YYYY-MM-DD del primer mes a facturar (mes del pago). */
  mesInicio: string
  solicitanteNombre: string
  solicitanteEmail: string
  plataforma?: string
  /** PE: segunda nota (hardware en USD) para nombrarla en la descripción. */
  notaHardware?: string
  /** Texto libre que se agrega al final de la descripción. */
  observacion?: string
}

export type FaltanteFacturacion = "giro" | "direccion" | "comuna" | "telefono" | "correo" | "contacto" | "documento" | "empresa"

const limpio = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim()

/**
 * Mes desde el que se factura (Victoria Luna / Nailliw 24-sep): del día 15 en
 * adelante Vicky "regala" el resto del mes y la facturación parte el mes
 * SIGUIENTE — las metas de telemarketing se proyectan por el mes del producto
 * facturado. Recibe la fecha de pago YA en la hora local del país (YYYY-MM-DD)
 * y devuelve YYYY-MM-DD: la misma fecha antes del 15, o el día 1 del mes
 * siguiente desde el 15.
 */
export const DIA_CORTE_FACTURACION = 15
export function mesInicioFacturacion(fechaPagoLocal: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(fechaPagoLocal || "")
  if (!m) return fechaPagoLocal
  const [a, mes, dia] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (dia < DIA_CORTE_FACTURACION) return `${m[1]}-${m[2]}-${m[3]}`
  const sigA = mes === 12 ? a + 1 : a
  const sigM = mes === 12 ? 1 : mes + 1
  return `${sigA}-${String(sigM).padStart(2, "0")}-01`
}

/** Nombre del mes en español para "Favor facturar Septiembre 2026". */
export function etiquetaMes(iso: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(iso || "")
  if (!m) return ""
  const meses = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"]
  return `${meses[Number(m[2]) - 1] || ""} ${m[1]}`.trim()
}

/**
 * Lo que finanzas rechaza si falta. La solicitud SE CREA igual con faltantes
 * (un registro con "por confirmar" es mejor que ninguno: el equipo lo ve y lo
 * completa), pero el llamador avisa y en PE/CO/MX el layout no acepta vacíos,
 * así que los obligatorios van con marcador explícito.
 */
export function faltantesFacturacion(d: DatosSolicitudFacturacion): FaltanteFacturacion[] {
  const out: FaltanteFacturacion[] = []
  if (!limpio(d.empresa)) out.push("empresa")
  if (!limpio(d.documento)) out.push("documento")
  if (!limpio(d.giro)) out.push("giro")
  if (!limpio(d.direccion)) out.push("direccion")
  if (!limpio(d.comuna)) out.push("comuna")
  if (!limpio(d.telefono)) out.push("telefono")
  if (!limpio(d.correo)) out.push("correo")
  if (!limpio(d.contactoNombre)) out.push("contacto")
  return out
}

/** Descripción con la forma exacta del golden chileno SF10268 (Nailliw). */
export function descripcionSolicitudFacturacion(d: DatosSolicitudFacturacion): string {
  const o = (v: unknown, alt = "por confirmar") => limpio(v) || alt
  const domicilio = [limpio(d.direccion), limpio(d.comuna), limpio(d.ciudad) && limpio(d.ciudad) !== limpio(d.comuna) ? limpio(d.ciudad) : ""]
    .filter(Boolean)
    .join(", ")
  const contacto = [limpio(d.contactoNombre), limpio(d.correo)].filter(Boolean).join(", ")
  const plataforma = limpio(d.plataforma) || "Geoavanzado"
  const lineas = [
    `Favor facturar ${etiquetaMes(d.mesInicio) || "el mes del pago"}, cliente con ${plataforma}`,
    "",
    `Nombre o Razón Social: ${o(d.empresa)}`,
    `${d.documentoEtiqueta} Contribuyente: ${o(d.documento)}`,
    `Giro: ${o(d.giro)}`,
    `Domicilio/Comuna: ${domicilio || "por confirmar"}`,
    `Teléfono de contacto: ${o(d.telefono)}`,
    `Nombre de contacto y correo: ${contacto || "por confirmar"}`,
  ]
  if (d.notaHardware) lineas.push("", `Nota de venta de hardware (USD, aparte): ${limpio(d.notaHardware)}`)
  if (limpio(d.observacion)) lineas.push("", limpio(d.observacion))
  lineas.push("", "Solicitud generada automáticamente por Vicky al confirmarse la nota de venta del alta por chat.")
  return lineas.join("\n")
}

/** Registro listo para `POST /crm/v3/Solicitud_Adm_y_Finanzas`. */
export function registroSolicitudFacturacion(d: DatosSolicitudFacturacion): Record<string, unknown> {
  const empresa = limpio(d.empresa).toUpperCase() || "EMPRESA"
  const obligatorio = (v: unknown) => limpio(v) || "por confirmar"
  const rec: Record<string, unknown> = {
    Name: d.nombrePlantilla.replace("{empresa}", empresa).slice(0, 255),
    Layout: { id: d.layoutId },
    Solicitud: "Facturación",
    nombre_por_colocar: "Nueva empresa",
    Pais: d.paisNombre,
    rea_solicitante: d.area,
    Nombre_solicitante_GV: limpio(d.solicitanteNombre).slice(0, 255),
    Correo_solicitante_gv1: limpio(d.solicitanteEmail).toLowerCase(),
    Mes_Inicio_Facturaci_n: d.mesInicio,
    Descripci_n: descripcionSolicitudFacturacion(d),
    // Los CAMPOS estructurados van SIEMPRE, en los cuatro países: en PE/CO/MX
    // son obligatorios del layout y en Chile son lo que una validación
    // automática puede leer (la Descripción es para la persona).
    Rut_empresa: obligatorio(d.documento),
    Giro: obligatorio(d.giro),
    Direcci_n: obligatorio(d.direccion),
    Comuna: obligatorio(d.comuna),
    Ciudad: limpio(d.ciudad) || obligatorio(d.comuna),
    Contacto_facturaci_n: obligatorio(d.contactoNombre),
    Nombre_empresa_en_platafora: empresa,
  }
  if (limpio(d.telefono)) rec.Telefono_Contacto = limpio(d.telefono)
  if (limpio(d.correo)) rec.Correo_facturaci_n = limpio(d.correo).toLowerCase()
  if (d.cuentaId) rec.Cuenta = { id: d.cuentaId }
  if (d.referenciaNdvId) rec.ID_NDV = { id: d.referenciaNdvId }
  if (limpio(d.urlPdfNdv)) rec.PDF_NDV = limpio(d.urlPdfNdv)
  return rec
}

/** Datos mínimos del bloque (subconjunto de DatosFacturacion; sin imports). */
export type DatosBloqueFacturacion = {
  razonSocial?: string
  documento?: string
  giro?: string
  direccion?: string
  comuna?: string
  ciudad?: string
  telefono?: string
  correo?: string
  contactoNombre?: string
}

/** El bloque en la forma que administración acepta (verificado en SF10187/10186/10183). */
export function bloqueDatosFacturacion(d: DatosBloqueFacturacion, etiquetaDocumento = "RUT"): { texto: string; faltantes: string[] } {
  const limpio = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim()
  const o = (v: unknown) => limpio(v) || "por confirmar"
  const faltantes: string[] = []
  for (const [k, nombre] of [
    ["razonSocial", "razón social"],
    ["documento", etiquetaDocumento],
    ["giro", "giro"],
    ["direccion", "dirección (calle y número)"],
    ["comuna", "comuna"],
    ["correo", "correo DTE"],
  ] as const) {
    if (!limpio(d[k])) faltantes.push(nombre)
  }
  const texto = [
    "DATOS DE FACTURACIÓN",
    "",
    `Razón social: ${o(d.razonSocial)}`,
    `${etiquetaDocumento}: ${o(d.documento)}`,
    `Giro: ${o(d.giro)}`,
    `Dirección: ${o(d.direccion)}`,
    `Comuna: ${o(d.comuna)}`,
    ...(limpio(d.ciudad) && limpio(d.ciudad).toLowerCase() !== limpio(d.comuna).toLowerCase() ? [`Ciudad: ${limpio(d.ciudad)}`] : []),
    `Correo DTE: ${o(d.correo)}`,
    `Teléfono: ${o(d.telefono)}`,
    ...(limpio(d.contactoNombre) ? [`Contacto: ${limpio(d.contactoNombre)}`] : []),
  ].join("\n")
  return { texto, faltantes }
}

