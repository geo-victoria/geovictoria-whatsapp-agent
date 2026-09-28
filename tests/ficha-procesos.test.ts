import { test } from "node:test"
import assert from "node:assert/strict"
import { reglaZoho, paisesConProceso, paisTieneProceso, paisDeTerritorio, gatePresentacion, paisDeCelularOperativo, fichaOperativa } from "../lib/paises/ficha-operativa.ts"

test("las reglas de Zoho de cada país salen de la ficha (Deals 2026 compartida, Chile la suya)", () => {
  assert.equal(reglaZoho("cl", "deals"), "3525045000595568541")
  for (const p of ["pe", "co", "mx"]) assert.equal(reglaZoho(p, "deals"), "3525045000635322005")
  for (const p of ["cl", "pe", "co", "mx"]) {
    assert.equal(reglaZoho(p, "leadsCalificado"), "3525045000649066001")
    assert.equal(reglaZoho(p, "leadsSinCalificar"), "3525045000652043111")
  }
  assert.equal(reglaZoho("ar", "deals"), "")
})

test("el reloj de 24 h es un proceso por país (México apagado hasta el VB)", () => {
  assert.deepEqual(paisesConProceso("relojCalificacion24h").sort(), ["cl", "co", "pe"])
  assert.equal(paisTieneProceso("mx", "relojCalificacion24h"), false)
})

test("tómbola por Zoho apagada ⇒ sin regla (el país cae a su rotación interna)", () => {
  process.env.VICKY_TOMBOLA_ZOHO_CO = "off"
  try {
    assert.equal(reglaZoho("co", "deals"), "")
  } finally {
    delete process.env.VICKY_TOMBOLA_ZOHO_CO
  }
  assert.equal(reglaZoho("co", "deals"), "3525045000635322005")
})

test("territorio de Zoho → país", () => {
  assert.equal(paisDeTerritorio("Perú"), "pe")
  assert.equal(paisDeTerritorio("México"), "mx")
  assert.equal(paisDeTerritorio("Chile"), "cl")
})

test("paso 4 (28-sep): las decisiones por país del traspaso y el post-pago son flags de la ficha", () => {
  // Perú es el único con gate de presentación (pe_presentacion / VICKY_PE_PRESENTACION).
  assert.deepEqual(gatePresentacion("pe"), { kv: "pe_presentacion", env: "VICKY_PE_PRESENTACION" })
  assert.equal(gatePresentacion("cl"), null)
  assert.deepEqual(paisesConProceso("presentacionConGate"), ["pe"])
  // El alta por chat corre en los cuatro.
  assert.deepEqual(paisesConProceso("altaPorChat").sort(), ["cl", "co", "mx", "pe"])
  // México: el lead sin formal nace con el SDR (Lalo 13-ago); los demás con Vicky.
  assert.deepEqual(paisesConProceso("leadNaceConSdr"), ["mx"])
  // Colombia: el lead del SDR es un handoff al cotizar (acuerdo CO 05-ago).
  assert.deepEqual(paisesConProceso("sdrEntregaAlCotizar"), ["co"])
  // Plantilla de presentación: Perú la suya, CO/MX vacía = la neutra de Chile.
  assert.equal(fichaOperativa("pe").plantillas.presentacionTraspaso, "vicky_pe_traspaso_ejecutivo")
  assert.equal(fichaOperativa("cl").plantillas.presentacionTraspaso, "vicky_traspaso_ejecutivo")
  assert.equal(fichaOperativa("co").plantillas.presentacionTraspaso, "")
})

test("paisDeCelularOperativo: celular completo por país; fijos y otros países dan null", () => {
  assert.equal(paisDeCelularOperativo("56944668823"), "cl")
  assert.equal(paisDeCelularOperativo("51906239544"), "pe")
  assert.equal(paisDeCelularOperativo("573181070737"), "co")
  assert.equal(paisDeCelularOperativo("5215659778486"), "mx")
  assert.equal(paisDeCelularOperativo("525659778486"), "mx")
  assert.equal(paisDeCelularOperativo("5622345678"), null) // fijo chileno de 10 dígitos
  assert.equal(paisDeCelularOperativo("34600000000"), null)
  assert.equal(paisDeCelularOperativo("FB.123"), null)
})
