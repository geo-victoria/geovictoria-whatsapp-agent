import { test } from "node:test"
import assert from "node:assert/strict"
import { rfcEnTexto } from "../lib/paises/mx/rfc.ts"

test("rfcEnTexto: extrae RFC con o sin separadores y no toma teléfonos", () => {
  assert.equal(rfcEnTexto("mi rfc es cec200528xx4"), "CEC200528XX4")
  assert.equal(rfcEnTexto("RFC: GOMA-850101-XY9 gracias"), "GOMA850101XY9")
  assert.equal(rfcEnTexto("llámame al 5215512345678"), null)
  assert.equal(rfcEnTexto("somos 12 personas"), null)
  assert.equal(rfcEnTexto("ABC991399XX1"), null) // mes 13
})
