import { test } from "node:test"
import assert from "node:assert/strict"
import { clasificarGestion, esNotaDeGestion, refrescarGestion } from "../lib/gestion-venta.ts"

const VICKY = "3525045000484500876"
const ADMIN = "3525045000000200013"
const HUMANO = "3525045000426432190"

test("nota de un ejecutivo = gestión; nota del robot no", () => {
  assert.equal(esNotaDeGestion({ Note_Title: "Llamé al cliente", Created_By: { id: HUMANO } }), true)
  assert.equal(esNotaDeGestion({ Note_Title: "Insight de la conversación (Vicky)", Created_By: { id: VICKY } }), false)
  assert.equal(esNotaDeGestion({ Note_Title: "⚠️ Cotización en Creator INCOMPLETA", Created_By: { id: ADMIN } }), false)
})

test("la nota del ESPEJO la crea el robot pero SÍ es gestión", () => {
  assert.equal(esNotaDeGestion({ Note_Title: "WhatsApp 27-ago (espejo emujica)", Created_By: { id: VICKY } }), true)
})

// Lalo 10-sep: el traspaso NO es actividad — sin notas del ejecutivo la venta
// es autónoma aunque la conversación se haya traspasado.
test("traspaso sin actividad = autónoma", () => {
  assert.equal(clasificarGestion({ notas: [{ Note_Title: "Traspaso a ejecutivo", Created_By: { id: VICKY } }] }), "autonoma")
})

test("mensaje del vendedor por espejo = asistida aunque la nota no haya llegado", () => {
  assert.equal(clasificarGestion({ notas: [], espejoDelVendedor: true }), "asistida")
  assert.equal(clasificarGestion({ llamadaAtendida: true }), "asistida")
})

test("sin señales legibles = sd, jamás autónoma por omisión", () => {
  assert.equal(clasificarGestion({}), "sd")
})

test("refresco: venta vieja ya clasificada no se relee; recién pagada sí", () => {
  const ahora = Date.parse("2026-09-10T18:00:00Z")
  const vieja = ahora - 20 * 86_400_000
  const hoy = ahora - 3_600_000
  assert.equal(refrescarGestion({ g: "autonoma", at: "2026-08-25T10:00:00Z" }, vieja, ahora), false)
  assert.equal(refrescarGestion({ g: "autonoma", at: "2026-09-10T09:00:00Z" }, hoy, ahora), true)
  assert.equal(refrescarGestion({ g: "sd", at: "2026-09-10T17:50:00Z" }, hoy, ahora), true)
  assert.equal(refrescarGestion(null, hoy, ahora), true)
})
