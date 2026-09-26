import test from "node:test"
import assert from "node:assert/strict"
import { razonSocialInvalidaMX } from "../lib/paises/mx/razon-social.ts"

test("razón social MX: el RFC, un pedazo del RFC o el contacto no valen", () => {
  assert.equal(razonSocialInvalidaMX("XAXX010101000", "XAXX010101000", "Luis"), true)
  assert.equal(razonSocialInvalidaMX("GEO", "GEO150101AB1", "Luis"), true) // batería 26-sep
  assert.equal(razonSocialInvalidaMX("Luis", "GEO150101AB1", "Luis"), true)
  assert.equal(razonSocialInvalidaMX("", "GEO150101AB1", "Luis"), true)
})
test("razón social MX: una razón social real pasa", () => {
  assert.equal(razonSocialInvalidaMX("Geo Soluciones SA de CV", "GEO150101AB1", "Luis"), false)
  assert.equal(razonSocialInvalidaMX("PRUEBA BATERIA VICKY NO USAR", "GEO150101AB1", "Luis"), false)
})
