import { test } from "node:test"
import assert from "node:assert/strict"
import { montoDelBloque } from "../lib/precio-bloque.ts"

// Formas REALES verificadas el 10-sep en los chats.
test("bloque con UF y CLP aproximado: manda el CLP", () => {
  const t = "Resumen mensual recurrente:\n\n- Control de Asistencia: 0,55 UF/mes\n\nTotal mensual con IVA: 0,65 UF (aprox. $26.765)\n\nPara armar la cotización formal…"
  assert.deepEqual(montoDelBloque(t), { clp: 26765, uf: 0.65 })
})

test("plan chico", () => {
  assert.equal(montoDelBloque("Total mensual con IVA: 0,3 UF (aprox. $12.166)").clp, 12166)
})

test("bloque de hardware sin CLP deja solo la UF", () => {
  const r = montoDelBloque("El reloj queda en 0,35 UF + IVA al mes.")
  assert.equal(r.clp, undefined)
  assert.equal(r.uf, 0.35)
})

test("bloque en pesos sin UF", () => {
  assert.deepEqual(montoDelBloque("Total mensual: $89.900"), { clp: 89900, uf: undefined })
})

test("texto sin precio no inventa monto", () => {
  assert.deepEqual(montoDelBloque("Te cuento que el plan incluye la app sin costo"), { clp: undefined, uf: undefined })
})

// CICATRIZ 10-sep: "Subtotal mensual" contiene "total mensual" y la primera
// versión devolvía el NETO como si fuera con IVA (16 % abajo).
test("bloque largo: manda el TOTAL con IVA, no el subtotal", () => {
  const t = [
    "Resumen mensual recurrente:",
    "- Control de Asistencia: 50 × 0,055 UF = 2,75 UF/mes",
    "- Reloj control físico: 1 unidad × 0,35 UF = 0,35 UF/mes",
    "Subtotal mensual: 3,1 UF",
    "IVA (19%): 0,59 UF",
    "Total mensual con IVA: 3,69 UF",
    "Equivalente: $150.898 CLP/mes (UF del día: $40.894,00)",
  ].join("\n")
  assert.equal(montoDelBloque(t).uf, 3.69)
})

test("solo subtotal en el texto: no se confunde con el total", () => {
  assert.equal(montoDelBloque("Subtotal mensual: 1,4 UF\nIVA (19%): 0,27 UF").uf, undefined)
})

test("el CLP de la línea Equivalente cuenta como monto con IVA", () => {
  const t = [
    "Subtotal mensual: 3,1 UF",
    "Total mensual con IVA: 3,69 UF",
    "Equivalente: $150.898 CLP/mes (UF del día: $40.894,00)",
  ].join("\n")
  assert.deepEqual(montoDelBloque(t), { clp: 150898, uf: 3.69 })
})
