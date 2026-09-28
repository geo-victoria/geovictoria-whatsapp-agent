import { test } from "node:test"
import assert from "node:assert/strict"
import { bloqueContenido } from "../lib/contenido-cotizacion-puro.ts"

test("caso Irene: sin línea de instalación, el bloque lo dice y no inventa", () => {
  const b = bloqueContenido(
    [
      { nombre: "Control de Asistencia", cantidad: 15, subtotalClp: 82.5, recurrente: true },
      { nombre: "Reloj de control (compra)", cantidad: 1, subtotalClp: 305, recurrente: false },
    ],
    "pe",
  )
  assert.match(b, /Control de Asistencia × 15: S\/ ?82[.,]50 neto \(mensual\)/)
  assert.match(b, /Reloj de control \(compra\): S\/ ?305[.,]00 neto \(pago único\)/)
  assert.match(b, /NO incluye instalación técnica/)
})

test("con instalación en la cotización no se niega", () => {
  const b = bloqueContenido([{ nombre: "Instalación técnica (Lima)", subtotalClp: 144, recurrente: false }], "pe")
  assert.doesNotMatch(b, /NO incluye instalación/)
})
