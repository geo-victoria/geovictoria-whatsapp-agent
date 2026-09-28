import { test } from "node:test"
import assert from "node:assert/strict"
import { esPreguntaSinOrden } from "../lib/pregunta-vs-orden.ts"

test("preguntas informativas: no autorizan cambiar la formal (caso Irene)", () => {
  for (const m of [
    "Tambien tienen en venta?",
    "¿también tienen en venta?",
    "y en venta?",
    "cuánto sale si lo compro?",
    "hay opción de compra",
    "¿incluye la instalación?",
  ]) assert.equal(esPreguntaSinOrden(m), true, m)
})

test("pedidos, aunque vengan con signo de pregunta, sí autorizan", () => {
  for (const m of [
    "¿me la puedes cambiar a venta?",
    "cámbiala a venta por favor",
    "quiero el reloj en compra",
    "sí",
    "dale, en venta",
    "prefiero la opción 2",
    "somos 12 ahora",
    "actualízala con 2 relojes?",
  ]) assert.equal(esPreguntaSinOrden(m), false, m)
})
