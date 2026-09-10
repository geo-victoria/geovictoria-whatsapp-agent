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
