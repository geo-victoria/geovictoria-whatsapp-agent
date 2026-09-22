import { test } from "node:test"
import assert from "node:assert/strict"
import { clasificarGestion, esNotaDeTelemarketing, refrescarGestion, sesionesTelemarketing } from "../lib/gestion-venta.ts"

const VICKY = "3525045000484500876"
const ADMIN = "3525045000000200013"
const ANA = "3525045000126464001" // Ana Paula López, telemarketing
const ALEYDIS = "3525045000583802005" // SDR
const ARACELLI = "3525045000594735052" // SDR
const IMPLEMENTADOR = "3525045000451232212" // Diego Alegre

test("nota de un ejecutivo de telemarketing = actividad", () => {
  assert.equal(esNotaDeTelemarketing({ Note_Title: "Llamé al cliente", Created_By: { id: ANA } }), true)
})

test("notas del robot no cuentan", () => {
  assert.equal(esNotaDeTelemarketing({ Note_Title: "Insight de la conversación (Vicky)", Created_By: { id: VICKY } }), false)
  assert.equal(esNotaDeTelemarketing({ Note_Title: "Cotización en Creator INCOMPLETA", Created_By: { id: ADMIN } }), false)
})

// Lalo 10-sep: "si escribe Aleydis o Aracelli no es asistida, son gestiones
// de postventa" — ellas o califican, o gestionan la venta autónoma de Vicky.
test("actividad de las SDR es POSTVENTA, no asistencia", () => {
  assert.equal(esNotaDeTelemarketing({ Note_Title: "Coordino la puesta en marcha", Created_By: { id: ALEYDIS } }), false)
  assert.equal(esNotaDeTelemarketing({ Note_Title: "Hablé con el cliente", Created_By: { id: ARACELLI } }), false)
  // Caso real COT1378 DE LA CUENCA: la nota-espejo la crea el robot y el
  // título nombra la sesión de Aleydis.
  assert.equal(esNotaDeTelemarketing({ Note_Title: "WhatsApp aaraque ↔ cliente (espejo, sesión aaraque)", Created_By: { id: VICKY } }), false)
  assert.equal(clasificarGestion({ notas: [{ Note_Title: "WhatsApp aaraque ↔ cliente (espejo)", Created_By: { id: VICKY } }] }), "autonoma")
})

test("nota de un implementador tampoco es asistencia comercial", () => {
  assert.equal(esNotaDeTelemarketing({ Note_Title: "Capacitación agendada", Created_By: { id: IMPLEMENTADOR } }), false)
})

// Casos reales COT1327 / COT1324 / COT1274.
test("nota-espejo de un ejecutivo de telemarketing = asistida", () => {
  assert.equal(esNotaDeTelemarketing({ Note_Title: "WhatsApp Ana Paula López ↔ cliente (espejo)", Created_By: { id: VICKY } }), true)
  assert.equal(esNotaDeTelemarketing({ Note_Title: "WhatsApp gmelendez ↔ cliente (espejo)", Created_By: { id: VICKY } }), true)
})

// Caso real COT1334 Eduardo Guzmán: 10 notas, todas del robot, con el
// traspaso a Tamara disparado y sin que ella hiciera nada.
test("traspaso sin actividad = autónoma", () => {
  assert.equal(clasificarGestion({ notas: [{ Note_Title: "Traspaso a ejecutivo", Created_By: { id: VICKY } }] }), "autonoma")
})

test("espejo o llamada de telemarketing = asistida aunque la nota no haya llegado", () => {
  assert.equal(clasificarGestion({ notas: [], espejoDeTelemarketing: true }), "asistida")
  assert.equal(clasificarGestion({ llamadaDeTelemarketing: true }), "asistida")
})

test("sin señales legibles = sd, jamás autónoma por omisión", () => {
  assert.equal(clasificarGestion({}), "sd")
})

test("las sesiones de espejo que cuentan son las 7 de telemarketing, sin SDR", () => {
  const s = sesionesTelemarketing()
  assert.equal(s.size, 7)
  assert.ok(s.has("tmartinezq") && s.has("alopez") && s.has("adiazg"))
  assert.ok(!s.has("aaraque") && !s.has("asepulveda"))
})

test("refresco: venta vieja ya clasificada no se relee; recién pagada sí", () => {
  const ahora = Date.parse("2026-09-10T18:00:00Z")
  const vieja = ahora - 20 * 86_400_000
  const hoy = ahora - 3_600_000
  assert.equal(refrescarGestion({ g: "autonoma", at: "2026-08-25T10:00:00Z" }, vieja, ahora), false)
  assert.equal(refrescarGestion({ g: "autonoma", at: "2026-09-10T09:00:00Z" }, hoy, ahora), true)
  assert.equal(refrescarGestion({ g: "sd", at: "2026-09-10T17:50:00Z" }, hoy, ahora), true)
  assert.equal(refrescarGestion(null, hoy, ahora), true)
})
