import test from "node:test"
import assert from "node:assert/strict"
import {
  categoriaDesdeItems,
  esEquipoDeCampo,
  cantidadDispositivos,
  nombreTicketST,
  descripcionTicketST,
  registroTicketST,
  faltantesTicketST,
  filasPlanillaEquipos,
  COLUMNAS_PLANILLA_EQUIPOS,
  type DatosTicketST,
} from "../lib/ticket-st-payload.ts"
import { regionDeUbicacion, regionDesdePadron } from "../lib/regiones-cl.ts"

// Caso real: TKT-123078 (Central de parabrisas, envío, Coquimbo) + NDV-32532.
const BASE: DatosTicketST = {
  pais: "cl",
  layoutId: "3525045000282855283",
  categoria: "Envío",
  empresa: "Central de parabrisas",
  rutEmpresa: "7175917-2",
  companyId: "133",
  cuentaId: "3525045000663698268",
  contactoId: "3525045000663698270",
  contactoNombre: "Ignacio Rojas",
  contactoTelefono: "+56952531741",
  contactoCorreo: "Ignacio.rojas@centraldeparabrisas.cl",
  ejecutivoId: "3525045000426432190",
  ejecutivoNombre: "Anderson Diaz",
  ejecutivoEmail: "adiazg@geovictoria.com",
  solicitanteNombre: "Anderson Diaz",
  solicitanteEmail: "adiazg@geovictoria.com",
  referenciaNdvId: "3525045000666843323",
  ndvNombre: "NDV-32532",
  soNumero: "SO-28795",
  pdfNdv: "https://gvfacturacionadm.blob.core.windows.net/quotation-pdf/NDV-32532.pdf",
  montoNvUF: 0.3,
  equipos: [{ nombre: "006.11 - Reloj Gama Media Facial WIFI/LAN", cantidad: 1, precio: 8 }],
  servicios: ["907 - [CHI] Envío/Despacho Asistencia"],
  direccion: "Avenida alessandri 861 el llano",
  comuna: "Coquimbo",
  region: "Coquimbo",
  relojPagado: false,
  mesFacturacion: "Octubre 2026",
  cotizacionNumero: "COT1512",
}

test("categoría: instalación manda sobre envío; solo envío → Envío", () => {
  assert.equal(categoriaDesdeItems(["006.11 - Reloj Gama Media Facial WIFI/LAN", "907 - [CHI] Envío/Despacho Asistencia"]), "Envío")
  assert.equal(categoriaDesdeItems(["006.11 - Reloj Gama Media Facial WIFI/LAN", "902 - [CHI] Instalación Asistencia RM", "907 - [CHI] Envío/Despacho Asistencia"]), "Instalación")
  assert.equal(categoriaDesdeItems(["006.11 - Reloj Gama Media Facial WIFI/LAN"]), "Envío")
})

test("equipo de campo: relojes y kits sí; envío, instalación y asistencia no", () => {
  assert.equal(esEquipoDeCampo("006.11 - Reloj Gama Media Facial WIFI/LAN"), true)
  assert.equal(esEquipoDeCampo("006.9 - Reloj Gama Estándar Facial WIFI/LAN"), true)
  assert.equal(esEquipoDeCampo("026.1 - Tarjeta ID (delgada)"), true)
  assert.equal(esEquipoDeCampo("907 - [CHI] Envío/Despacho Asistencia"), false)
  assert.equal(esEquipoDeCampo("902 - [CHI] Instalación Asistencia RM"), false)
  assert.equal(esEquipoDeCampo("Control de Asistencia"), false)
  assert.equal(cantidadDispositivos([{ nombre: "006.11 - Reloj Gama Media Facial WIFI/LAN", cantidad: 2, precio: 8 }, { nombre: "026.1 - Tarjeta ID (delgada)", cantidad: 20, precio: 0.03 }]), 2)
})

test("nombre y descripción con la forma de Nailliw + la línea de GV Avanzado", () => {
  assert.equal(nombreTicketST(BASE), "ENVIO DE EQUIPO- GVA - Central de parabrisas")
  assert.equal(nombreTicketST({ ...BASE, categoria: "Instalación" }), "INSTALACIÓN DE EQUIPO- GVA - Central de parabrisas")
  const d = descripcionTicketST(BASE)
  assert.match(d, /Favor su ayuda para Envío de equipos Geoavanzado a la empresa Central de parabrisas a la dirección: Avenida alessandri 861 el llano\tCoquimbo\tCoquimbo/)
  assert.match(d, /GV Avanzado \(ID 133\)/)
  assert.match(d, /1 × 006\.11 - Reloj Gama Media Facial WIFI\/LAN/)
  assert.match(d, /Gracias por su Gestión\./)
  assert.match(descripcionTicketST({ ...BASE, categoria: "Instalación" }), /^Buen Día\n\nFavor su ayuda para Instalación de equipos GVA/)
})

test("registro golden: layout, picklists, lookups, NDV/SO/PDF/monto, región, método, observación de factura", () => {
  const r = registroTicketST(BASE)
  assert.deepEqual(r.Layout, { id: "3525045000282855283" })
  assert.equal(r.Pick_List_1, "Envío")
  assert.equal(r.Subcategor_a, "Asistencia y/o comedor")
  assert.equal(r.rea_solicitante, "Telemarketing")
  assert.equal(r.Pa_s, "Chile")
  assert.deepEqual(r.Lookup_1, { id: "3525045000663698268" })
  assert.deepEqual(r.Contacto, { id: "3525045000663698270" })
  assert.deepEqual(r.Ejecutivo_Comercial, { id: "3525045000426432190" })
  assert.equal(r.Correo_ejecutivo_a, "adiazg@geovictoria.com")
  assert.deepEqual(r.ID_Nota_de_venta, { id: "3525045000666843323" })
  assert.equal(r.ID_Sales_order, "SO-28795")
  assert.equal(r.Monto_NV, 0.3)
  assert.equal(r.Cantidad_dispositivos, 1)
  assert.deepEqual(r.Regi_n_inst_visita_env_o, ["Coquimbo"])
  assert.equal(r.Cliente_retira_reloj_en_GeoVictoria, "Envío a dirección del cliente")
  assert.equal(r.Reloj_ya_fue_pagado_Solo_Telemarketing, "No")
  assert.equal(r.Observaciones_factura, "Facturar arriendo de equipo desde Octubre 2026.")
  assert.equal(r.Contacto_adicional, "Ignacio Rojas")
  assert.equal(r.N_mero_contacto_adicional, "+56952531741")
  assert.equal("Condiciones_de_Servicio" in r, false)
  const i = registroTicketST({ ...BASE, categoria: "Instalación", relojPagado: true })
  assert.equal(i.Cliente_retira_reloj_en_GeoVictoria, "Instalación de equipo")
  assert.deepEqual(i.Condiciones_de_Servicio, ["No aplica"])
  assert.equal(i.Reloj_ya_fue_pagado_Solo_Telemarketing, "Sí")
})

test("faltantes nombran lo que ST rechaza; sin faltantes en el golden", () => {
  assert.deepEqual(faltantesTicketST(BASE), [])
  assert.deepEqual(faltantesTicketST({ ...BASE, direccion: "", region: "", soNumero: "" }), ["direccion", "region", "so"])
})

test("planilla: cabecera de la plantilla 2025 y una fila por equipo con el nombre EXACTO de la NDV", () => {
  const filas = filasPlanillaEquipos({ ...BASE, equipos: [...BASE.equipos, { nombre: "026.1 - Tarjeta ID (delgada)", cantidad: 20, precio: 0.03 }] })
  const cab = filas.findIndex((f) => f[0] === COLUMNAS_PLANILLA_EQUIPOS[0])
  assert.ok(cab > 0)
  assert.equal(filas[cab].length, 20)
  const datos = filas.slice(cab + 1)
  assert.equal(datos.length, 2)
  assert.equal(datos[0][0], "Central de parabrisas")
  assert.equal(datos[0][1], "7175917-2")
  assert.equal(datos[0][4], "006.11 - Reloj Gama Media Facial WIFI/LAN")
  assert.equal(datos[0][7], "Coquimbo")
  assert.equal(datos[0][9], "Por confirmar en la capacitación")
  assert.equal(datos[0][15], "WIFI")
})

test("regiones del picklist ST desde comuna, ciudad, región o padrón", () => {
  assert.equal(regionDeUbicacion("Coquimbo"), "Coquimbo")
  assert.equal(regionDeUbicacion("La Pintana"), "Metropolitana")
  assert.equal(regionDeUbicacion("Punta Arenas"), "Magallanes")
  assert.equal(regionDeUbicacion("Chillán Viejo"), "Ñuble")
  assert.equal(regionDeUbicacion("San Fernando"), "O'Higgins")
  assert.equal(regionDeUbicacion("Copiapó"), "Atacama")
  assert.equal(regionDeUbicacion("Temuco"), "Araucanía")
  assert.equal(regionDeUbicacion("Río Ibáñez"), "Aysén")
  assert.equal(regionDeUbicacion("Providencia, Región Metropolitana"), "Metropolitana")
  assert.equal(regionDeUbicacion("Iquique"), "Tarapacá")
  assert.equal(regionDeUbicacion("Villa Alemana, V región"), "Valparaíso")
  assert.equal(regionDeUbicacion(""), "")
  assert.equal(regionDesdePadron("REGION METROPOLITANA DE SANTIAGO"), "Metropolitana")
  assert.equal(regionDesdePadron("REGION DEL BIOBIO"), "Biobío")
})
