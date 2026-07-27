/**
 * El RUT no puede ser un muro entre el cliente y su cotización.
 *
 * CASO QUE ORIGINA ESTA REGLA (27-jul, Macarena de La Pancora y el Erizo):
 * dio dos veces un RUT con un dígito de tipeo (77128187-5 en vez de
 * 78.128.187-5) y Vicky entró en bucle de "revísalo de nuevo" — dos intentos
 * fallidos, cero alternativas, con la cotización a UN dato de distancia.
 *
 * La regla que queda en el prompt (pedido Lalo): un reintento de revisión, y
 * al segundo fallo —o si el cliente no tiene el RUT de la empresa— se ofrece
 * emitir con el RUT PERSONAL (persona natural), actualizable después con
 * actualizar_cotizacion. El backend siempre lo soportó: el schema de
 * generar_link_cotizadora dice "RUT empresa o persona natural" desde su
 * origen — lo que faltaba era que Vicky lo ofreciera.
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const RAIZ = new URL("..", import.meta.url).pathname
const PROMPT = readFileSync(join(RAIZ, "app/api/vic-sales-agent-v3/prompt.ts"), "utf8")
const TOOL = readFileSync(join(RAIZ, "lib/tools/generar-link-cotizadora.ts"), "utf8")

describe("la escalera del RUT en el prompt CL", () => {
  test("existe la regla y nombra la alternativa del RUT personal", () => {
    assert.match(PROMPT, /RUT QUE NO VALIDA O QUE EL CLIENTE NO TIENE A MANO/)
    assert.match(PROMPT, /RUT personal/)
    assert.match(PROMPT, /actualizar_cotizacion permite corregirlo después/)
  })

  test("un solo reintento de revisión antes de ofrecer la salida", () => {
    assert.match(PROMPT, /pide revisarlo UNA sola vez/)
    assert.match(PROMPT, /PROHIBIDO un tercer "revísalo de nuevo" sin haber ofrecido la alternativa/)
  })

  test("la alternativa no degrada la cotización ante el cliente", () => {
    // "igual de válida" es parte del ofrecimiento: sin eso, el cliente percibe
    // la vía del RUT personal como una cotización de segunda.
    assert.match(PROMPT, /igual de válida/)
  })
})

describe("el backend efectivamente acepta persona natural", () => {
  test("el schema de la tool lo declara desde siempre", () => {
    assert.match(TOOL, /RUT empresa o persona natural/)
  })
})
