/**
 * Vicky suelta la venta cuando aparece cualquier excusa para no cerrarla.
 *
 * TRES CASOS DEL 27-jul, el mismo patrón por tres puertas distintas:
 *
 *   a) Victor Bravo (Transportes Vibra). Ya tenía precio y solo faltaba el
 *      RUT. Preguntó por el artículo 25 bis, quedó en que lo llamara un
 *      ejecutivo, y ahí Vicky abandonó la cotización.
 *
 *   b) +56977021717, 30 personas y 2 relojes ($128.347/mes + $48.433 único).
 *      A los 12 minutos dijo "por ahora no necesito una cotización formal,
 *      estamos evaluando posibilidades". Media hora después preguntaba cómo
 *      se carga la nómina desde Excel, cuánto demora quedar operativo y pedía
 *      una reunión "antes de decidir" — y Vicky seguía obedeciendo aquel "no".
 *
 *   c) Mismo cliente, 12:43: hizo CUATRO preguntas concretas (arriendo,
 *      alcance de la instalación, si incluye capacitación y soporte,
 *      permanencia mínima) y Vicky respondió "Déjame dejarte el mejor precio
 *      posible, ¿me confirmas que seguimos con esta opción?". Tuvo que
 *      insistir para que se las contestaran.
 *
 * Y una cuarta: la duda que la hizo derivar en (b) —el alcance de la puesta
 * en marcha— era información que Vicky tiene. Es una capacitación online
 * guiada donde se carga toda la data del cliente, con soporte incluido
 * durante todo el contrato.
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const RAIZ = new URL("..", import.meta.url).pathname
const PROMPT = readFileSync(join(RAIZ, "app/api/vic-sales-agent-v3/prompt.ts"), "utf8")

describe("la reunión y la cotización conviven", () => {
  test("agendar una reunión no reemplaza la cotización", () => {
    assert.match(PROMPT, /agendar una reunión NUNCA reemplaza la cotización formal/i)
    assert.match(PROMPT, /Se agenda la reunión Y se ofrece la cotización, en el mismo turno/)
  })

  test("y derivar a un ejecutivo tampoco", () => {
    assert.match(PROMPT, /DERIVAR A UN EJECUTIVO NO CANCELA LA COTIZACIÓN/)
  })
})

describe('el "no" a la cotización formal caduca', () => {
  test("la regla existe y dice explícitamente que no es permanente", () => {
    assert.match(PROMPT, /EL "NO" A LA COTIZACIÓN FORMAL CADUCA/)
    assert.match(PROMPT, /NO es una instrucción permanente/)
  })

  test("enumera las señales de decisión que lo hacen caducar", () => {
    const bloque = PROMPT.slice(
      PROMPT.indexOf('EL "NO" A LA COTIZACIÓN FORMAL CADUCA'),
      PROMPT.indexOf("NUNCA CAMBIES UNA PREGUNTA CONCRETA"),
    )
    for (const señal of [
      /proceso de contratación/i,
      /carga la nómina/i,
      /reunión para decidir/i,
      /permanencia/i,
    ]) {
      assert.match(bloque, señal, `falta la señal ${señal}`)
    }
  })

  test("se re-ofrece UNA vez y encuadrada, no como presión", () => {
    assert.match(PROMPT, /vuelves a ofrecerla UNA vez/)
    assert.match(PROMPT, /No compromete a nada/)
  })

  test("y si vuelve a decir que no, se respeta", () => {
    assert.match(PROMPT, /Si vuelve a decir que no, lo respetas y no insistes más/)
  })
})

describe("las preguntas concretas se responden antes que nada", () => {
  test("la regla prohíbe cambiarlas por un descuento", () => {
    assert.match(PROMPT, /NUNCA CAMBIES UNA PREGUNTA CONCRETA POR UN DESCUENTO/)
    assert.match(PROMPT, /El descuento va DESPUÉS de dejar todas las dudas resueltas/)
  })

  test("nombra las preguntas que sí o sí se responden", () => {
    const bloque = PROMPT.slice(
      PROMPT.indexOf("NUNCA CAMBIES UNA PREGUNTA CONCRETA"),
      PROMPT.indexOf("QUÉ ES LA PUESTA EN MARCHA"),
    )
    for (const tema of [/arriendo o compra/i, /permanencia mínima/i, /capacitación y soporte/i]) {
      assert.match(bloque, tema, `falta el tema ${tema}`)
    }
  })

  test("explica POR QUÉ, no solo que no se haga", () => {
    // Una prohibición sin motivo se erosiona; con motivo, el modelo generaliza
    // a los casos que nadie enumeró.
    assert.match(PROMPT, /está evaluando riesgo, no precio/)
  })
})

describe("la puesta en marcha la explica Vicky, no la deriva", () => {
  test("la definición está en el prompt", () => {
    assert.match(PROMPT, /CAPACITACIÓN ONLINE GUIADA/)
    assert.match(PROMPT, /se carga toda la data junto al cliente/)
    assert.match(PROMPT, /soporte queda incluido durante todo el contrato/)
  })

  test("dice explícitamente que NO se derive", () => {
    assert.match(PROMPT, /NO lo derives a un ejecutivo: es información que tienes/)
  })

  test("no promete una cantidad de sesiones que nadie definió", () => {
    // El cliente preguntó "cuántas sesiones están incluidas" y esa cifra no
    // existe. Inventarla es una promesa que el equipo tendría que cumplir.
    const bloque = PROMPT.slice(PROMPT.indexOf("QUÉ ES LA PUESTA EN MARCHA"))
    assert.doesNotMatch(
      bloque.slice(0, 900),
      /\b(una|dos|tres|\d+)\s+sesion/i,
      "el prompt está prometiendo una cantidad de sesiones",
    )
  })
})
