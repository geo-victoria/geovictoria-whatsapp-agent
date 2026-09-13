import { test } from "node:test"
import assert from "node:assert/strict"
import { planDeToque, esToqueComercial } from "../lib/campana-reactivacion-reglas.ts"

test("cotización aceptada usa la plantilla de cobro en CUALQUIER casilla", () => {
  for (const c of [1, 2, 3, 4] as const) {
    const p = planDeToque(c, true, { cotizacionAceptada: true })
    assert.equal(p.tpl, "vicky_loop_pago_link_cl")
    assert.deepEqual(p.vars, ["nombre", "link"])
    assert.match(p.descripcion, /solo falta el pago/)
  }
})

test("aceptada manda incluso sobre el tope del toque 4", () => {
  assert.equal(planDeToque(4, true, { topeAplicado: true, cotizacionAceptada: true }).tpl, "vicky_loop_pago_link_cl")
})

test("sin aceptar, los ganchos de cada casilla quedan intactos", () => {
  assert.equal(planDeToque(1, true).tpl, "vicky_reactivacion_cotizacion_cl_v4")
  assert.equal(planDeToque(1, false).tpl, "vicky_reactivacion_sin_nombre_cl_v4")
  assert.equal(planDeToque(2, true).tpl, "vicky_react_t2_cl_v2")
  assert.equal(planDeToque(3, true).tipo, "dcto")
  assert.equal(planDeToque(4, true).tpl, "vicky_react_t4_cl")
  assert.equal(planDeToque(4, true, { topeAplicado: true }).tpl, "vicky_react_t4_20_cl")
})

test("el contenido no cuenta como toque de campaña para el descanso", () => {
  // El estado terminal no es una campaña que pida algo. Sin esto, con una
  // pieza al mes siempre habría un evento a menos de 28 días y el primer
  // toque de un ciclo nuevo jamás volvería a dispararse.
  assert.equal(esToqueComercial("contenido_1"), false)
  assert.equal(esToqueComercial("contenido_12"), false)
  assert.equal(esToqueComercial("react_t1"), true)
  assert.equal(esToqueComercial("react_t4"), true)
  assert.equal(esToqueComercial("dcto10_2026-08-26"), true)
  assert.equal(esToqueComercial("remk_300_08sep"), true)
  assert.equal(esToqueComercial(null), true)
})
