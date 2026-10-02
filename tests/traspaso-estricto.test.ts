import { test } from "node:test"
import assert from "node:assert/strict"
import { cinturonTraspasoEstricto, hablaDePrecio, hablaDeCapacitacion, TOOLS_PRECIO_TRASPASO } from "../lib/traspaso-estricto.ts"

test("precio tras el traspaso (frases reales Electric World)", () => {
  assert.ok(hablaDePrecio("Con 25 personas el total sería S/.418 al mes"))
  assert.ok(hablaDePrecio("Mónica te puede dar un descuento por volumen"))
  assert.ok(hablaDePrecio("son S/ 150 + IGV"))
  assert.ok(hablaDePrecio("¿Cuánto cuesta? Te cuento: 20 soles por persona"))
})

test("capacitación tras el traspaso", () => {
  assert.ok(hablaDeCapacitacion("Después te agendamos la capacitación con el implementador"))
  assert.ok(hablaDeCapacitacion("la puesta en marcha es rápida"))
})

test("lo que sí puede decir no se toca", () => {
  for (const t of [
    "El reloj marca con rostro, huella o tarjeta.",
    "Sí, la app funciona sin internet y sincroniza después.",
    "Los datos de Mónica te los dejé más arriba 😊",
  ]) {
    const r = cinturonTraspasoEstricto(t, "Mónica")
    assert.equal(r.violacion, "", t)
    assert.equal(r.reemplazo, t)
  }
})

test("el reemplazo nombra al ejecutivo y no vuelve a disparar", () => {
  const r = cinturonTraspasoEstricto("El total sería S/ 418 al mes", "Mónica Mendoza")
  assert.equal(r.violacion, "precio")
  assert.match(r.reemplazo, /Mónica Mendoza/)
  assert.equal(cinturonTraspasoEstricto(r.reemplazo, "Mónica Mendoza").violacion, "")
})

test("tools de precio bloqueadas", () => {
  assert.ok(TOOLS_PRECIO_TRASPASO.has("cotizar_referencial"))
  assert.ok(TOOLS_PRECIO_TRASPASO.has("generar_link_cotizadora"))
  assert.ok(!TOOLS_PRECIO_TRASPASO.has("enviar_ficha_reloj"))
})
