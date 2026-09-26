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
import { textoNucleo } from "../lib/prompt-nucleo/texto.ts"
import { FICHA_MX } from "../lib/paises/mx/ficha.ts"

// Desde el 26-sep México es el núcleo armado con su ficha: la regla vive en
// la línea de derivar_a_soporte de FICHA_MX. La promesa de contacto sin
// tool la ataja el cinturón del orquestador (rescate de callback), no el prompt.
const PROMPT_MX = textoNucleo(FICHA_MX, "")

describe("el RFC no bloquea la derivación (prompt MX)", () => {
  test("la regla existe en lo que ve el cliente", () => {
    assert.match(PROMPT_MX, /El RFC NUNCA es requisito para derivar/)
  })
})
