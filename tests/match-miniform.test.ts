import { test } from "node:test"
import assert from "node:assert/strict"
import { nombreDelPrefill, elegirLeadDelForm } from "../lib/match-miniform.ts"

test("lee el nombre del texto del botón y nada más", () => {
  assert.equal(nombreDelPrefill("Hola, soy Ernesto, me gustaría cotizar sus soluciones."), "Ernesto")
  assert.equal(nombreDelPrefill("Hola, soy FRANCESCA, me gustaría cotizar sus soluciones."), "FRANCESCA")
  assert.equal(nombreDelPrefill("Hola, soy jose, me gustaría cotizar sus soluciones.  1-10 empleados"), "jose")
  assert.equal(nombreDelPrefill("Hola, soy Ernesto, quiero cotizar. Somos 420"), null)
  assert.equal(nombreDelPrefill("Hola buenas tardes"), null)
})

test("un solo candidato con el mismo nombre en la ventana", () => {
  const t = Date.parse("2026-10-01T18:20:54Z")
  const c = [
    { id: "A", firstName: "Ernesto", createdMs: Date.parse("2026-10-01T18:20:28Z") },
    { id: "B", firstName: "Virginia", createdMs: Date.parse("2026-10-01T18:15:00Z") },
  ]
  assert.equal(elegirLeadDelForm("ernesto", t, c), "A")
})

test("dos con el mismo nombre = ambiguo; fuera de la ventana = nada", () => {
  const t = Date.parse("2026-10-01T18:20:54Z")
  assert.equal(elegirLeadDelForm("José", t, [
    { id: "A", firstName: "Jose", createdMs: t - 60_000 },
    { id: "B", firstName: "JOSÉ", createdMs: t - 120_000 },
  ]), null)
  assert.equal(elegirLeadDelForm("Jose", t, [{ id: "A", firstName: "Jose", createdMs: t - 3 * 3600e3 }]), null)
})
