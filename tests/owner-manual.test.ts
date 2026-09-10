import { test } from "node:test"
import assert from "node:assert/strict"
import { veredictoOwnerDesdeTimeline, ACTOR_APP_ID, type EventoTimeline } from "../lib/owner-manual.ts"

const ev = (at: string, actorId: string, actorNombre: string, owner = true): EventoTimeline => ({
  action: "updated",
  audited_time: at,
  done_by: { id: actorId, name: actorNombre },
  field_history: owner
    ? [{ api_name: "Owner", _value: { old: "Vicky GeoVictoria", new: "Aleydis Araque" } }]
    : [{ api_name: "Valor_fijo_del_trato_Global", _value: { old: "1", new: "2" } }],
})

// OMEGA (…556033): Lalo lo movió a mano el 02-sep por el conector admin.
test("owner puesto por GeoVictoria Admin = decisión manual, no se toca", () => {
  const v = veredictoOwnerDesdeTimeline([ev("2026-09-02T14:47:40-04:00", "3525045000200013", "GeoVictoria Admin")])
  assert.equal(v.manual, true)
  assert.equal(v.motivo, "humano")
  assert.equal(v.actor, "GeoVictoria Admin")
})

// Cancino (…339242) y Patiño (…458659): los movió nuestro propio código.
test("owner puesto por la app = re-sorteable", () => {
  const v = veredictoOwnerDesdeTimeline([ev("2026-08-31T15:42:23-04:00", ACTOR_APP_ID, "Vicky GeoVictoria")])
  assert.equal(v.manual, false)
  assert.equal(v.motivo, "app")
})

// MSS Asesores (…038535): nació con Aleydis, sin evento de Owner.
test("sin evento de Owner = nació de nuestro flujo, re-sorteable", () => {
  const v = veredictoOwnerDesdeTimeline([ev("2026-09-09T10:00:00-04:00", ACTOR_APP_ID, "Vicky GeoVictoria", false)])
  assert.equal(v.manual, false)
  assert.equal(v.motivo, "sin_evento")
})

test("manda el ÚLTIMO cambio de dueño, no el primero", () => {
  const v = veredictoOwnerDesdeTimeline([
    ev("2026-08-20T09:00:00-04:00", ACTOR_APP_ID, "Vicky GeoVictoria"),
    ev("2026-09-02T14:47:40-04:00", "3525045000594735052", "Aracelli Sepúlveda"),
  ])
  assert.equal(v.manual, true)
  assert.equal(v.actor, "Aracelli Sepúlveda")
})

test("timeline vacío no bloquea (sin evento de owner)", () => {
  assert.equal(veredictoOwnerDesdeTimeline([]).manual, false)
})
