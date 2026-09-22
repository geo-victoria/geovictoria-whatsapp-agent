import { test } from "node:test"
import assert from "node:assert/strict"
import { afirmaTiempoFalso, descripcionTiempo } from "../lib/toque-tiempo.ts"

// Los dos textos REALES que recibió +56932011618 el 13-sep tras pedir 24 h.
test("'pasaron los días' a los 12 minutos se rechaza", () => {
  const real =
    "Camila, pasaron los días y no vi que hayas revisado el link de la cotización con el 10% de descuento, ese precio de $24.103 sigue ahí. Lo revisaste?"
  const v = afirmaTiempoFalso(real, 12)
  assert.equal(v.ok, false)
  assert.equal(v.motivo, "tiempo_transcurrido")
})

test("'ese precio ya venció' con la oferta viva se rechaza", () => {
  const real =
    "Camila, veo que no alcanzaste a revisar la cotización con el 10% de descuento, ese precio ya venció. Quieres que lo veamos igual?"
  const v = afirmaTiempoFalso(real, 72, true)
  assert.equal(v.ok, false)
  assert.equal(v.motivo, "vencimiento")
})

test("el mismo texto a los 5 días es legítimo", () => {
  const real = "Camila, pasaron los días y no vi que hayas revisado el link. Lo revisaste?"
  assert.equal(afirmaTiempoFalso(real, 5 * 24 * 60).ok, true)
})

test("sin medición no se bloquea (fail-open)", () => {
  assert.equal(afirmaTiempoFalso("pasaron los días…", null).ok, true)
})

test("un toque que no habla de tiempo pasa siempre", () => {
  const t = "Quedaste en ver el tema de los turnos rotativos con tu socio. Alcanzaste a conversarlo?"
  assert.equal(afirmaTiempoFalso(t, 10).ok, true)
  assert.equal(afirmaTiempoFalso(t, 10, true).ok, true)
})

test("vencimiento sin oferta vigente no se juzga", () => {
  assert.equal(afirmaTiempoFalso("el precio ya venció", 9999, false).ok, true)
})

test("descripcionTiempo en palabras", () => {
  assert.equal(descripcionTiempo(12), "12 minutos")
  assert.equal(descripcionTiempo(1), "1 minuto")
  assert.equal(descripcionTiempo(72), "1 hora")
  assert.equal(descripcionTiempo(60 * 30), "1 día")
  assert.equal(descripcionTiempo(null), "no se pudo medir cuánto tiempo pasó")
})
