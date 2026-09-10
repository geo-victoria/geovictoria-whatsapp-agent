import test from "node:test"
import assert from "node:assert/strict"
import { destinoTrasCalificar, esSdrCalificacionCL } from "../lib/sdr-calificacion.ts"

const ALEYDIS = "3525045000583802005"
const ARACELLI = "3525045000594735052"

test("esSdrCalificacionCL reconoce a las dos por id y por correo", () => {
  assert.equal(esSdrCalificacionCL({ ownerId: ALEYDIS }), true)
  assert.equal(esSdrCalificacionCL({ ownerId: ARACELLI }), true)
  assert.equal(esSdrCalificacionCL({ ownerEmail: "AAraque@geovictoria.com" }), true)
  // Ejecutivos: su cartera se respeta como siempre.
  assert.equal(esSdrCalificacionCL({ ownerId: "3525045000000211283" }), false)
  assert.equal(esSdrCalificacionCL({ ownerEmail: "tmartinezq@geovictoria.com" }), false)
  assert.equal(esSdrCalificacionCL({}), false)
})

test("caso Cafetería: calificado con RUT en manos de la SDR → deal + tómbola", () => {
  assert.equal(
    destinoTrasCalificar({ territorio: "Chile", ownerId: ALEYDIS, calificado: true, rut: "77009088-1" }),
    "deal_tombola",
  )
})

test("caso Diego (40 app, sin RUT): calificado sin RUT → lead a TLMK", () => {
  assert.equal(
    destinoTrasCalificar({ territorio: "Chile", ownerId: ARACELLI, calificado: true, rut: "" }),
    "lead_tlmk",
  )
})

test("sin calificar se queda con la SDR: es exactamente su trabajo", () => {
  assert.equal(
    destinoTrasCalificar({ territorio: "Chile", ownerId: ALEYDIS, calificado: false, rut: "77009088-1" }),
    "sin_cambio",
  )
})

test("venta autónoma de Aleydis: jamás se re-sortea", () => {
  // Por hito post-pago…
  assert.equal(
    destinoTrasCalificar({ territorio: "Chile", ownerId: ALEYDIS, calificado: true, rut: "1-9", hito: "aceptada" }),
    "sin_cambio",
  )
  assert.equal(
    destinoTrasCalificar({ territorio: "Chile", ownerId: ALEYDIS, calificado: true, rut: "1-9", hito: "onboarding_listo" }),
    "sin_cambio",
  )
  // …y por venta ya cerrada (deal en 6/7/8 o pago registrado).
  assert.equal(
    destinoTrasCalificar({ territorio: "Chile", ownerId: ALEYDIS, calificado: true, rut: "1-9", ventaCerrada: true }),
    "sin_cambio",
  )
})

test("la cartera de un ejecutivo y los otros países no se tocan", () => {
  assert.equal(
    destinoTrasCalificar({ territorio: "Chile", ownerId: "3525045000223766001", calificado: true, rut: "1-9" }),
    "sin_cambio",
  )
  assert.equal(
    destinoTrasCalificar({ territorio: "Colombia", ownerId: ALEYDIS, calificado: true, rut: "1-9" }),
    "sin_cambio",
  )
})
