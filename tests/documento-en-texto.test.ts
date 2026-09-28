import { test } from "node:test"
import assert from "node:assert/strict"
import { documentoEnTexto, documentoDeContactoEnTexto, etiquetaDocumento } from "../lib/paises/documento-en-texto.ts"
import { rutEnTexto } from "../lib/rut.ts"

test("un extractor por país, elegido por la ficha (RUT · RUC · NIT · RFC)", () => {
  assert.equal(documentoEnTexto("cl", "mi rut es 76.188.587-1 gracias"), "76188587-1")
  assert.equal(documentoEnTexto("pe", "ruc 20605842055"), "20605842055")
  assert.equal(documentoEnTexto("co", "nit 901367959-1"), "901367959-1")
  assert.equal(documentoEnTexto("mx", "rfc CEC2005286R4"), "CEC2005286R4")
  assert.equal(etiquetaDocumento("pe"), "RUC")
})

test("el documento de otro país no se confunde: un RUC en un chat chileno no es RUT", () => {
  assert.equal(documentoEnTexto("cl", "ruc 20605842055"), null)
  assert.equal(documentoEnTexto("pe", "76.188.587-1"), null)
})

test("por teléfono: prefijo del país manda, desconocido cae a Chile (conducta histórica)", () => {
  assert.equal(documentoDeContactoEnTexto("51900000001", "ruc 20605842055"), "20605842055")
  assert.equal(documentoDeContactoEnTexto("56944668823", "rut 76.188.587-1"), "76188587-1")
  assert.equal(documentoDeContactoEnTexto("34600000000", "rut 76.188.587-1"), "76188587-1")
})

test("rutEnTexto vive en lib/rut (puro) y sigue exigiendo guion o puntos", () => {
  assert.equal(rutEnTexto("761885871"), null)
  assert.equal(rutEnTexto("76188587-1"), "76188587-1")
})
