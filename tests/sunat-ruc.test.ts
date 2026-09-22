import test from "node:test"
import assert from "node:assert/strict"
import { parsearFichaSunat } from "../lib/paises/pe/sunat-ruc.ts"

test("parsearFichaSunat: respuesta real de apis.net.pe v1 → razón social y ubicación", () => {
  const f = parsearFichaSunat("20605842055", {
    nombre: "GEOVICTORIA PERU S.A.C.", estado: "ACTIVO", condicion: "HABIDO",
    direccion: "AV. EL DERBY NRO 254 INT. 506 URB. EL DERBY DE MONTERRICO ", lote: "-",
    distrito: "SANTIAGO DE SURCO", provincia: "LIMA", departamento: "LIMA",
  })
  assert.ok(f)
  assert.equal(f.razonSocial, "GEOVICTORIA PERU S.A.C.")
  assert.equal(f.distrito, "SANTIAGO DE SURCO")
  assert.equal(f.direccion, "AV. EL DERBY NRO 254 INT. 506 URB. EL DERBY DE MONTERRICO")
  assert.equal(parsearFichaSunat("20605842055", { message: "not found" }), null)
})
