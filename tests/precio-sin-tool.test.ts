/**
 * Ningún precio sale sin respaldo (04-sep, caso Carlos/Anton Paar).
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { chequearPreciosDelReply, montosDe } from "../lib/precio-sin-tool.ts"

const HIST_CARLOS = [
  "1 - Para 5 personas te recomiendo Reloj en arriendo + App:\n💰 0,9 UF + IVA al mes (aprox. $43.780).",
  "Lista tu cotización, Carlos! 🎉 Revísala aquí: https://cotizacion.geovictoria.com/q/3525045000658264373-c5af3ebdcc",
]

test("el caso real: $47.642 inventado con 6 personas se detecta", () => {
  const r = chequearPreciosDelReply(
    "Con 6 personas el valor mensual sube a aproximadamente 0,98 UF + IVA (alrededor de $47.642/mes).",
    [],
    HIST_CARLOS,
  )
  assert.equal(r.hayInventado, true)
  assert.ok(r.inventados.includes(47642), "debe señalar el monto inventado")
})

test("repetir el precio que Vicky ya dio es legítimo", () => {
  const r = chequearPreciosDelReply(
    "Como te decía, son $43.780 al mes con IVA 😊",
    [],
    HIST_CARLOS,
  )
  assert.equal(r.hayInventado, false)
})

test("el redondeo de la UF del día no dispara el guardrail", () => {
  // $43.780 ayer, $43.781 hoy: el mismo precio con otra UF.
  const r = chequearPreciosDelReply("Son $43.781 al mes.", [], HIST_CARLOS)
  assert.equal(r.hayInventado, false)
})

test("con una tool de precio del turno, el mensaje pasa entero", () => {
  const r = chequearPreciosDelReply(
    "Quedó en $99.999 al mes y el pago inicial es $120.000.",
    ["actualizar_cotizacion"],
    HIST_CARLOS,
  )
  assert.equal(r.hayInventado, false)
})

test("una tool que NO es de precio no respalda nada", () => {
  const r = chequearPreciosDelReply("Son $99.999 al mes.", ["enviar_ficha_reloj"], HIST_CARLOS)
  assert.equal(r.hayInventado, true)
})

test("un mensaje sin cifras jamás se bloquea", () => {
  const r = chequearPreciosDelReply("Perfecto Carlos, tómate tu tiempo 😊", [], HIST_CARLOS)
  assert.equal(r.hayInventado, false)
})

test("montosDe entiende pesos y UF, e ignora cifras que no son precio", () => {
  const m = montosDe("0,9 UF + IVA al mes (aprox. $43.780) — 5 personas, $100 de nada")
  assert.ok(m.includes(43780))
  assert.ok(m.includes(900), "0,9 UF se normaliza a 900")
  assert.ok(!m.includes(100), "$100 no es un precio de este negocio")
})
