/**
 * Agenda de reuniones MX: event type 6101466 (Lalo, 27-jul).
 *
 * Es el agendamiento SIN cotización — la llamada exploratoria del equipo
 * mexicano, espejo del 3188650 chileno. Al pasar de env-vacío a default en
 * código, REUNIONES_MX_HABILITADAS queda true por defecto: las tools de
 * agenda se exponen al modelo y el prompt cambia del fallback "deriva a
 * Yahel" al flujo de agenda real.
 *
 * El interruptor sigue existiendo: CAL_EVENT_TYPE_ID_MX="" (string vacío) en
 * Vercel apaga la agenda — por eso el default usa `??` y no `||`: con `||` un
 * env vacío re-activaría el default y la agenda no se podría apagar nunca.
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const RAIZ = new URL("..", import.meta.url).pathname
const TOOLS = readFileSync(join(RAIZ, "lib/paises/mx/tools.ts"), "utf8")

describe("event type de reuniones MX", () => {
  test("default 6101466 con override por env", () => {
    assert.match(TOOLS, /process\.env\.CAL_EVENT_TYPE_ID_MX \?\? "6101466"/)
  })

  test("usa ?? y no ||: un env vacío APAGA la agenda, no la re-activa", () => {
    assert.doesNotMatch(TOOLS, /CAL_EVENT_TYPE_ID_MX \|\| "6101466"/)
  })

  test("el gate sigue derivando del valor efectivo", () => {
    assert.match(TOOLS, /REUNIONES_MX_HABILITADAS = Boolean\(CAL_EVENT_TYPE_ID_MX\)/)
  })

  test("consultar y agendar usan el event type MX, no el chileno", () => {
    const usos = [...TOOLS.matchAll(/eventTypeId: CAL_EVENT_TYPE_ID_MX/g)]
    assert.ok(usos.length >= 2, `se esperaban ≥2 usos (consultar + agendar), hay ${usos.length}`)
  })

  test("el fallback a derivar_a_ejecutivo sigue existiendo para cuando se apague", () => {
    assert.match(TOOLS, /Usa derivar_a_ejecutivo \(motivo pidio_persona\)/)
  })
})
