import { test } from "node:test"
import assert from "node:assert/strict"
import { dotacionEnTexto } from "../lib/dotacion-en-texto.ts"

test("rango: toma el piso (caso La Birra 01-oct)", () => {
  assert.equal(dotacionEnTexto("Muriel Infante, de 200 a 400 personas"), 200)
  assert.equal(dotacionEnTexto("entre 50 y 80 trabajadores"), 50)
  assert.equal(dotacionEnTexto("somos 30-40 colaboradores"), 30)
})

test("número simple, 'somos N' y 'más de N'", () => {
  assert.equal(dotacionEnTexto("Somos 15 personas"), 15)
  assert.equal(dotacionEnTexto("somos como 12"), 12)
  assert.equal(dotacionEnTexto("más de 100 empleados"), 101)
})

test("no confunde RUT, teléfono ni años", () => {
  assert.equal(dotacionEnTexto("La Birra Chile Spa\n77.755.282-1"), undefined)
  assert.equal(dotacionEnTexto("mi número es 56996389729"), undefined)
  assert.equal(dotacionEnTexto("desde 2019 trabajamos con otro sistema"), undefined)
})

test("manda la última mención (el cliente se corrige)", () => {
  assert.equal(dotacionEnTexto("somos 20 personas\nperdón, son 25 personas"), 25)
})
