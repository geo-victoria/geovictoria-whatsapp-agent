import { test } from "node:test"
import assert from "node:assert/strict"
import { correoDeToque, asuntoDeToque } from "../lib/campana-correo.ts"

const base = { nombre: "Ana", empresa: "Constructora Avanti", link: "https://x/q/abc", pdfUrl: "https://x/p.pdf", waUrl: "https://wa.me/569" } as const

test("toque 1: recordatorio de vigencia, sin descuentos", () => {
  const { asunto, html } = correoDeToque({ ...base, casilla: 1 })
  assert.match(asunto, /sigue vigente/)
  assert.match(html, /Sigue vigente y con el mismo valor/)
  assert.doesNotMatch(html, /descuento/i)
})

test("toque 2: usa el MISMO gancho que la plantilla de WhatsApp", () => {
  const gancho = "no hay permanencia, así que puedes partir con lo justo y crecer después"
  const { html } = correoDeToque({ ...base, casilla: 2, gancho })
  assert.match(html, /No hay permanencia/)
})

test("toque 3: JAMÁS dice que el descuento ya está aplicado — manda a WhatsApp", () => {
  const { asunto, html } = correoDeToque({ ...base, casilla: 3 })
  assert.match(asunto, /descuento esperándote/)
  assert.match(html, /todavía sin el descuento/)
  assert.match(html, /Responder por WhatsApp y aplicar el descuento/)
})

test("toque 4 SIN el tope aplicado: cierra honesto y no promete ningún %", () => {
  const { asunto, html } = correoDeToque({ ...base, casilla: 4, pctDescuento: 0 })
  assert.match(asunto, /¿Cerramos o lo dejamos hasta aquí\?/)
  assert.doesNotMatch(html, /20%/)
})

test("toque 4 CON el tope aplicado: nombra el 20% porque el link ya lo muestra", () => {
  const { asunto, html } = correoDeToque({ ...base, casilla: 4, pctDescuento: 20 })
  assert.match(asunto, /20% de descuento/)
  assert.match(html, /20% de descuento en el plan durante los primeros 6 meses/)
})

test("un descuento por debajo del tope no habilita la promesa del 20%", () => {
  assert.doesNotMatch(correoDeToque({ ...base, casilla: 4, pctDescuento: 10 }).html, /20%/)
})

test("sin nombre saluda igual y sin link no pinta el botón", () => {
  const { html } = correoDeToque({ ...base, casilla: 1, nombre: "", link: "", pdfUrl: "" })
  assert.match(html, /Hola! Soy/)
  assert.doesNotMatch(html, /Ver mi cotización/)
})

test("el asunto lleva la empresa cuando la hay", () => {
  assert.match(asuntoDeToque({ ...base, casilla: 1 }), /· Constructora Avanti/)
})
