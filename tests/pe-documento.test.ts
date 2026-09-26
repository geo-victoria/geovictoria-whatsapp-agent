import test from "node:test"
import assert from "node:assert/strict"
import { normalizarDocumentoPE, parsearFichaDni } from "../lib/paises/pe/documento.ts"

// Casos reales 24-25 sep: Fernando (boleta con DNI 06576356) y Ana (DNI de 8
// dígitos, a quien Vicky le pidió siete veces un "DNI de 11 dígitos").
test("documento PE: RUC válido, DNI de 8 dígitos, y nada más", () => {
  assert.deepEqual(normalizarDocumentoPE("20605842055"), { tipo: "RUC", numero: "20605842055" })
  assert.deepEqual(normalizarDocumentoPE("06576356"), { tipo: "DNI", numero: "06576356" })
  assert.deepEqual(normalizarDocumentoPE("DNI 71951543"), { tipo: "DNI", numero: "71951543" })
  assert.equal(normalizarDocumentoPE("20605842056"), null) // RUC con DV malo
  assert.equal(normalizarDocumentoPE("1234567"), null)
})
test("ficha RENIEC: nombre en orden natural", () => {
  const f = parsearFichaDni("06576356", {
    nombre: "CHAVEZ DE LOS SANTOS FERNANDO OMAR", nombres: "FERNANDO OMAR", apellidoPaterno: "CHAVEZ", apellidoMaterno: "DE LOS SANTOS",
  })
  assert.equal(f?.nombre, "Fernando Omar Chavez De Los Santos")
})
