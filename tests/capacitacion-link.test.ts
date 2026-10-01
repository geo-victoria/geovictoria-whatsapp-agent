import { test } from "node:test"
import assert from "node:assert/strict"
import { tipoCapacitacion, linkCapacitacion, mensajeCapacitacionLink, paisConCapacitacionPorLink } from "../lib/onboarding/capacitacion-link.ts"

test("tipo por dotación y equipo (regla de Sofía)", () => {
  assert.equal(tipoCapacitacion({ usuarios: 8, conEquipo: false }), "masiva_app")
  assert.equal(tipoCapacitacion({ usuarios: 8, conEquipo: true }), "masiva_box")
  assert.equal(tipoCapacitacion({ usuarios: 20, conEquipo: true }), "masiva_box")
  assert.equal(tipoCapacitacion({ usuarios: 21, conEquipo: false }), "individual")
  assert.equal(tipoCapacitacion({ usuarios: 45, conEquipo: true }), "individual")
  assert.equal(tipoCapacitacion({ usuarios: null, conEquipo: false }), "masiva_app")
})

test("links por defecto y override por env", () => {
  assert.match(linkCapacitacion("masiva_app", {}), /gv4-app-chile/)
  assert.match(linkCapacitacion("masiva_box", {}), /gv4-box-chile/)
  assert.match(linkCapacitacion("individual", {}), /zohobookings\.com\/4631613000006741310/)
  assert.equal(linkCapacitacion("masiva_app", { VICKY_CAP_LINK_APP: "https://x.test/a" }), "https://x.test/a")
})

test("mensaje lleva el link y solo Chile usa links", () => {
  const url = linkCapacitacion("masiva_box", {})
  assert.ok(mensajeCapacitacionLink("masiva_box", url).includes(url))
  assert.equal(paisConCapacitacionPorLink("cl"), true)
  assert.equal(paisConCapacitacionPorLink("pe"), false)
})
