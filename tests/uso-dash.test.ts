import { test } from "node:test"
import assert from "node:assert/strict"
import {
  slugPersona,
  claveUso,
  parseClaveUso,
  parseRegistro,
  sumarUso,
  agregarUso,
  EVENTOS_USO,
} from "../lib/uso-dash.ts"

test("slugPersona: sin tildes, minúsculas, guiones, sin guiones sobrantes", () => {
  assert.equal(slugPersona("Ana Paula Pérez"), "ana-paula-perez")
  assert.equal(slugPersona("  Administrador "), "administrador")
  assert.equal(slugPersona("José Ñuñez (TMK)"), "jose-nunez-tmk")
  assert.equal(slugPersona(""), "")
  assert.ok(slugPersona("x".repeat(80)).length <= 40)
})

test("claveUso ↔ parseClaveUso: ida y vuelta para todos los eventos", () => {
  for (const ev of EVENTOS_USO) {
    const k = claveUso("2026-09-24", "ana-paula-perez", ev)
    assert.equal(k, `uso_2026-09-24_ana-paula-perez_${ev}`)
    assert.deepEqual(parseClaveUso(k), { fecha: "2026-09-24", slug: "ana-paula-perez", evento: ev })
  }
  assert.equal(parseClaveUso("pf_123_abrio"), null)
  assert.equal(parseClaveUso("uso_2026-09-24_ana_otro_evento"), null)
  assert.equal(parseClaveUso("uso_2026-09-24__editor"), null)
})

test("sumarUso: crea y acumula conservando el primero", () => {
  const a = sumarUso(null, "Ana", "2026-09-24T12:00:00.000Z", "352504")
  assert.deepEqual(a, { n: 1, primero: "2026-09-24T12:00:00.000Z", ultimo: "2026-09-24T12:00:00.000Z", quien: "Ana", detalle: "352504" })
  const b = sumarUso(a, "Ana", "2026-09-24T13:00:00.000Z")
  assert.equal(b.n, 2)
  assert.equal(b.primero, a.primero)
  assert.equal(b.ultimo, "2026-09-24T13:00:00.000Z")
  assert.equal(b.detalle, "352504")
  assert.deepEqual(parseRegistro(JSON.stringify(b)), b)
  assert.equal(parseRegistro("no es json"), null)
  assert.equal(parseRegistro(JSON.stringify({ n: -1 })), null)
})

test("agregarUso: por persona y por día, ignorando basura", () => {
  const v = (n: number, quien: string, ultimo: string) => JSON.stringify({ n, primero: ultimo, ultimo, quien })
  const { personas, dias } = agregarUso([
    { key: "uso_2026-09-23_ana_calc_abrio", value: v(3, "Ana", "2026-09-23T15:00:00.000Z") },
    { key: "uso_2026-09-24_ana_calc_abrio", value: v(2, "Ana", "2026-09-24T15:00:00.000Z") },
    { key: "uso_2026-09-24_ana_calc_emitio", value: v(1, "Ana", "2026-09-24T15:05:00.000Z") },
    { key: "uso_2026-09-24_beto_editor", value: v(1, "Beto", "2026-09-24T10:00:00.000Z") },
    { key: "uso_2026-09-24_beto_editor", value: "{rota" },
    { key: "pf_99999_abrio", value: "2026-09-24T10:00:00.000Z|desktop" },
  ])
  assert.equal(personas.length, 2)
  assert.equal(personas[0].quien, "Ana")
  assert.equal(personas[0].total, 6)
  assert.equal(personas[0].dias, 2)
  assert.equal(personas[0].porEvento.calc_abrio, 5)
  assert.equal(personas[0].porEvento.calc_emitio, 1)
  assert.equal(personas[0].ultimo, "2026-09-24T15:05:00.000Z")
  assert.equal(personas[1].quien, "Beto")
  assert.equal(dias[0].fecha, "2026-09-24")
  assert.equal(dias[0].personas, 2)
  assert.equal(dias[0].total, 4)
  assert.equal(dias[1].fecha, "2026-09-23")
  assert.equal(dias[1].total, 3)
})
