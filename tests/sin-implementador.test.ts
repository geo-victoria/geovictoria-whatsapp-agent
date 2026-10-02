import { test } from "node:test"
import assert from "node:assert/strict"
import { sinImplementadorNombrado } from "../lib/onboarding/capacitacion-link.ts"
import { promptConfiguracionCL } from "../lib/onboarding/prompt.ts"

test("capacitación por link: el prompt no deja 'tu implementador' ni 'relator' asignado", () => {
  const p = sinImplementadorNombrado(
    promptConfiguracionCL({ resumen: "", pendientes: [], nTrabajadores: 0, altaCreada: true }),
  )
  assert.ok(!/\btu implementador\b|\bsu implementador\b|\bsu relator\b|\btu relator\b/.test(p))
  assert.ok(!/2 horas por videollamada con su relator/.test(p))
  assert.match(p, /equipo de implementación/)
})
