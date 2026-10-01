import { test } from "node:test"
import assert from "node:assert/strict"
import { duenoPuestoPorRegla } from "../lib/dueno-por-regla.ts"

const AHORA = Date.UTC(2026, 9, 1, 18, 23, 30)

test("Ernesto: la regla lo asignó 4 s antes → el trato no hereda", () => {
  const marca = JSON.stringify({ at: AHORA - 4_000, ownerId: "monica" })
  assert.equal(duenoPuestoPorRegla(marca, "monica", AHORA), true)
})

test("pasada la ventana el dueño ya pudo gestionar → hereda", () => {
  const marca = JSON.stringify({ at: AHORA - 3 * 3600_000, ownerId: "monica" })
  assert.equal(duenoPuestoPorRegla(marca, "monica", AHORA, 120), false)
})

test("alguien movió el lead después de nuestra regla → manda esa decisión", () => {
  const marca = JSON.stringify({ at: AHORA - 60_000, ownerId: "monica" })
  assert.equal(duenoPuestoPorRegla(marca, "victoria", AHORA), false)
})

test("sin marca o marca ilegible → hereda como siempre", () => {
  assert.equal(duenoPuestoPorRegla(null, "x", AHORA), false)
  assert.equal(duenoPuestoPorRegla("{roto", "x", AHORA), false)
})

test("marca sin ownerId (regla CL devuelve solo correo) cuenta por tiempo", () => {
  const marca = JSON.stringify({ at: AHORA - 60_000, ownerId: "" })
  assert.equal(duenoPuestoPorRegla(marca, "anderson", AHORA), true)
})
