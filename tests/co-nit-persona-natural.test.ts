import { test } from "node:test"
import assert from "node:assert/strict"
import { nitValido, normalizarNit } from "../lib/paises/co/nit.ts"

test("persona natural: la cédula sirve como NIT, también las antiguas de 6-7 dígitos", () => {
  assert.equal(nitValido("1020304050"), true)
  assert.equal(nitValido("79123456"), true)
  assert.equal(nitValido("4123456"), true)
  assert.equal(nitValido("412345"), true)
  assert.equal(nitValido("41234"), false)
  assert.match(normalizarNit("4123456"), /^4123456-\d$/)
  assert.equal(nitValido("900.123.456-7"), true)
})
