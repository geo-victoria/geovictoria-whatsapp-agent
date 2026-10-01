import { test } from "node:test"
import assert from "node:assert/strict"
import { digitosTel, telCalza, territorioDeFono } from "../lib/leads-gemelos.ts"

test("teléfono con espacios del formulario calza con el contacto", () => {
  assert.equal(telCalza("+51957 732 010", "51957732010"), true)
  assert.equal(telCalza("+5656987654321", "56987654321"), true)
  assert.equal(digitosTel("+56 56 9 8765 4321"), "56987654321")
})

test("número local sin código: exige el territorio del país (CL y PE comparten 9 dígitos)", () => {
  assert.equal(telCalza("957732010", "51957732010", "Perú"), true)
  assert.equal(telCalza("957732010", "51957732010", "Chile"), false)
  assert.equal(telCalza("+56957732010", "51957732010"), false)
})

test("territorio por prefijo", () => {
  assert.equal(territorioDeFono("573181070737"), "colombia")
  assert.equal(territorioDeFono("5215537295284"), "")
  assert.equal(territorioDeFono("525537295284"), "mexico")
})
