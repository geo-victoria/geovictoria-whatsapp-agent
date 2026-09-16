import test from "node:test"
import assert from "node:assert/strict"
import { clasificarGestionV3, notaCumpleMinimo, rubricaDeterminista, type RubricaNota } from "../lib/gestion-venta-v3.ts"

const GREY = "3525045000146108001"
const ALEYDIS = "3525045000583802005"
const roster = new Set([GREY])
const pago = Date.parse("2026-09-16T16:29:00Z")
const buena: RubricaNota = { fechaCanal: true, resumen: true, gestion: true, resultado: true, proximoPaso: false, bidireccional: true, intentoSinRespuesta: false }

test("intento sin respuesta = autónoma (caso Panadería Omar Hernández)", () => {
  const r = clasificarGestionV3({ pagoMs: pago, rosterIds: roster, llamadas: [], reuniones: [], notas: [
    { id: "1", autorId: GREY, creadaMs: pago - 86_400_000, esEspejo: false, rubrica: { ...buena, bidireccional: false, intentoSinRespuesta: true, resumen: false } },
  ] })
  assert.equal(r.veredicto, "autonoma")
})

test("nota completa con respuesta del cliente antes del pago = asistida", () => {
  const r = clasificarGestionV3({ pagoMs: pago, rosterIds: roster, llamadas: [], reuniones: [], notas: [
    { id: "1", autorId: GREY, creadaMs: pago - 3_600_000, esEspejo: false, rubrica: buena },
  ] })
  assert.equal(r.veredicto, "asistida")
})

test("nota de SDR no cuenta (decisión 1)", () => {
  const r = clasificarGestionV3({ pagoMs: pago, rosterIds: roster, llamadas: [], reuniones: [], notas: [
    { id: "1", autorId: ALEYDIS, creadaMs: pago - 3_600_000, esEspejo: false, rubrica: buena },
  ] })
  assert.equal(r.veredicto, "autonoma")
  assert.match(r.descartada[0], /roster/)
})

test("nota posterior al pago + 24 h es postventa (decisión 2); dentro del margen cuenta", () => {
  const tarde = clasificarGestionV3({ pagoMs: pago, rosterIds: roster, llamadas: [], reuniones: [], notas: [
    { id: "1", autorId: GREY, creadaMs: pago + 30 * 3_600_000, esEspejo: false, rubrica: buena },
  ] })
  assert.equal(tarde.veredicto, "autonoma")
  const margen = clasificarGestionV3({ pagoMs: pago, rosterIds: roster, llamadas: [], reuniones: [], notas: [
    { id: "1", autorId: GREY, creadaMs: pago + 20 * 3_600_000, esEspejo: false, rubrica: buena },
  ] })
  assert.equal(margen.veredicto, "asistida")
})

test("nota-espejo no es criterio (Victoria)", () => {
  const r = clasificarGestionV3({ pagoMs: pago, rosterIds: roster, llamadas: [], reuniones: [], notas: [
    { id: "1", autorId: "robot", creadaMs: pago - 3_600_000, esEspejo: true, rubrica: buena },
  ] })
  assert.equal(r.veredicto, "autonoma")
})

test("mínimo de la nota (decisión 3): sin gestión no pasa; resultado y próximo paso no bloquean", () => {
  assert.equal(notaCumpleMinimo({ ...buena, gestion: false }), false)
  assert.equal(notaCumpleMinimo({ ...buena, resultado: false, proximoPaso: false }), true)
})

test("llamada contestada sin nota que documente gestión = revisar", () => {
  const r = clasificarGestionV3({ pagoMs: pago, rosterIds: roster, notas: [], reuniones: [], llamadas: [
    { id: "c", ownerId: GREY, inicioMs: pago - 7_200_000, duracionSeg: 180, tipo: "Saliente" },
  ] })
  assert.equal(r.veredicto, "revisar")
})

test("reunión realizada antes del pago = asistida", () => {
  const r = clasificarGestionV3({ pagoMs: pago, rosterIds: roster, notas: [], llamadas: [], reuniones: [
    { id: "e", ownerId: GREY, inicioMs: pago - 86_400_000, titulo: "Demo" },
  ] })
  assert.equal(r.veredicto, "asistida")
})

test("rúbrica determinista: 'segui' y 'en seguimiento' son todo falso; intento corto sin respuesta se marca", () => {
  assert.deepEqual(rubricaDeterminista("segui")?.gestion, false)
  assert.deepEqual(rubricaDeterminista("En seguimiento.")?.fechaCanal, false)
  assert.equal(rubricaDeterminista("se llama al cliente, pero no atiende, se envía whatsapp")?.intentoSinRespuesta, true)
  assert.equal(rubricaDeterminista("Cliente contestó la llamada, revisamos la propuesta y quedó de pagar mañana"), null)
})
