import { test } from "node:test"
import assert from "node:assert/strict"
import { paisDeNumero, paisDeLinea, paisDePlantilla, plantillaCoherenteConLinea, channelIdPorPais } from "../lib/linea-por-pais.ts"
import { paisDeContacto } from "../lib/ruteo-pais.ts"

test("prefijos: CL, CO, MX (521 y 52), PE y otro", () => {
  assert.equal(paisDeNumero("56944668823"), "cl")
  assert.equal(paisDeNumero("573181070737"), "co")
  assert.equal(paisDeNumero("5215659778486"), "mx")
  assert.equal(paisDeNumero("525659778486"), "mx")
  assert.equal(paisDeNumero("51922067167"), "pe")
  assert.equal(paisDeNumero("+51 936 953 838"), "pe")
  assert.equal(paisDeNumero("5112345"), "otro") // fijo peruano corto: no es celular
  assert.equal(paisDeNumero("12025550123"), "otro")
})

test("ruteo-pais reconoce Perú por prefijo y por marcador PE.", () => {
  assert.equal(paisDeContacto("51922067167"), "pe")
  assert.equal(paisDeContacto("PE.1025995573684934"), "pe")
  assert.equal(paisDeContacto("56944668823"), "cl")
  assert.equal(paisDeContacto("511234567"), "desconocido")
})

test("país de una línea por su channelId o número", () => {
  assert.equal(paisDeLinea("GeoVictoriaEspaol-whatsapp-51922067167"), "pe")
  assert.equal(paisDeLinea("GeoVictoriaEspaol-whatsapp-56967308227"), "cl")
  assert.equal(paisDeLinea("56927526890"), "cl") // segunda línea chilena: por prefijo
  assert.equal(paisDeLinea(""), "otro")
})

test("país de una plantilla por su nombre (solo con marcador de borde)", () => {
  assert.equal(paisDePlantilla("vicky_alta_flow_clv4"), "cl")
  assert.equal(paisDePlantilla("vicky_react_t2_cl_v2"), "cl")
  assert.equal(paisDePlantilla("vicky_loop_pago_link_cl"), "cl")
  assert.equal(paisDePlantilla("vicky_co_solicitud_recibida"), "co")
  assert.equal(paisDePlantilla("vicky_mx_lead_apertura"), "mx")
  assert.equal(paisDePlantilla("vicky_pe_apertura"), "pe")
  // "cotizacion" NO es "co"; sin marcador → null
  assert.equal(paisDePlantilla("vicky_cotizacion_actualizada_llamada"), null)
  assert.equal(paisDePlantilla("vicky_traspaso_ejecutivo"), null)
  assert.equal(paisDePlantilla("vicky_t0_finde"), null)
  assert.equal(paisDePlantilla("vicky_campana_dcto_v1"), null)
})

test("una plantilla _cl no sale por la línea peruana ni una _pe por la chilena", () => {
  assert.equal(plantillaCoherenteConLinea("vicky_alta_flow_clv4", "51922067167"), false)
  assert.equal(plantillaCoherenteConLinea("vicky_pe_apertura", "56967308227"), false)
  assert.equal(plantillaCoherenteConLinea("vicky_alta_flow_clv4", "56967308227"), true)
  assert.equal(plantillaCoherenteConLinea("vicky_traspaso_ejecutivo", "51922067167"), true) // sin marcador: pasa
  assert.equal(plantillaCoherenteConLinea("vicky_alta_flow_clv4", ""), true) // línea ilegible: no se afirma nada
})

test("channelId por país: PE y CO tienen default canónico, CL usa la env histórica", () => {
  assert.equal(channelIdPorPais("pe"), "GeoVictoriaEspaol-whatsapp-51922067167")
  assert.equal(channelIdPorPais("co"), "GeoVictoriaEspaol-whatsapp-573181070737")
  assert.equal(channelIdPorPais("mx"), "GeoVictoriaEspaol-whatsapp-5215659778486")
  assert.equal(channelIdPorPais("cl"), (process.env.BOTMAKER_CHANNEL_V3 || "").trim())
})

// 25-sep (prueba de Ana Fiori con el número oculto): el identificador de
// WhatsApp sin número trae el país como prefijo y manda sobre los dígitos.
test("paisLineaDeContacto: BSUID con prefijo de país y números", async () => {
  const { paisLineaDeContacto } = await import("../lib/linea-por-pais.ts")
  assert.equal(paisLineaDeContacto("PE.4635395106744525"), "pe")
  assert.equal(paisLineaDeContacto("CO.1594422999071237"), "co")
  assert.equal(paisLineaDeContacto("51986892263"), "pe")
  assert.equal(paisLineaDeContacto("56912345678"), "cl")
  assert.equal(paisLineaDeContacto("4635395106744525"), "otro")
})
