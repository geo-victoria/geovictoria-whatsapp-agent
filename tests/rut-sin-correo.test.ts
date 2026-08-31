/**
 * Directiva "llegó el RUT, no hay correo, EMITE" (Lalo 31-ago).
 * El caso 1 es literal de la prueba en vivo que la motivó.
 */
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import {
  directivaRutSinCorreo,
  traeRutValido,
  clienteDioCorreo,
} from "../lib/rut-sin-correo.ts"

const conPrecio = [
  { role: "user", content: "somos 18 personas en una caleta de pesca artesanal" },
  { role: "assistant", content: "Con app móvil → $18.711/mes con IVA." },
]

describe("directiva RUT sin correo", () => {
  test("dispara con el caso real de la prueba (18435922-7)", () => {
    assert.match(directivaRutSinCorreo("18435922-7", conPrecio), /OMITIENDO/)
  })
  test("acepta el RUT con puntos y guion", () => {
    assert.notEqual(directivaRutSinCorreo("77.111.222-6", conPrecio), "")
  })
  test("NO dispara si el cliente ya dio su correo antes", () => {
    const h = [...conPrecio, { role: "user", content: "mi correo es lalo@geovictoria.com" }]
    assert.equal(directivaRutSinCorreo("18435922-7", h), "")
  })
  test("NO dispara si RUT y correo vienen juntos", () => {
    assert.equal(directivaRutSinCorreo("18435922-7 lalo@geovictoria.com", conPrecio), "")
  })
  test("NO dispara antes de mostrar precio", () => {
    assert.equal(directivaRutSinCorreo("18435922-7", [{ role: "user", content: "hola" }]), "")
  })
  test("NO dispara con dígito verificador malo", () => {
    assert.equal(directivaRutSinCorreo("18435922-3", conPrecio), "")
  })
  test("no confunde cantidades con RUT", () => {
    assert.equal(traeRutValido("somos 18 personas en 2 sedes"), false)
  })
  test("detecta el correo del turno", () => {
    assert.equal(clienteDioCorreo("ahi va: a@b.cl", []), true)
  })
})
