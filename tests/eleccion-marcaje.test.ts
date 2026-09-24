import { test } from "node:test"
import assert from "node:assert/strict"
import { ultimaEleccionEsSoloApp } from "../lib/eleccion-marcaje.ts"

test("la última elección manda: 'reloj y app' y después 'opción 2, solo app' = solo app (batería MX 24-sep)", () => {
  assert.equal(ultimaEleccionEsSoloApp(["somos 16", "reloj y app", "me parece caro", "ok me quedo con la opción 2, solo app", "mi RFC es XAXX010101000"]), true)
  assert.equal(ultimaEleccionEsSoloApp(["reloj y app", "la 2"]), true)
  assert.equal(ultimaEleccionEsSoloApp(["ambas", "mejor sin reloj"]), true)
})

test("elegir el reloj después de la app vuelve a habilitarlo; sin elección no bloquea", () => {
  assert.equal(ultimaEleccionEsSoloApp(["solo app", "pensándolo bien, mejor con reloj"]), false)
  assert.equal(ultimaEleccionEsSoloApp(["reloj y app", "la primera"]), false)
  assert.equal(ultimaEleccionEsSoloApp(["somos 12", "en Coyoacán"]), false)
  assert.equal(ultimaEleccionEsSoloApp(["me interesa con ambos"]), false)
})
