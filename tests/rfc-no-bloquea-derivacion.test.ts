/**
 * El RFC jamás condiciona una derivación (caso real MX, 29-jul-2026).
 *
 * Marisela, coordinadora del Colegio Anáhuac de Cuautitlán (120 personas),
 * pidió que el equipo la contactara. Vicky respondió "mañana me pasas el RFC
 * y al instante te dejo registrada con el equipo": condicionó la derivación a
 * un dato que solo sirve para la cotización formal, no llamó ninguna tool, y
 * la clienta quedó esperando a un equipo que nunca supo de ella (sin lead ni
 * callback en Zoho). Reportado por Karen De la Garza (MX) el 30-jul.
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const RAIZ = new URL("..", import.meta.url).pathname
const PROMPT_MX = readFileSync(join(RAIZ, "lib/paises/mx/prompt.ts"), "utf8")

describe("el RFC no bloquea la derivación (prompt MX)", () => {
  test("la regla existe y nombra la única función real del RFC", () => {
    assert.match(PROMPT_MX, /EL RFC NUNCA ES REQUISITO PARA DERIVAR/)
    assert.match(PROMPT_MX, /generar la cotización formal en PDF/)
  })

  test("derivar exige la tool en el mismo turno — sin promesas vacías", () => {
    assert.match(PROMPT_MX, /derivar_a_ejecutivo EN ESE MISMO TURNO/)
    assert.match(PROMPT_MX, /promesa vacía PROHIBIDA/)
  })

  test("queda anclada al caso real para que nadie la borre a ciegas", () => {
    assert.match(PROMPT_MX, /Colegio Anáhuac/)
  })
})
