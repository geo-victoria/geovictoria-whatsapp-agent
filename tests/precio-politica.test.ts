/**
 * Montos de POLÍTICA vs precios inventados (14-sep, caso Dubraska).
 * La multa del arriendo (6 UF + IVA) está en el prompt y no la produce
 * ninguna tool: no puede tratarse como precio alucinado.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { chequearPreciosDelReply } from "../lib/precio-sin-tool.ts"

test("la multa de 6 UF del arriendo no es un precio inventado", () => {
  const reply =
    "Sí, exacto — los relojes en arriendo son propiedad de GeoVictoria, así que al terminar el servicio se devuelven. " +
    "La devolución la haces tú, a Avenida Los Leones 2061, Providencia. Y si cortas con menos de 6 mensualidades " +
    "pagadas, hay una multa de 6 UF + IVA por cada reloj."
  const r = chequearPreciosDelReply(reply, [], [])
  assert.equal(r.hayInventado, false, JSON.stringify(r.inventados))
})

test("6 UF como precio de plan SIGUE siendo inventado", () => {
  const reply = "Tu plan mensual queda en 6 UF al mes."
  const r = chequearPreciosDelReply(reply, [], [])
  assert.equal(r.hayInventado, true)
})

test("un precio cualquiera sin tool sigue cayendo", () => {
  const r = chequearPreciosDelReply("Te queda en $47.642 con 6 personas.", [], [])
  assert.equal(r.hayInventado, true)
  assert.deepEqual(r.inventados, [47642])
})

test("con tool de precio en el turno no se persigue nada", () => {
  const r = chequearPreciosDelReply("Total mensual con IVA: $26.765", ["cotizar_referencial"], [])
  assert.equal(r.hayInventado, false)
})
