import { test } from "node:test"
import assert from "node:assert/strict"
import { calcularAnualPais } from "../lib/paises/anualizar-calculo.ts"

// PE: 15 personas (S/82,50) + arriendo S/67, 10 % por 6 meses.
test("anualidad PE = Chile: el descuento cubre sus meses, el arriendo va a lista los 12", () => {
  const a = calcularAnualPais(
    [
      { codigo: "plan_asistencia", nombre: "Plan de asistencia (15 personas)", subtotal: 82.5, modalidad: "Recurrente", esRecurrente: true },
      { codigo: "reloj_pe", nombre: "Reloj de control (arriendo)", subtotal: 67, modalidad: "Arriendo", esRecurrente: true },
    ],
    10, 6, 2,
  )
  assert.equal(a.planAnual, Math.round((82.5 * 0.9 * 6 + 82.5 * 6) * 100) / 100) // 940.5
  assert.equal(a.arriendoAnual, 804)
  assert.equal(a.meses, 6)
})

// CO: 14 personas ($191.800), 20 % indefinido (0 → 12), alquiler $86.000.
test("anualidad CO: 0 meses = los 12; COP enteros; el alquiler no baja", () => {
  const a = calcularAnualPais(
    [
      { codigo: "plan_asistencia", nombre: "Control de Asistencia", subtotal: 191800, modalidad: "Recurrente", esRecurrente: true },
      { codigo: "reloj_arriendo", nombre: "Alquiler de equipo biométrico", subtotal: 86000, modalidad: "Arriendo", esRecurrente: true },
    ],
    20, 0, 0,
  )
  assert.equal(a.planAnual, Math.round(191800 * 0.8 * 12)) // 1.841.280
  assert.equal(a.arriendoAnual, 86000 * 12)
  assert.equal(a.meses, 12)
})

test("sin descuento el año es 12 × la mensualidad; la Activación y los únicos no entran", () => {
  const a = calcularAnualPais(
    [
      { codigo: "plan_asistencia", nombre: "Control de Asistencia", subtotal: 315000, modalidad: "Único", esRecurrente: true },
      { codigo: "activacion", nombre: "Activación", subtotal: 315000, modalidad: "Venta", esRecurrente: false },
    ],
    0, 6, 0,
  )
  assert.equal(a.planAnual, 315000 * 12)
  assert.equal(a.arriendoAnual, 0)
})
