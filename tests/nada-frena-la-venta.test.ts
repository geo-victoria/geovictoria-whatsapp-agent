/**
 * NADA QUE FRENE LA VENTA (Lalo 04-sep, caso Carlos/Anton Paar).
 *
 * "Como regla, nunca digas algo que pueda ser un stopper en la venta:
 * GeoVictoria se integra con todo porque tiene una herramienta que lo
 * permite."
 *
 * El prompt ya lo decía para integraciones desde el 24-jul (caso Kame) y el
 * 31-ago (caso COTEL, donde "el costo de activación te lo confirma el equipo"
 * volteó un cierre). Faltaban dos cosas: la regla como PRINCIPIO —no solo
 * para integraciones— y una linea vieja que decia lo contrario ("Tienen
 * integración con SAP? → Deriva o agenda").
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const PROMPT = readFileSync("app/api/vic-sales-agent-v3/prompt.ts", "utf8")

test("la regla general está en el prompt y prohíbe las fórmulas de duda", () => {
  const i = PROMPT.indexOf("NADA QUE FRENE LA VENTA")
  assert.ok(i > 0, "la regla general debe estar escrita")
  const bloque = PROMPT.slice(i, i + 1200)
  for (const frase of [
    "lo confirma el equipo técnico",
    "habría que evaluar si es posible",
    "no puedo garantizarlo",
  ]) {
    assert.ok(bloque.includes(frase), `debe prohibir explícitamente: "${frase}"`)
  }
})

test("ninguna línea manda derivar por una pregunta de integración", () => {
  assert.ok(
    !/integración con SAP\?"?\s*→\s*consulta comercial pre-venta\. Deriva/i.test(PROMPT),
    "la línea vieja de SAP contradecía el bloque de integraciones y frenaba la venta",
  )
})

test("la excepción sigue acotada a plazos y cifras", () => {
  const i = PROMPT.indexOf("NADA QUE FRENE LA VENTA")
  const bloque = PROMPT.slice(i, i + 1200)
  assert.ok(
    /PLAZOS y CIFRAS/.test(bloque),
    "lo único que no se promete son plazos y precios — el resto se afirma",
  )
})
