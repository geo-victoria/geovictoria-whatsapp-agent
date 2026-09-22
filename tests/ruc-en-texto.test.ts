import test from "node:test"
import assert from "node:assert/strict"
import { rucEnTexto } from "../lib/rut.ts"

test("rucEnTexto: RUC válido pelado, con separadores y dentro de una frase", () => {
  assert.equal(rucEnTexto("mi ruc es 20605842055 gracias"), "20605842055")
  assert.equal(rucEnTexto("RUC 20-605842055"), "20605842055")
  assert.equal(rucEnTexto("es el 20 605842055"), "20605842055")
})

test("rucEnTexto: no toma teléfonos ni números de 11 dígitos que no validan", () => {
  assert.equal(rucEnTexto("mi celular es 51922067167"), null)
  assert.equal(rucEnTexto("20605842050"), null)
  assert.equal(rucEnTexto("somos 18 personas en Piura"), null)
})
