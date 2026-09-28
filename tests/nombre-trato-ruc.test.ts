import { test } from "node:test"
import assert from "node:assert/strict"
import { nombreTratoConRuc } from "../lib/nombre-trato-ruc.ts"

test("Perú: RUC al inicio del trato, conserva '- Cotización Vicky' y el producto", () => {
  assert.equal(nombreTratoConRuc("GRUPO X S.A.C. - Cotización Vicky", "20613644963"), "20613644963 - GRUPO X S.A.C. - Cotización Vicky")
  assert.equal(nombreTratoConRuc("World Motors (Control de Asistencia)", "20508306831"), "20508306831 - World Motors (Control de Asistencia)")
  assert.equal(nombreTratoConRuc("20508306831 - World Motors", "20508306831"), "20508306831 - World Motors")
  assert.equal(nombreTratoConRuc("X", "123"), "X")
})
