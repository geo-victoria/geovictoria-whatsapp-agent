import { test } from "node:test"
import assert from "node:assert/strict"
import { reglaZoho, paisesConProceso, paisTieneProceso, paisDeTerritorio } from "../lib/paises/ficha-operativa.ts"

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
