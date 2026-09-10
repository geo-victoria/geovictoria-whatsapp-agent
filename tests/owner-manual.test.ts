import { test } from "node:test"
import assert from "node:assert/strict"
import { veredictoOwnerDesdeTimeline, ACTOR_APP_ID, type EventoTimeline } from "../lib/owner-manual.ts"

const ev = (at: string, actorId: string, actorNombre: string, nuevo: string | null): EventoTimeline => ({
  action: "updated",
  audited_time: at,
  done_by: { id: actorId, name: actorNombre },
  field_history: nuevo
    ? [{ api_name: "Owner", _value: { old: "Vicky GeoVictoria", new: nuevo } }]
    : [{ api_name: "Valor_fijo_del_trato_Global", _value: { old: "1", new: "2" } }],
})
const APP = (at: string, nuevo: string | null) => ev(at, ACTOR_APP_ID, "Vicky GeoVictoria", nuevo)
const ADMIN = (at: string, nuevo: string) => ev(at, "3525045000000200013", "GeoVictoria Admin", nuevo)

// OMEGA (…556033): Lalo lo movió a mano el 02-sep por el conector admin.
test("owner puesto por GeoVictoria Admin = decisión manual, no se toca", () => {
  const v = veredictoOwnerDesdeTimeline([ADMIN("2026-09-02T14:47:40-04:00", "Aleydis Araque")], "Aleydis Araque")
  assert.equal(v.manual, true)
  assert.equal(v.motivo, "humano")
  assert.equal(v.actor, "GeoVictoria Admin")
})

// TRAMUS/ROSSELLÓ: el conector admin movió a las 14:47 y la app RE-ESTAMPÓ el
// mismo dueño a las 16:30 — el último evento es de la app y aun así es manual.
test("re-estampado de la app sobre una decisión humana sigue siendo manual", () => {
  const v = veredictoOwnerDesdeTimeline(
    [APP("2026-09-02T16:30:18-04:00", "Aracelli Sepúlveda"), ADMIN("2026-09-02T14:47:46-04:00", "Aracelli Sepúlveda")],
    "Aracelli Sepulveda", // sin tilde: la comparación normaliza
  )
  assert.equal(v.manual, true)
  assert.equal(v.motivo, "humano")
})

// Cancino (…339242) y Patiño (…458659): los movió nuestro propio código.
test("owner puesto por la app = re-sorteable", () => {
  const v = veredictoOwnerDesdeTimeline([APP("2026-08-31T15:42:23-04:00", "Aleydis Araque")], "Aleydis Araque")
  assert.equal(v.manual, false)
  assert.equal(v.motivo, "app")
})

// MSS Asesores (…038535): nació con Aleydis, sin evento de Owner.
test("sin evento de Owner = nació de nuestro flujo, re-sorteable", () => {
  const v = veredictoOwnerDesdeTimeline([APP("2026-09-09T10:00:00-04:00", null)], "Aleydis Araque")
  assert.equal(v.manual, false)
  assert.equal(v.motivo, "sin_evento")
})

test("decisión humana ya superada por un re-sorteo posterior no protege", () => {
  const v = veredictoOwnerDesdeTimeline(
    [APP("2026-09-05T10:00:00-04:00", "Anderson Diaz"), ADMIN("2026-09-02T14:47:40-04:00", "Aleydis Araque")],
    "Anderson Diaz",
  )
  assert.equal(v.manual, false)
  assert.equal(v.motivo, "humano_superado")
})

test("sin dueño actual legible se protege igual", () => {
  const v = veredictoOwnerDesdeTimeline([ADMIN("2026-09-02T14:47:40-04:00", "Aleydis Araque")])
  assert.equal(v.manual, true)
})

test("timeline vacío no bloquea (sin evento de owner)", () => {
  assert.equal(veredictoOwnerDesdeTimeline([]).manual, false)
})
