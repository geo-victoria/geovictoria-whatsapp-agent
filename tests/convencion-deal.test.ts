import test from "node:test"
import assert from "node:assert/strict"
import { recurrenteNetoDeItems, monedaDealDeTerritorio, monedaDealDeTelefono } from "../lib/convencion-deal.ts"

test("Chile en UF: recurrente desde Subtotal_UF con 2 decimales", () => {
  const items = [
    { Codigo_Item: "asistencia", Es_Recurrente: true, Subtotal_UF: 0.55, Subtotal_CLP: 22550 },
    { Codigo_Item: "senseface_2a", Es_Recurrente: true, Subtotal_UF: 0.35, Subtotal_CLP: 14350 },
    { Codigo_Item: "envio_reloj", Es_Recurrente: false, Subtotal_UF: 0.5, Subtotal_CLP: 20500 },
  ]
  assert.equal(recurrenteNetoDeItems(items, 10, "UF"), 0.81)
  assert.equal(recurrenteNetoDeItems([{ Codigo_Item: "plan_anual", Subtotal_UF: 6.6 }], 0, "UF"), 0.55)
  assert.equal(recurrenteNetoDeItems(items, 0, "COP"), 36900)
})

test("moneda por territorio y por prefijo", () => {
  assert.equal(monedaDealDeTerritorio("Chile"), "UF")
  assert.equal(monedaDealDeTerritorio("Perú"), "SOL")
  assert.equal(monedaDealDeTelefono("+56 9 1234 5678"), "UF")
  assert.equal(monedaDealDeTelefono("573001234567"), "COP")
  assert.equal(monedaDealDeTelefono(""), null)
})
