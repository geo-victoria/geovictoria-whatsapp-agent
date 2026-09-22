/**
 * La hora de pared manda: normalizarSlotIso corrige offsets inventados.
 *
 * CASO REAL (Valeska Ortega / Tri-Stone, +56994696609, 28-jul): la tool
 * ofreció "viernes 15:00/15:20/15:40" (slots reales de Chile), la clienta
 * eligió 15:40 y el modelo construyó el slotIso A MANO:
 *
 *   2026-07-31T15:40:00-03:00   ← offset de VERANO; Chile en julio es -04
 *
 * Ese string es el instante 14:40 de Chile. El slot de las 14:40 también
 * estaba libre → "disponible_exacto" → la reunión nació una hora antes de lo
 * confirmado, y la confirmación le dijo a la clienta "02:40 p. m.". Cuando
 * reclamó, el reintento falló y el guardrail remató con "tu reunión quedó
 * pendiente de registro".
 *
 * La regla que queda: lo que el cliente LEYÓ Y CONFIRMÓ es la hora de pared
 * del string. Si el offset declarado no es el real de la zona en esa fecha,
 * se reinterpreta; los ISO en Z (instantes de la tool de slots) y los de
 * offset correcto pasan intactos.
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { normalizarSlotIso } from "../lib/calendar.ts"

const RAIZ = new URL("..", import.meta.url).pathname
const CAL = readFileSync(join(RAIZ, "lib/calendar.ts"), "utf8")

describe("normalizarSlotIso: la hora de pared manda", () => {
  test("el caso Valeska: -03 en julio chileno se reinterpreta como -04", () => {
    assert.equal(
      normalizarSlotIso("2026-07-31T15:40:00-03:00", "America/Santiago"),
      "2026-07-31T19:40:00.000Z",
    )
  })

  test("offset correcto pasa intacto", () => {
    assert.equal(
      normalizarSlotIso("2026-07-31T15:40:00-04:00", "America/Santiago"),
      "2026-07-31T15:40:00-04:00",
    )
  })

  test("los instantes en Z (vienen de la tool de slots) jamás se tocan", () => {
    assert.equal(
      normalizarSlotIso("2026-07-31T18:40:00.000Z", "America/Santiago"),
      "2026-07-31T18:40:00.000Z",
    )
  })

  test("en verano chileno el -03 es correcto y pasa intacto", () => {
    // Diciembre: America/Santiago está en -03 (horario de verano).
    assert.equal(
      normalizarSlotIso("2026-12-15T15:40:00-03:00", "America/Santiago"),
      "2026-12-15T15:40:00-03:00",
    )
  })

  test("México: un -06 inventado en julio (CDMX es -05... no: -06 sin DST) — el real manda", () => {
    // America/Mexico_City abolió el DST: es -06 todo el año. Un modelo que
    // asuma -05 (viejo horario de verano) queda corregido.
    assert.equal(
      normalizarSlotIso("2026-07-31T10:00:00-05:00", "America/Mexico_City"),
      "2026-07-31T16:00:00.000Z",
    )
  })

  test("strings que no son fechas vuelven tal cual, sin lanzar", () => {
    assert.equal(normalizarSlotIso("mañana a las 3", "America/Santiago"), "mañana a las 3")
    assert.equal(normalizarSlotIso("", "America/Santiago"), "")
  })
})

describe("y está aplicada en los DOS puntos de entrada a Cal", () => {
  test("bookMeeting normaliza antes de agendar", () => {
    const fn = CAL.slice(
      CAL.indexOf("export async function bookMeeting"),
      CAL.indexOf("export async function checkSlotAvailability"),
    )
    assert.match(fn, /const slotIso = normalizarSlotIso\(params\.slotIso, timeZone\)/)
  })

  test("checkSlotAvailability normaliza antes de verificar", () => {
    const fn = CAL.slice(CAL.indexOf("export async function checkSlotAvailability"), CAL.length)
    assert.match(fn, /const slotIso = normalizarSlotIso\(params\.slotIso, tz\)/)
  })
})
