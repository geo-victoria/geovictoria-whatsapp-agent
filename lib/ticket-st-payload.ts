/**
 * Ticket de Servicio Técnico (módulo TicketsST) para una venta de Vicky —
 * parte PURA: tipos, forma del registro, descripción, faltantes y las filas
 * de la planilla de equipos. Calcado de los 39 tickets que Nailliw creó para
 * ventas de Vicky entre agosto y septiembre (los que SSTT acepta a la primera)
 * y de los motivos de rechazo medidos el 30-sep:
 *   - "Empresa y rut no están creados en plataforma GV" (6): altas por chat en
 *     GV Avanzado → el ticket lo dice explícito, con el ID de la empresa.
 *   - "Equipo en planilla no coincide con ítem NDV" (2): el modelo de la
 *     planilla sale del ÍTEM de la NDV (Equipos_Referencias_NV), nunca a mano.
 *   - "No se adjunta planilla" / "Adjuntar planilla correcta": la planilla va
 *     siempre, generada desde la NDV.
 * lib/ticket-st.ts le pone Zoho encima.
 */

export type CategoriaTicketST = "Envío" | "Instalación"

export type EquipoTicket = {
  /** Nombre EXACTO del ítem en la NDV (Books): "006.11 - Reloj Gama Media Facial WIFI/LAN". */
  nombre: string
  cantidad: number
  /** Precio del ítem en la NDV (UF). */
  precio: number
}

export type DatosTicketST = {
  pais: "cl"
  layoutId: string
  categoria: CategoriaTicketST
  /** Razón social de la cuenta (la que ST compara con la plataforma). */
  empresa: string
  rutEmpresa: string
  /** ID de la empresa en GV Avanzado (alta por chat), si se conoce. */
  companyId?: string
  cuentaId: string
  contactoId?: string
  contactoNombre: string
  contactoTelefono: string
  contactoCorreo: string
  ejecutivoId?: string
  ejecutivoNombre: string
  ejecutivoEmail: string
  solicitanteNombre: string
  solicitanteEmail: string
  referenciaNdvId?: string
  ndvNombre: string
  soNumero: string
  pdfNdv: string
  montoNvUF: number
  equipos: EquipoTicket[]
  /** Líneas de servicio de la NDV (envío/instalación), para la descripción. */
  servicios: string[]
  direccion: string
  comuna: string
  region: string
  relojPagado: boolean
  /** "Octubre 2026": mes desde el que finanzas provisiona el arriendo. */
  mesFacturacion: string
  cotizacionNumero: string
}

export type FaltanteTicket = "direccion" | "comuna" | "region" | "contactoTelefono" | "contactoCorreo" | "ndv" | "so" | "equipos" | "ejecutivo"

const limpio = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim()

/** Categoría según los ítems de la NDV: instalación técnica manda sobre envío. */
export function categoriaDesdeItems(nombresItems: string[]): CategoriaTicketST {
  const n = nombresItems.map((s) => limpio(s).toLowerCase())
  if (n.some((s) => /instalaci|visita t[eé]cnica/.test(s))) return "Instalación"
  return "Envío"
}

/** ¿Es un equipo que ST despacha o instala? (no un servicio ni un accesorio de plataforma). */
export function esEquipoDeCampo(nombreItem: string): boolean {
  const s = limpio(nombreItem).toLowerCase()
  if (/env[ií]o|despacho|instalaci|visita|homologaci|capacitaci|asistencia|plan\b|servicio/.test(s) && !/reloj|kit|impresora|tarjeta|senseface|gabinete/.test(s)) return false
  return /reloj|kit|impresora|tarjeta|senseface|totem|t[oó]tem|gabinete|lector|ups/.test(s)
}

export function cantidadDispositivos(equipos: EquipoTicket[]): number {
  // Los accesorios (tarjetas, gabinetes, UPS) no cuentan como dispositivo; el
  // ticket de Nailliw pone 1 por reloj. Sin reloj legible, la suma.
  const relojes = equipos.filter((e) => /reloj|kit|senseface|impresora|t[oó]tem|totem/i.test(e.nombre))
  const base = relojes.length ? relojes : equipos
  return Math.max(1, base.reduce((a, e) => a + (Number(e.cantidad) || 0), 0))
}

export function nombreTicketST(d: Pick<DatosTicketST, "categoria" | "empresa">): string {
  const emp = limpio(d.empresa) || "EMPRESA"
  return d.categoria === "Instalación" ? `INSTALACIÓN DE EQUIPO- GVA - ${emp}` : `ENVIO DE EQUIPO- GVA - ${emp}`
}

/** Texto exacto de Nailliw + la línea de GV Avanzado (motivo de rechazo nº 1). */
export function descripcionTicketST(d: DatosTicketST): string {
  const dir = [limpio(d.direccion) || "dirección por confirmar", limpio(d.comuna), limpio(d.region)].filter(Boolean).join("\t")
  const gva = `Empresa creada en plataforma GV Avanzado${d.companyId ? ` (ID ${d.companyId})` : ""} — alta por chat de Vicky, no está en la plataforma GV clásica.`
  const equipos = d.equipos.length ? `Equipos según NDV ${d.ndvNombre}: ${d.equipos.map((e) => `${e.cantidad} × ${e.nombre}`).join(" · ")}.` : ""
  const cuerpo =
    d.categoria === "Instalación"
      ? `Buen Día\n\nFavor su ayuda para Instalación de equipos GVA a la empresa ${limpio(d.empresa)} la siguiente dirección ${dir}\n\n${gva}\n${equipos}\nContacto en el lugar: ${limpio(d.contactoNombre) || "por confirmar"} · ${limpio(d.contactoTelefono) || "sin teléfono"} · ${limpio(d.contactoCorreo) || "sin correo"}\n\nGracias por su Gestión.`
      : `Favor su ayuda para Envío de equipos Geoavanzado a la empresa ${limpio(d.empresa)} a la dirección: ${dir}\n\n${gva}\n${equipos}\nRecibe: ${limpio(d.contactoNombre) || "por confirmar"} · ${limpio(d.contactoTelefono) || "sin teléfono"} · ${limpio(d.contactoCorreo) || "sin correo"}\n\nAdjunto documentos (planilla de equipos generada desde la NDV).\n\nGracias por su Gestión.`
  return `${cuerpo}\n\nTicket creado automáticamente por Vicky desde la venta ${d.cotizacionNumero || ""}.`.replace(/\n{3,}/g, "\n\n")
}

export function faltantesTicketST(d: DatosTicketST): FaltanteTicket[] {
  const f: FaltanteTicket[] = []
  if (!limpio(d.direccion)) f.push("direccion")
  if (!limpio(d.comuna)) f.push("comuna")
  if (!limpio(d.region)) f.push("region")
  if (!limpio(d.contactoTelefono)) f.push("contactoTelefono")
  if (!limpio(d.contactoCorreo)) f.push("contactoCorreo")
  if (!limpio(d.ndvNombre)) f.push("ndv")
  if (!limpio(d.soNumero)) f.push("so")
  if (!d.equipos.length) f.push("equipos")
  if (!limpio(d.ejecutivoEmail)) f.push("ejecutivo")
  return f
}

/** Registro para POST /crm/v3/TicketsST (layout ST CHILE), con la forma golden. */
export function registroTicketST(d: DatosTicketST): Record<string, unknown> {
  const r: Record<string, unknown> = {
    Layout: { id: d.layoutId },
    Name: nombreTicketST(d),
    Pick_List_1: d.categoria,
    Subcategor_a: "Asistencia y/o comedor",
    rea_solicitante: "Telemarketing",
    Nombre_solicitante: limpio(d.solicitanteNombre) || "Vicky GeoVictoria",
    Correo_solicitante: limpio(d.solicitanteEmail) || "vicky@geovictoria.com",
    Descripci_n: descripcionTicketST(d),
    Pa_s: "Chile",
    Cantidad_dispositivos: cantidadDispositivos(d.equipos),
    Direcci_n_env_o_visita: [limpio(d.direccion), limpio(d.comuna), limpio(d.region)].filter(Boolean).join("\t"),
    Reloj_ya_fue_pagado_Solo_Telemarketing: d.relojPagado ? "Sí" : "No",
    Contacto_adicional: limpio(d.contactoNombre) || undefined,
    N_mero_contacto_adicional: limpio(d.contactoTelefono) || undefined,
    Correo_contacto_adicional: limpio(d.contactoCorreo) || undefined,
    Observaciones_factura: d.mesFacturacion ? `Facturar arriendo de equipo desde ${d.mesFacturacion}.` : undefined,
  }
  if (d.cuentaId) r.Lookup_1 = { id: d.cuentaId }
  if (d.contactoId) r.Contacto = { id: d.contactoId }
  if (d.ejecutivoId) r.Ejecutivo_Comercial = { id: d.ejecutivoId }
  if (limpio(d.ejecutivoEmail)) r.Correo_ejecutivo_a = limpio(d.ejecutivoEmail)
  if (d.referenciaNdvId) r.ID_Nota_de_venta = { id: d.referenciaNdvId }
  if (limpio(d.soNumero)) r.ID_Sales_order = limpio(d.soNumero)
  if (limpio(d.pdfNdv)) r.PDF_NDV = limpio(d.pdfNdv)
  if (Number.isFinite(d.montoNvUF) && d.montoNvUF > 0) r.Monto_NV = Number(d.montoNvUF.toFixed(3))
  if (limpio(d.region)) r.Regi_n_inst_visita_env_o = [limpio(d.region)]
  r.Cliente_retira_reloj_en_GeoVictoria = d.categoria === "Instalación" ? "Instalación de equipo" : "Envío a dirección del cliente"
  if (d.categoria === "Instalación") r.Condiciones_de_Servicio = ["No aplica"]
  for (const k of Object.keys(r)) if (r[k] === undefined) delete r[k]
  return r
}

/** Columnas de la hoja "Equipos Asistencia WIFI-LAN" de la planilla oficial 2025 (SharePoint ST). */
export const COLUMNAS_PLANILLA_EQUIPOS = [
  "Empresa (Nombre fantasía)", "Rut Empresa", "Sucursal", "Cantidad Equipo/s", "Modelo Equipo", "Componentes adicionales",
  "Dirección", "Comuna", "Región", "Horario atención", "Nombre", "Teléfono", "Correo", "Grupo(s) Asociado(s) al Equipo",
  "Tipo de enchufe a punto eléctrico", "Protocolo De Comunicación", "Dirección IP Fija", "Máscara de sub-red", "Puerta de salida", "DNS",
] as const

/**
 * Filas de la planilla: cabecera de la plantilla oficial + una fila por
 * equipo de la NDV. Lo que el chat no pregunta va DECLARADO ("Por confirmar
 * en la capacitación"), nunca inventado.
 */
export function filasPlanillaEquipos(d: DatosTicketST): Array<Array<string | number | null>> {
  const filas: Array<Array<string | number | null>> = [
    ["Equipos Asistencia"],
    [],
    [null, null, null, null, "Versión 2025"],
    [],
    ["Contacto GeoVictoria", limpio(d.ejecutivoNombre) || "Vicky GeoVictoria", limpio(d.ejecutivoEmail) || "vicky@geovictoria.com", null, null, "Condiciones Instalación", null, null, "Si/No", "Detalle"],
    [null, null, null, null, null, "Requiere Permisos de Ingreso", null, null, "No", ""],
    [null, null, null, null, null, "Requiere Documentación Prevención de Riesgos", null, null, "No", ""],
    ["Requisitos mínimos para Instalación del equipo de asistencia", null, null, null, null, "Restricciones Eléctricas (corte energía)", null, null, "No", ""],
    ["1. El punto de red se debe encontrar a menos de 1,5 m del lugar donde se instalará el reloj control", null, null, null, null, "Restricciones Horarias", null, null, "No", ""],
    ["2. El punto de red debe presentarse con salida a internet por puerto 80", null, null, null, null, "Requiere EPP", null, null, "No", ""],
    ["3. El enchufe de corriente debe encontrarse a menos de 1,5 m del lugar donde se instalará el reloj control", null, null, null, null, "Otros documentos o formularios", null, null, "No", ""],
    [],
    ["DATOS PLATAFORMA GEOVICTORIA", null, "DETALLE EQUIPOS", null, null, null, "DATOS SUCURSAL", null, null, null, "CONTACTO SUCURSAL", null, null, "ASIGNACIÓN GRUPOS", "ESPECIFICACIONES TÉCNICAS DEL EQUIPO", null, "LLENAR INFORMACIÓN SOLO SI SE SELECCIONA IP FIJA"],
    [...COLUMNAS_PLANILLA_EQUIPOS],
  ]
  const porConfirmar = "Por confirmar en la capacitación"
  const sucursal = limpio(d.comuna) ? `Casa matriz (${limpio(d.comuna)})` : "Casa matriz"
  for (const e of d.equipos) {
    filas.push([
      limpio(d.empresa), limpio(d.rutEmpresa), sucursal, Number(e.cantidad) || 1, limpio(e.nombre), "No aplica",
      limpio(d.direccion), limpio(d.comuna), limpio(d.region), porConfirmar,
      limpio(d.contactoNombre), limpio(d.contactoTelefono), limpio(d.contactoCorreo), porConfirmar,
      "Enchufe normal", "WIFI", "", "", "", "",
    ])
  }
  return filas
}
